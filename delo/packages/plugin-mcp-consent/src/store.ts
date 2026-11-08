/**
 * The acceptance store of Delo's MCP add-time consent: one JSON file in the
 * Delo home's protected state. C1's protected files carry mode 0600 and are
 * read through the refusal rule, and this one lives under the home's
 * `secrets/` directory, which the sandbox's confinement rules deny to confined
 * commands — a command an acceptance would let run outside the agent sandbox
 * can neither read the list nor add itself to it. The store's entries are
 * keyed by the command; one entry holds the argument list that was accepted
 * with that command and when it was accepted.
 *
 * The module is free of Cordis, so the store's format, its refusals and its
 * file handling are testable without a mounted plugin.
 *
 * @module @delo/plugin-mcp-consent/store
 */
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DELO_HOME_ENTRIES, PRIVATE_DIR_MODE } from '@delo/contract-home-layout'
import { readProtectedFile, writeProtectedFile } from '@delo/home'

/** Format version of the acceptance store. */
export const ACCEPTANCE_STORE_VERSION = 1 as const

/** Directory of the acceptance store under the home's `secrets/` directory. */
export const ACCEPTANCE_STORE_DIR = 'mcp-add-consent'

/** File name of the acceptance store inside its directory. */
export const ACCEPTANCE_STORE_FILE = 'acceptances.json'

/** One accepted command: the argument list accepted with it, and when. */
export interface AcceptedCommand {
  /** The arguments the command was accepted with, in the configured order. */
  readonly args: readonly string[]
  /** When the acceptance was recorded, in milliseconds since the epoch. */
  readonly acceptedAt: number
}

/** Why a store that exists could not be read as this version's format. */
export class AcceptanceStoreError extends Error {
  /**
   * @param reason - what the store holds instead of this version's format.
   */
  constructor(reason: string) {
    super(reason)
    this.name = 'AcceptanceStoreError'
  }
}

/**
 * The store's path under a resolved Delo home: the home's `secrets/` directory (contract C1's protected state),
 * this plugin's own directory below it, and the store's file name.
 * @param home - the resolved Delo home.
 * @returns the absolute path.
 */
export function acceptanceStorePath(home: string): string {
  return join(home, DELO_HOME_ENTRIES.secrets, ACCEPTANCE_STORE_DIR, ACCEPTANCE_STORE_FILE)
}

/**
 * Whether a value is a list of argument strings.
 * @param value - the value to check.
 * @returns true when the value is an array whose every entry is a string.
 */
function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

/**
 * Whether a value is a plain JSON object.
 * @param value - the value to check.
 * @returns true when the value is an object and not an array or null.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * One acceptance as the store holds it.
 * @param command - the accepted command, named in the reason.
 * @param value - the store's value for it.
 * @returns the acceptance.
 * @throws {AcceptanceStoreError} when the value is not an object holding only the argument list and the acceptance
 *   time, with the right types.
 */
function acceptanceOf(command: string, value: unknown): AcceptedCommand {
  const named = `the acceptance of the command ${JSON.stringify(command)}`
  if (!isRecord(value)) throw new AcceptanceStoreError(`${named} is not an object`)
  const extra = Object.keys(value).filter(key => key !== 'args' && key !== 'acceptedAt')
  if (extra.length > 0) throw new AcceptanceStoreError(`${named} sets ${extra.join(', ')}`)
  if (!isStringList(value['args'])) throw new AcceptanceStoreError(`${named} does not hold a list of argument strings`)
  const acceptedAt = value['acceptedAt']
  if (typeof acceptedAt !== 'number' || !Number.isFinite(acceptedAt)) {
    throw new AcceptanceStoreError(`${named} does not hold a number acceptance time`)
  }
  return { args: value['args'], acceptedAt }
}

/**
 * Parse the store's text into its acceptances, keyed by command.
 * @param text - the store file's text.
 * @returns the acceptances.
 * @throws {AcceptanceStoreError} when the text is not this version's format: no JSON document, not an object, a
 *   version other than {@link ACCEPTANCE_STORE_VERSION}, an unknown field, or an acceptance whose fields are wrong.
 */
