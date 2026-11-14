/**
 * The page unlock token of PIN mode (C14, "PIN mode"), held only in this page's memory so that a reload, a new tab or a
 * restored page starts locked. The lock screen sets it after `POST /auth/pin/unlock` and clears it on every lock; the
 * connection reads it for the `Delorun-Unlock` header and the `delorun-unlock.<token>` WebSocket subprotocol.
 *
 * Never write the token to storage, a cookie, a URL or a log.
 *
 * @module @delorun/bundle-local/client/page-unlock-token
 */

/** A listener told the new token, or null when the page locked. */
export type UnlockTokenListener = (token: string | null) => void

let current: string | null = null
const listeners = new Set<UnlockTokenListener>()

/**
 * The token this page unlocked with.
 * @returns the token, or null while the page is locked.
 */
export function currentUnlockToken(): string | null {
  return current
}

/**
 * Hold a new token, or drop it with null, and tell every listener.
 * @param token - the token `POST /auth/pin/unlock` returned, or null to lock the page.
 */
export function setUnlockToken(token: string | null): void {
  if (token === current) return
  current = token
  for (const listener of listeners) listener(token)
}

/**
 * Listen for the token changing.
 * @param listener - called with each new token, or null when the page locks.
 * @returns the disposer that stops listening.
 */
export function onUnlockToken(listener: UnlockTokenListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
