/**
 * A fixture home for the relay's end-to-end spec: it connects to the relay over its real
 * WebSocket path, completes C6's handshake with its own home key, and then terminates the
 * browser connections' TLS itself with its own certificate. It is the only holder of that
 * certificate's key, so a browser that completes a handshake proves the relay passed encrypted
 * bytes it could not read.
 */
import { readFileSync } from 'node:fs'
import { createSecureContext, TLSSocket } from 'node:tls'
import { Duplex } from 'node:stream'
import { RELAY_SUBPROTOCOL, type OpenPayload, type TunnelTokenClaims } from '@delorun/contract-relay-protocol'
import { WebSocket, type ClientOptions } from 'ws'
import type { KeyObject } from 'node:crypto'
import { encodeClose, encodeControl, encodeCredit, encodeData, parseFrame } from '../../src/frames.ts'
import { signBytes, toBase64Url, utf8 } from '../../src/keys.ts'
import { proofMessage } from '../../src/tunnel.ts'

/** One browser connection the home serves. */
export interface HomeStream {
  readonly id: number
  readonly tls: TLSSocket
  readonly duplex: TunnelDuplex
  /** The `OPEN` payload the relay sent. */
  readonly open: OpenPayload
  /** Bytes the home received from the browser, decrypted. */
  readonly received: Buffer[]
}

/** A duplex whose reads come from the tunnel's `DATA` frames and whose writes become frames. */
export class TunnelDuplex extends Duplex {
  private readonly send: (bytes: Uint8Array) => void

  /**
   * @param send - sends one `DATA` frame for the bytes written.
   */
  constructor(send: (bytes: Uint8Array) => void) {
    super()
    this.send = send
  }

  /** Feed bytes the relay forwarded. */
  feed(bytes: Uint8Array): void {
    this.push(Buffer.from(bytes))
  }

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.send(new Uint8Array(chunk))
    callback()
  }
}

/** What the home's connection needs. */
export interface FixtureHomeOptions {
  /** The relay's tunnel URL, `wss://127.0.0.1:<port>/v1/tunnel`. */
  readonly url: string
  /** The relay's own name, which the TLS and SNI handshake uses. */
  readonly relayName: string
  /** The relay's self-signed certificate, which this client trusts. */
  readonly relayCertificate: string
  /** The name this home is bound to. */
  readonly name: string
  /** The home's private key. */
  readonly homeKey: KeyObject
  /** The tunnel token the relay issued. */
  readonly token: string
  /** The certificate chain the home presents for its own name. */
  readonly certificateFile: string
  /** The certificate's private key. */
  readonly keyFile: string
  /** The relay id the token claims. */
  readonly relayId: string
}

/**
 * A home that serves the browser connections the relay routes to it.
 */
export class FixtureHome {
  readonly streams = new Map<number, HomeStream>()
  /** The `OPEN` payloads, in the order the relay sent them. */
  readonly opens: OpenPayload[] = []
  /** The text messages the relay sent, parsed. */
  readonly messages: { readonly type?: string; readonly nonce?: string; readonly tunnelId?: string }[] = []
  private readonly socket: WebSocket
  private readonly context: ReturnType<typeof createSecureContext>
  private readonly homeKey: KeyObject
  private readonly relayId: string
  private readonly claims: TunnelTokenClaims
  private readonly sendCredits = new Map<number, number>()
  private nextStream: number | undefined

  private constructor(options: FixtureHomeOptions, socket: WebSocket) {
    this.socket = socket
    this.homeKey = options.homeKey
    this.relayId = options.relayId
    this.context = createSecureContext({ cert: readFileSync(options.certificateFile), key: readFileSync(options.keyFile) })
    this.claims = claimsOf(options.token)
  }

