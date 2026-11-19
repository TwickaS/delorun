/**
 * The seams the chat's cards call out through: the page's reach for approvals, which the host studio provides as the
 * optional client service `agentSeatReach`, and the Host routes for Resume and the model choice, called by this
 * plugin's own client. Without a reach service the page cannot tell who answers, so a card offers Reject only.
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
  /**
   * Confirm one granting answer before the card sends it, such as with Face ID on a phone; absent means no step.
   * @param answer - the prompt and the answer's value.
   * @returns true to send the answer, false to keep the card answerable and send nothing.
   */
  readonly confirm?: (answer: SeatAnswerRequest) => Promise<boolean>
}

/** One granting answer of a seat's approval, as the card is about to send it. */
export interface SeatAnswerRequest {
  /** The chat whose prompt is answered. */
  readonly sessionId: string
  /** The prompt's call id; undefined when the prompt names none. */
  readonly callId: string | undefined
  /** The prompt's grants marker. */
  readonly grants: string
  /** The answer's value: `allowed-once` or `allowed-for-run`. */
  readonly value: string
}

/** The service a studio that knows the page's unlock state provides as `agentSeatReach`, read with `ctx.get`; without it a card offers Reject only. */
export type SeatReachService = SeatReachSource

/** What the chat's cards call out through. */
export interface SeatClient {
  /** Ask a seat in a plan limit to go on (EA12); resolves when the Host accepted. */
  readonly resume: (sessionId: string) => Promise<void>
  /** Choose the model the plan offers for the workspace's seats (EA22); resolves when the Host accepted. */
  readonly chooseModel: (sessionId: string, modelId: string) => Promise<void>
}
