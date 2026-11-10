/**
 * The hold on the default Workspace notice: while a distribution's first-run flow tells the person about a missing
 * default Workspace itself, the Workspace notice channel keeps that one notice back. With no holder registered every
 * notice shows at once, as before.
 * @module @deepseek-ai/dsh-client-ui-workspace/client/notice-hold
 */
import type { RowToast, RowToastState } from './contract/slots.ts'

/** How a holder ends its hold. */
export interface NoticeHoldOutcome {
  /** The holder told the person why there is no default Workspace, so the held notice is dropped instead of shown. */
  readonly told?: boolean
}

/** Ends one hold; a second call does nothing. */
export type NoticeHoldRelease = (outcome?: NoticeHoldOutcome) => void

/** The notice channel with the hold applied. */
export interface NoticeHold {
  /**
   * Show a notice, or keep the default Workspace notice back while a hold is registered.
   * @param toast - the notice.
   */
  notify(toast: RowToast): void
  /**
   * Keep the default Workspace notice back until the returned release runs. A notice already showing is withdrawn
   * and kept back too.
   * @returns the release; once the last hold ends, a kept notice shows unless a holder said it told the person.
   */
  hold(): NoticeHoldRelease
}

/**
 * Apply the hold to a notice channel.
 * @param show - shows one notice.
 * @param current - the notice showing now, if any.
 * @param withdraw - removes the notice showing now.
 * @returns the channel with the hold.
 */
export function createNoticeHold(show: (toast: RowToast) => void, current: () => RowToastState | null, withdraw: () => void): NoticeHold {
  const holds = new Set<symbol>()
  let kept: RowToast | undefined
  return {
    notify(toast) {
      if (toast.kind === 'defaultWorkspaceFailed' && holds.size > 0) {
        kept = toast
        return
      }
      show(toast)
    },
    hold() {
      const token = Symbol('default Workspace notice hold')
      holds.add(token)
      if (current()?.kind === 'defaultWorkspaceFailed') {
        kept = { kind: 'defaultWorkspaceFailed' }
        withdraw()
      }
      return (outcome) => {
        if (!holds.delete(token)) return
        if (outcome?.told === true) kept = undefined
        if (holds.size > 0 || kept === undefined) return
        const toast = kept
        kept = undefined
        show(toast)
      }
    },
  }
}
