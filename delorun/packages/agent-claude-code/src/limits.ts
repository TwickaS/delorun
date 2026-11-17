/**
 * Claude Code's plan figures as {@link AccountObservation}s: the rate-limit events a run reports, and the account and
 * usage answers of a limits check. Only the plan name, percentages, reset times and the sign-in state pass; the email,
 * organisation and token fields of the program's answers are dropped here.
 * @module @delorun/agent-claude-code/limits
 */
import type { AccountInfo, SDKControlGetUsageResponse, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk'
import type { AccountObservation, LimitWindow } from './pending-contract.ts'

/** The window status a rate-limit event's status maps to. */
const EVENT_STATUS: Readonly<Record<SDKRateLimitInfo['status'], LimitWindow['status']>> = {
  allowed: 'allowed',
  allowed_warning: 'near',
  rejected: 'reached',
}

/**
 * One rate-limit event of a run as a window. The event's utilisation is a fraction and its reset time is in seconds.
 * @param info - the event's rate-limit information.
 * @returns the window: kind is the program's own window name, `unknown` when absent.
 */
export function eventWindow(info: SDKRateLimitInfo): LimitWindow {
  return {
    kind: info.rateLimitType ?? 'unknown',
    ...info.utilization === undefined ? {} : { usedPercent: info.utilization * 100 },
    ...info.resetsAt === undefined ? {} : { resetsAt: info.resetsAt * 1000 },
    status: EVENT_STATUS[info.status],
  }
}

/**
 * One rate-limit event of a run as an observation.
 * @param info - the event's rate-limit information.
 * @returns the observation, signed in, from a run.
 */
export function runObservation(info: SDKRateLimitInfo): AccountObservation {
  return { provider: 'claude-code', signedIn: 'yes', windows: [eventWindow(info)], source: 'run' }
}

type UsageWindow = { readonly utilization: number | null; readonly resets_at: string | null }

function isUsageWindow(value: unknown): value is UsageWindow {
  return typeof value === 'object' && value !== null && 'utilization' in value && 'resets_at' in value
}

/**
 * The usage answer's windows. The answer's utilisation is already a percentage and its reset time an ISO date.
 * @param usage - the usage answer.
 * @returns one window per window the answer reports, in the answer's order.
 */
export function usageWindows(usage: SDKControlGetUsageResponse): LimitWindow[] {
  if (!usage.rate_limits_available || usage.rate_limits === null) return []
  return Object.entries(usage.rate_limits).flatMap(([kind, window]): LimitWindow[] => {
    if (!isUsageWindow(window)) return []
    const resetsAt = window.resets_at === null ? Number.NaN : Date.parse(window.resets_at)
    return [{
      kind,
      ...window.utilization === null ? {} : { usedPercent: window.utilization },
      ...Number.isNaN(resetsAt) ? {} : { resetsAt },
      status: window.utilization === null ? 'unknown' : window.utilization >= 100 ? 'reached' : 'allowed',
    }]
  })
}

function names(source: string | undefined): boolean {
  return source !== undefined && source !== 'none'
}

/**
 * The sign-in state from the account answer. A plan, a token or key source, or a backend other than Anthropic's own
 * (whose sign-in is outside Claude Code) means signed in. Anthropic's own backend with no plan and no source means
 * signed out; an answer with none of these fields tells nothing.
 * @param account - the account answer; only these fields are read, none is kept.
 * @returns the state.
 */
export function signedInFrom(account: AccountInfo): AccountObservation['signedIn'] {
  if (account.subscriptionType !== undefined || names(account.tokenSource) || names(account.apiKeySource)) return 'yes'
  if (account.apiProvider !== undefined && account.apiProvider !== 'firstParty') return 'yes'
  return account.apiProvider === 'firstParty' || account.tokenSource !== undefined ? 'no' : 'unknown'
}

/**
 * A limits check's answers as an observation.
 * @param account - the account answer.
 * @param usage - the usage answer, or undefined when that call failed.
 * @returns the observation from a check, with no personal field.
 */
export function probeObservation(account: AccountInfo, usage: SDKControlGetUsageResponse | undefined): AccountObservation {
  return {
    provider: 'claude-code',
    signedIn: signedInFrom(account),
    ...account.subscriptionType === undefined ? {} : { plan: account.subscriptionType },
    windows: usage === undefined ? [] : usageWindows(usage),
    source: 'probe',
  }
}
