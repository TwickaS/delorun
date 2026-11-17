/**
 * The studio's routes to a chat's real-browser grant and the messages they carry, free of Cordis and Node so the
 * browser imports them.
 * @module @delorun/browser-use-browse/wire
 */

/** The exact routes under `/api`. */
export const REAL_BROWSER_ROUTES = {
  /** `POST` {@link RealBrowserChatRequest}: the chat's grant, as {@link RealBrowserState}. Any approved device. */
  state: '/api/delorunRealBrowser.state',
  /** `POST` {@link RealBrowserChatRequest}: turn the chat's grant off, as {@link RealBrowserState}. Any approved device. */
  end: '/api/delorunRealBrowser.end',
  /**
   * `POST` {@link RealBrowserAwayRequest}: let runs the person did not start use the grant, or stop that, as
   * {@link RealBrowserState}. The computer or an unlocked device.
   */
  away: '/api/delorunRealBrowser.away',
} as const

/** The largest request body the routes read, in bytes. */
export const MAX_REAL_BROWSER_REQUEST_BYTES = 1024

/** A request naming one open chat. */
export interface RealBrowserChatRequest {
  readonly sessionId: string
}

/** A request to turn the away permission on, for the row's `awayDays`, or off. */
export interface RealBrowserAwayRequest extends RealBrowserChatRequest {
  readonly on: boolean
}

/** One chat's grant. */
export interface RealBrowserState {
  /** Whether the agent may use the person's own browser in this chat. */
  readonly live: boolean
  /** Until when, in Unix epoch milliseconds, runs the person did not start may use it; null for never. */
  readonly awayUntil: number | null
}

/** The codes a route refuses with. */
export type RealBrowserRefusalCode = 'INVALID_REQUEST' | 'UNKNOWN_CHAT' | 'NO_GRANT'
