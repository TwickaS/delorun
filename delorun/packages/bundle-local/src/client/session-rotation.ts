/**
 * Sign a reach page in again after the home rotated or ended its session. C4 rotates every session of the home when a
 * device is approved or removed, a passkey is enrolled or a reach option changes, and closes each rotated session's
 * connection; the page's reconnection is then refused for good. Each time the page loses its connection, one `HEAD /`
 * asks whether the session still admits it; admission answers `401` only for C4's signed-out codes
 * (`ROTATION_REQUIRED`, `NOT_SIGNED_IN`, `SESSION_EXPIRED`), and on that answer the page reloads. The home sends the
 * reload to its sign-in page, where the device signs a fresh challenge with its key and returns to the same address,
 * without asking the person anything. Any other answer, or a failed probe, leaves the page reconnecting as before.
 *
 * @module @delorun/bundle-local/client/session-rotation
 */
import type { ConnectionStateSource } from '@deepseek-ai/dsh-client-connection/client'

/** The status C4's admission answers a rotated, signed-out or expired reach session with. */
const SIGNED_OUT_STATUS = 401

/**
 * Watch a reach page's connection and reload it once its session no longer admits it.
 * @param state - the page's connection state.
 * @param probe - sends `HEAD /` and resolves with its status.
 * @param reload - reloads the page.
 * @returns a stop function.
 */
export function watchSessionRotation(state: ConnectionStateSource, probe: () => Promise<number>, reload: () => void): () => void {
  let asking = false
  let stopped = false
  const check = (): void => {
    const now = state.getSnapshot()
    if (now === undefined || now === 'connected' || asking) return
    asking = true
    probe().then((status) => {
      if (!stopped && status === SIGNED_OUT_STATUS) reload()
    }, (_offline: unknown) => {
      // A probe that cannot reach the home says nothing about the session; the next drop asks again.
    }).finally(() => { asking = false })
  }
  const unsubscribe = state.subscribe(check)
  return () => {
    stopped = true
    unsubscribe()
  }
}
