/**
 * One tunnel of C6's handshake and frame loop: the challenge, the home key's proof over a fresh
 * nonce, the live check that refuses a second tunnel for a live name and announces it to that
 * tunnel, `ready`, then the binary frames the relay routes. The tunnel owns its streams, so a
 * stream id a home sends is resolved in that home's map alone; a frame for a stream the tunnel
 * never opened is a protocol error, and closing the tunnel ends every stream it owns at once.
 *
 * @module @delo/relay/tunnel
 */
import {
  RELAY_LIMITS,
  TUNNEL_CLOSE_CODES,
  TUNNEL_PROOF_LABEL,
  type Announcement,
  type AnnouncementKind,
  type Base64Url,
  type RelayId,
  type TunnelTokenClaims,
} from '@delo/contract-relay-protocol'
import type { KeyObject } from 'node:crypto'
import { RelayError, closeCodeOf } from './errors.ts'
import { encodeControl, parseFrame, type HomeControlMessage } from './frames.ts'
import { concatBytes, fromBase64Url, randomBase64Url, utf8, verifyBytes } from './keys.ts'
import type { RelayLog } from './log.ts'
import { Stream } from './stream.ts'
import type { BrowserConnection, TimerSeam, TunnelSocket } from './transport.ts'

/** The instant a `ready` message carries to the home: the limits this relay applies. */
export type ReadyLimits = typeof RELAY_LIMITS

/** The options of one tunnel. */
export interface TunnelOptions {
  /** The upgraded WebSocket. */
  readonly socket: TunnelSocket
  /** The verified token's claims. */
  readonly claims: TunnelTokenClaims
  /** The public key the token's name is bound to. */
  readonly homePublicKey: KeyObject
  /** The relay's id, which the challenge and the proof message name. */
  readonly relayId: RelayId
  /** The tunnel's id, base64url. */
  readonly tunnelId: string
  /** The clock, in milliseconds since the epoch. */
  readonly now: () => number
  /** The timers the handshake limit, the ping interval and the stall limit run on. */
  readonly timers: TimerSeam
  /** The relay's log. */
  readonly log: RelayLog
  /**
   * The tunnel already live for this name, whether or not its own handshake completed; the
   * tunnel refuses itself when this returns itself, so a caller returns the registry's entry.
   */
  readonly liveCheck: () => Tunnel | undefined
  /** Called when the tunnel becomes live, after `ready` was sent. */
  readonly onLive: (tunnel: Tunnel) => void
  /** Called once when the tunnel is no longer live, after its streams ended. */
  readonly onGone: (tunnel: Tunnel) => void
  /**
   * Called when this attempt found another tunnel live for the name, after the home was told and
   * before the socket closes; the caller announces the attempt to the live tunnel.
   */
  readonly onSecondTunnel: (live: Tunnel) => void
}

/** The phase a tunnel is in. */
type Phase = 'challenge' | 'live' | 'closed'

/**
 * The message the home's proof signs: the label, a zero byte, then the relay id, the name, the
 * token's id and the challenge nonce as their UTF-8 texts (C6, "Handshake").
 * @param parts - the relay id, the name, the token's id and the nonce.
 * @returns the signed bytes.
 */
export function proofMessage(parts: { readonly relayId: string; readonly name: string; readonly jti: string; readonly nonce: string }): Uint8Array {
  return concatBytes(utf8(TUNNEL_PROOF_LABEL), Uint8Array.of(0), utf8(parts.relayId), utf8(parts.name), utf8(parts.jti), utf8(parts.nonce))
}

/**
 * The home side of one tunnel. It starts after the relay verified the token, sends the
 * challenge, verifies the proof and then routes frames until the tunnel closes.
 */
export class Tunnel {
  /** The bound name this tunnel serves. */
  readonly name: string
  /** The tunnel's id. */
  readonly tunnelId: string
  private readonly options: TunnelOptions
  private readonly streams = new Map<number, Stream>()
  private phase: Phase = 'challenge'
  private nextStreamId = 1
  private nonce: string | undefined
  private lastReceivedAt: number
  private closeCode: number | undefined
  private readonly stop: (() => void)[] = []
  private handshakeTimer: (() => void) | undefined
  private pingTimer: (() => void) | undefined

  /**
   * @param options - the socket, the token's claims, the bound key, the clock, the timers and the
   *   callbacks the relay's registry supplies.
   */
  constructor(options: TunnelOptions) {
    this.options = options
    this.name = options.claims.name
    this.tunnelId = options.tunnelId
    this.lastReceivedAt = options.now()
  }

  /** Whether the handshake completed and the tunnel has not closed. */
  get live(): boolean {
    return this.phase === 'live'
  }