export function parseAcceptanceStore(text: string): ReadonlyMap<string, AcceptedCommand> {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    throw new AcceptanceStoreError('the store holds no JSON document')
  }
  if (!isRecord(document)) throw new AcceptanceStoreError('the store is not a JSON object')
  if (document['v'] !== ACCEPTANCE_STORE_VERSION) {
    throw new AcceptanceStoreError(`the store's version is ${JSON.stringify(document['v'])}, not ${String(ACCEPTANCE_STORE_VERSION)}`)
  }
  const extra = Object.keys(document).filter(key => key !== 'v' && key !== 'acceptances')
  if (extra.length > 0) throw new AcceptanceStoreError(`the store sets ${extra.join(', ')}`)
  if (!isRecord(document['acceptances'])) throw new AcceptanceStoreError('the store does not hold an acceptances object')
  const entries = new Map<string, AcceptedCommand>()
  for (const [command, value] of Object.entries(document['acceptances'])) {
    if (command.length === 0) throw new AcceptanceStoreError('the store holds an acceptance with an empty command')
    entries.set(command, acceptanceOf(command, value))
  }
  return entries
}

/**
 * The store's text for a set of acceptances: one JSON object whose acceptances are sorted by command, with a
 * trailing newline.
 * @param entries - the acceptances, keyed by command.
 * @returns the text to write.
 */
export function serializeAcceptanceStore(entries: ReadonlyMap<string, AcceptedCommand>): string {
  const acceptances: Record<string, AcceptedCommand> = {}
  for (const command of [...entries.keys()].sort()) {
    const accepted = entries.get(command)
    if (accepted !== undefined) acceptances[command] = { args: [...accepted.args], acceptedAt: accepted.acceptedAt }
  }
  return `${JSON.stringify({ v: ACCEPTANCE_STORE_VERSION, acceptances }, null, 2)}\n`
}

/** What reading the store found. */
export type AcceptanceStoreRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'readable', readonly entries: ReadonlyMap<string, AcceptedCommand> }
  | { readonly kind: 'refused', readonly problem: string }

/**
 * Whether a failure is the missing store, which is no refusal: a home without an acceptance store has accepted
 * nothing yet.
 * @param error - the failure of the read.
 * @returns true when the failure reports `ENOENT`.
 */
function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * The reason a failed read gives, in its own words. The refusal message may reach the person, and the path it may
 * name is the person's own store.
 * @param error - the failure of the read.
 * @returns the failure's message, or a plain one when it has none.
 */
function problemOf(error: unknown): string {
  return error instanceof Error ? error.message : 'the file could not be read'
}

/**
 * Read the store from its path, applying contract C1's protected-file refusal rule.
 * @param path - the store's absolute path.
 * @returns `absent` while no store exists, `readable` with its acceptances, or `refused` with the reason a store
 *   that exists could not be read as this version's format — a laxer mode, a symbolic link, another format, or a
 *   filesystem failure.
 */
export async function readAcceptanceStore(path: string): Promise<AcceptanceStoreRead> {
  let bytes: Buffer
  try {
    bytes = await readProtectedFile(path)
  } catch (error) {
    if (isMissing(error)) return { kind: 'absent' }
    return { kind: 'refused', problem: problemOf(error) }
  }
  try {
    return { kind: 'readable', entries: parseAcceptanceStore(bytes.toString('utf8')) }
  } catch (error) {
    return { kind: 'refused', problem: problemOf(error) }
  }
}

/**
 * Write the store at its path through contract C1's protected-file write: a sibling temporary file at mode 0600,
 * flushed and renamed over the path. The store's directory is created at the private directory mode when missing.
 * @param path - the store's absolute path.
 * @param entries - the acceptances to write, keyed by command.
 */
export async function writeAcceptanceStore(path: string, entries: ReadonlyMap<string, AcceptedCommand>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE })
  await writeProtectedFile(path, serializeAcceptanceStore(entries))
}

/**
 * Whether an acceptance's argument list is the one under review, element for element and in order.
 * @param accepted - the accepted argument list.
 * @param current - the argument list under review.
 * @returns true when both lists hold the same arguments in the same order.
 */
export function sameArgs(accepted: readonly string[], current: readonly string[]): boolean {
  return accepted.length === current.length && accepted.every((argument, index) => argument === current[index])
}
