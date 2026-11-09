/**
 * One browser connection's association with one stream of one tunnel: the relay sends the
 * stream's `OPEN` and the ClientHello, then forwards the connection's bytes as `DATA` frames and
 * the home's payloads back, applying C6's flow control. Each direction starts with 1 MiB of
 * credit; the relay sends no more than its credit allows, holds at most 1 MiB of the browser's
 * bytes waiting for credit, pauses the browser connection at that cap, and closes the stream
 * with reason 3 when a side sends beyond its credit. The association reads no byte of the
 * stream: a payload is a byte string it moves, never a value it interprets.
 *
 * @module @delo/relay/stream
 */
import { RELAY_LIMITS, STREAM_CLOSE_REASONS } from '@delo/contract-relay-protocol'
import { encodeClose, encodeCredit, encodeData, encodeOpen, type StreamCloseReason } from './frames.ts'
import type { RelayLog } from './log.ts'
import { openPayload, type PeerAssertion } from './peer.ts'
import type { BrowserConnection } from './transport.ts'

/** The options of one stream association. */
export interface StreamOptions {
  /** The stream id, assigned by the relay and never reused within a tunnel. */
  readonly streamId: number
  /** The name of the ClientHello that opened the stream, which is the tunnel's bound name. */
  readonly name: string
  /** The peer facts the relay asserts for the connection. */
  readonly peer: PeerAssertion
  /** The browser connection. */
  readonly browser: BrowserConnection
  /** Sends one frame on the tunnel that owns the stream. */
  readonly send: (frame: Uint8Array) => void
  /** The relay's log. */
  readonly log: RelayLog
  /** Removes the stream from its tunnel. */
  readonly onClosed: (streamId: number) => void
}

/**
 * Started at most once and closed at most once: `teardown` is idempotent, so a browser that
 * closes and a tunnel that closes produce one close frame and one removal.
 */
export class Stream {
  /** The stream id. */
  readonly streamId: number
  private readonly options: StreamOptions
  /** Bytes this relay may still send to the home: the credit the home granted. */
  private sendCredit: number = RELAY_LIMITS.streamBufferBytes
  /** Bytes the home may still send to this relay: the credit the relay granted. */
  private receiveCredit: number = RELAY_LIMITS.streamBufferBytes
  /** The browser's bytes the relay holds while it has no credit to send them. */
  private backlog: Uint8Array[] = []
  private backlogBytes = 0
  /** Bytes written to the browser that its transport has not taken yet. */
  private pendingCredit = 0
  private paused = false
  private closed = false
  private readonly stop: (() => void)[] = []

  /**
   * @param options - the stream's id, name, peer, browser, frame sender and close callback.
   */
  constructor(options: StreamOptions) {
    this.options = options
    this.streamId = options.streamId
  }

  /** Bytes the relay holds for this stream, waiting for the home's credit. */
  get bufferedBytes(): number {
    return this.backlogBytes
  }

  /**
   * Send the stream's `OPEN` frame and the ClientHello the relay already read, then forward the
   * browser's later bytes and its close.
   * @param clientHello - the bytes of the ClientHello that opened the stream.
   */
  start(clientHello: Uint8Array): void {
    if (this.closed) return
    this.options.send(encodeOpen(this.streamId, openPayload(this.options.name, this.options.peer)))
    this.receive(clientHello)
    if (this.closed) return
    this.stop.push(this.options.browser.onData(bytes => {
      this.receive(bytes)
    }))
    this.stop.push(this.options.browser.onClose(() => {
      this.teardown(STREAM_CLOSE_REASONS.normal)
    }))
    this.stop.push(this.options.browser.onDrain(() => {
      this.drained()
    }))
  }

  /**
   * Hold the bytes one read of the browser delivered and send what the home's credit allows.
   * @param bytes - the connection's encrypted bytes.
   */
  receive(bytes: Uint8Array): void {
    if (this.closed || bytes.byteLength === 0) return
    this.backlog.push(bytes)
    this.backlogBytes += bytes.byteLength
    if (this.backlogBytes > RELAY_LIMITS.streamBufferBytes) {
      this.fail(`the browser sent ${String(this.backlogBytes)} bytes while the relay held above its 1 MiB buffer`)
      return
    }
    this.flush()
  }

