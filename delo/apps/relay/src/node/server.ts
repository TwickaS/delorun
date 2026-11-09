/**
 * The relay's Node transport: one TCP listener on C6's port 443 reads each connection's
 * ClientHello, terminates TLS for the tunnel host alone, serves `/v1/tunnel-token` and
 * `/v1/tunnel` there, and hands every bound name's raw connection to the data plane with the
 * bytes that were already read. For a bound name it holds no certificate and decrypts nothing:
 * the browser's TLS ends at the home. The relay reads only the SNI of a bound name's
 * connection and the frame headers of the tunnel.
 *
 * @module @delo/relay/node/server
 */
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createNetServer, Socket } from 'node:net'
import { Duplex } from 'node:stream'
import { createSecureContext, TLSSocket } from 'node:tls'
import { RELAY_PATHS, RELAY_SUBPROTOCOL } from '@delo/contract-relay-protocol'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { ClientHelloReader } from '../client-hello.ts'
import type { RelaySettings } from '../config.ts'
import { RelayError } from '../errors.ts'
import { silentRelayLog, type RelayLog } from '../log.ts'
import { peerAssertion, type PeerAssertion } from '../peer.ts'
import { RelayCore, tokenRefusal, type TunnelUpgrade } from '../relay.ts'
import type { BrowserConnection, TunnelSocket } from '../transport.ts'
import { RELAY_LIMITS } from '@delo/contract-relay-protocol'

/** The port C6 fixes for browser connections. */
export const RELAY_PORT = 443

/** The most bytes a token request body may carry, above which the request is refused unread. */
const REQUEST_MAX_BYTES = 16_384

/**
 * The transport's own message bound: above every frame limit C6 defines, so an oversized frame
 * reaches the relay's parser and closes the tunnel with C6's 4413 instead of the transport's
 * own close code. A message above it is closed by the transport.
 */
const MESSAGE_MAX_BYTES = RELAY_LIMITS.streamBufferBytes

/** The options of {@link startRelayServer}. */
export interface RelayServerOptions {
  /** The validated configuration. */
  readonly settings: RelaySettings
  /** C20's `relay` log; a silent log by default. */
  readonly log?: RelayLog
  /** The port; C6 fixes 443, and a spec passes 0 to have the operating system assign one. */
  readonly port?: number
  /** The interface to bind; every interface by default. */
  readonly host?: string
}

/** One running relay. */
export interface RelayServer {
  /** The data plane. */
  readonly core: RelayCore
  /** The port the listener took. */
  readonly port: number
  /** Stop listening and end every tunnel and stream. */
  close(): Promise<void>
}

/**
 * A duplex over an accepted socket whose first bytes the relay already read: the preface keeps
 * the TLS layer of the tunnel host reading a stream while the relay decides the route from the
 * name it read. TLS cannot wrap the socket itself, because the bytes it would read first are the
 * ones the reader consumed.
 */
class Preface extends Duplex {
  private readonly socket: Socket

  /**
   * @param socket - the accepted connection.
   */
  constructor(socket: Socket) {
    super()
    this.socket = socket
    socket.on('close', () => {
      this.push(null)
    })
    socket.on('error', error => {
      this.destroy(error)
    })
  }

  /**
   * Feed the bytes the relay read before it knew the route.
   * @param chunk - the bytes.
   * @returns true while the stream wants more without backpressure.
   */
  feed(chunk: Buffer): boolean {
    return this.push(chunk)
  }

  override _read(): void {
    this.socket.resume()
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.socket.write(chunk)
    callback()
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.socket.destroy()
    callback(error)
  }
}

/** One browser connection over its TCP socket, which the relay never decrypts. */
class SocketConnection implements BrowserConnection {
  readonly peer: PeerAssertion
  private readonly socket: Socket
  private readonly stop: (() => void)[] = []
  private destroyed = false

  /**
   * @param socket - the accepted connection, paused and positioned after its ClientHello.
   */
  constructor(socket: Socket) {
    this.socket = socket
    this.peer = peerAssertion({ address: socket.remoteAddress, port: socket.remotePort })
    socket.on('error', () => {
      // A browser that resets its connection has closed it; the close listener ends the stream.
      this.destroy()
    })
  }

  send(bytes: Uint8Array): boolean {
    if (this.destroyed) return false
    return this.socket.write(bytes)
  }

  onDrain(listener: () => void): () => void {
    this.socket.on('drain', listener)
    return () => {
      this.socket.off('drain', listener)
    }
  }

  pause(): void {
    this.socket.pause()
  }

  resume(): void {
    if (!this.destroyed) this.socket.resume()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const stop of this.stop) stop()
    this.stop.length = 0
    this.socket.destroy()
  }

  onData(listener: (bytes: Uint8Array) => void): () => void {
    const handler = (chunk: Buffer): void => {
      listener(new Uint8Array(chunk))
    }
    this.socket.on('data', handler)
    // The ClientHello reader paused the socket; the stream now forwards what arrives.
    this.socket.resume()
    const stop = (): void => {
      this.socket.off('data', handler)
    }
    this.stop.push(stop)
    return stop
  }

  onClose(listener: () => void): () => void {
    const handler = (): void => {
      listener()
    }
    this.socket.on('close', handler)
    const stop = (): void => {
      this.socket.off('close', handler)
    }
    this.stop.push(stop)
    return stop
  }
}

