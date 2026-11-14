/**
 * Shared fixtures for the relay's specs: an in-memory configuration with generated Ed25519
 * home keys, a fake tunnel WebSocket and a fake browser connection, a clock and a timer seam a
 * spec advances by hand, a ClientHello builder, and a home that completes C6's handshake. Every
 * key is generated at run time, so no key material is committed and no two runs share one.
 */
import { RELAY_LIMITS, RELAY_PROTOCOL_VERSION, RELAY_SUBPROTOCOL, type Announcement, type TunnelTokenClaims } from '@delorun/contract-relay-protocol'
import { canonicalJson } from '@delorun/release-formats/sign/json'
import type { KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClientHelloReader } from '../src/client-hello.ts'
import { parseRelayConfig, type RelaySettings } from '../src/config.ts'
import { parseFrame, type Frame } from '../src/frames.ts'
import { generateEd25519, rawPublicKey, signBytes, toBase64Url, utf8 } from '../src/keys.ts'
import type { RelayLog } from '../src/log.ts'
import { peerAssertion, type PeerAssertion } from '../src/peer.ts'
import { RelayCore } from '../src/relay.ts'
import { proofMessage } from '../src/tunnel.ts'
import type { BrowserConnection, TimerSeam, TunnelSocket } from '../src/transport.ts'

/** One record a spec can read. */
export interface RecordedLogEntry {
  readonly level: 'error' | 'warn' | 'info' | 'debug'
  readonly msg: string
  readonly data: Readonly<Record<string, unknown>> | undefined
}

/** A log that keeps its records, for a spec to assert what the relay wrote. */
export class RecordingLog implements RelayLog {
  readonly entries: RecordedLogEntry[] = []
  readonly secrets: string[] = []

  error(msg: string, data?: Readonly<Record<string, unknown>>): void {
    this.entries.push({ level: 'error', msg, data })
  }

  warn(msg: string, data?: Readonly<Record<string, unknown>>): void {
    this.entries.push({ level: 'warn', msg, data })
  }

  info(msg: string, data?: Readonly<Record<string, unknown>>): void {
    this.entries.push({ level: 'info', msg, data })
  }

  debug(msg: string, data?: Readonly<Record<string, unknown>>): void {
    this.entries.push({ level: 'debug', msg, data })
  }

  secret(value: string): void {
    this.secrets.push(value)
  }

  /** The records whose message contains a text. */
  matching(text: string): RecordedLogEntry[] {
    return this.entries.filter(entry => entry.msg.includes(text))
  }
}

/** A clock and the timers a spec advances by hand. */
export class FakeTimers implements TimerSeam {
  private at = 0
  private readonly scheduled: { readonly due: number; readonly run: () => void; cancelled: boolean }[] = []

  /** The current instant, in milliseconds since the epoch. */
  get now(): number {
    return this.at
  }

  after(ms: number, run: () => void): () => void {
    const entry = { due: this.at + ms, run, cancelled: false }
    this.scheduled.push(entry)
    return () => {
      entry.cancelled = true
    }
  }

  /**
   * Advance the clock and run every timer that falls due, including one scheduled by a timer
   * that ran.
   * @param ms - the milliseconds to advance.
   */
  advance(ms: number): void {
    const target = this.at + ms
    for (;;) {
      const due = this.scheduled.filter(entry => !entry.cancelled && entry.due <= target).sort((left, right) => left.due - right.due)[0]
      if (due === undefined) break
      due.cancelled = true
      this.at = due.due
      due.run()
    }
    this.at = target
  }

  /** The delays of the timers still waiting, in order. */
  pending(): number[] {
    return this.scheduled.filter(entry => !entry.cancelled).map(entry => entry.due - this.at)
  }
}

/** One tunnel's WebSocket in memory. */
export class FakeTunnelSocket implements TunnelSocket {
  readonly texts: string[] = []
  readonly binaries: Uint8Array[] = []
  closeCode: number | undefined
  closeReason = ''
  pings = 0
  private closed = false
  private readonly textListeners = new Set<(text: string) => void>()
  private readonly binaryListeners = new Set<(bytes: Uint8Array) => void>()
  private readonly closeListeners = new Set<() => void>()
  private readonly pongListeners = new Set<() => void>()

  sendText(text: string): void {
    if (!this.closed) this.texts.push(text)
  }

  sendBinary(bytes: Uint8Array): void {
    if (!this.closed) this.binaries.push(bytes)
  }

  close(code: number, reason: string): void {
    if (this.closed) return
    this.closeCode = code
    this.closeReason = reason
    this.closed = true
    for (const listener of this.closeListeners) listener()
  }

