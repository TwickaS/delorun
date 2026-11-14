/**
 * What both halves of the main chat plugin share. Browser-safe.
 *
 * @module @delorun/plugin-main-chat/wire
 */

/**
 * The main chat's Session id. It is fixed, so every page and every harness
 * start reach the same chat without storing its id.
 */
export const MAIN_CHAT_SESSION_ID = 'delorun-main-chat'

/** The harness's paths. The studio fetches each without its leading `/`, relative to the document. */
export const MAIN_CHAT_PATHS = {
  /** `POST`: create the main chat when it is missing; 204 once it exists. */
  open: '/api/delorunMainChat.open',
  /**
   * `GET`: {@link MainChatReportCount}, the reports waiting in the main chat's inbox. With `?after=<version>` the answer
   * waits, at most {@link REPORT_WAIT_MS}, until the count's version is above that one.
   */
  reports: '/api/delorunMainChat.reports',
} as const

/** How long `GET` {@link MAIN_CHAT_PATHS}.reports with `after` waits before it answers the count it has, kept below the idle timeouts of the proxies in front of a cell. */
export const REPORT_WAIT_MS = 25_000

/** The answer to `GET` {@link MAIN_CHAT_PATHS}.reports. */
export interface MainChatReportCount {
  /** Reports delivered to the main chat that it has not yet taken into a step. */
  readonly waiting: number
  /** Grows with every change of `waiting`; starts at 0 when the harness does. */
  readonly version: number
}
