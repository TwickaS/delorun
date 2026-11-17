/**
 * The page's reach for a live agent's approvals, from the unlock state this plugin already holds. The computer's own
 * page may grant; a phone may grant only while its page holds a PIN unlock; a phone with a code unlock, or none, may
 * only reject (decision D1). It is provided as `agentSeatReach` for `@delorun/plugin-agent-seats`.
 * @module @delorun/bundle-local/client/agent-seat-reach
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PinSource } from './pin-lock.ts'
import type { UnlockSource } from './unlock.ts'

/** What the live-agent chat reads: the same shape as `SeatReachSource` in `@delorun/plugin-agent-seats/client`. */
type Reach = { readonly kind: 'computer' } | { readonly kind: 'unlocked-phone' } | { readonly kind: 'locked-phone' }

const COMPUTER: Reach = { kind: 'computer' }
const UNLOCKED: Reach = { kind: 'unlocked-phone' }
const LOCKED: Reach = { kind: 'locked-phone' }

/** The service, read by `@delorun/plugin-agent-seats` through `ctx.get('agentSeatReach')`. */
export interface AgentSeatReachService {
  /** The current reach; the same object until the reach changes. */
  readonly get: () => Reach
  /** Listen for a change; returns the disposer. */
  readonly subscribe: (listener: () => void) => () => void
  /** Open the page's PIN lock screen, or the unlock dialog where PIN mode is off. */
  readonly openUnlock: () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** This page's reach for a live agent's approvals. */
    agentSeatReach: AgentSeatReachService
  }
}

/**
 * Provide the service.
 * @param ctx - the browser plugin context.
 * @param pin - PIN mode's source.
 * @param unlock - the unlock source, whose dialog the Unlock to answer button opens.
 * @param onComputer - whether the page is on the home's own computer.
 */
export function provideAgentSeatReach(ctx: Context, pin: PinSource, unlock: UnlockSource, onComputer: boolean): void {
  const get = (): Reach => onComputer ? COMPUTER : pin.hooks.pin.getSnapshot().phase === 'unlocked' ? UNLOCKED : LOCKED
  ctx.provide('agentSeatReach', {
    get,
    subscribe: listener => pin.hooks.pin.subscribe(listener),
    openUnlock: () => { if (!pin.ask()) unlock.open() },
  })
}