  ping(): void {
    this.pings += 1
  }

  onText(listener: (text: string) => void): () => void {
    this.textListeners.add(listener)
    return () => {
      this.textListeners.delete(listener)
    }
  }

  onBinary(listener: (bytes: Uint8Array) => void): () => void {
    this.binaryListeners.add(listener)
    return () => {
      this.binaryListeners.delete(listener)
    }
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => {
      this.closeListeners.delete(listener)
    }
  }

  onPong(listener: () => void): () => void {
    this.pongListeners.add(listener)
    return () => {
      this.pongListeners.delete(listener)
    }
  }

  /**
   * Deliver a text message from the home.
   * @param text - the message.
   */
  deliverText(text: string): void {
    for (const listener of this.textListeners) listener(text)
  }

  /**
   * Deliver a binary message from the home.
   * @param bytes - the message.
   */
  deliverBinary(bytes: Uint8Array): void {
    for (const listener of this.binaryListeners) listener(bytes)
  }

  /** Deliver a WebSocket pong, as the home's WebSocket answers the relay's ping. */
  deliverPong(): void {
    for (const listener of this.pongListeners) listener()
  }

  /** Deliver the home's close, as its socket would. */
  remoteClose(): void {
    this.closed = true
    for (const listener of this.closeListeners) listener()
  }

  /** The binary messages parsed as frames. */
  frames(): Frame[] {
    return this.binaries.map(bytes => parseFrame(bytes))
  }

  /** The announcements the relay sent on stream 0. */
  announcements(): Announcement[] {
    return this.frames().flatMap(frame => (frame.type === 'control' && frame.message.type === 'announce' ? [frame.message] : []))
  }

  /** The last text message, parsed. */
  lastText(): { readonly type?: string; readonly code?: string; readonly relayId?: string; readonly nonce?: string; readonly tunnelId?: string } | undefined {
    const text = this.texts.at(-1)
    return text === undefined ? undefined : (JSON.parse(text) as { readonly type?: string })
  }
}

/** One browser connection in memory. */
export class FakeBrowser implements BrowserConnection {
  readonly peer: PeerAssertion
  readonly sent: Uint8Array[] = []
  pauses = 0
  resumes = 0
  destroyed = false
  /** What `send` answers: false models a transport whose buffer is full until `drain`. */
  writable = true
  private readonly dataListeners = new Set<(bytes: Uint8Array) => void>()
  private readonly closeListeners = new Set<() => void>()
  private readonly drainListeners = new Set<() => void>()

  /**
   * @param peer - the peer facts this connection reports.
   */
  constructor(peer: PeerAssertion = peerAssertion({ address: '203.0.113.7', port: 51_234 })) {
    this.peer = peer
  }

  send(bytes: Uint8Array): boolean {
    if (this.destroyed) return false
    this.sent.push(Uint8Array.from(bytes))
    return this.writable
  }

  onDrain(listener: () => void): () => void {
    this.drainListeners.add(listener)
    return () => {
      this.drainListeners.delete(listener)
    }
  }

  pause(): void {
    this.pauses += 1
  }

  resume(): void {
    this.resumes += 1
  }

  destroy(): void {
    this.destroyed = true
  }

  onData(listener: (bytes: Uint8Array) => void): () => void {
    this.dataListeners.add(listener)
    return () => {
      this.dataListeners.delete(listener)
    }
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => {
      this.closeListeners.delete(listener)
    }
  }

  /**
   * Deliver the bytes the browser sends.
   * @param bytes - the bytes.
   */
  deliver(bytes: Uint8Array): void {
    for (const listener of this.dataListeners) listener(bytes)
  }

  /** Deliver the browser's close. */
  close(): void {
    for (const listener of this.closeListeners) listener()
  }

  /** Report that the transport took the bytes it held. */
  drain(): void {
    for (const listener of this.drainListeners) listener()
  }

  /** Every byte the relay sent to the browser. */
  received(): Uint8Array {
    return Buffer.concat(this.sent.map(bytes => Buffer.from(bytes)))
  }
}

/** A temporary directory the spec removes. */
export interface TempDir {
  readonly dir: string
  remove(): void
}

/**
 * A new temporary directory.
 * @param prefix - its name's prefix.
 * @returns the directory and its removal.
 */
