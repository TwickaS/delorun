/**
 * The external agents' account figures: one JSON file per Delorun home, `secrets/external-agents/accounts.json`, mode
 * 0600 under the home's `secrets/` directory, which confined commands can neither read nor write, so a command a model
 * runs cannot plant a reached limit that refuses every start.
 *
 * The file holds, per provider, whether the program said it is signed in, the plan's name, each limit window's used
 * percentage and reset time with when it was seen and by which source, the models the program offers, and when the
 * last check ran. Nothing else a program returns is kept: an observation passes {@link sanitiseObservation}, which
 * keeps only those fields, each within a fixed character set and length, so an email, organisation name, account id
 * or token in a program's reply never reaches the file (A298).
 *
 * A file that cannot be read or is not this version's format reads as no figures: nothing refuses, and the next
 * observation rewrites it whole. Free of Cordis, so the format is testable without a mounted plugin.
 *
 * @module @delorun/external-agents/accounts/store
 */
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { DELORUN_HOME_ENTRIES } from '@delorun/contract-home-layout'
import { readProtectedFile, writeProtectedFile } from '@delorun/home'
import { z } from 'zod'
import type { AccountObservation, ExternalAgentName } from '../contract.ts'
import { ACCOUNT_PROVIDERS, type AccountsAnswer, type AccountState, type AccountsFile, type RefreshAnswer, type StoredWindow } from './wire.ts'

/** Format version of the accounts file. */
export const ACCOUNTS_FILE_VERSION = 1 as const

/** The largest accounts file read, in bytes; a larger one reads as no figures. */
export const ACCOUNTS_FILE_MAX_BYTES = 256 * 1024

/** The most limit windows kept per provider; an observation's further windows are dropped. */
export const MAX_WINDOWS = 16

/** The most offered models kept per provider. */
export const MAX_OFFERED_MODELS = 64

/** Mode of the `secrets/external-agents/` directory. */
const PRIVATE_DIR_MODE = 0o700

/** An account nothing has been seen for. */
export const UNKNOWN_ACCOUNT: AccountState = { signedIn: 'unknown', windows: [] }

const Kind = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/u)
const Plan = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,47}$/u)
const ModelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u)
// A display name is free text from the program; no control characters and no `@`, so no address passes as one.
const ModelName = z.string().regex(/^[^\u0000-\u001f\u007f@]{1,128}$/u)
const Percent = z.number().finite().min(0).transform(value => Math.min(value, 100))
const Time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const SignedIn = z.enum(['yes', 'no', 'unknown'])
const Status = z.enum(['allowed', 'near', 'reached', 'unknown'])
const Source = z.enum(['run', 'probe'])

const ObservedWindow = z.object({ kind: Kind, usedPercent: Percent.exactOptional(), resetsAt: Time.exactOptional(), status: Status })
const OfferedModelItem = z.object({ id: ModelId, displayName: ModelName, isDefault: z.boolean() })

const StoredWindowItem = ObservedWindow.extend({ seenAt: Time, source: Source })
const AccountItem = z.object({
  signedIn: SignedIn,
  plan: Plan.exactOptional(),
  windows: z.array(StoredWindowItem).max(MAX_WINDOWS),
  offeredModels: z.array(OfferedModelItem).max(MAX_OFFERED_MODELS).exactOptional(),
  checkedAt: Time.exactOptional(),
  checkFailedAt: Time.exactOptional(),
})
const AccountsFileItem = z.object({
  v: z.literal(ACCOUNTS_FILE_VERSION),
  accounts: z.object({ 'claude-code': AccountItem.exactOptional(), codex: AccountItem.exactOptional() }),
})

