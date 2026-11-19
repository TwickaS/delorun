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
      settle(undefined)
      if (request.signal?.aborted === true) return Promise.resolve(undefined)
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
