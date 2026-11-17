/**
 * The account service (`src/accounts/service.ts`) over a fake start gate and a fake clock: when a check starts, what
 * it records, and that reading never starts one.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountObservation, ExternalAgentName } from '../src/contract.ts'
import { reachedLimit, windowStanding } from '../src/accounts/limit.ts'
import { createAgentAccounts, type AgentAccountsService, type CheckResult } from '../src/accounts/service.ts'
import { accountsFilePath, readAccountsFile } from '../src/accounts/store.ts'

const MINUTE = 60_000
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** What the fake gate and clock hold, which a test changes. */
interface FakeState {
  readonly path: string
  readonly checks: ExternalAgentName[]
  readonly reports: string[]
  readonly clock: { now: number }
  /** What the next check answers; a function runs when the check starts. */
  answer: CheckResult | (() => Promise<CheckResult>)
  readonly installed: Set<ExternalAgentName>
}

/** A fake gate, clock and home around one service. */
interface Fixture extends FakeState {
  readonly accounts: AgentAccountsService
  /** Build another service over the same home, as after a restart. */
  readonly restart: () => AgentAccountsService
}

const OBSERVED: AccountObservation = {
  provider: 'claude-code', signedIn: 'yes', plan: 'max', source: 'probe',
  windows: [{ kind: 'five-hour', usedPercent: 20, resetsAt: 10 * 60 * MINUTE, status: 'allowed' }],
}

/**
 * @param state - the fake gate and clock.
 * @returns a service over them.
 */
function serviceOver(state: FakeState): AgentAccountsService {
  return createAgentAccounts({
    storePath: state.path,
    now: () => state.clock.now,
    probeMinIntervalMs: () => 30 * MINUTE,
    installed: provider => state.installed.has(provider),
    check: async (provider) => {
      state.checks.push(provider)
      return typeof state.answer === 'function' ? state.answer() : state.answer
    },
    report: (message) => { state.reports.push(message) },
    signal: new AbortController().signal,
  })
}

/**
 * @param path - the accounts file to use, or a fresh one.
 * @returns the fixture.
 */
function fixture(path?: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'ea1-limits-service-'))
  roots.push(root)
  const state: FakeState = {
    path: path ?? accountsFilePath(root), checks: [], reports: [], clock: { now: 60 * MINUTE },
    answer: { kind: 'observed', observation: OBSERVED },
    installed: new Set(['claude-code', 'codex']),
  }
  // The fixture is the state itself, so a test's change is what the service sees.
  return Object.assign(state, { accounts: serviceOver(state), restart: () => serviceOver(state) })
}

