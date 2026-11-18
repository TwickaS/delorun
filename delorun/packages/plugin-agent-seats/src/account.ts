/**
 * What the chat shows about an agent's account: the plan and limit figures the accounts store holds.
 * @module @delorun/plugin-agent-seats/account
 */
import type { AccountRecord, AgentAccounts, ExternalAgentName } from '@delorun/external-agents/contract'
import type { AccountFigures } from './state/store.ts'

/** The kinds that name a weekly window: Claude's `seven_day` and Codex's 10080-minute window. */
const WEEKLY_KINDS: ReadonlySet<string> = new Set(['seven_day', 'window_10080m'])

/**
 * The figures of an account the chat shows. A window whose reset time has passed is stale and shows nothing.
 * @param record - the agent's stored account.
 * @param now - the time the figures are read at, epoch milliseconds.
 * @returns the plan and the used percent of the 5-hour and weekly windows, each only when known.
 */
export function accountFigures(record: AccountRecord, now: number): AccountFigures {
  const current = record.windows.filter(window => window.resetsAt === undefined || window.resetsAt > now)
  const fiveHour = current.find(window => window.kind === 'five_hour')
  const weekly = current.find(window => WEEKLY_KINDS.has(window.kind))
  return {
    ...record.plan === undefined ? {} : { plan: record.plan },
    ...fiveHour?.usedPercent === undefined ? {} : { fiveHourPercent: Math.round(fiveHour.usedPercent) },
    ...fiveHour?.resetsAt === undefined ? {} : { fiveHourResetAt: fiveHour.resetsAt },
    ...weekly?.usedPercent === undefined ? {} : { weeklyPercent: Math.round(weekly.usedPercent) },
  }
}

/**
 * The figures of an agent's stored account.
 * @param accounts - the accounts store, when the gate package is mounted.
 * @param agent - the agent.
 * @param now - the time the figures are read at, epoch milliseconds.
 * @returns the figures; none without a store.
 */
export async function accountOf(accounts: Pick<AgentAccounts, 'read'> | undefined, agent: ExternalAgentName, now: number): Promise<AccountFigures> {
  return accounts === undefined ? {} : accountFigures(await accounts.read(agent), now)
}

/**
 * The status fields that name the program.
 * @param version - the program's version, when its pack is added.
 * @returns the fields to log with the status.
 */
export function programInfo(version: string | undefined): { readonly version?: string } {
  return version === undefined ? {} : { version }
}
