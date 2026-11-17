/**
 * @delorun/plugin-tool-failure-guard: stops a turn that keeps hitting failing tool calls, so a model that cannot reach
 * a tool does not spend the person's tokens trying one workaround after another. Each agent's tool results are counted
 * ([tally](./tally.ts)); after `reminderAfter` failures in a row the model gets one logged reminder, and when either
 * limit is reached the guard cancels the turn at its next step boundary, after every tool result is saved and before
 * the next model request. The cancel reason is recorded in the turn's `turn/end` event, and the studio shows one stop
 * notice for it ([client](./client/index.ts)). A message from the person starts a fresh count and carries on.
 *
 * @module @delorun/plugin-tool-failure-guard
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { FailureTally, outcomeOf, resolveLimits, TOOL_FAILURE_GUARD_STOP_REASON, type FailureLimits } from './tally.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The guard's reminder to the model after several failed tool calls in a row. */
    'tool-failure-guard': { kind: 'tool-failure-guard' } & ContextFormed
  }
}

export { FailureTally, outcomeOf, resolveLimits, TOOL_FAILURE_GUARD_STOP_REASON, ToolFailureGuardConfigError } from './tally.ts'
export type { CallOutcome, FailureLimits, FailureLimitsInput, TallyVerdict } from './tally.ts'

/** The plugin's name in logs. */
export const name = 'delorun-tool-failure-guard'

/** The guard listens on the tools and agent-loop events only. */
export const inject = []

/** The guard's configuration. */
export interface Config {
  /**
   * Count failed tool calls and stop a turn that keeps failing. On, the shipped composition mounts it that way. Off —
   * Delorun's C16 switch `tool_failure_guard`, the parity value — the plugin registers nothing.
   */
  readonly enabled: boolean
  /** Failed tool calls in a row that stop the turn; at least 2. */
  readonly consecutiveFailures: number
  /** How many of the latest counted tool calls the failure window holds; at least 2. */
  readonly windowSize: number
  /** Failed tool calls within the window that stop the turn; at least 2 and at most `windowSize`. */
  readonly windowFailures: number
  /** Failed tool calls in a row after which the model gets one reminder; below `consecutiveFailures`, `0` for none. */
  readonly reminderAfter: number
  /**
   * Tool-name patterns (`*` matches any run of characters) whose calls the guard ignores: they neither count nor end a
   * run of failures. A pattern that matches no registered tool is allowed.
   */
  readonly exclude: string[]
  /**
   * Also write {@link STDERR_NOTICE} to the process's standard error when the guard stops a turn. `delorun headless`
   * sets it on, because it prints only the turn's final text and has no chat to show the notice in.
   */
  readonly stderrNotice: boolean
}

/** The configuration schema; `enabled` defaults to the parity value, the limits to the shipped ones. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  consecutiveFailures: z.natural().default(6),
  windowSize: z.natural().default(12),
  windowFailures: z.natural().default(8),
  reminderAfter: z.natural().default(3),
  exclude: z.array(z.string()).default([]),
  stderrNotice: z.boolean().default(false),
})

/** The line `stderrNotice` writes when the guard stops a turn. */
export const STDERR_NOTICE = 'delorun: the turn stopped because tool calls kept failing; check the errors in the chat, then run the task again.\n'

/** The source stamped on the reminder; the session renders it as a plugin notice, not as the person's words. */
function reminderSource(count: number): UserMessage['source'] {
  return { kind: 'tool-failure-guard', form: 'notice', summary: `${count} failed tool calls` }
}

/**
 * The reminder the model reads after `count` failed tool calls in a row.
 * @param count - the failures in the current run.
 * @param limits - the limits, for the stop it announces.
 * @returns the reminder's text.
 */
export function reminderText(count: number, limits: FailureLimits): string {
  return `The last ${count} tool calls failed. If a tool is unavailable or keeps failing the same way, stop and tell `
    + 'the user what failed and what they can do about it, instead of trying other tools to work around it. '
    + `This turn stops after ${limits.consecutiveFailures} failed tool calls in a row.`
}

/** Compile one `*` pattern to an anchored expression; every other character matches itself. */
function patternOf(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/** The structured error code of a failed result or a blocking decision, if any. */
function failureCode(result: ToolExecutionResult, decision: PostToolDecision): string | undefined {
  if (decision.kind === 'block') return decision.info?.code
  return result.isError ? result.error.info?.code : undefined
}

/**
 * Validate the limits and, with the switch on, count every agent's tool results.
 * @param ctx - the plugin context; the listeners are disposed with it.
 * @param config - the row's validated Config.
 * @throws ToolFailureGuardConfigError when the limits cannot work, so the row fails at load.
 */
export function apply(ctx: Context, config: Config): void {
  const limits = resolveLimits(config)
  if (!config.enabled) return
  const excluded = config.exclude.map(patternOf)
  const tallies = new WeakMap<Agent, FailureTally>()

  /** The agent's tally, created on its first counted call. */
  function tallyOf(agent: Agent): FailureTally {
    const existing = tallies.get(agent)
    if (existing !== undefined) return existing
    const created = new FailureTally(limits)
    tallies.set(agent, created)
    return created
  }

  // Counted after delegating, so a later listener's block counts as the failure the model reads. A call without an
  // agent has no turn to stop.
  ctx.on('tools/post-execute', async (exec: ToolExecution, result, next): Promise<PostToolDecision> => {
    const decision = await next()
    if (exec.agent === undefined || excluded.some(pattern => pattern.test(exec.name))) return decision
    const failed = decision.kind === 'block' || result.isError
    const tally = tallyOf(exec.agent)
    const verdict = tally.record(outcomeOf(failed, failureCode(result, decision)))
    if (verdict !== 'remind') return decision
    const reminder = createUserMessage({
      content: [{ type: 'text', text: reminderText(tally.consecutive, limits) }],
      source: reminderSource(tally.consecutive),
    })
    return { ...decision, additionalContexts: [reminder, ...decision.additionalContexts ?? []] }
  })

  // The step boundary: a message from the person starts a fresh count and the step runs; otherwise a stopped tally
  // cancels the turn before its next model request. `keepInbox` keeps the person's queued messages for the next turn.
  ctx.on('agent/pre-step', ({ agent, messages }, next) => {
    if (messages.some(message => message.source.kind === 'user')) {
      tallies.delete(agent)
      return next()
    }
    if (tallies.get(agent)?.tripped === true) {
      tallies.delete(agent)
      agent.cancel({ kind: 'hook', reason: TOOL_FAILURE_GUARD_STOP_REASON }, { keepInbox: true })
      if (config.stderrNotice) process.stderr.write(STDERR_NOTICE)
    }
    return next()
  })
}