  /** The close code the relay sent, once it closed. */
  get closedWith(): number | undefined {
    return this.closeCode
  }

  /** The open streams, which no caller may extend directly. */
  get openStreams(): number {
    return this.streams.size
  }

  /**
   * Begin the handshake: listen for the home's text, binary and pong messages, send the challenge
   * and arm C6's 10-second limit.
   */
  start(): void {
    if (this.phase !== 'challenge') return
    this.stop.push(this.options.socket.onText(text => {
      this.onText(text)
    }))
    this.stop.push(this.options.socket.onBinary(bytes => {
      this.onBinary(bytes)
    }))
    this.stop.push(this.options.socket.onClose(() => {
      this.dispose(undefined)
    }))
    const stopPong = this.options.socket.onPong?.(() => {
      this.lastReceivedAt = this.options.now()
    })
    if (stopPong !== undefined) this.stop.push(stopPong)
    this.nonce = randomBase64Url(RELAY_LIMITS.challengeNonceBytes)
    this.options.socket.sendText(JSON.stringify({ type: 'challenge', relayId: this.options.relayId, nonce: this.nonce }))
    this.handshakeTimer = this.options.timers.after(RELAY_LIMITS.handshakeTimeoutMs, () => {
      this.fail(new RelayError('HANDSHAKE_TIMEOUT', 'the handshake did not complete within 10 seconds'))
    })
  }

  /**
   * Open one stream for a browser connection whose ClientHello named this tunnel's name.
   * @param browser - the browser connection.
   * @param clientHello - the bytes of the ClientHello that opened it.
   * @returns the stream, or `limit` when the home already has C6's 64 concurrent streams.
   */
  openStream(browser: BrowserConnection, clientHello: Uint8Array): Stream | 'limit' {
    if (this.phase !== 'live') return 'limit'
    if (this.streams.size >= RELAY_LIMITS.concurrentStreamsPerHome) return 'limit'
    const stream = new Stream({
      streamId: this.nextStreamId,
      name: this.name,
      peer: browser.peer,
      browser,
      send: frame => {
        this.send(frame)
      },
      log: this.options.log,
      onClosed: streamId => {
        this.streams.delete(streamId)
      },
    })
    this.nextStreamId += 1
    this.streams.set(stream.streamId, stream)
    stream.start(clientHello)
    return stream
  }

  /**
   * Send an announcement on the tunnel's stream 0.
   * @param kind - the announcement's kind.
   * @param clientAddress - the relay's unverified assertion about the connection it concerns.
   * @param jti - the refused token's id, for a refused second tunnel.
   */
  announce(kind: AnnouncementKind, clientAddress: string, jti?: Base64Url): void {
    if (this.phase !== 'live') return
    const message: Announcement = { type: 'announce', kind, at: this.options.now(), clientAddress, ...jti === undefined ? {} : { jti } }
    this.send(encodeControl(message))
  }

  /**
   * End the tunnel: every stream's browser connection is destroyed at once, the registry is told,
   * and, when the relay closes it, the socket is closed with C6's code.
   * @param code - the close code, or `undefined` when the home closed the socket.
   * @param reason - the close reason text.
   */
  dispose(code: number | undefined, reason = ''): void {
    if (this.phase === 'closed') return
    this.phase = 'closed'
    this.closeCode = code
    for (const stop of this.stop) stop()
    this.stop.length = 0
    this.handshakeTimer?.()
    this.pingTimer?.()
    this.handshakeTimer = undefined
    this.pingTimer = undefined
    const streams = [...this.streams.values()]
    this.streams.clear()
    for (const stream of streams) stream.teardown(undefined)
    this.options.onGone(this)
    if (code !== undefined) this.options.socket.close(code, reason)
  }

