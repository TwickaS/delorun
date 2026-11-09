/**
 * The transports the data plane needs, as the narrow interfaces it uses: one browser
 * connection's encrypted bytes, one tunnel's WebSocket messages, and the timer seam the
 * handshake and stall limits run on. The Node adapters implement them; specs implement them in
 * memory, so every refusal is reachable without a socket, a name or a network.
 *
 * @module @delo/relay/transport
 */
import type { PeerAssertion } from './peer.ts'

/**
 * One browser connection after the relay has read its ClientHello. The relay writes the
 * connection's bytes to the home and the home's bytes back; it never reads them as anything
 * but a byte string.
 */
export interface BrowserConnection {
  /** The peer facts the relay asserts for this connection; never verified. */
  readonly peer: PeerAssertion
  /**
   * Write bytes to the browser.
   * @param bytes - the bytes.
   * @returns true when the transport accepted them without backpressure, false when it will
   *   call the `drain` listener once its buffer has room again.
   */
  send(bytes: Uint8Array): boolean
  /**
   * Register the listener for the transport's buffer having room again.
   * @param listener - the listener.
   * @returns the unsubscribe.
   */
  onDrain(listener: () => void): () => void
  /** Stop reading from the browser, so its bytes stay in the transport's buffer. */
  pause(): void
  /** Read from the browser again. */
  resume(): void
  /** Close the browser connection; later writes are dropped and no listener fires. */
  destroy(): void
  /**
   * Register the listener for the browser's bytes.
   * @param listener - the listener.
   * @returns the unsubscribe.
   */
  onData(listener: (bytes: Uint8Array) => void): () => void
  /**
   * Register the listener for the browser's close.
   * @param listener - the listener.
   * @returns the unsubscribe.
   */
  onClose(listener: () => void): () => void
}

/** One tunnel's WebSocket. The relay sends the handshake as text and everything else as binary. */
export interface TunnelSocket {
  /**
   * Send one text message.
   * @param text - the message.
   */
  sendText(text: string): void
  /**
   * Send one binary message.
   * @param bytes - the message.
   */
  sendBinary(bytes: Uint8Array): void
  /**
   * Close the tunnel.
   * @param code - the close code.
   * @param reason - the reason text.
   */
  close(code: number, reason: string): void
  /**
   * Register the listener for the home's text messages.
   * @param listener - the listener.
   * @returns the unsubscribe.
   */
  onText(listener: (text: string) => void): () => void
  /**
   * Register the listener for the home's binary messages.
   * @param listener - the listener.
   * @returns the unsubscribe.
   */
  onBinary(listener: (bytes: Uint8Array) => void): () => void
  /**
   * Register the listener for the tunnel's close, whoever closed it.
   * @param listener - the listener.
   * @returns the unsubscribe.
   */
  onClose(listener: () => void): () => void
  /** Send a WebSocket ping, when the transport supports one. */
  ping?(): void
  /**
   * Register the listener for a WebSocket pong, when the transport reports one. A pong counts as
   * something received, so a tunnel whose home answers every ping stays out of C6's silence limit.
   * @param listener - the listener.
   * @returns the unsubscribe.
   */
  onPong?(listener: () => void): () => void
}

/** The timer seam the handshake limit, the ping interval and the stall limit run on. */
export interface TimerSeam {
  /**
   * Run a callback after a delay.
   * @param ms - the delay in milliseconds.
   * @param run - the callback.
   * @returns the cancel.
   */
  after(ms: number, run: () => void): () => void
}

/** The process's timers, unref'd so a timer never holds the relay process open by itself. */
export const systemTimers: TimerSeam = {
  after: (ms, run) => {
    const timer = setTimeout(run, ms)
    timer.unref()
    return () => {
      clearTimeout(timer)
    }
  },
}
