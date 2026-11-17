/**
 * The two seams the chat's cards call out through, provided by the host studio as the optional client service
 * `agentSeatClient`. Without it the cards still show, and their buttons stay disabled.
 * @module
 */

/** Where an answer to a seat's approval can come from, as this page can tell. */
export type SeatReach =
  | { readonly kind: 'computer' }
  | { readonly kind: 'unlocked-phone'; readonly until: number }
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

/** What the studio supplies the chat's cards. */
export interface SeatClient {
  /** Ask a seat in a plan limit to go on (EA12); resolves when the Host accepted. */
  readonly resume: (sessionId: string) => Promise<void>
  /** Choose the model the plan offers for the workspace's seats (EA22); resolves when the Host accepted. */
  readonly chooseModel: (sessionId: string, modelId: string) => Promise<void>
  /** This page's reach for approvals. */
  readonly reach: SeatReachSource
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The studio's seat actions; optional. */
    agentSeatClient?: SeatClient
  }
}
