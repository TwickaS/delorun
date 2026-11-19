/**
 * The tool-failure guard's counting rules, free of Cordis: which tool outcomes count as failures, the validated limits,
 * and one agent's running tally. The plugin entry ([index](./index.ts)) feeds it each call's outcome and acts on its
 * verdicts.
 *
 * @module @delorun/plugin-tool-failure-guard/tally
 */

/**
 * The turn-end cancel reason the guard records when it stops a turn. It is persisted in the turn's `turn/end` event
 * (`{ kind: 'aborted', reason: { kind: 'hook', reason } }`), and the studio's stop notice matches it, so the value never
 * changes.
 */
export const TOOL_FAILURE_GUARD_STOP_REASON = 'delorun/tool-failure-guard'

/**
 * Error codes of failed results that the guard does not count: the person refused or cancelled an approval, or the call
 * was cancelled. The tools registry records these strings and does not export them, so they are restated here.
 */
const NEUTRAL_ERROR_CODES: ReadonlySet<string> = new Set([
  'APPROVAL_REJECTED',
  'APPROVAL_CANCELLED',
  'ABORTED',
  'ABORTED_BEFORE_DISPATCH',
])

/** How one tool call counts: a failure, a success that ends a failure run, or neutral (it changes nothing). */
export type CallOutcome = 'failure' | 'success' | 'neutral'

/**
 * Classify one finished tool call.
 * @param failed - whether the call's final result is an error, including a result a policy listener blocked.
 * @param code - the structured error code the failed result carries, if any.
 * @returns `neutral` for a refusal by the person or a cancellation, otherwise `failure` or `success`.
 */
export function outcomeOf(failed: boolean, code: string | undefined): CallOutcome {
  if (!failed) return 'success'
  return code !== undefined && NEUTRAL_ERROR_CODES.has(code) ? 'neutral' : 'failure'
}

/** The validated limits one tally applies. */
export interface FailureLimits {
  /** Failed calls in a row that stop the turn. */
  readonly consecutiveFailures: number
  /** How many of the latest counted calls the window holds. */
  readonly windowSize: number
  /** Failed calls within the window that stop the turn. */
  readonly windowFailures: number
  /** Failed calls in a row after which the model gets one reminder; `0` sends none. */
  readonly reminderAfter: number
}

/** The limits as the plugin's Config states them, before validation. */
export interface FailureLimitsInput {
  readonly consecutiveFailures: number
  readonly windowSize: number
  readonly windowFailures: number
  readonly reminderAfter: number
}

/** A limit set that cannot work, refused when the row loads. */
export class ToolFailureGuardConfigError extends Error {
  /** @param message - which field is wrong and what it must be. */
  constructor(message: string) {
    super(`tool-failure-guard: ${message}`)
    this.name = 'ToolFailureGuardConfigError'
  }
}

/** Refuse a field that is not a whole number at least `min`. */
function requireInteger(field: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new ToolFailureGuardConfigError(`\`${field}\` is ${value}; it must be a whole number of at least ${min}`)
  }
}

/**
 * Validate the limits.
 * @param input - the row's limits.
 * @returns the same limits, checked.
 * @throws ToolFailureGuardConfigError when a limit is not a whole number in its range, the window cannot hold its
 * failure count, or the reminder would come at or after the stop.
 */
export function resolveLimits(input: FailureLimitsInput): FailureLimits {
  requireInteger('consecutiveFailures', input.consecutiveFailures, 2)
  requireInteger('windowSize', input.windowSize, 2)
  requireInteger('windowFailures', input.windowFailures, 2)
  requireInteger('reminderAfter', input.reminderAfter, 0)
  if (input.windowFailures > input.windowSize) {
    throw new ToolFailureGuardConfigError(`\`windowFailures\` (${input.windowFailures}) is larger than \`windowSize\` (${input.windowSize})`)
  }
  if (input.reminderAfter >= input.consecutiveFailures) {
    throw new ToolFailureGuardConfigError(`\`reminderAfter\` (${input.reminderAfter}) must be below \`consecutiveFailures\` (${input.consecutiveFailures}), or 0 for no reminder`)
  }
  return { ...input }
}

/** What a recorded outcome asks the plugin to do: nothing, remind the model, or stop the turn at its next step. */
export type TallyVerdict = 'none' | 'remind' | 'stop'

/**
 * One agent's running count of failed tool calls. A success ends the current run of failures but stays in the window;
 * a neutral outcome changes nothing. The tally reminds at most once, and once a limit is reached it stays stopped until
 * the plugin discards it.
 */
export class FailureTally {
  private readonly limits: FailureLimits
  /** The latest counted outcomes, oldest first, at most `windowSize`; `true` is a failure. */
  private readonly window: boolean[] = []
  private run = 0
  private stopped = false
  private reminded = false

  /** @param limits - the validated limits. */
  constructor(limits: FailureLimits) {
    this.limits = limits
  }

  /** Failed calls in the current run. */
  get consecutive(): number {
    return this.run
  }

  /** Whether a limit has been reached. */
  get tripped(): boolean {
    return this.stopped
  }

  /**
   * Record one call.
   * @param outcome - the call's outcome from {@link outcomeOf}.
   * @returns `stop` when this call reaches a limit, `remind` the first time a run reaches `reminderAfter`, else `none`.
   */
  record(outcome: CallOutcome): TallyVerdict {
    if (outcome === 'neutral') return 'none'
    const failed = outcome === 'failure'
    this.window.push(failed)
    if (this.window.length > this.limits.windowSize) this.window.shift()
    this.run = failed ? this.run + 1 : 0
    if (!failed) return 'none'
    const inWindow = this.window.filter(Boolean).length
    if (this.run >= this.limits.consecutiveFailures || inWindow >= this.limits.windowFailures) {
      this.stopped = true
      return 'stop'
    }
    if (this.reminded || this.run !== this.limits.reminderAfter) return 'none'
    this.reminded = true
    return 'remind'
  }
}
