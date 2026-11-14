/**
 * The page unlock's carriers on the connection (C4, "Page unlock"): the `Delo-Unlock` header on `/api` requests and the
 * `delo-unlock.<token>` WebSocket subprotocol on the `/api/remote.mux` upgrade, both read from the page's token holder
 * ({@link currentUnlockToken}) for every request and socket. A page with no token sends neither. When the token changes
 * or the page locks, the socket is replaced so its subprotocol matches the page's state.
 *
 * @module @delo/bundle-local/client/unlock-connection
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle, RequestExtras } from '@deepseek-ai/dsh-client-connection/client'
import { currentUnlockToken, onUnlockToken } from './page-unlock-token.ts'

/** The request header that carries the token. */
export const UNLOCK_HEADER = 'Delo-Unlock'

/** The protocol the page offers first, so the upgrade answer names one the browser accepts once the token is stripped. */
export const MUX_PROTOCOL = 'delo.mux'

/**
 * The extras for the token the page holds.
 * @param token - the token, or null while the page is locked.
 * @returns the header and subprotocols to add, none while locked.
 */
export function unlockExtras(token: string | null): RequestExtras {
  if (token === null) return {}
  return { headers: { [UNLOCK_HEADER]: token }, subprotocols: [MUX_PROTOCOL, `delo-unlock.${token}`] }
}

/**
 * Register the unlock's carriers with the connection, and replace the socket when the token changes.
 * @param ctx - the plugin context, whose `connection` service is read when present.
 */
export function applyUnlockConnection(ctx: Context): void {
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  if (connection === undefined) return
  ctx.effect(() => connection.registerRequestExtras(() => unlockExtras(currentUnlockToken())), 'delo-unlock: the page token on every request and socket')
  ctx.effect(() => onUnlockToken(() => { connection.reconnect() }), 'delo-unlock: a new token or a lock replaces the socket')
}
