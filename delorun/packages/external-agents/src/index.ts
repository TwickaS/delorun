/**
 * @delorun/external-agents: the start gate for Claude Code and Codex as live agents. It is the only code that starts
 * an external agent's program (`ctx.externalAgents`), keeps one program per seat child, bounds how many run, and holds
 * the account and limits store (`ctx.agentAccounts`). The drivers (`@delorun/agent-claude-code`,
 * `@delorun/agent-codex`) register with it and get their processes only through it. The driver contract is in
 * [contract](./contract.ts); finding the pinned programs is in [locate](./locate.ts).
 * @module @delorun/external-agents
 */
import z from '@deepseek-ai/schemastery'

export * from './contract.ts'

/** The gate's configuration. */
export interface Config {
  /** How many external agent programs may run at once in this home, seats and limits checks together; at least 1. */
  readonly maxLivePrograms: number
  /** How long a program gets to exit after it is asked to stop, in milliseconds, before it is killed; at least 100. */
  readonly graceMs: number
  /** The shortest time between two limits checks of one agent, in whole minutes; at least 1. */
  readonly probeMinIntervalMinutes: number
}

/** The configuration schema, with the shipped defaults. */
export const Config: z<Config> = z.object({
  maxLivePrograms: z.natural().min(1).default(4),
  graceMs: z.natural().min(100).default(3_000),
  probeMinIntervalMinutes: z.natural().min(1).default(30),
})
