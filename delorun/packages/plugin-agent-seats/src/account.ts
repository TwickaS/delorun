/**
 * What the chat shows about an agent's account and program: the plan and limit figures the accounts store holds, and the
 * version of the program a pack brings.
 * @module @delorun/plugin-agent-seats/account
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AccountRecord, ExternalAgentName } from '@delorun/external-agents/contract'
import { locateClaudeSdk, locateCodex } from '@delorun/external-agents/locate'
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
 * The version of an agent's program as its pack brings it: Claude Code's from the Agent SDK's manifest, Codex's from
 * its package.
 * @param agent - the agent.
 * @param profileDirectory - the profile's directory, where the pack is looked for.
 * @returns the version, or undefined when the pack is not installed or its manifest does not say.
 */
export function programVersion(agent: ExternalAgentName, profileDirectory: string): string | undefined {
  if (agent === 'codex') return locateCodex(profileDirectory)?.version
  const sdk = locateClaudeSdk(profileDirectory)
  if (sdk === undefined) return undefined
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(sdk.directory, 'package.json'), 'utf8'))
  } catch (error: unknown) {
    // The manifest was readable when the SDK was located; without its program version the SDK's own is shown.
    manifest = error
  }
  const program = typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'claudeCodeVersion') : undefined
  return typeof program === 'string' ? program : sdk.version
}
