/**
 * Delo's egress proxy: an HTTP proxy on a Unix socket that lets a sandboxed command reach the hosts of one allowlist
 * and nothing else. The sandbox binds the socket into a command whose network is `allowlist`, and its bridge serves it
 * on the command's own loopback interface (`@deepseek-ai/dsh-sandbox-local`).
 *
 * Each request names its destination: `CONNECT host:port` for a tunnel, which carries HTTPS and anything else over
 * TCP, or an absolute `http://` URL for plain HTTP. The proxy checks the name against the allowlist before anything
 * else, so a name the list does not admit is never looked up and a command cannot send data out through DNS
 * questions. An admitted name is resolved here, every address it resolves to is classified by the fetch guard's
 * refusal matrix, and the request is refused when any address is loopback, private, link-local or another refused
 * range, even when the name is listed. The connection then goes to the first approved address that answers, never to
 * a second lookup's answer. Every refusal is answered `403` with a sentence naming the host and the reason, and
 * reported to the owner's log.
 *
 * Free of Cordis: the service that owns the proxies passes its log and the deployment's connect timeout.
 *
 * @module @delo/plugin-permission-defaults/egress-proxy
 */
import { lookup } from 'node:dns/promises'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect as netConnect, isIP, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { refusalOf, type FetchGuardRefusalCode } from '@delo/plugin-fetch-guard/guard'
import { hostAllowed, normalizeHostEntry } from './network.ts'

/** Why the proxy refused a request. */
export type EgressRefusalCode =
  /** The host is not on the allowlist; it was not looked up. */
  | 'not-listed'
  /** The listed host did not resolve. */
  | 'unresolved'
  /** The request did not name a destination the proxy serves. */
  | 'bad-request'
  /** The listed host resolved to an address the fetch guard's matrix refuses. */
  | FetchGuardRefusalCode

/** One refused request, as the owner's log reports it. */
export interface EgressRefusal {
  /** The host the request named, normalized, at most 255 characters. */
  readonly host: string
  /** The port the request named, or 0 when it named none. */
  readonly port: number
  readonly code: EgressRefusalCode
}

/** One resolved address of a listed host. */
export interface ResolvedAddress {
  readonly address: string
  readonly family: number
}

/** What one proxy serves and how it reports. */
export interface EgressProxyOptions {
  /** Absolute path of the Unix socket to listen on. */
  readonly socket: string
  /** The normalized allowlist entries. */
  readonly hosts: readonly string[]
  /** How long one connection to a listed host may take to open. */
  readonly connectTimeoutMs: number
  /**
   * Called once per refused request.
   * @param refusal - the refused host, port and reason.
   */
  readonly onRefusal: (refusal: EgressRefusal) => void
  /**
   * Resolve a listed host; `node:dns` answers every address by default.
   * @param host - the listed host name.
   * @returns its addresses.
   */
  readonly resolve?: (host: string) => Promise<readonly ResolvedAddress[]>
  /**
   * Open a TCP connection to an approved address; `node:net` by default. Specs pass a dialer that maps documentation
   * addresses to local servers, so no test reaches the internet.
   * @param address - the approved address.
   * @param port - the destination port.
   * @returns the connecting socket.
   */
  readonly dial?: (address: string, port: number) => Socket
}

/** The status and reason phrase of each refusal; every fetch guard code shares `address`. */
const REFUSALS: Record<'not-listed' | 'unresolved' | 'bad-request' | 'address', { readonly status: number; readonly phrase: string }> = {
  'not-listed': { status: 403, phrase: 'Host not on this workspace\'s network allowlist' },
  unresolved: { status: 502, phrase: 'Listed host did not resolve' },
  'bad-request': { status: 400, phrase: 'Not a proxy request' },
  address: { status: 403, phrase: 'Host resolves to a refused address' },
}

/**
 * The status and reason phrase of one refusal.
 * @param code - the refusal's code.
 * @returns its own entry, or the refused-address entry for a fetch guard code.
 */
function refusalKind(code: EgressRefusalCode): { readonly status: number; readonly phrase: string } {
  switch (code) {
    case 'not-listed':
    case 'unresolved':
    case 'bad-request':
      return REFUSALS[code]
    default:
      return REFUSALS.address
  }
}

