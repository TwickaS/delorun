/**
 * The accounts file (`src/accounts/store.ts`): what an observation may leave in it, how observations fold together,
 * and how a missing, corrupt or lax file reads.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AccountObservation } from '../src/contract.ts'
import {
  accountsFilePath, ACCOUNTS_FILE_VERSION, MAX_WINDOWS, mergeObservation, parseAccountsFile, problemOf, readAccountsFile, sanitiseObservation, writeAccountsFile,
} from '../src/accounts/store.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** @returns a fresh home folder. */
function home(): string {
  const root = mkdtempSync(join(tmpdir(), 'ea1-limits-store-'))
  roots.push(root)
  return root
}

/** Personal values a program's account reply carries; none may reach the file. */
const PERSONAL = ['person@example.com', 'Example Org Ltd', 'acct_4f2a9c', 'org_77b1', 'sk-ant-oat01-SECRETTOKEN', 'user-9d8e7f', 'Jane Person']

/**
 * An observation with a program's raw fields laid over it, as a careless driver might build one; the result still
 * types as the contract's observation, as it would reach `observe`.
 * @param base - a valid observation.
 * @param raw - the program's fields, which may replace the base's.
 * @returns the combined object.
 */
function withRawFields(base: AccountObservation, raw: Readonly<Record<string, unknown>>): AccountObservation {
  return Object.assign({}, base, raw)
}

/**
 * An observation as a careless driver might build it: the program's whole reply spread in beside the allowed fields.
 * @returns the observation, typed as the contract's.
 */
function observationFullOfPersonalFields(): AccountObservation {
  const claudeAccountInfo = { email: PERSONAL[0], organization: PERSONAL[1], subscriptionType: 'max', apiProvider: 'firstParty', tokenSource: 'claude.ai', accountUuid: PERSONAL[2] }
  return withRawFields({ provider: 'claude-code', signedIn: 'yes', plan: 'max', source: 'probe', windows: [] }, {
    ...claudeAccountInfo,
    accessToken: PERSONAL[4],
    windows: [
      { kind: 'five-hour', usedPercent: 12, resetsAt: 1_900_000_000_000, status: 'allowed', organizationId: PERSONAL[3], email: PERSONAL[0] },
      { kind: 'seven-day', usedPercent: 46, resetsAt: 1_900_100_000_000, status: 'near', accountId: PERSONAL[2] },
      { kind: PERSONAL[0], usedPercent: 1, status: 'allowed' },
    ],
    offeredModels: [
      { id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', isDefault: false, owner: PERSONAL[5] },
      { id: 'private-model', displayName: `Shared by ${PERSONAL[0]}`, isDefault: false },
    ],
    user: { name: PERSONAL[6], id: PERSONAL[5] },
  })
}

/** Every field name the accounts file may hold. */
const STORED_KEYS = new Set(['v', 'accounts', 'claude-code', 'codex', 'signedIn', 'plan', 'windows', 'kind', 'usedPercent', 'resetsAt', 'status', 'seenAt', 'source', 'offeredModels', 'id', 'displayName', 'isDefault', 'checkedAt', 'checkFailedAt'])

/**
 * @param value - parsed JSON.
 * @returns every object key at any depth.
 */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf)
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)])
}