  /**
   * Open the tunnel and complete the handshake.
   * @param options - the relay's URL and certificate, the name, the home key and the token.
   * @returns the connected home, once the relay sent `ready`.
   */
  static connect(options: FixtureHomeOptions): Promise<FixtureHome> {
    const socket = new WebSocket(options.url, RELAY_SUBPROTOCOL, {
      headers: { authorization: `Delorun-Tunnel ${options.token}` },
      ca: options.relayCertificate,
      servername: options.relayName,
      rejectUnauthorized: true,
    } as ClientOptions)
    const home = new FixtureHome(options, socket)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('the fixture home reached no ready message'))
      }, 10_000)
      socket.on('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      socket.on('message', (data: unknown, isBinary: boolean) => {
        if (isBinary) {
          home.onFrame(new Uint8Array(data as Buffer))
          return
        }
        const message = JSON.parse(String(data)) as { readonly type?: string; readonly nonce?: string; readonly tunnelId?: string }
        home.messages.push(message)
        if (message.type === 'challenge' && message.nonce !== undefined) {
          const signature = toBase64Url(signBytes(home.homeKey, proofMessage({ relayId: home.relayId, name: home.claims.name, jti: home.claims.jti, nonce: message.nonce })))
          socket.send(JSON.stringify({ type: 'proof', signature }))
          return
        }
        if (message.type === 'ready') {
          clearTimeout(timer)
          resolve(home)
        }
      })
    })
  }

  /**
   * The stream the relay opened for a browser connection.
   * @param id - the stream id.
   * @returns the stream, or `undefined` before the relay opened it.
   */
  stream(id: number): HomeStream | undefined {
    return this.streams.get(id)
  }

  /** The bytes a stream received from the browser, decrypted by the home's TLS. */
  received(id: number): Buffer {
    return Buffer.concat(this.streams.get(id)?.received ?? [])
  }

  /** Close the tunnel, as a home that stops does. */
  close(): void {
    for (const stream of this.streams.values()) {
      stream.tls.destroy()
      stream.duplex.destroy()
    }
    this.streams.clear()
    this.socket.close()
  }

  /** Answer one frame from the relay. */
  private onFrame(bytes: Uint8Array): void {
    const frame = parseFrame(bytes)
    if (frame.type === 'control') return
    if (frame.type === 'open') {
      this.opens.push(frame.payload)
      this.openStream(frame.streamId, frame.payload)
      return
    }
    const stream = this.streams.get(frame.streamId)
    if (stream === undefined) return
    if (frame.type === 'data') {
      stream.duplex.feed(frame.payload)
      const credit = (this.sendCredits.get(frame.streamId) ?? 0) + frame.payload.byteLength
      if (credit >= 65_536) {
        this.send(encodeCredit(frame.streamId, credit))
        this.sendCredits.set(frame.streamId, 0)
      } else {
        this.sendCredits.set(frame.streamId, credit)
      }
      return
    }
    if (frame.type === 'close') {
      stream.tls.destroy()
      stream.duplex.destroy()
      this.streams.delete(frame.streamId)
    }
  }

  /** Open one stream and terminate the browser's TLS on it. */
  private openStream(id: number, open: OpenPayload): void {
    if (this.nextStream !== undefined && id !== this.nextStream) return
    this.nextStream = id + 1
    const duplex = new TunnelDuplex(bytes => {
      this.send(encodeData(id, bytes))
    })
    const tls = new TLSSocket(duplex, { isServer: true, secureContext: this.context })
    const stream: HomeStream = { id, tls, duplex, open, received: [] }
    this.streams.set(id, stream)
    tls.on('data', chunk => {
      stream.received.push(Buffer.from(chunk))
      tls.write(chunk)
    })
    tls.on('error', () => {
      this.send(encodeClose(id, 3))
      this.streams.delete(id)
    })
    tls.on('close', () => {
      this.streams.delete(id)
    })
  }

  /** Send one frame, if the tunnel is open. */
  private send(frame: Uint8Array): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(frame, { binary: true })
  }
}

/**
 * The claims of a token, as its holder reads them.
 * @param token - the token text.
 * @returns the claims.
 */
export function claimsOf(token: string): TunnelTokenClaims {
  return JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as TunnelTokenClaims
}

/**
 * The bytes of a control text message a home sends, for a fixture that acknowledges a ping.
 * @returns the `pong` frame.
 */
export function pong(): Uint8Array {
  return encodeControl({ type: 'pong' })
}

/** The UTF-8 bytes of a text, for a fixture that writes to its TLS socket. */
export function bytesOf(text: string): Uint8Array {
  return utf8(text)
}
