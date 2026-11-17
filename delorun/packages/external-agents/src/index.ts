/**
 * @delorun/external-agents: the start gate for Claude Code and Codex as live agents. It is the only code that starts
 * an external agent's program (`ctx.externalAgents`, [gate](./gate.ts)), keeps one program per seat child, bounds how
 * many run, and holds the account and limits store (`ctx.agentAccounts`). The drivers (`@delorun/agent-claude-code`,
 * `@delorun/agent-codex`) register with it and get their processes only through it. The driver contract is in
 * [contract](./contract.ts); finding the pinned programs is in [locate](./locate.ts).
 * @module @delorun/external-agents
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'
import { ExternalAgentsService } from './gate.ts'

export * from './contract.ts'
export { ExternalAgentsService, spawnEnvironment } from './gate.ts'

/** The gate's configuration. */
export interface Config {
  /** How many external agent programs may run at once in this home, seats and limits checks together; at least 1. */
  readonly maxLivePrograms: number
  /** How long a program gets to exit after it is asked to stop, in milliseconds, before it is killed; at least 100. */
  readonly graceMs: number
  /** The shortest time between two limits checks of one agent, in whole minutes; at least 1. */
  readonly probeMinIntervalMinutes: number
  /**
   * The C16 switch `external_agent_limit_refusal`: on, a reached plan limit with a reset time in the future refuses a
   * live agent's start and a one-shot external run with a fixed sentence to the model. Off, the parity value, nothing
   * refuses for a limit.
   */
  readonly limitRefusal: boolean
}

/** The configuration schema, with the shipped defaults; `limitRefusal` defaults to its parity value, off. */
export const Config: z<Config> = z.object({
  maxLivePrograms: z.natural().min(1).default(4),
  graceMs: z.natural().min(100).default(3_000),
  probeMinIntervalMinutes: z.natural().min(1).default(30),
  limitRefusal: z.boolean().default(false),
})

/**
 * Mount the gate once the subprocess service is present.
 * @param ctx - the scope that loads the plugin.
 * @param config - the row's validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['subprocess'], (scope) => {
    scope.plugin(ExternalAgentsService, {
      maxLivePrograms: config.maxLivePrograms,
      graceMs: config.graceMs,
      limitRefusal: config.limitRefusal,
      env: process.env,
      now: Date.now,
      probeFolder: () => mkdtemp(join(tmpdir(), 'delorun-agent-check-')),
    })
  })
}
