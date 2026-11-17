/**
 * Session events of a chat's grant to use the person's own browser, with their sign-ins, beside the default isolated
 * one. A browser provider that is not the default reads them to decide which Sessions it serves.
 * @module @deepseek-ai/dsh-experimental-browser-use-runtime/real-browser
 */

import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

/**
 * How a chat's real-browser grant was given: `approval` is the person's answer to the agent's ask, whose
 * `approval/asked` event sits at `askedSeq` in the same log.
 */
export type RealBrowserGrantSource = { readonly kind: 'approval'; readonly askedSeq: SessionSeq }

/** Why a chat's real-browser grant ended: the person turned it off. */
export type RealBrowserEndReason = 'person'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** The person allowed their own browser for the rest of this Session; it lasts until a `real-browser/ended`. */
    'real-browser/granted': { source: RealBrowserGrantSource }
    /**
     * Whether a run the person did not start, such as a scheduled one, may use the running grant: until the Unix
     * epoch milliseconds `until`, or no longer for `null`. A later one replaces it; `real-browser/ended` ends it.
     */
    'real-browser/away': { until: number | null }
    /** The Session's real-browser grant ended, its away permission with it; a later `real-browser/granted` starts a new one. */
    'real-browser/ended': { reason: RealBrowserEndReason }
  }
}
