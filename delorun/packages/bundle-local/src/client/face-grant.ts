/**
 * The store behind `ctx.delorunFaceGrant`: one pending confirmation at a time, shown by the overlay of
 * [`FaceIdGrantOverlay.tsx`](./FaceIdGrantOverlay.tsx). A second request while one shows ends the first as cancelled, and so
 * does cancelling the call it was asked for.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { FaceGrant, FaceGrantRequest } from '@delorun/plugin-changes/face-grant'

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

/**
 * The grant id a confirmation skipped under a live Face ID pass resolves with. It is no grant: the home admits the call
 * by the pass and ignores `Delorun-Grant`; if the pass ended in between, the home refuses the call as without a grant.
 */
export const PASS_GRANT_ID = 'pass'

/**
 * The proactive confirmation for callers that ask before they send (Changes, Update, a seat's answer): while this page's
 * Face ID pass covers the action it resolves with {@link PASS_GRANT_ID} and shows no sheet; otherwise it asks. A call the
 * home already refused goes through `grant` itself, never through this, since the refusal means the home holds no pass.
 * @param grant - the queued confirmation.
 * @param pass - the page's pass mirror.
 * @returns the confirmation.
 */
export function passAware(grant: FaceGrant, pass: { readonly covers: (action: string) => boolean }): FaceGrant {
  return request => (request.signal?.aborted !== true && pass.covers(request.action) ? Promise.resolve(PASS_GRANT_ID) : grant(request))
}