/** One tunnel over its WebSocket. */
class SocketTunnel implements TunnelSocket {
  private readonly socket: WebSocket
  private readonly text = new Set<(message: string) => void>()
  private readonly binary = new Set<(bytes: Uint8Array) => void>()

  /**
   * @param socket - the upgraded WebSocket.
   */
  constructor(socket: WebSocket) {
    this.socket = socket
    socket.on('message', (data: RawData, isBinary: boolean) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
      if (isBinary) {
        for (const listener of this.binary) listener(new Uint8Array(bytes))
      } else {
        for (const listener of this.text) listener(bytes.toString('utf8'))
      }
    })
    socket.on('error', () => {
      // A tunnel that resets its connection closes; its close listener ends it and its streams.
      socket.terminate()
    })
  }

  sendText(message: string): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(message)
  }

  sendBinary(bytes: Uint8Array): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(bytes, { binary: true })
  }

  close(code: number, reason: string): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.close(code, reason)
  }

  ping(): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.ping()
  }

  onText(listener: (message: string) => void): () => void {
    this.text.add(listener)
    return () => {
      this.text.delete(listener)
    }
  }

  onBinary(listener: (bytes: Uint8Array) => void): () => void {
    this.binary.add(listener)
    return () => {
      this.binary.delete(listener)
    }
  }

  onClose(listener: () => void): () => void {
    this.socket.on('close', listener)
    return () => {
      this.socket.off('close', listener)
    }
  }

  onPong(listener: () => void): () => void {
    // The home's answer to the relay's ping is something received: without this listener an idle
    // but healthy tunnel would close on C6's 45-second silence limit.
    this.socket.on('pong', listener)
    return () => {
      this.socket.off('pong', listener)
    }
  }
}

/** The WebSocket subprotocol the upgrade asked for, when it asked for C6's. */
function subprotocolOf(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header.join(',') : header ?? ''
  return value.split(',').map(part => part.trim()).find(part => part === RELAY_SUBPROTOCOL)
}

/** Answer one HTTP request on the tunnel host. */
async function answerHttp(core: RelayCore, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = (request.url ?? '/').split('?')[0] ?? '/'
  if (path !== RELAY_PATHS.tunnelToken) {
    respond(response, 404, { error: 'NOT_FOUND' })
    return
  }
  if (request.method !== 'POST') {
    respond(response, 405, { error: 'METHOD_NOT_ALLOWED' })
    return
  }
  const body = await readBody(request)
  if (body === undefined) {
    respond(response, 413, { error: 'TOKEN_REQUEST_INVALID', detail: 'the request body is above 16,384 bytes' })
    return
  }
  try {
    const { token } = core.tokenRequest(body)
    respond(response, 200, { token })
  } catch (error: unknown) {
    const refusal = tokenRefusal(error)
    if (refusal === undefined) throw error
    respond(response, refusal.status, refusal.detail === undefined ? { error: refusal.code } : { error: refusal.code, detail: refusal.detail })
  }
}

/** Read a request body, or `undefined` when it is above C6's token request limit. */
function readBody(request: IncomingMessage): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    request.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > REQUEST_MAX_BYTES) {
        over = true
        chunks.length = 0
        request.resume()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      resolve(over ? undefined : new Uint8Array(Buffer.concat(chunks)))
    })
    request.on('error', error => {
      reject(new RelayError('CONFIG_UNREADABLE', `a request body could not be read: ${error.message}`))
    })
  })
}

/** Write one JSON response. */
function respond(response: ServerResponse, status: number, body: object): void {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) })
  response.end(text)
}

/** Refuse an upgrade on its raw socket, before any WebSocket exists. */
function refuseUpgrade(socket: import('node:stream').Duplex, status: number, body: object): void {
  const text = JSON.stringify(body)
  socket.write(`HTTP/1.1 ${String(status)} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Bad Request'}\r\ncontent-type: application/json\r\ncontent-length: ${String(Buffer.byteLength(text))}\r\nconnection: close\r\n\r\n${text}`)
  socket.destroy()
}

/**
 * Read one connection's ClientHello: its SNI name and the bytes read so far.
 * @param socket - the accepted connection, paused by the reader's end.
 * @param timeoutMs - C6's 10-second ClientHello limit.
 * @returns the name and bytes, or `undefined` when the connection sent no usable hello.
 */
