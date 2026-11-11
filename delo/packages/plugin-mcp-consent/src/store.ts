/**
 * The acceptance store of Delo's MCP add-time consent: one JSON file in the
 * Delo home's protected state. C1's protected files carry mode 0600 and are
 * read through the refusal rule, and this one lives under the home's
 * `secrets/` directory, which the sandbox's confinement rules deny to confined
 * commands — a command an acceptance would let run outside the agent sandbox
 * can neither read the list nor add itself to it. The store's entries are
 * keyed by the command; one entry holds what was accepted with that command —
 * the argument list, the configured working directory, the absolute
 * executable path and canonical working directory they resolved to, and the
 * configured environment as its variable names and a SHA-256 digest of the
 * names and values, never the values themselves — and when it was accepted. A
 * store of version 1, written before an acceptance covered the working
 * directory and the environment, or of version 2, written before it covered
 * the resolved executable path and working directory, is superseded: none of
 * its acceptances counts.
 *
 * The module is free of Cordis, so the store's format, its refusals and its
 * file handling are testable without a mounted plugin.
 *
 * @module @delo/plugin-mcp-consent/store
 */
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { sortedEnvEntries } from '@deepseek-ai/dsh-mcp-client'
import type { McpServerCommand } from '@deepseek-ai/dsh-mcp-client'
import { DELO_HOME_ENTRIES, PRIVATE_DIR_MODE } from '@delo/contract-home-layout'
import { readProtectedFile, writeProtectedFile } from '@delo/home'

/** Format version of the acceptance store. */
export const ACCEPTANCE_STORE_VERSION = 3 as const

/**
 * Format versions written before an acceptance covered everything a review compares: version 1 held no working
 * directory or environment, and version 2 no resolved executable path or working directory. A store of one of them is
 * superseded: none of its acceptances counts, and the next acceptance starts a store of this version.
 */
export const SUPERSEDED_STORE_VERSIONS: readonly number[] = [1, 2]

/** Directory of the acceptance store under the home's `secrets/` directory. */
export const ACCEPTANCE_STORE_DIR = 'mcp-add-consent'

/** File name of the acceptance store inside its directory. */
export const ACCEPTANCE_STORE_FILE = 'acceptances.json'

/** A server start as an acceptance judges it: everything a review is shown except the server's namespace. */
export type ServerStart = Omit<McpServerCommand, 'serverName'>

/**
 * One accepted command: the argument list, working directory, resolved executable path and working directory, and
 * environment accepted with it, and when.
 */
export interface AcceptedCommand {
  /** The arguments the command was accepted with, in the configured order. */
  readonly args: readonly string[]
  /** The configured working directory the command was accepted with; the empty string is the Host's working directory. */
  readonly cwd: string
  /** The absolute path of the executable the command resolved to when it was accepted. */
  readonly resolvedCommand: string
  /** The canonical working directory the command was accepted to run in. */
  readonly resolvedCwd: string
  /** The names of the configured environment variables the command was accepted with, sorted. */
  readonly envNames: readonly string[]
  /** {@link envDigest} of the configured environment the command was accepted with. */
  readonly envDigest: string
  /** When the acceptance was recorded, in milliseconds since the epoch. */
  readonly acceptedAt: number
}

/** The fields of one acceptance in the store's format, in the order they are written. */
const ACCEPTANCE_FIELDS: readonly string[] = ['args', 'cwd', 'resolvedCommand', 'resolvedCwd', 'envNames', 'envDigest', 'acceptedAt']

/** The text of an environment digest: the algorithm and 64 lowercase hexadecimal digits. */
const ENV_DIGEST = /^sha256:[0-9a-f]{64}$/

/**
 * The digest an acceptance keeps of a configured environment: SHA-256 of the JSON text of its `[name, value]` pairs
 * sorted by name, so equal environments have equal digests whatever order their keys were written in, and the store
 * holds no value in plain text.
 * @param env - the configured environment entries.
 * @returns `sha256:` and the hexadecimal digest.
 */