describe('an observation', () => {
  it('keeps only the allowed fields of a reply full of personal ones, so none reaches the file', async () => {
    const sanitised = sanitiseObservation(observationFullOfPersonalFields())
    expect(sanitised).toEqual({
      provider: 'claude-code',
      signedIn: 'yes',
      plan: 'max',
      source: 'probe',
      windows: [
        { kind: 'five-hour', usedPercent: 12, resetsAt: 1_900_000_000_000, status: 'allowed' },
        { kind: 'seven-day', usedPercent: 46, resetsAt: 1_900_100_000_000, status: 'near' },
      ],
      offeredModels: [{ id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', isDefault: false }],
    })
    const path = accountsFilePath(home())
    await writeAccountsFile(path, { v: ACCOUNTS_FILE_VERSION, accounts: { 'claude-code': mergeObservation(undefined, sanitised, 1_000) } })
    const text = readFileSync(path, 'utf8')
    for (const value of PERSONAL) expect(text, value).not.toContain(value)
    expect(keysOf(JSON.parse(text)).filter(key => !STORED_KEYS.has(key))).toEqual([])
  })

  it('drops a plan name that could hold an address, a bad window on its own, a repeated kind and windows past the limit', () => {
    const observation = withRawFields({ provider: 'codex', signedIn: 'unknown', windows: [], source: 'run' }, {
      signedIn: 'maybe', plan: 'person@example.com', source: 'run',
      windows: [
        { kind: 'five-hour', usedPercent: 150, status: 'reached' },
        { kind: 'five-hour', usedPercent: 3, status: 'allowed' },
        { kind: 'seven-day', usedPercent: -1, status: 'allowed' },
        { kind: 'seven-day', usedPercent: 5, resetsAt: 1.5, status: 'allowed' },
        { kind: 'seven-day', status: 'gone' },
        ...Array.from({ length: MAX_WINDOWS + 4 }, (_, index) => ({ kind: `${String(index + 1)}-minute`, status: 'unknown' })),
      ],
    })
    const sanitised = sanitiseObservation(observation)
    expect(sanitised.plan).toBeUndefined()
    expect(sanitised.signedIn).toBe('unknown')
    expect(sanitised.windows[0]).toEqual({ kind: 'five-hour', usedPercent: 100, status: 'reached' })
    expect(sanitised.windows.filter(window => window.kind === 'five-hour')).toHaveLength(1)
    expect(sanitised.windows.some(window => window.kind === 'seven-day')).toBe(false)
    expect(sanitised.windows.length).toBeLessThanOrEqual(MAX_WINDOWS)
    expect(sanitised).not.toHaveProperty('offeredModels')
  })
})

describe('folding observations', () => {
  const probe = (windows: AccountObservation['windows'], extra: Partial<AccountObservation> = {}) =>
    sanitiseObservation({ provider: 'claude-code', signedIn: 'yes', windows, source: 'probe', ...extra })

  it('records when each window was seen and by what, and when a check last answered', () => {
    const account = mergeObservation(undefined, probe([{ kind: 'five-hour', usedPercent: 10, status: 'allowed' }], { plan: 'pro' }), 100)
    expect(account).toEqual({
      signedIn: 'yes', plan: 'pro', checkedAt: 100,
      windows: [{ kind: 'five-hour', usedPercent: 10, status: 'allowed', seenAt: 100, source: 'probe' }],
    })
  })

  it('replaces a window of the same kind, keeps windows not named and a sign-in answer an unknown one does not replace', () => {
    const first = mergeObservation(undefined, probe([{ kind: 'five-hour', usedPercent: 10, status: 'allowed' }, { kind: 'seven-day', usedPercent: 40, status: 'allowed' }]), 100)
    const run = sanitiseObservation({ provider: 'claude-code', signedIn: 'unknown', windows: [{ kind: 'five-hour', usedPercent: 100, resetsAt: 900, status: 'reached' }], source: 'run' })
    const second = mergeObservation(first, run, 200)
    expect(second.signedIn).toBe('yes')
    expect(second.checkedAt).toBe(100)
    expect(second.windows).toEqual([
      { kind: 'five-hour', usedPercent: 100, resetsAt: 900, status: 'reached', seenAt: 200, source: 'run' },
      { kind: 'seven-day', usedPercent: 40, status: 'allowed', seenAt: 100, source: 'probe' },
    ])
  })

  it('keeps a window seen later than the observation folded in', () => {
    const later = mergeObservation(undefined, probe([{ kind: 'five-hour', usedPercent: 50, status: 'allowed' }]), 500)
    const older = mergeObservation(later, probe([{ kind: 'five-hour', usedPercent: 5, status: 'allowed' }], { signedIn: 'no' }), 300)
    expect(older.windows).toEqual([{ kind: 'five-hour', usedPercent: 50, status: 'allowed', seenAt: 500, source: 'probe' }])
    expect(older.signedIn).toBe('no')
  })
})

describe('the accounts file', () => {
  it('lives under the home\'s protected secrets folder', () => {
    expect(accountsFilePath('/h')).toBe(join('/h', 'secrets', 'external-agents', 'accounts.json'))
  })

  it('reads as no figures while it does not exist, and round-trips at mode 0600 in a 0700 folder', async () => {
    const path = accountsFilePath(home())
    expect(await readAccountsFile(path)).toEqual({ kind: 'readable', file: { v: 1, accounts: {} } })
    const file = { v: ACCOUNTS_FILE_VERSION, accounts: { codex: { signedIn: 'no' as const, windows: [] } } }
    await writeAccountsFile(path, file)
    expect(await readAccountsFile(path)).toEqual({ kind: 'readable', file })
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700)
    }
  })

  it('reads a corrupt file, another version or a lax file as unreadable', async () => {
    const path = accountsFilePath(home())
    mkdirSync(join(path, '..'), { recursive: true })
    for (const text of ['{not json', JSON.stringify({ v: 2, accounts: {} }), JSON.stringify({ v: 1, accounts: { codex: { signedIn: 'yes' } } })]) {
      writeFileSync(path, text, { mode: 0o600 })
      expect((await readAccountsFile(path)).kind, text).toBe('unreadable')
    }
    if (process.platform !== 'win32') {
      writeFileSync(path, JSON.stringify({ v: 1, accounts: {} }))
      chmodSync(path, 0o644)
      expect((await readAccountsFile(path)).kind).toBe('unreadable')
    }
  })

  it('drops fields this version does not know and providers it does not keep', () => {
    const text = JSON.stringify({ v: 1, accounts: { codex: { signedIn: 'yes', windows: [], email: 'person@example.com' }, other: { signedIn: 'yes', windows: [] } } })
    expect(parseAccountsFile(text)).toEqual({ v: 1, accounts: { codex: { signedIn: 'yes', windows: [] } } })
  })

  it('words a failure that is not an Error as text', () => {
    expect(problemOf(new Error('gone'))).toBe('gone')
    expect(problemOf('gone')).toBe('gone')
  })
})
