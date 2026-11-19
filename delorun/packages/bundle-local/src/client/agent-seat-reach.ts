/**
 * The page's reach for a live agent's approvals. Only the computer's own page grants: a phone's PIN unlock no longer
 * stands in for a confirmation, and a seat's answer has no per-call grant yet, so a phone gets no reach service and its
 * cards offer Reject only. It is provided as `agentSeatReach` for `@delorun/plugin-agent-seats`.
 * @module @delorun/bundle-local/client/agent-seat-reach
 */
import type { Context } from '@deepseek-ai/cordis'

/** What the live-agent chat reads: the same shape as `SeatReachSource` in `@delorun/plugin-agent-seats/client`. */
type Reach = { readonly kind: 'computer' } | { readonly kind: 'unlocked-phone' } | { readonly kind: 'locked-phone' }

const COMPUTER: Reach = { kind: 'computer' }

/** The service the live-agent chat reads. */
export interface AgentSeatReachService {
  /** The current reach; the same object until the reach changes. */
  readonly get: () => Reach
  /** Listen for a change; returns the disposer. */
  readonly subscribe: (listener: () => void) => () => void
  /** Open what lets this page grant; nothing on the computer, which always may. */
  readonly openUnlock: () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** This page's reach for a live agent's approvals; absent on a phone. */
    agentSeatReach: AgentSeatReachService
  }
}

/**
 * Provide the service on the home's own computer; on a phone provide nothing.
 * @param ctx - the browser plugin context.
 * @param onComputer - whether the page is on the home's own computer.
 */
export function provideAgentSeatReach(ctx: Context, onComputer: boolean): void {
  if (!onComputer) return
  ctx.provide('agentSeatReach', {
    get: () => COMPUTER,
    // The computer's reach never changes.
    subscribe: () => () => undefined,
    openUnlock: () => undefined,
  })
}
