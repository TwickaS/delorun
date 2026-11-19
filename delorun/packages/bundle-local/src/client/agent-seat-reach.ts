/**
 * The page's reach for a live agent's approvals. The computer's own page and an approved device's page show the granting
 * answers; on a device each one first takes a Face ID confirmation, or the PIN keypad on a device with no passkey, which
 * mints the answer grant the home requires (A483). A page that is neither gets no reach service, and its cards offer
 * Reject only. It is provided as `agentSeatReach` for `@delorun/plugin-agent-seats`.
 * @module @delorun/bundle-local/client/agent-seat-reach
 */
import type { Context } from '@deepseek-ai/cordis'
import type { FaceGrant } from '@delorun/plugin-changes/face-grant'

/** What the live-agent chat reads: the same shape as `SeatReachSource` in `@delorun/plugin-agent-seats/client`. */
type Reach = { readonly kind: 'computer' } | { readonly kind: 'unlocked-phone' } | { readonly kind: 'locked-phone' }

/** One granting answer of a seat's approval, as `SeatAnswerRequest` in `@delorun/plugin-agent-seats/client`. */
interface SeatAnswer {
  readonly sessionId: string
  readonly callId: string | undefined
  readonly grants: string
  readonly value: string
}

const COMPUTER: Reach = { kind: 'computer' }
const DEVICE: Reach = { kind: 'unlocked-phone' }

/** The grant action whose words the Face ID sheet shows for a seat's answer. */
export const SEAT_ANSWER_ACTION = 'plugin-agent-seats/answer'

/** The service the live-agent chat reads. */
export interface AgentSeatReachService {
  /** The current reach; the same object until the reach changes. */
  readonly get: () => Reach
  /** Listen for a change; returns the disposer. */
  readonly subscribe: (listener: () => void) => () => void
  /** Nothing to open: every page with a reach may answer. */
  readonly openUnlock: () => void
  /**
   * Confirm one granting answer before it is sent.
   * @param answer - the prompt and the answer's value.
   * @returns true when the answer may go: always on the computer; on a device once the answer grant is minted.
   */
  readonly confirm: (answer: SeatAnswer) => Promise<boolean>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** This page's reach for a live agent's approvals; absent on a page that is neither the computer nor an approved device. */
    agentSeatReach: AgentSeatReachService
  }
}

/**
 * Provide the service on the home's computer and on an approved device; on any other page provide nothing.
 * @param ctx - the browser plugin context.
 * @param place - where the page is.
 * @param grant - the page's queued Face ID confirmation.
 */
export function provideAgentSeatReach(ctx: Context, place: 'computer' | 'device' | 'none', grant: FaceGrant): void {
  if (place === 'none') return
  const reach = place === 'computer' ? COMPUTER : DEVICE
  ctx.provide('agentSeatReach', {
    get: () => reach,
    // The page's place never changes.
    subscribe: () => () => undefined,
    openUnlock: () => undefined,
    confirm: async ({ sessionId, callId, grants, value }) => {
      if (place === 'computer') return true
      // A prompt without a call id cannot be keyed; the answer goes without a grant and the home refuses it.
      if (callId === undefined) return true
      return await grant({ action: SEAT_ANSWER_ACTION, call: { answer: { agent: sessionId, callId, grants, value } } }) !== undefined
    },
  })
}
