/**
 * The store behind `ctx.delorunFaceGrant`: one pending confirmation at a time, shown by the overlay of
 * [`FaceIdGrantOverlay.tsx`](./FaceIdGrantOverlay.tsx). A second request while one shows ends the first as cancelled, and so
 * does cancelling the call it was asked for.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { PASS_GRANT_ID, type FaceGrant, type FaceGrantRequest } from '@delorun/plugin-changes/face-grant'

/** A confirmation that waits for the person. */
export interface PendingGrant {
  /** What the grant covers. */
  readonly request: FaceGrantRequest
}

/** The store and its actions. */
export interface FaceGrantSource {
  /** The pending confirmation for the overlay, or null while none waits. */
  readonly hooks: { readonly pending: HostObservable<PendingGrant | null> }
  /** The service function. */
  readonly grant: FaceGrant
  /**
   * End the pending confirmation.
   * @param grantId - the grant minted for it, or undefined when the person cancelled.
   */
  readonly settle: (grantId: string | undefined) => void
}

/**
 * Create the store.
 * @returns the store with the service function and its settle action.
 */
export function createFaceGrantSource(): FaceGrantSource {
  const store = createSnapshotStore<PendingGrant | null>(null)
  let resolve: ((grantId: string | undefined) => void) | undefined
  const settle = (grantId: string | undefined): void => {
    const done = resolve
    resolve = undefined
    store.set(null)
    done?.(grantId)
  }
  return {
    hooks: { pending: store },
    grant: (request) => {
      if (request.signal?.aborted === true) return Promise.resolve(undefined)
      settle(undefined)
      return new Promise<string | undefined>((done) => {
        const close = (): void => { if (resolve === finish) settle(undefined) }
        const finish = (grantId: string | undefined): void => {
          request.signal?.removeEventListener('abort', close)
          done(grantId)
        }
        resolve = finish
        store.set({ request })
        request.signal?.addEventListener('abort', close, { once: true })
      })
    },
    settle,
  }
}

/** The grant id a covered confirmation resolves with; see `PASS_GRANT_ID` in `@delorun/plugin-changes/face-grant`. */
export { PASS_GRANT_ID } from '@delorun/plugin-changes/face-grant'

/**
 * The proactive confirmation for callers that ask before they send (Changes, Update, a seat's answer): while this page's
 * Face ID pass covers the action (and, for an approval answer, `answer/<grants marker>`), it reads the pass from the home once more and, if it still covers it, resolves with
 * {@link PASS_GRANT_ID} and shows no sheet; otherwise it asks. A request the home refuses although it carried
 * {@link PASS_GRANT_ID} (the pass ended in between) is asked again with a sheet by `grantingFetch`.
 * @param grant - the queued confirmation.
 * @param pass - the page's pass mirror.
 * @returns the confirmation.
 */
export function passAware(grant: FaceGrant, pass: { readonly covers: (action: string) => boolean; readonly refresh: () => Promise<void> }): FaceGrant {
  return async (request) => {
    // An answer is also checked under its own action, `answer/<grants marker>`, so a seat's full-access answer asks.
    const answer = 'answer' in request.call ? `answer/${request.call.answer.grants}` : undefined
    const live = (): boolean => request.signal?.aborted !== true && pass.covers(request.action) && (answer === undefined || pass.covers(answer))
    if (live()) {
      await pass.refresh()
      if (live()) return PASS_GRANT_ID
    }
    return await grant(request)
  }
}