describe('a refresh', () => {
  it('starts nothing for an agent whose pack is not added', async () => {
    const f = fixture()
    f.installed.delete('codex')
    const answer = await f.accounts.refresh('codex', 'check-now')
    expect(answer.outcome).toEqual({ kind: 'not-installed' })
    expect(answer.account).toMatchObject({ provider: 'codex', installed: false, signedIn: 'unknown' })
    expect(f.checks).toEqual([])
  })

  it('checks through the gate and stores the figures as a check\'s, at the clock\'s time', async () => {
    const f = fixture()
    const answer = await f.accounts.refresh('claude-code', 'pack-added')
    expect(f.checks).toEqual(['claude-code'])
    expect(answer.outcome).toEqual({ kind: 'checked' })
    expect(answer.account).toMatchObject({ provider: 'claude-code', installed: true, signedIn: 'yes', plan: 'max', checkedAt: 60 * MINUTE })
    expect(answer.account.windows).toEqual([{ ...OBSERVED.windows[0], seenAt: 60 * MINUTE, source: 'probe' }])
  })

  it('stores a check\'s figures under the provider it was asked for, whatever the driver named', async () => {
    const f = fixture()
    f.answer = { kind: 'observed', observation: { ...OBSERVED, provider: 'claude-code', source: 'run' } }
    await f.accounts.refresh('codex', 'check-now')
    const read = await readAccountsFile(f.path)
    expect(read.kind === 'readable' ? Object.keys(read.file.accounts) : []).toEqual(['codex'])
    expect((await f.accounts.read('codex')).windows[0]?.source).toBe('probe')
  })

  it('is throttled within the interval, also after a restart, and runs again once it passed', async () => {
    const f = fixture()
    await f.accounts.refresh('claude-code', 'pack-added')
    f.clock.now += 10 * MINUTE
    expect((await f.accounts.refresh('claude-code', 'check-now')).outcome).toEqual({ kind: 'throttled', nextAt: 90 * MINUTE })
    expect((await f.restart().refresh('claude-code', 'pack-added')).outcome.kind).toBe('throttled')
    expect(f.checks).toEqual(['claude-code'])
    f.clock.now = 90 * MINUTE
    expect((await f.accounts.refresh('claude-code', 'check-now')).outcome).toEqual({ kind: 'checked' })
    expect(f.checks).toEqual(['claude-code', 'claude-code'])
  })

  it('after `signed-in` skips the throttle, and each provider is throttled on its own', async () => {
    const f = fixture()
    await f.accounts.refresh('claude-code', 'check-now')
    expect((await f.accounts.refresh('claude-code', 'signed-in')).outcome).toEqual({ kind: 'checked' })
    expect((await f.accounts.refresh('codex', 'check-now')).outcome).toEqual({ kind: 'checked' })
    expect(f.checks).toEqual(['claude-code', 'claude-code', 'codex'])
  })

  it('runs one check per provider at a time; a refresh meanwhile gets the same answer', async () => {
    const f = fixture()
    let release!: () => void
    f.answer = () => new Promise((resolve) => { release = () => { resolve({ kind: 'observed', observation: OBSERVED }) } })
    const first = f.accounts.refresh('claude-code', 'check-now')
    const second = f.accounts.refresh('claude-code', 'signed-in')
    await vi.waitFor(() => { expect(f.checks).toHaveLength(1) })
    release()
    expect(await second).toEqual(await first)
    expect(f.checks).toEqual(['claude-code'])
  })

  it('records a failed check\'s time, keeps the figures as they were seen and throttles the next', async () => {
    const f = fixture()
    await f.accounts.refresh('claude-code', 'check-now')
    f.clock.now += 40 * MINUTE
    f.answer = { kind: 'failed', problem: 'the program exited with code 1' }
    const failed = await f.accounts.refresh('claude-code', 'check-now')
    expect(failed.outcome).toEqual({ kind: 'failed', problem: 'the program exited with code 1' })
    expect(failed.account).toMatchObject({ signedIn: 'yes', plan: 'max', checkedAt: 60 * MINUTE, checkFailedAt: 100 * MINUTE })
    expect(failed.account.windows[0]?.seenAt).toBe(60 * MINUTE)
    f.clock.now += MINUTE
    expect((await f.accounts.refresh('claude-code', 'check-now')).outcome.kind).toBe('throttled')
  })

  it('answers a check that throws as failed', async () => {
    const f = fixture()
    f.answer = () => Promise.reject(new Error('spawn refused'))
    expect((await f.accounts.refresh('codex', 'check-now')).outcome).toEqual({ kind: 'failed', problem: 'spawn refused' })
  })

  it('passes on a gate refusal and a pack removed meanwhile without recording a check', async () => {
    const f = fixture()
    f.answer = { kind: 'refused', problem: 'Four agents are already running: Claude Code, Codex.' }
    expect((await f.accounts.refresh('codex', 'check-now')).outcome).toEqual({ kind: 'refused', problem: 'Four agents are already running: Claude Code, Codex.' })
    f.answer = { kind: 'not-installed' }
    expect((await f.accounts.refresh('codex', 'check-now')).outcome).toEqual({ kind: 'not-installed' })
    expect(f.checks).toEqual(['codex', 'codex'])
    expect(await readAccountsFile(f.path)).toEqual({ kind: 'readable', file: { v: 1, accounts: {} } })
  })
})

describe('reading', () => {
  it('never starts a check, and reads unknown figures for every provider at first', async () => {
    const f = fixture()
    const all = await f.accounts.readAll()
    expect(all).toEqual({
      now: 60 * MINUTE,
      accounts: [
        { provider: 'claude-code', installed: true, signedIn: 'unknown', windows: [] },
        { provider: 'codex', installed: true, signedIn: 'unknown', windows: [] },
      ],
    })
    await f.accounts.read('codex')
    await f.accounts.limitReached('codex')
    expect(f.checks).toEqual([])
  })

  it('reads a corrupt file as unknown figures, refuses nothing, and the next observation rewrites it', async () => {
    const f = fixture()
    mkdirSync(join(f.path, '..'), { recursive: true })
    writeFileSync(f.path, '{"v":1,"accounts":', { mode: 0o600 })
    expect(await f.accounts.read('claude-code')).toMatchObject({ signedIn: 'unknown', windows: [] })
    expect(await f.accounts.limitReached('claude-code')).toBeUndefined()
    await f.accounts.observe(OBSERVED)
    expect((await f.accounts.read('claude-code')).plan).toBe('max')
  })
})