export function envDigest(env: Readonly<Record<string, string>>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(sortedEnvEntries(env))).digest('hex')}`
}

/**
 * The acceptance of a server start, recorded at a time.
 * @param start - the accepted start.
 * @param acceptedAt - when it was accepted, in milliseconds since the epoch.
 * @returns the acceptance the store holds for the start's command.
 */
export function acceptanceOfStart(start: ServerStart, acceptedAt: number): AcceptedCommand {
  return {
    args: [...start.args],
    cwd: start.cwd,
    resolvedCommand: start.resolvedCommand,
    resolvedCwd: start.resolvedCwd,
    envNames: sortedEnvEntries(start.env).map(([name]) => name),
    envDigest: envDigest(start.env),
    acceptedAt,
  }
}

/**
 * Why an acceptance does not cover a server start of its command, in words that name no environment value.
 * @param accepted - the command's acceptance.
 * @param start - the start under review.
 * @returns the reason, or `undefined` when the acceptance covers the start.
 */
export function mismatchOf(accepted: AcceptedCommand, start: ServerStart): string | undefined {
  if (!sameArgs(accepted.args, start.args)) return 'the person accepted a different argument list with this command'
  if (accepted.cwd !== start.cwd) return 'the person accepted this command with a different working directory'
  if (accepted.resolvedCwd !== start.resolvedCwd) {
    return `the working directory resolves to ${JSON.stringify(start.resolvedCwd)}, and the person accepted this command run in ${JSON.stringify(accepted.resolvedCwd)}`
  }
  if (accepted.resolvedCommand !== start.resolvedCommand) {
    return `the command resolves to the executable ${JSON.stringify(start.resolvedCommand)}, and the person accepted ${JSON.stringify(accepted.resolvedCommand)}`
  }
  if (accepted.envDigest !== envDigest(start.env)) return 'the person accepted this command with different environment variables or values'
  return undefined
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

/** A store of a {@link SUPERSEDED_STORE_VERSIONS} version, whose acceptances do not count. */
export class SupersededStoreError extends AcceptanceStoreError {
  /** The store's version. */
  readonly version: number

  /**
   * @param version - the store's superseded version.
   */
  constructor(version: number) {
    super(`the store's version is ${String(version)}, written before an acceptance covered the resolved executable path and working directory`)
    this.name = 'SupersededStoreError'
    this.version = version
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
 * @throws {AcceptanceStoreError} when the value is not an object holding only the argument list, the working
 *   directory, the absolute resolved executable path and working directory, the environment's names and digest, and
 *   the acceptance time, with the right types.
 */
function acceptanceOf(command: string, value: unknown): AcceptedCommand {
  const named = `the acceptance of the command ${JSON.stringify(command)}`
  if (!isRecord(value)) throw new AcceptanceStoreError(`${named} is not an object`)
  const extra = Object.keys(value).filter(key => !ACCEPTANCE_FIELDS.includes(key))
  if (extra.length > 0) throw new AcceptanceStoreError(`${named} sets ${extra.join(', ')}`)
  const { args, cwd, resolvedCommand, resolvedCwd, envNames, envDigest: digest, acceptedAt } = value
  if (!isStringList(args)) throw new AcceptanceStoreError(`${named} does not hold a list of argument strings`)
  if (typeof cwd !== 'string') throw new AcceptanceStoreError(`${named} does not hold a working directory string`)
  if (typeof resolvedCommand !== 'string' || !isAbsolute(resolvedCommand)) {
    throw new AcceptanceStoreError(`${named} does not hold an absolute resolved executable path`)
  }
  if (typeof resolvedCwd !== 'string' || !isAbsolute(resolvedCwd)) {
    throw new AcceptanceStoreError(`${named} does not hold an absolute resolved working directory`)
  }
  if (!isStringList(envNames)) throw new AcceptanceStoreError(`${named} does not hold a list of environment variable names`)
  if (typeof digest !== 'string' || !ENV_DIGEST.test(digest)) {
    throw new AcceptanceStoreError(`${named} does not hold a sha256 environment digest`)
  }
  if (typeof acceptedAt !== 'number' || !Number.isFinite(acceptedAt)) {
    throw new AcceptanceStoreError(`${named} does not hold a number acceptance time`)
  }
  return { args, cwd, resolvedCommand, resolvedCwd, envNames, envDigest: digest, acceptedAt }
}

/**
 * Parse the store's text into its acceptances, keyed by command.
 * @param text - the store file's text.
 * @returns the acceptances.
 * @throws {SupersededStoreError} when the store is of a {@link SUPERSEDED_STORE_VERSIONS} version.
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
  const version = document['v']
  if (typeof version === 'number' && SUPERSEDED_STORE_VERSIONS.includes(version)) throw new SupersededStoreError(version)
  if (version !== ACCEPTANCE_STORE_VERSION) {
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
    if (accepted !== undefined) {
      acceptances[command] = {
        args: [...accepted.args],
        cwd: accepted.cwd,
        resolvedCommand: accepted.resolvedCommand,
        resolvedCwd: accepted.resolvedCwd,
        envNames: [...accepted.envNames],
        envDigest: accepted.envDigest,
        acceptedAt: accepted.acceptedAt,
      }
    }
  }
  return `${JSON.stringify({ v: ACCEPTANCE_STORE_VERSION, acceptances }, null, 2)}\n`
}

/** What reading the store found. */
export type AcceptanceStoreRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'readable', readonly entries: ReadonlyMap<string, AcceptedCommand> }
  | { readonly kind: 'superseded', readonly version: number }
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
 * @returns `absent` while no store exists, `readable` with its acceptances, `superseded` with the version of a store
 *   written before an acceptance covered everything a review compares, or `refused` with the reason a
 *   store that exists could not be read as this version's format — a laxer mode, a symbolic link, another format, or
 *   a filesystem failure.
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
    if (error instanceof SupersededStoreError) return { kind: 'superseded', version: error.version }
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