const AccountViewItem = AccountItem.extend({ provider: z.enum(ACCOUNT_PROVIDERS), installed: z.boolean() })
const AccountsAnswerItem = z.object({ accounts: z.array(AccountViewItem).max(ACCOUNT_PROVIDERS.length), now: Time })
const Problem = z.string().max(2048)
const RefreshAnswerItem = z.object({
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('checked') }),
    z.object({ kind: z.literal('failed'), problem: Problem }),
    z.object({ kind: z.literal('throttled'), nextAt: Time }),
    z.object({ kind: z.literal('not-installed') }),
    z.object({ kind: z.literal('refused'), problem: Problem }),
  ]),
  account: AccountViewItem,
  now: Time,
})

/**
 * Read an `agents.accounts` answer that crossed a process boundary, such as the update channel's final line.
 * @param value - the answer's fields.
 * @returns the answer, or undefined when it is not one; fields this version does not know are dropped.
 */
export function parseAccountsAnswer(value: unknown): AccountsAnswer | undefined {
  const parsed = AccountsAnswerItem.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/**
 * Read an `agents.refresh` answer that crossed a process boundary.
 * @param value - the answer's fields.
 * @returns the answer, or undefined when it is not one; fields this version does not know are dropped.
 */
export function parseRefreshAnswer(value: unknown): RefreshAnswer | undefined {
  const parsed = RefreshAnswerItem.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** An observation after {@link sanitiseObservation}: only the fields the file may hold. */
export interface SanitisedObservation {
  /** The provider. */
  readonly provider: ExternalAgentName
  /** Whether the program said it is signed in. */
  readonly signedIn: 'yes' | 'no' | 'unknown'
  /** The plan's name, when it passed the plan-name check. */
  readonly plan?: string
  /** The windows that passed their checks, at most {@link MAX_WINDOWS}, one per kind. */
  readonly windows: readonly Omit<StoredWindow, 'seenAt' | 'source'>[]
  /** The offered models that passed their checks, when the observation named any. */
  readonly offeredModels?: AccountState['offeredModels']
  /** Where the figures came from. */
  readonly source: 'run' | 'probe'
}

/**
 * The parsed items of a list that pass a schema; the others are dropped.
 * @param items - the list, or anything else (read as empty).
 * @param schema - the item schema.
 * @param limit - the most items kept.
 * @returns the items that passed, in order.
 */
function passing<T>(items: unknown, schema: z.ZodType<T>, limit: number): T[] {
  if (!Array.isArray(items)) return []
  const kept: T[] = []
  for (const item of items) {
    const parsed = schema.safeParse(item)
    if (parsed.success && kept.length < limit) kept.push(parsed.data)
  }
  return kept
}

/**
 * Keep only what the accounts file may hold from an observation a driver reported. Every field is rebuilt from the
 * checked value, so a field the program added, such as an email or an organisation name, is dropped whatever the
 * object carries; a value that fails its check is dropped on its own and the rest is kept.
 * @param observation - the observation as the driver reported it.
 * @returns the observation's allowed fields.
 */
export function sanitiseObservation(observation: AccountObservation): SanitisedObservation {
  const plan = Plan.safeParse(observation.plan)
  const windows: Omit<StoredWindow, 'seenAt' | 'source'>[] = []
  for (const window of passing(observation.windows, ObservedWindow, MAX_WINDOWS)) {
    if (!windows.some(kept => kept.kind === window.kind)) windows.push(window)
  }
  return {
    provider: observation.provider,
    signedIn: SignedIn.catch('unknown').parse(observation.signedIn),
    windows,
    source: Source.catch('run').parse(observation.source),
    ...present('plan', plan.success ? plan.data : undefined),
    ...present('offeredModels', observation.offeredModels === undefined ? undefined : passing(observation.offeredModels, OfferedModelItem, MAX_OFFERED_MODELS)),
  }
}

/**
 * One optional field, absent rather than present and undefined.
 * @param key - the field's name.
 * @param value - its value, or undefined.
 * @returns an object holding the field, or an empty one.
 */
function present<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  const field: { [P in K]?: V } = {}
  if (value !== undefined) field[key] = value
  return field
}

/**
 * Fold an observation into a provider's account. A known sign-in answer replaces the stored one and `unknown` keeps
 * it; a plan or offered-model list replaces the stored one; each window replaces the stored window of its kind unless
 * the stored one was seen later; windows the observation does not name stay as they were seen.
 * @param account - the stored account, or undefined when none is stored.
 * @param observation - the sanitised observation.
 * @param now - the time the observation was made, in milliseconds since the epoch.
 * @returns the account to store.
 */
export function mergeObservation(account: AccountState | undefined, observation: SanitisedObservation, now: number): AccountState {
  const previous = account ?? UNKNOWN_ACCOUNT
  const windows = new Map(previous.windows.map(window => [window.kind, window]))
  for (const window of observation.windows) {
    const stored = windows.get(window.kind)
    if (stored !== undefined && stored.seenAt > now) continue
    windows.set(window.kind, { ...window, seenAt: now, source: observation.source })
  }
  return {
    signedIn: observation.signedIn === 'unknown' ? previous.signedIn : observation.signedIn,
    windows: [...windows.values()].slice(0, MAX_WINDOWS),
    ...present('plan', observation.plan ?? previous.plan),
    ...present('offeredModels', observation.offeredModels ?? previous.offeredModels),
    ...present('checkedAt', observation.source === 'probe' ? now : previous.checkedAt),
    ...present('checkFailedAt', previous.checkFailedAt),
  }
}

/**
 * The accounts file's path under the home's protected `secrets/` directory.
 * @param home - the resolved Delorun home.
 * @returns the absolute path.
 */
export function accountsFilePath(home: string): string {
  return join(home, DELORUN_HOME_ENTRIES.secrets, 'external-agents', 'accounts.json')
}

/** What reading the accounts file found. */
export type AccountsRead =
  | { readonly kind: 'readable'; readonly file: AccountsFile }
  | { readonly kind: 'unreadable'; readonly problem: string }

/** An accounts file with no figures. */
export const EMPTY_ACCOUNTS: AccountsFile = { v: ACCOUNTS_FILE_VERSION, accounts: {} }

/**
 * Parse the accounts file's text. Fields this version does not know are dropped.
 * @param text - the file's text.
 * @returns the accounts.
 * @throws {Error} naming what is wrong when the text is not JSON or not this version's format.
 */
export function parseAccountsFile(text: string): AccountsFile {
  const parsed = AccountsFileItem.safeParse(JSON.parse(text))
  if (!parsed.success) throw new Error(`the file is not version ${String(ACCOUNTS_FILE_VERSION)} of the accounts format`)
  const accounts: Partial<Record<ExternalAgentName, AccountState>> = {}
  for (const provider of ACCOUNT_PROVIDERS) {
    const account = parsed.data.accounts[provider]
    if (account !== undefined) accounts[provider] = account
  }
  return { v: ACCOUNTS_FILE_VERSION, accounts }
}

/**
 * Read the accounts file through the protected-file checks.
 * @param path - the file's absolute path.
 * @returns the accounts (none while no file exists), or `unreadable` with the problem.
 */
export async function readAccountsFile(path: string): Promise<AccountsRead> {
  let bytes: Buffer
  try {
    bytes = await readProtectedFile(path, ACCOUNTS_FILE_MAX_BYTES)
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return { kind: 'readable', file: EMPTY_ACCOUNTS }
    return { kind: 'unreadable', problem: problemOf(error) }
  }
  try {
    return { kind: 'readable', file: parseAccountsFile(bytes.toString('utf8')) }
  } catch (error) {
    return { kind: 'unreadable', problem: problemOf(error) }
  }
}

/**
 * Write the accounts file whole, at mode 0600, creating its directory at mode 0700 when missing.
 * @param path - the file's absolute path.
 * @param file - the accounts.
 */
export async function writeAccountsFile(path: string, file: AccountsFile): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: PRIVATE_DIR_MODE })
  await writeProtectedFile(path, `${JSON.stringify(file, null, 2)}\n`)
}

/**
 * The words of a failed read or write.
 * @param error - the failure.
 * @returns its message, or the value as text when it is not an Error.
 */
export function problemOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
