/**
 * The seams the chat's cards call out through: the page's reach for approvals, which the host studio provides as the
 * optional client service `agentSeatReach`, and the Host routes for Resume and the model choice, called by this
 * plugin's own client. Without a reach service the page counts as the computer.
 * @module
 */

/** Where an answer to a seat's approval can come from, as this page can tell. */
export type SeatReach =
  | { readonly kind: 'computer' }
  | { readonly kind: 'unlocked-phone'; readonly until?: number }
  | { readonly kind: 'locked-phone' }

/** A live read of {@link SeatReach}. */
export interface SeatReachSource {
  /** The current reach; the same object until the reach changes, as `useSyncExternalStore` needs. */
  readonly get: () => SeatReach
  /** Listen for a change; returns the disposer. */
  readonly subscribe: (listener: () => void) => () => void
  /** Open the page's existing PIN unlock. */
  readonly openUnlock: () => void
}

/** The service a studio that knows the page's unlock state provides as `agentSeatReach`, read with `ctx.get`; without it the page counts as the computer. */
export type SeatReachService = SeatReachSource

/** What the chat's cards call out through. */
export interface SeatClient {
  /** Ask a seat in a plan limit to go on (EA12); resolves when the Host accepted. */
  readonly resume: (sessionId: string) => Promise<void>
  /** Choose the model the plan offers for the workspace's seats (EA22); resolves when the Host accepted. */
  readonly chooseModel: (sessionId: string, modelId: string) => Promise<void>
}