export function tempDir(prefix = 'delorun-relay-'): TempDir {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    remove: () => {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** The configuration text a fixture writes. */
export interface ConfigFixture {
  /** The bound names and the home key of each. */
  readonly bindings: readonly { readonly name: string; readonly homeKey: KeyObject }[]
  /** The relay's own name. */
  readonly tunnelHost?: string
  /** The state directory. */
  readonly stateDir: string
  /** The tunnel host's certificate file. */
  readonly tunnelCertFile?: string
  /** The tunnel host's private key file. */
  readonly tunnelKeyFile?: string
}

/**
 * The configuration text one fixture writes.
 * @param fixture - the bindings, the tunnel host and the state directory.
 * @returns the YAML text.
 */
export function configText(fixture: ConfigFixture): string {
  const lines = [
    `tunnelHost: ${fixture.tunnelHost ?? 'relay.example.test'}`,
    `tunnelCertFile: ${fixture.tunnelCertFile ?? '/etc/delorun-relay/tls-cert.pem'}`,
    `tunnelKeyFile: ${fixture.tunnelKeyFile ?? '/etc/delorun-relay/tls-key.pem'}`,
    `stateDir: ${fixture.stateDir}`,
    'bindings:',
    ...fixture.bindings.flatMap(binding => [`  - name: ${binding.name}`, `    homePublicKey: ${toBase64Url(rawPublicKey(binding.homeKey))}`]),
  ]
  return `${lines.join('\n')}\n`
}

/** A relay with its settings, core, log, clock and home keys. */
export interface RelayFixture {
  readonly settings: RelaySettings
  readonly core: RelayCore
  readonly log: RecordingLog
  readonly timers: FakeTimers
  readonly homes: ReadonlyMap<string, KeyObject>
  readonly tokenKey: KeyObject
  /** The clock, in milliseconds since the epoch. */
  now(): number
}

/**
 * Build a relay over a generated configuration: one Ed25519 home key per name and a fresh token
 * key.
 * @param options - the names, the tunnel host and the start instant.
 * @returns the fixture.
 */
export function makeRelay(options: { readonly names?: readonly string[]; readonly tunnelHost?: string; readonly startedAt?: number } = {}): RelayFixture {
  const names = options.names ?? ['studio.example.test']
  const homes = new Map<string, KeyObject>(names.map(name => [name, generateEd25519()]))
  const tokenKey = generateEd25519()
  const timers = new FakeTimers()
  if (options.startedAt !== undefined) timers.advance(options.startedAt)
  const settings = parseRelayConfig(
    configText({
      bindings: [...homes].map(([name, homeKey]) => ({ name, homeKey })),
      stateDir: '/var/lib/delorun-relay-test',
      ...options.tunnelHost === undefined ? {} : { tunnelHost: options.tunnelHost },
    }),
    { tokenKey, now: () => timers.now },
  )
  const log = new RecordingLog()
  const core = new RelayCore({ settings, log, now: () => timers.now, timers })
  return { settings, core, log, timers, homes, tokenKey, now: () => timers.now }
}

/**
 * A home-signed token request body.
 * @param homeKey - the home's private key.
 * @param name - the name the home claims.
 * @param timestamp - the request's instant.
 * @returns the body bytes.
 */
export function tokenRequestBody(homeKey: KeyObject, name: string, timestamp: number): Uint8Array {
  const homePublicKey = toBase64Url(rawPublicKey(homeKey))
  const signed = { name, homePublicKey, timestamp, v: RELAY_PROTOCOL_VERSION }
  const signature = toBase64Url(signBytes(homeKey, utf8(canonicalJson(signed))))
  return utf8(JSON.stringify({ ...signed, signature }))
}

/**
 * The claims of a token, as its holder reads them.
 * @param token - the token text.
 * @returns the claims.
 */
export function claimsOf(token: string): TunnelTokenClaims {
  const text = token.split('.')[0] ?? ''
  return JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as TunnelTokenClaims
}

/**
 * A token for one name, requested as its home.
 * @param fixture - the relay.
 * @param name - the name.
 * @returns the token.
 */
export function issueToken(fixture: RelayFixture, name: string): string {
  const homeKey = fixture.homes.get(name)
  if (homeKey === undefined) throw new Error(`the fixture binds no name ${name}`)
  return fixture.core.tokenRequest(tokenRequestBody(homeKey, name, fixture.now())).token
}

/** A home's connection after its upgrade attempt. */
export interface HomeConnection {
  readonly socket: FakeTunnelSocket
  readonly accepted: boolean
  readonly status: number | undefined
  readonly code: string | undefined
  readonly tunnelId: string | undefined
  /** Whether the handshake reached `ready`. */
  readonly ready: boolean
}

/**
 * Open a tunnel as a home does: present a token, answer the challenge with the home key's proof
 * and read `ready` or `refused`.
 * @param fixture - the relay.
 * @param options - the name, the token, an override of the subprotocol, authorization or peer.
 * @returns the connection.
 */
export function connectHome(
  fixture: RelayFixture,
  options: {
    readonly name: string
    readonly token?: string
    readonly subprotocol?: string | undefined
    readonly authorization?: string | undefined
    readonly peer?: PeerAssertion
    /** The key that signs the proof; the name's bound home key by default. */
    readonly proofKey?: KeyObject
    /** The nonce to answer, or `undefined` to answer none and leave the handshake open. */
    readonly answer?: 'proof' | 'none'
  },
): HomeConnection {
  const token = options.token ?? issueToken(fixture, options.name)
  const socket = new FakeTunnelSocket()
  const acceptance = fixture.core.acceptTunnel(
    {
      subprotocol: options.subprotocol === undefined ? RELAY_SUBPROTOCOL : options.subprotocol,
      authorization: options.authorization === undefined ? `Delorun-Tunnel ${token}` : options.authorization,
      peer: options.peer ?? peerAssertion({ address: '198.51.100.9', port: 44_000 }),
    },
    socket,
  )
  if (!acceptance.accepted) return { socket, accepted: false, status: acceptance.status, code: acceptance.code, tunnelId: undefined, ready: false }
  const challenge = socket.lastText()
  const nonce = challenge?.nonce
  if (nonce === undefined || options.answer === 'none') return { socket, accepted: true, status: undefined, code: undefined, tunnelId: acceptance.tunnelId, ready: false }
  const homeKey = options.proofKey ?? fixture.homes.get(options.name)
  if (homeKey === undefined) throw new Error(`the fixture binds no name ${options.name}`)
  const claims = claimsOf(token)
  const signature = toBase64Url(signBytes(homeKey, proofMessage({ relayId: fixture.settings.relayId, name: claims.name, jti: claims.jti, nonce })))
  socket.deliverText(JSON.stringify({ type: 'proof', signature }))
  return { socket, accepted: true, status: undefined, code: undefined, tunnelId: acceptance.tunnelId, ready: socket.lastText()?.type === 'ready' }
}

/** The bytes of one ClientHello, with the name a browser asks for. */
export interface HelloOptions {
  /** The `server_name` entry's host name; omitted leaves the extension out. */
  readonly sni?: string
  /** An ALPN protocol to offer, such as `acme-tls/1`. */
  readonly alpn?: string
}

/**
 * Build a minimal but well-formed TLS ClientHello.
 * @param options - the SNI name and an ALPN protocol.
 * @returns the record bytes.
 */
export function clientHello(options: HelloOptions): Uint8Array {
  const extensions: number[] = []
  if (options.sni !== undefined) {
    const name = [...Buffer.from(options.sni, 'utf8')]
    const entry = [0x00, (name.length >> 8) & 0xff, name.length & 0xff, ...name]
    const list = [(entry.length >> 8) & 0xff, entry.length & 0xff, ...entry]
    extensions.push(0x00, 0x00, (list.length >> 8) & 0xff, list.length & 0xff, ...list)
  }
  if (options.alpn !== undefined) {
    const protocol = [...Buffer.from(options.alpn, 'utf8')]
    const protocols = [protocol.length & 0xff, ...protocol]
    const data = [(protocols.length >> 8) & 0xff, protocols.length & 0xff, ...protocols]
    extensions.push(0x00, 0x10, (data.length >> 8) & 0xff, data.length & 0xff, ...data)
  }
  const body = [
    0x03, 0x03,
    ...new Array<number>(32).fill(0x5a),
    0x00,
    0x00, 0x04, 0x13, 0x01, 0x13, 0x02,
    0x01, 0x00,
    (extensions.length >> 8) & 0xff, extensions.length & 0xff, ...extensions,
  ]
  const handshake = [0x01, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff, ...body]
  return Uint8Array.from([0x16, 0x03, 0x01, (handshake.length >> 8) & 0xff, handshake.length & 0xff, ...handshake])
}

/**
 * Read one ClientHello through the relay's reader.
 * @param bytes - the record.
 * @returns the name the reader found.
 */
export function sniOf(bytes: Uint8Array): string | undefined {
  const reader = new ClientHelloReader()
  const read = reader.push(bytes)
  if (!read.done) throw new Error('the fixture ClientHello is incomplete')
  return read.sni
}

/** The limits a spec reads instead of repeating C6's numbers. */
export const LIMITS = RELAY_LIMITS