  /**
   * Take the credit the home granted, resume the browser and send the held bytes.
   * @param bytes - the bytes granted.
   */
  grant(bytes: number): void {
    if (this.closed || bytes === 0) return
    this.sendCredit = Math.min(this.sendCredit + bytes, RELAY_LIMITS.streamBufferBytes)
    this.reading(this.backlogBytes >= RELAY_LIMITS.streamBufferBytes)
    this.flush()
  }

  /**
   * Write one `DATA` payload the home sent to the browser.
   * @param payload - 1 to 65,536 bytes of the connection's encrypted bytes.
   */
  forward(payload: Uint8Array): void {
    if (this.closed) return
    if (payload.byteLength > this.receiveCredit) {
      this.fail('the home sent bytes beyond the credit the relay granted')
      return
    }
    this.receiveCredit -= payload.byteLength
    if (this.options.browser.send(payload)) this.credit(payload.byteLength)
    else this.pendingCredit += payload.byteLength
  }

  /**
   * Close the browser connection because the home closed the stream.
   * @param reason - the `CLOSE` frame's reason.
   */
  remoteClose(reason: StreamCloseReason): void {
    this.teardown(reason)
  }

  /**
   * End the stream: destroy the browser's connection, remove the stream from its tunnel and,
   * for a close this relay began or the browser caused, tell the home why.
   * @param reason - the reason for the home, or `undefined` when the tunnel is already gone.
   */
  teardown(reason: StreamCloseReason | undefined): void {
    if (this.closed) return
    this.closed = true
    for (const stop of this.stop) stop()
    this.stop.length = 0
    this.backlog = []
    this.backlogBytes = 0
    this.options.browser.destroy()
    if (reason !== undefined) {
      try {
        this.options.send(encodeClose(this.streamId, reason))
      } catch (_error: unknown) {
        // The tunnel's socket is gone, so the close frame has no receiver; the stream still ends.
      }
    }
    this.options.onClosed(this.streamId)
  }

  /** Send the held bytes while credit remains, and pause the browser when they are held back. */
  private flush(): void {
    while (!this.closed && this.backlogBytes > 0 && this.sendCredit > 0) {
      const head = this.backlog[0]
      if (head === undefined) return
      const size = Math.min(head.byteLength, this.sendCredit, RELAY_LIMITS.dataPayloadBytes)
      const chunk = head.subarray(0, size)
      this.options.send(encodeData(this.streamId, chunk))
      this.sendCredit -= size
      this.backlogBytes -= size
      if (size === head.byteLength) this.backlog.shift()
      else this.backlog[0] = head.subarray(size)
    }
    this.reading(this.backlogBytes >= RELAY_LIMITS.streamBufferBytes)
  }

  /** Pause or resume the browser connection. */
  private reading(pause: boolean): void {
    if (this.closed || pause === this.paused) return
    this.paused = pause
    if (pause) this.options.browser.pause()
    else this.options.browser.resume()
  }

  /** The browser's transport took the bytes it held, so the home may send more. */
  private drained(): void {
    if (this.closed || this.pendingCredit === 0) return
    const bytes = this.pendingCredit
    this.pendingCredit = 0
    this.credit(bytes)
  }

  /** Grant the home bytes the browser has taken. */
  private credit(bytes: number): void {
    this.receiveCredit = Math.min(this.receiveCredit + bytes, RELAY_LIMITS.streamBufferBytes)
    this.options.send(encodeCredit(this.streamId, bytes))
  }

  /** Close the stream with reason 3 and end it, because a side sent beyond its credit. */
  private fail(detail: string): void {
    if (this.closed) return
    this.options.log.warn('stream closed with reason 3', { stream: this.streamId, name: this.options.name, detail })
    this.teardown(STREAM_CLOSE_REASONS.protocolError)
  }
}