describe('observing a run', () => {
  it('stores a run\'s windows as a run\'s and leaves the check time alone', async () => {
    const f = fixture()
    await f.accounts.observe({ provider: 'codex', signedIn: 'yes', source: 'run', windows: [{ kind: 'five-hour', usedPercent: 81, status: 'near' }] })
    const codex = await f.accounts.read('codex')
    expect(codex.windows).toEqual([{ kind: 'five-hour', usedPercent: 81, status: 'near', seenAt: 60 * MINUTE, source: 'run' }])
    expect(codex.checkedAt).toBeUndefined()
  })

  it('reports a write that fails and does not throw', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ea1-limits-service-'))
    roots.push(root)
    writeFileSync(join(root, 'secrets'), 'a file where the folder should be')
    const f = fixture(accountsFilePath(root))
    await f.accounts.observe(OBSERVED)
    f.answer = { kind: 'failed', problem: 'gone' }
    await f.accounts.refresh('codex', 'check-now')
    expect(f.reports).toEqual([expect.stringContaining('claude-code limit figures could not be saved'), expect.stringContaining('codex limits check time could not be saved')])
  })

  it('serialises writes, so two observations at once both land', async () => {
    const f = fixture()
    await Promise.all([
      f.accounts.observe({ provider: 'codex', signedIn: 'yes', source: 'run', windows: [] }),
      f.accounts.observe({ provider: 'claude-code', signedIn: 'no', source: 'run', windows: [] }),
    ])
    const all = await f.accounts.readAll()
    expect(all.accounts.map(account => account.signedIn)).toEqual(['no', 'yes'])
  })
})

describe('once a driver registers', () => {
  it('checks that provider in the background', async () => {
    const f = fixture()
    f.accounts.driverAdded('codex')
    await vi.waitFor(async () => { expect((await f.accounts.read('codex')).checkedAt).toBe(60 * MINUTE) })
    expect(f.checks).toEqual(['codex'])
  })

  it('reports a check that could not run', async () => {
    const reports: string[] = []
    const accounts = createAgentAccounts({
      storePath: accountsFilePath('/nonexistent'), now: () => 0, probeMinIntervalMs: () => 0,
      installed: () => { throw new Error('the driver list is gone') },
      check: () => Promise.resolve({ kind: 'not-installed' }),
      report: (message) => { reports.push(message) },
      signal: new AbortController().signal,
    })
    accounts.driverAdded('claude-code')
    await vi.waitFor(() => { expect(reports).toHaveLength(1) })
    expect(reports).toEqual(['the claude-code limits check after its pack was added failed (the driver list is gone)'])
  })
})

describe('the reached-limit rule', () => {
  const window = (status: 'allowed' | 'near' | 'reached' | 'unknown', resetsAt?: number, kind = 'five-hour') =>
    ({ kind, status, seenAt: 0, source: 'run' as const, ...(resetsAt === undefined ? {} : { resetsAt }) })

  it('refuses until the latest reset of the reached windows, and only while it is ahead', () => {
    const account = { signedIn: 'yes' as const, windows: [window('reached', 500), window('reached', 900, 'seven-day'), window('near', 2_000, 'thirty-day')] }
    expect(reachedLimit(account, 100)).toEqual({ kind: 'seven-day', resetsAt: 900 })
    expect(reachedLimit(account, 600)).toEqual({ kind: 'seven-day', resetsAt: 900 })
    expect(reachedLimit(account, 900)).toBeUndefined()
  })

  it('never refuses on a reached window without a reset time, on other statuses or with no figures', () => {
    expect(reachedLimit({ signedIn: 'yes', windows: [window('reached'), window('near', 999), window('unknown', 999)] }, 0)).toBeUndefined()
    expect(reachedLimit(undefined, 0)).toBeUndefined()
  })

  it('calls a window whose reset time has passed reset, and one without a reset time current', () => {
    expect(windowStanding(window('reached', 500), 500)).toBe('reset')
    expect(windowStanding(window('reached', 500), 499)).toBe('current')
    expect(windowStanding(window('allowed'), 10_000)).toBe('current')
  })
})
