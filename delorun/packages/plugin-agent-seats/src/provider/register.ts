/**
 * Registers the live agents' provider side: one subagent provider and one hand-off tool per configured seat, and the
 * hiding of upstream's one-shot tools. Every registration is an effect; with the preview flag off nothing registers,
 * so a chat's tool list is as without this package.
 * @module @delorun/plugin-agent-seats/provider/register
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../config.ts'
import { hideOneShotTools, oneShotToolName, type HiddenOneShot } from './hide.ts'
import { isExternalAgentName, seatProvider, seatProviderName } from './provider.ts'
import { handOffTool, type HandOffOptions } from './tool.ts'

/**
 * Fail loud on a seat list the provider side cannot serve.
 * @param config - the row's configuration.
 * @throws when a seat names an agent the gate does not run, or two seats share a provider, route or tool name.
 */
function assertSeats(config: Config): void {
  const seen = { provider: new Set<string>(), route: new Set<string>(), toolName: new Set<string>() }
  for (const seat of config.seats) {
    if (!isExternalAgentName(seat.provider)) {
      throw new Error(`delorun-agent-seats: seat provider "${seat.provider}" is not an external agent; use "claude-code" or "codex"`)
    }
    for (const key of ['provider', 'route', 'toolName'] as const) {
      if (seen[key].has(seat[key])) throw new Error(`delorun-agent-seats: two seats share the ${key} "${seat[key]}"`)
      seen[key].add(seat[key])
    }
  }
}

/**
 * Register the providers and hand-off tools of every configured seat while the flag is on.
 * @param ctx - the plugin context with `subagents`, `tools`, `externalAgents` and `llm`.
 * @param config - the validated row configuration.
 * @param flag - reads `externalAgents.liveAgents`; checked once, so a change takes a reload of the row.
 * @param options - the clock, for tests.
 */
export function registerSeatProviders(ctx: Context, config: Config, flag: () => boolean, options: Partial<HandOffOptions> = {}): void {
  if (!flag()) return
  assertSeats(config)
  const handOff: HandOffOptions = { now: options.now ?? Date.now }
  const hidden: HiddenOneShot[] = []
  for (const seat of config.seats) {
    if (!isExternalAgentName(seat.provider)) continue
    const agent = seat.provider
    hidden.push({ seatTool: seat.toolName, oneShotTool: oneShotToolName(agent) })
    ctx.effect(() => ctx.subagents.registerProvider(seatProvider(seat)), `delorun-agent-seats: provider ${seatProviderName(agent)}`)
    ctx.effect(() => ctx.tools.register(handOffTool(ctx, seat, agent, handOff)), `delorun-agent-seats: tool ${seat.toolName}`)
  }
  ctx.on('agent/created', ({ agent }) => {
    hideOneShotTools(ctx, agent, hidden)
    return undefined
  })
}