  /** The home's text messages, which are the handshake's proof and nothing else. */
  private onText(text: string): void {
    this.lastReceivedAt = this.options.now()
    if (this.phase !== 'challenge') {
      this.fail(new RelayError('PROTOCOL_ERROR', 'the tunnel sent a text message after its handshake'))
      return
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch (_error: unknown) {
      this.fail(new RelayError('PROTOCOL_ERROR', 'the proof is not JSON'))
      return
    }
    const proof = value as { readonly type?: unknown; readonly signature?: unknown }
    if (proof === null || typeof proof !== 'object' || proof.type !== 'proof' || typeof proof.signature !== 'string') {
      this.fail(new RelayError('PROTOCOL_ERROR', 'the handshake\'s answer is not a proof'))
      return
    }
    const nonce = this.nonce
    if (nonce === undefined) {
      this.fail(new RelayError('PROTOCOL_ERROR', 'the handshake has no nonce'))
      return
    }
    let signature: Uint8Array
    try {
      signature = fromBase64Url(proof.signature, 64)
    } catch (_error: unknown) {
      this.fail(new RelayError('PROOF_INVALID', 'the proof carries no 64-byte base64url signature'))
      return
    }
    const message = proofMessage({ relayId: this.options.relayId, name: this.name, jti: this.options.claims.jti, nonce })
    if (!verifyBytes(this.options.homePublicKey, message, signature)) {
      this.fail(new RelayError('PROOF_INVALID', 'the proof does not verify with the key bound to the name'))
      return
    }
    this.handshakeTimer?.()
    this.handshakeTimer = undefined
    this.ready()
  }

  /** Complete the handshake, or refuse the attempt because the name has a live tunnel. */
  private ready(): void {
    const live = this.options.liveCheck()
    if (live !== undefined && live !== this) {
      this.options.socket.sendText(JSON.stringify({ type: 'refused', code: 'TUNNEL_ALREADY_LIVE' }))
      this.options.onSecondTunnel(live)
      this.dispose(TUNNEL_CLOSE_CODES.TUNNEL_ALREADY_LIVE, 'TUNNEL_ALREADY_LIVE')
      return
    }
    this.phase = 'live'
    this.options.socket.sendText(JSON.stringify({ type: 'ready', tunnelId: this.tunnelId, limits: RELAY_LIMITS }))
    this.options.onLive(this)
    this.scheduleTick()
  }

  /** The home's binary messages, which are frames after the handshake. */
  private onBinary(bytes: Uint8Array): void {
    this.lastReceivedAt = this.options.now()
    if (this.phase !== 'live') {
      this.fail(new RelayError('PROTOCOL_ERROR', 'the tunnel sent a frame before its handshake completed'))
      return
    }
    let frame
    try {
      frame = parseFrame(bytes)
    } catch (error: unknown) {
      this.fail(error instanceof RelayError ? error : new RelayError('PROTOCOL_ERROR', 'the tunnel sent a frame that is not readable'))
      return
    }
    switch (frame.type) {
      case 'open':
        this.fail(new RelayError('PROTOCOL_ERROR', 'a home sends no OPEN frame'))
        return
      case 'data': {
        const stream = this.streams.get(frame.streamId)
        if (stream === undefined) {
          this.fail(new RelayError('PROTOCOL_ERROR', `the tunnel sent DATA for stream ${String(frame.streamId)}, which it never opened`))
          return
        }
        stream.forward(frame.payload)
        return
      }
      case 'credit': {
        const stream = this.streams.get(frame.streamId)
        if (stream === undefined) {
          this.fail(new RelayError('PROTOCOL_ERROR', `the tunnel sent CREDIT for stream ${String(frame.streamId)}, which it never opened`))
          return
        }
        stream.grant(frame.credit)
        return
      }
      case 'close': {
        const stream = this.streams.get(frame.streamId)
        if (stream === undefined) {
          this.fail(new RelayError('PROTOCOL_ERROR', `the tunnel sent CLOSE for stream ${String(frame.streamId)}, which it never opened`))
          return
        }
        stream.remoteClose(frame.reason)
        return
      }
      case 'control': {
        const message: HomeControlMessage | Announcement = frame.message
        if (message.type === 'announce') {
          this.fail(new RelayError('PROTOCOL_ERROR', 'a home sends no announcement'))
          return
        }
        return
      }
      default:
        this.fail(new RelayError('PROTOCOL_ERROR', 'the tunnel sent a frame the protocol does not define'))
    }
  }

  /** Send one frame, and end the tunnel if its socket refuses it. */
  private send(frame: Uint8Array): void {
    if (this.phase === 'closed') return
    this.options.socket.sendBinary(frame)
  }

  /** Ping the home and enforce C6's stall limit, then schedule the next tick. */
  private scheduleTick(): void {
    this.pingTimer = this.options.timers.after(RELAY_LIMITS.pingIntervalMs, () => {
      if (this.phase !== 'live') return
      if (this.options.now() - this.lastReceivedAt >= RELAY_LIMITS.silenceLimitMs) {
        this.fail(new RelayError('PROTOCOL_ERROR', 'the relay received nothing from the tunnel for 45 seconds'))
        return
      }
      this.options.socket.ping?.()
      this.scheduleTick()
    })
  }

  /** Close the tunnel with the refusal's code and end it. */
  private fail(error: RelayError): void {
    if (this.phase === 'closed') return
    this.options.log.warn('tunnel refused', { name: this.name, code: error.code, ...error.detail === undefined ? {} : { detail: error.detail } })
    this.dispose(closeCodeOf(error.code) ?? TUNNEL_CLOSE_CODES.PROTOCOL_ERROR, error.code)
  }
}