function readHello(socket: Socket, timeoutMs: number): Promise<{ readonly sni: string; readonly hello: Uint8Array } | undefined> {
  return new Promise(resolve => {
    const reader = new ClientHelloReader()
    let settled = false
    const timer = setTimeout(() => {
      finish(undefined)
    }, timeoutMs)
    timer.unref()
    const finish = (value: { readonly sni: string; readonly hello: Uint8Array } | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('close', onClose)
      socket.off('error', onClose)
      socket.pause()
      resolve(value)
    }
    const onData = (chunk: Buffer): void => {
      try {
        const read = reader.push(new Uint8Array(chunk))
        if (read.done) finish(read.sni === undefined ? undefined : { sni: read.sni, hello: reader.received })
      } catch (_error: unknown) {
        // C6 closes a connection whose ClientHello is malformed, oversized or late without a
        // response, so the reader's refusal ends the connection here.
        finish(undefined)
      }
    }
    const onClose = (): void => {
      finish(undefined)
    }
    socket.on('data', onData)
    socket.on('close', onClose)
    socket.on('error', onClose)
  })
}

/**
 * Start the relay: one TCP listener, C6's tunnel host on it and every bound name routed to the
 * home that registered it.
 * @param options - the configuration, the log, the port and the interface.
 * @returns the running relay.
 * @throws RelayError `CONFIG_UNREADABLE` when the tunnel host's certificate or key cannot be read.
 */
export async function startRelayServer(options: RelayServerOptions): Promise<RelayServer> {
  const log = options.log ?? silentRelayLog
  const core = new RelayCore({ settings: options.settings, log })
  const secureContext = (() => {
    try {
      return createSecureContext({ cert: readFileSync(options.settings.tunnelCertFile), key: readFileSync(options.settings.tunnelKeyFile) })
    } catch (error: unknown) {
      throw new RelayError('CONFIG_UNREADABLE', `the tunnel host's certificate and key cannot be read: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
  })()
  const sockets = new Set<Socket>()
  const websockets = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MESSAGE_MAX_BYTES,
    handleProtocols: protocols => (protocols.has(RELAY_SUBPROTOCOL) ? RELAY_SUBPROTOCOL : false),
  })
  const http = createHttpServer((request, response) => {
    void answerHttp(core, request, response).catch((error: unknown) => {
      log.error('the token endpoint failed', { error: error instanceof Error ? error.message : 'unknown' })
      respond(response, 500, { error: 'INTERNAL' })
    })
  })
  http.on('upgrade', (request, socket, head) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/'
    if (path !== RELAY_PATHS.tunnel) {
      refuseUpgrade(socket, 404, { error: 'NOT_FOUND' })
      return
    }
    const peer = socket instanceof Socket ? peerAssertion({ address: socket.remoteAddress, port: socket.remotePort }) : peerAssertion({ address: undefined, port: undefined })
    const upgrade: TunnelUpgrade = {
      subprotocol: subprotocolOf(request.headers['sec-websocket-protocol']),
      authorization: request.headers.authorization,
      peer,
    }
    const authorization = core.authorizeTunnel(upgrade)
    if (!authorization.accepted) {
      refuseUpgrade(socket, authorization.status, authorization.detail === undefined ? { error: authorization.code } : { error: authorization.code, detail: authorization.detail })
      return
    }
    websockets.handleUpgrade(request, socket, head, ws => {
      core.startTunnel(authorization.claims, upgrade.peer, new SocketTunnel(ws))
    })
  })
  const server = createNetServer(socket => {
    sockets.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
    })
    socket.on('error', () => {
      socket.destroy()
    })
    void readHello(socket, RELAY_LIMITS.clientHelloTimeoutMs).then(hello => {
      if (hello === undefined) {
        socket.destroy()
        return
      }
      if (hello.sni === options.settings.tunnelHost) {
        // Only the tunnel host's handshake is terminated here, and with this relay's certificate;
        // a bound name's bytes go to its home untouched. The preface carries the bytes the reader
        // consumed and every later one, so the TLS layer sees the browser's own handshake.
        const preface = new Preface(socket)
        preface.feed(Buffer.from(hello.hello))
        socket.on('data', (chunk: Buffer) => {
          if (!preface.feed(chunk)) socket.pause()
        })
        const tls = new TLSSocket(preface, { isServer: true, secureContext })
        tls.on('error', () => {
          socket.destroy()
        })
        http.emit('connection', tls)
        socket.resume()
        return
      }
      if (!options.settings.bindings.has(hello.sni)) {
        log.info('browser connection dropped: no binding', { name: hello.sni, clientAddress: socket.remoteAddress ?? 'unknown' })
        socket.destroy()
        return
      }
      core.openBrowser(hello.sni, hello.hello, new SocketConnection(socket))
    })
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? RELAY_PORT, options.host ?? '0.0.0.0', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : options.port ?? RELAY_PORT)
    })
  })
  log.info('relay listening', { tunnelHost: options.settings.tunnelHost, port, relayId: options.settings.relayId })
  return {
    core,
    port,
    close: async () => {
      core.dispose()
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      websockets.close()
      await new Promise<void>(resolve => {
        http.close(() => {
          resolve()
        })
      })
      await new Promise<void>(resolve => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}