/**
 * The sentence a refused command reads.
 * @param refusal - the refusal.
 * @returns the sentence.
 */
export function refusalSentence(refusal: EgressRefusal): string {
  const host = JSON.stringify(refusal.host)
  switch (refusal.code) {
    case 'not-listed':
      return `Delo's egress proxy refused ${host}: this workspace's network allows only the hosts on its allowlist. The person can add the host in Settings, Network, at the computer that runs Delo.`
    case 'unresolved':
      return `Delo's egress proxy could not resolve ${host}.`
    case 'bad-request':
      return 'Delo\'s egress proxy serves CONNECT host:port and absolute http:// requests only.'
    default:
      return `Delo's egress proxy refused ${host}: it resolves to a ${refusal.code} address, which the proxy never connects to, even for a listed host.`
  }
}

/** Header fields that describe one hop and never travel to the destination. */
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'upgrade'])

/**
 * Split an authority (`host:port`, `[v6]:port`) into its host and port.
 * @param authority - the CONNECT target.
 * @returns the normalized host and the port, or `undefined` when the authority names no valid port.
 */
export function parseAuthority(authority: string): { readonly host: string; readonly port: number } | undefined {
  const colon = authority.lastIndexOf(':')
  if (colon <= 0) return undefined
  const portText = authority.slice(colon + 1)
  const port = /^\d{1,5}$/u.test(portText) ? Number(portText) : 0
  if (port < 1 || port > 65_535) return undefined
  return { host: normalizeHostEntry(authority.slice(0, colon)), port }
}

/** Delo's egress proxy for one allowlist. */
export class EgressProxy {
  private readonly server: Server
  /** Open tunnels, ended when the proxy closes. */
  /** What the proxy serves and how it reports. */
  private readonly options: EgressProxyOptions
  private readonly tunnels = new Set<Duplex>()
  private readonly resolveHost: (host: string) => Promise<readonly ResolvedAddress[]>
  private readonly dial: (address: string, port: number) => Socket

  /**
   * @param options - what the proxy serves and how it reports.
   */
  constructor(options: EgressProxyOptions) {
    this.options = options
    this.resolveHost = options.resolve ?? (host => lookup(host, { all: true, verbatim: true }))
    this.dial = options.dial ?? ((address, port) => netConnect({ host: address, port }))
    this.server = createServer((request, response) => { void this.forward(request, response) })
    this.server.on('connect', (request: IncomingMessage, client: Duplex, head: Buffer) => { void this.tunnel(request, client, head) })
    this.server.on('clientError', (_error, client) => { client.destroy() })
  }

