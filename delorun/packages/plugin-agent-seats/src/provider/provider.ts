/**
 * The Delorun subagent provider behind each hand-off tool: a continuable provider whose children are seats, so the
 * child's own log records `<agent>-seat` as its provider and the adapter, the executor and the screens recognise a seat
 * without a preset lookup.
 * @module @delorun/plugin-agent-seats/provider/provider
 */
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import type { ExternalAgentName } from '@delorun/external-agents/contract'
import type { SeatConfig } from '../config.ts'

/** The model id every seat route takes; the program picks its own model. */
export const SEAT_MODEL = 'program'

/**
 * Whether a configured provider names an agent the start gate runs.
 * @param provider - a seat's configured provider.
 * @returns true for `claude-code` and `codex`.
 */
export function isExternalAgentName(provider: string): provider is ExternalAgentName {
  return provider === 'claude-code' || provider === 'codex'
}

/**
 * The `ctx.subagents` provider name of an agent's seats.
 * @param provider - the driver's agent name, such as `claude-code`.
 * @returns the provider name, such as `claude-code-seat`.
 */
export function seatProviderName(provider: string): string {
  return `${provider}-seat`
}

/**
 * The subagent provider of one seat. It contributes no history and no setup: the seat preset, the route and the first
 * message come from the hand-off tool, and the program opens on the child's first turn through the start gate.
 * @param seat - the configured seat.
 * @returns the provider.
 */
export function seatProvider(seat: SeatConfig): SubagentProvider {
  return {
    name: seatProviderName(seat.provider),
    capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true },
    inheritsParentContext: false,
    agentRouteDefaults: { provider: seat.route, model: SEAT_MODEL },
    prepareContinuable: () => Promise.resolve({}),
  }
}
