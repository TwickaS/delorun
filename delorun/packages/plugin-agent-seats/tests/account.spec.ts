/** The figures the chat shows from the accounts store. */
import { describe, expect, it } from 'vitest'
import type { AccountRecord } from '@delorun/external-agents/contract'
import { accountFigures, accountOf, programInfo } from '../src/account.ts'

const NOW = 1_000_000
const record = (extra: Partial<AccountRecord>): AccountRecord => ({ provider: 'claude-code', signedIn: 'yes', windows: [], installed: true, ...extra })
const window = (kind: string, usedPercent: number | undefined, resetsAt: number | undefined) =>
  ({ kind, status: 'allowed' as const, seenAt: NOW - 1, source: 'run' as const, ...usedPercent === undefined ? {} : { usedPercent }, ...resetsAt === undefined ? {} : { resetsAt } })

describe('accountFigures', () => {
  it('has nothing for an account nothing is known about', () => {
    expect(accountFigures(record({}), NOW)).toEqual({})
  })

  it('shows the plan alone when no window is known', () => {
    expect(accountFigures(record({ plan: 'Max' }), NOW)).toEqual({ plan: 'Max' })
  })

  it('shows the plan, both percents (rounded) and the 5-hour reset', () => {
    const windows = [window('five_hour', 41.6, NOW + 100), window('seven_day', 7.2, NOW + 5000)]
    expect(accountFigures(record({ plan: 'Max', windows }), NOW)).toEqual({ plan: 'Max', fiveHourPercent: 42, fiveHourResetAt: NOW + 100, weeklyPercent: 7 })
  })

  it('reads Codex\'s 10080-minute window as the weekly one', () => {
    expect(accountFigures(record({ windows: [window('window_10080m', 30, NOW + 1)] }), NOW)).toEqual({ weeklyPercent: 30 })
  })

  it('ignores a window whose reset time has passed and one with no percent', () => {
    const windows = [window('five_hour', 90, NOW - 1), window('seven_day', undefined, NOW + 1)]
    expect(accountFigures(record({ windows }), NOW)).toEqual({})
  })
})

describe('accountOf', () => {
  it('reads the store\'s record for the agent', async () => {
    const read = (agent: string) => Promise.resolve(record({ provider: agent === 'codex' ? 'codex' : 'claude-code', plan: 'Pro' }))
    expect(await accountOf({ read }, 'codex', NOW)).toEqual({ plan: 'Pro' })
  })

  it('has no figures without a store', async () => {
    expect(await accountOf(undefined, 'codex', NOW)).toEqual({})
  })
})

describe('programInfo', () => {
  it('names the version when known and nothing otherwise', () => {
    expect(programInfo('2.1.263')).toEqual({ version: '2.1.263' })
    expect(programInfo(undefined)).toEqual({})
  })
})
