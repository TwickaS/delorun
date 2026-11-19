/**
 * Registers the live agents' provider side: one subagent provider and one hand-off tool per configured seat, and the
 * hiding of upstream's one-shot tools. Every registration is an effect; with the preview flag off nothing registers,
 * so a chat's tool list is as without this package.
 * @module @delorun/plugin-agent-seats/provider/register
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ExternalAgentName } from '@delorun/external-agents/contract'
import type { Config, SeatConfig } from '../config.ts'
import { hideOneShotTools, oneShotToolName, type HiddenOneShot } from './hide.ts'
import { isExternalAgentName, seatProvider, seatProviderName } from './provider.ts'
import { handOffTool, type HandOffOptions } from './tool.ts'

/** A configured seat with the agent the gate runs for it. */
export interface ExternalSeat {
  /** The configured seat. */
  readonly seat: SeatConfig
  /** The agent its `provider` names. */
  readonly agent: ExternalAgentName
}

/**
 * Fail loud on a seat list the provider side cannot serve.
 * @param config - the row's configuration.
 * @returns every seat with its agent.
 * @throws when a seat names an agent the gate does not run, or two seats share a provider, route or tool name.
 */
function externalSeats(config: Config): ExternalSeat[] {
  const seen = { provider: new Set<string>(), route: new Set<string>(), toolName: new Set<string>() }
  const seats: ExternalSeat[] = []
  for (const seat of config.seats) {
    const agent = seat.provider
    if (!isExternalAgentName(agent)) {
      throw new Error(`delorun-agent-seats: seat provider "${seat.provider}" is not an external agent; use "claude-code" or "codex"`)
    }
    for (const key of ['provider', 'route', 'toolName'] as const) {
      if (seen[key].has(seat[key])) throw new Error(`delorun-agent-seats: two seats share the ${key} "${seat[key]}"`)
      seen[key].add(seat[key])
    }
    seats.push({ seat, agent })
  }
  return seats
}

/**
 * Register the providers and hand-off tools of every configured seat while the flag is on.
 * @param ctx - the plugin context with `subagents`, `tools`, `externalAgents` and `llm`.
 * @param config - the validated row configuration.
 * @param flag - reads `externalAgents.liveAgents`; checked once, so a change takes a reload of the row.
 * @param options - the clock, for tests.
 * @returns the seats registered with their agents; empty while the flag is off.
 * @throws when a seat names an agent the gate does not run, or two seats share a provider, route or tool name.
 */
export function registerSeatProviders(ctx: Context, config: Config, flag: () => boolean, options: Partial<HandOffOptions> = {}): ExternalSeat[] {
  if (!flag()) return []
  const seats = externalSeats(config)
  const handOff: HandOffOptions = { now: options.now ?? Date.now }
  const hidden: HiddenOneShot[] = []
  for (const { seat, agent } of seats) {
    hidden.push({ seatTool: seat.toolName, oneShotTool: oneShotToolName(agent) })
    ctx.effect(() => ctx.subagents.registerProvider(seatProvider(seat)), `delorun-agent-seats: provider ${seatProviderName(agent)}`)
    ctx.effect(() => ctx.tools.register(handOffTool(ctx, seat, agent, handOff)), `delorun-agent-seats: tool ${seat.toolName}`)
  }
  ctx.on('agent/created', ({ agent }) => {
    hideOneShotTools(ctx, agent, hidden)
    return undefined
  })
  return seats
}
