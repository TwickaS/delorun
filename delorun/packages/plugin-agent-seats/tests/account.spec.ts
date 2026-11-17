/** The figures and the program version the chat shows from the accounts store and the added pack. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { AccountRecord } from '@delorun/external-agents/contract'
import { accountFigures, programVersion } from '../src/account.ts'

const locate = vi.hoisted(() => ({ claude: vi.fn(), codex: vi.fn() }))
vi.mock('@delorun/external-agents/locate', () => ({ locateClaudeSdk: locate.claude, locateCodex: locate.codex }))

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

describe('programVersion', () => {
  const sdkAt = async (manifest: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'ea2-sdk-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    await writeFile(join(dir, 'package.json'), manifest)
    return dir
  }

  it('is unknown when the pack is not added', () => {
    locate.claude.mockReturnValue(undefined)
    locate.codex.mockReturnValue(undefined)
    expect(programVersion('claude-code', '/profile')).toBeUndefined()
    expect(programVersion('codex', '/profile')).toBeUndefined()
  })

  it('reads Codex\'s version from its package', () => {
    locate.codex.mockReturnValue({ directory: '/codex', version: '0.130.0' })
    expect(programVersion('codex', '/profile')).toBe('0.130.0')
  })

  it('reads Claude Code\'s version from the SDK manifest', async () => {
    locate.claude.mockReturnValue({ directory: await sdkAt('{"claudeCodeVersion":"2.1.263"}'), version: '0.3.263', entry: '/x' })
    expect(programVersion('claude-code', '/profile')).toBe('2.1.263')
  })

  it.each([['names no program version', '{}'], ['cannot be read as JSON', 'not json']])('falls back to the SDK\'s own version when the manifest %s', async (_name, manifest) => {
    locate.claude.mockReturnValue({ directory: await sdkAt(manifest), version: '0.3.263', entry: '/x' })
    expect(programVersion('claude-code', '/profile')).toBe('0.3.263')
  })
})