  /**
   * Listen on the socket.
   * @returns when the proxy accepts connections.
   * @throws the listen error, such as `EADDRINUSE`.
   */
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.options.socket, () => {
        this.server.off('error', reject)
        resolve()
      })
    })
  }

  /**
   * Stop listening and end every open request and tunnel, so a command loses the network this list gave it.
   * @returns when the socket is closed.
   */
  close(): Promise<void> {
    for (const tunnel of this.tunnels) tunnel.destroy()
    this.tunnels.clear()
    return new Promise((resolve) => {
      this.server.close(() => { resolve() })
      this.server.closeAllConnections()
    })
  }

  /**
   * Decide one destination: the allowlist first, then the addresses it resolves to.
   * @param host - the normalized host.
   * @param port - the port.
   * @returns the approved addresses, or the refusal.
   */
  private async admit(host: string, port: number): Promise<{ readonly addresses: readonly ResolvedAddress[] } | { readonly refusal: EgressRefusal }> {
    const named = { host: host.slice(0, 255), port }
    if (!hostAllowed(this.options.hosts, host)) return { refusal: { ...named, code: 'not-listed' } }
    let addresses: readonly ResolvedAddress[]
    if (isIP(host) !== 0) {
      addresses = [{ address: host, family: isIP(host) }]
    } else {
      try {
        addresses = await this.resolveHost(host)
      } catch (_unresolved) {
        // The resolver's message names the host the refusal already names.
        return { refusal: { ...named, code: 'unresolved' } }
      }
    }
    const code = refusalOf(addresses.map(entry => entry.address))
    return code === undefined ? { addresses } : { refusal: { ...named, code } }
  }

  /**
   * Open a connection to the first approved address that answers within the timeout.
   * @param addresses - the approved addresses, in the resolver's order.
   * @param port - the port.
   * @returns the connected socket, or `undefined` when none answered.
   */
  private async open(addresses: readonly ResolvedAddress[], port: number): Promise<Socket | undefined> {
    for (const { address } of addresses) {
      const socket = this.dial(address, port)
      const connected = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { socket.destroy(); resolve(false) }, this.options.connectTimeoutMs)
        socket.once('connect', () => { clearTimeout(timer); resolve(true) })
        socket.once('error', () => { clearTimeout(timer); resolve(false) })
      })
      if (connected) return socket
      socket.destroy()
    }
    return undefined
  }

  /**
   * Report a refusal and answer it on a raw connection.
   * @param client - the client's connection.
   * @param refusal - the refusal.
   */
  private refuseRaw(client: Duplex, refusal: EgressRefusal): void {
    this.options.onRefusal(refusal)
    const kind = refusalKind(refusal.code)
    const body = `${refusalSentence(refusal)}\n`
    client.end(`HTTP/1.1 ${kind.status} ${kind.phrase}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`)
  }

  /**
   * Answer one `CONNECT`: refuse it, or open the tunnel and copy both ways.
   * @param request - the CONNECT request.
   * @param client - the client's connection.
   * @param head - bytes the client sent after the request.
   */
  private async tunnel(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    this.tunnels.add(client)
    client.on('error', () => { client.destroy() })
    client.on('close', () => { this.tunnels.delete(client) })
    const target = parseAuthority(request.url ?? '')
    if (target === undefined) {
      this.refuseRaw(client, { host: (request.url ?? '').slice(0, 255), port: 0, code: 'bad-request' })
      return
    }
    const decision = await this.admit(target.host, target.port)
    if ('refusal' in decision) {
      this.refuseRaw(client, decision.refusal)
      return
    }
    const upstream = await this.open(decision.addresses, target.port)
    if (upstream === undefined || client.destroyed) {
      upstream?.destroy()
      client.end('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n')
      return
    }
    this.tunnels.add(upstream)
    upstream.on('close', () => { this.tunnels.delete(upstream); client.destroy() })
    upstream.on('error', () => { upstream.destroy() })
    client.on('close', () => { upstream.destroy() })
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length > 0) upstream.write(head)
    client.pipe(upstream)
    upstream.pipe(client)
  }

  /**
   * Answer one absolute-form `http://` request: refuse it, or send it to the approved address and copy the response.
   * @param request - the client's request.
   * @param response - the client's response.
   */
  private async forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let url: URL | undefined
    try {
      url = request.url !== undefined && /^http:\/\//iu.test(request.url) ? new URL(request.url) : undefined
    } catch (_invalid) {
      // An unparsable target is answered as a request the proxy does not serve.
      url = undefined
    }
    const refuse = (refusal: EgressRefusal): void => {
      this.options.onRefusal(refusal)
      const kind = refusalKind(refusal.code)
      response.writeHead(kind.status, kind.phrase, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
      response.end(`${refusalSentence(refusal)}\n`)
    }
    if (url === undefined) {
      refuse({ host: (request.url ?? '').slice(0, 255), port: 0, code: 'bad-request' })
      return
    }
    const host = normalizeHostEntry(url.hostname)
    const port = url.port === '' ? 80 : Number(url.port)
    const decision = await this.admit(host, port)
    if ('refusal' in decision) {
      refuse(decision.refusal)
      return
    }
    const socket = await this.open(decision.addresses, port)
    if (socket === undefined) {
      response.writeHead(502, { connection: 'close' })
      response.end()
      return
    }
    const outgoing = httpRequest({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: forwardedHeaders(request.headers),
      setHost: false,
      createConnection: () => socket,
    })
    outgoing.on('response', (upstream) => {
      response.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, forwardedHeaders(upstream.headers))
      upstream.pipe(response)
    })
    outgoing.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { connection: 'close' })
      response.end()
    })
    request.pipe(outgoing)
  }
}

/**
 * The header fields one hop passes on: every field but the hop-by-hop ones and the proxy's own.
 * @param headers - the received fields.
 * @returns the fields to send.
 */
function forwardedHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_HEADERS.has(name)))
}
