/**
 * The acceptance store of Delo's MCP add-time consent: one JSON file in the
 * Delo home's protected state. C1's protected files carry mode 0600 and are
 * read through the refusal rule, and this one lives under the home's
 * `secrets/` directory, which the sandbox's confinement rules deny to confined
 * commands — a command an acceptance would let run outside the agent sandbox
 * can neither read the list nor add itself to it.
 *
 * A store of this version holds one acceptance per configured server name: the
 * whole start accepted for that server — the command, the argument list, the
 * configured working directory, the absolute executable path and canonical
 * working directory they resolved to, on Windows the canonical command shell
 * that runs a batch file, and a SHA-256 digest of each configured environment
 * variable's value, never the values themselves — and when it was accepted. It
 * also holds the starts the person set aside, declined or revoked, by server
 * name and start digest, and the command-keyed acceptances of a version 4
 * store, which never allow a start: a start that one of them covers exactly is
 * reviewed once as `upgraded`. A store of version 1, written before an
 * acceptance covered the working directory and the environment, of version 2,
 * written before it covered the resolved executable path and working
 * directory, or of version 3, written before it covered the command shell or
 * without them, is superseded: none of its acceptances counts.
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
import { SERVER_NAME_PATTERN } from './wire.ts'

/** Format version of the acceptance store. */
export const ACCEPTANCE_STORE_VERSION = 5 as const

/**
 * The format version whose acceptances were keyed by the command alone. A store of it is read as this version with
 * no acceptance, and its acceptances are kept as {@link AcceptanceStore.commandKeyed} records, which never allow a
 * start.
 */
export const COMMAND_KEYED_STORE_VERSION = 4 as const

/**
 * Format versions written before an acceptance covered everything a review compares: version 1 held no working
 * directory or environment, version 2 no resolved executable path or working directory, and version 3 no command
 * shell that runs a Windows batch file, or no resolved paths at all. A store of one of them is superseded: none of its
 * acceptances counts, and the next write starts a store of this version.
 */
export const SUPERSEDED_STORE_VERSIONS: readonly number[] = [1, 2, 3]

/** Directory of the acceptance store under the home's `secrets/` directory. */
export const ACCEPTANCE_STORE_DIR = 'mcp-add-consent'

/** File name of the acceptance store inside its directory. */
export const ACCEPTANCE_STORE_FILE = 'acceptances.json'

/** The length of an acceptance id: hexadecimal digits of a SHA-256. */
export const ACCEPTANCE_ID_LENGTH = 32

/** An acceptance id's form: {@link ACCEPTANCE_ID_LENGTH} lowercase hexadecimal digits. */
export const ACCEPTANCE_ID_PATTERN = /^[0-9a-f]{32}$/

/** A server start as an acceptance judges it: everything a review is shown except the server's namespace. */
export type ServerStart = Omit<McpServerCommand, 'serverName'>

/** A configured environment as the store keeps it: each variable's name and the digest of its value. */
export type EnvDigests = Readonly<Record<string, string>>

/** The accepted start of one server name. */
export interface ServerAcceptance {
  /** The accepted executable. */
  readonly command: string
  /** The accepted arguments, in the configured order. */
  readonly args: readonly string[]
  /** The accepted working directory; the empty string is the Host's working directory. */
  readonly cwd: string
  /** The absolute path of the executable the start resolved to when it was accepted. */
  readonly resolvedCommand: string
  /** The canonical working directory the start was accepted to run in. */
  readonly resolvedCwd: string
  /**
   * The canonical path of the command shell accepted to run a Windows batch file; absent when the executable runs
   * directly, and then absent from the store's text.
   */
  readonly resolvedShell?: string
  /** {@link envDigests} of the accepted environment. */
  readonly env: EnvDigests
  /** When the acceptance was recorded, in milliseconds since the epoch. */
  readonly acceptedAt: number
}

/** One acceptance of a version 4 store, keyed by its command; it never allows a start. */
export interface CommandKeyedAcceptance {
  /** The arguments the command was accepted with, in the configured order. */
  readonly args: readonly string[]
  /** The working directory the command was accepted with. */
  readonly cwd: string
  /** The absolute path of the executable the command resolved to. */
  readonly resolvedCommand: string
  /** The canonical working directory the command was accepted to run in. */
  readonly resolvedCwd: string
  /** The canonical command shell accepted to run a Windows batch file; absent when the executable runs directly. */
  readonly resolvedShell?: string
  /** The names of the configured environment variables the command was accepted with, sorted. */
  readonly envNames: readonly string[]
  /** {@link envDigest} of the configured environment the command was accepted with. */
  readonly envDigest: string
  /** When the acceptance was recorded, in milliseconds since the epoch. */
  readonly acceptedAt: number
}

/** How the person set a server's start aside. */
export type SetAsideState = 'declined' | 'revoked'

/** A start the person set aside for one server name, which stays stopped without a waiting review. */
export interface SetAsideStart {
  /** Whether the person declined the start's review or revoked its acceptance. */
  readonly state: SetAsideState
  /** {@link startDigest} of the start set aside; another start of the server waits for an answer. */
  readonly start: string
}

/** The store's content. */
export interface AcceptanceStore {
  /** The accepted starts, keyed by server name. */
  readonly acceptances: ReadonlyMap<string, ServerAcceptance>
  /** The starts set aside, keyed by server name. */
  readonly setAside: ReadonlyMap<string, SetAsideStart>
  /** The acceptances of a version 4 store, keyed by command, until a start each covers is accepted. */
  readonly commandKeyed: ReadonlyMap<string, CommandKeyedAcceptance>
}

/** A store with nothing in it. */
export const EMPTY_ACCEPTANCE_STORE: AcceptanceStore = { acceptances: new Map(), setAside: new Map(), commandKeyed: new Map() }

/** The fields of one acceptance in the store's format, in the order they are written. */
const ACCEPTANCE_FIELDS: readonly string[] = ['command', 'args', 'cwd', 'resolvedCommand', 'resolvedCwd', 'resolvedShell', 'env', 'acceptedAt']

/** The fields of one version 4 acceptance, in the order they are written. */
const COMMAND_KEYED_FIELDS: readonly string[] = ['args', 'cwd', 'resolvedCommand', 'resolvedCwd', 'resolvedShell', 'envNames', 'envDigest', 'acceptedAt']

/** The fields of one set-aside start, in the order they are written. */
const SET_ASIDE_FIELDS: readonly string[] = ['state', 'start']

/** The fields of a store of this version. */
const STORE_FIELDS: readonly string[] = ['v', 'acceptances', 'setAside', 'commandKeyed']

/** The text of a digest: the algorithm and 64 lowercase hexadecimal digits. */
const DIGEST = /^sha256:[0-9a-f]{64}$/

/**
 * The digest of a text: `sha256:` and 64 hexadecimal digits.
 * @param text - the text.
 * @returns the digest.
 */
function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

/**
 * The digest a version 4 acceptance kept of a configured environment: SHA-256 of the JSON text of its `[name, value]`
 * pairs sorted by name, so equal environments have equal digests whatever order their keys were written in. A review
 * id carries it, and a version 4 acceptance is compared with it.
 * @param env - the configured environment entries.
 * @returns `sha256:` and the hexadecimal digest.
 */
export function envDigest(env: Readonly<Record<string, string>>): string {
  return sha256(JSON.stringify(sortedEnvEntries(env)))
}

/**
 * The digests an acceptance keeps of a configured environment: for each variable, sorted by name, SHA-256 of the JSON
 * text of its `[name, value]` pair, so a review names exactly which variables changed and the store holds no value in
 * plain text.
 * @param env - the configured environment entries.
 * @returns each name with its value's digest.
 */
export function envDigests(env: Readonly<Record<string, string>>): EnvDigests {
  return Object.fromEntries(sortedEnvEntries(env).map(([name, value]) => [name, sha256(JSON.stringify([name, value]))]))
}

/**
 * The digest of a whole start as an acceptance holds it: its command, arguments, working directory, the paths they
 * resolved to and its environment digests.
 * @param start - the start, its environment already digested.
 * @returns `sha256:` and the hexadecimal digest.
 */
function digestOf(start: Omit<ServerAcceptance, 'acceptedAt'>): string {
  const env = sortedEnvEntries(start.env)
  return sha256(JSON.stringify([start.command, start.args, start.cwd, start.resolvedCommand, start.resolvedCwd, start.resolvedShell ?? null, env]))
}

/**
 * The digest of a whole server start: its command, arguments, working directory, the executable path, working
 * directory and command shell they resolved to, and each environment variable's digest.
 * @param start - the start.
 * @returns `sha256:` and the hexadecimal digest.
 */
export function startDigest(start: ServerStart): string {
  return digestOf({ ...resolvedPathsOf(start), command: start.command, args: start.args, cwd: start.cwd, env: envDigests(start.env) })
}

/**
 * The resolved paths of a start, with no `resolvedShell` key for an executable that runs directly.
 * @param start - the start or acceptance.
 * @returns its resolved executable path, working directory and command shell.
 */
function resolvedPathsOf(start: Pick<ServerStart, 'resolvedCommand' | 'resolvedCwd' | 'resolvedShell'>): Pick<ServerStart, 'resolvedCommand' | 'resolvedCwd' | 'resolvedShell'> {
  return {
    resolvedCommand: start.resolvedCommand,
    resolvedCwd: start.resolvedCwd,
    ...start.resolvedShell === undefined ? {} : { resolvedShell: start.resolvedShell },
  }
}

/**
 * The id of one server name's acceptance: a digest of the server name and the whole accepted start, so accepting
 * another start of the server gives another id.
 * @param serverName - the server name.
 * @param accepted - its acceptance.
 * @returns {@link ACCEPTANCE_ID_LENGTH} hexadecimal digits.
 */
export function acceptanceIdOf(serverName: string, accepted: ServerAcceptance): string {
  return createHash('sha256').update(JSON.stringify(['acceptance', serverName, digestOf(accepted)])).digest('hex').slice(0, ACCEPTANCE_ID_LENGTH)
}

/**
 * The digest of the start an acceptance holds, as {@link startDigest} gives it for that start.
 * @param accepted - the acceptance.
 * @returns `sha256:` and the hexadecimal digest.
 */
export function acceptedStartDigest(accepted: ServerAcceptance): string {
  return digestOf(accepted)
}

/**
 * The acceptance of a server start, recorded at a time.
 * @param start - the accepted start.
 * @param acceptedAt - when it was accepted, in milliseconds since the epoch.
 * @returns the acceptance the store holds for the start's server name.
 */
export function acceptanceOfStart(start: ServerStart, acceptedAt: number): ServerAcceptance {
  return { command: start.command, args: [...start.args], cwd: start.cwd, ...resolvedPathsOf(start), env: envDigests(start.env), acceptedAt }
}

/** The part of a start that differs from its server's acceptance. */
export type ChangedPart = 'command' | 'arguments' | 'directory' | 'environment' | 'resolved'

/** What differs between a server's acceptance and a start of the server. */
export interface StartChange {
  /** The first part that differs, in the order a review compares them. */
  readonly part: ChangedPart
  /** The names of the variables added, removed or given another value, sorted; empty unless the part is `environment`. */
  readonly changedVariables: readonly string[]
  /** Why the acceptance does not cover the start, in words that name no environment value. */
  readonly reason: string
}

/**
 * The names of the variables whose digests differ between two environments, sorted.
 * @param accepted - the accepted environment's digests.
 * @param current - the environment under review's digests.
 * @returns the names added, removed or given another value.
 */
export function changedVariablesOf(accepted: EnvDigests, current: EnvDigests): readonly string[] {
  const names = new Set([...Object.keys(accepted), ...Object.keys(current)])
  return [...names].filter(name => accepted[name] !== current[name]).sort()
}

/**
 * A change of one part, without changed variables.
 * @param part - the part.
 * @param reason - why the acceptance does not cover the start.
 * @returns the change.
 */
function changed(part: ChangedPart, reason: string): StartChange {
  return { part, changedVariables: [], reason }
}

/**
 * What a server's acceptance does not cover of a start of the server. The configured command, arguments, working
 * directory and environment are compared first, then the paths they resolve to: the working directory, the
 * executable and the command shell, so a start whose configuration is unchanged but resolves elsewhere is not covered
 * and its change is `resolved`.
 * @param accepted - the server's acceptance.
 * @param start - the start under review.
 * @returns the first part that differs with its reason and the changed variables, or `undefined` when the acceptance
 *   covers the start.
 */
export function changeOf(accepted: ServerAcceptance, start: ServerStart): StartChange | undefined {
  if (accepted.command !== start.command) return changed('command', 'the person accepted a different command for this server')
  if (!sameArgs(accepted.args, start.args)) return changed('arguments', 'the person accepted a different argument list for this server')
  if (accepted.cwd !== start.cwd) return changed('directory', 'the person accepted this server with a different working directory')
  const changedVariables = changedVariablesOf(accepted.env, envDigests(start.env))
  if (changedVariables.length > 0) {
    return { part: 'environment', changedVariables, reason: `the person accepted this server with different environment variables or values (${changedVariables.join(', ')})` }
  }
  if (accepted.resolvedCwd !== start.resolvedCwd) {
    return changed('resolved', `the working directory resolves to ${JSON.stringify(start.resolvedCwd)}, and the person accepted this server run in ${JSON.stringify(accepted.resolvedCwd)}`)
  }
  if (accepted.resolvedCommand !== start.resolvedCommand) {
    return changed('resolved', `the command resolves to the executable ${JSON.stringify(start.resolvedCommand)}, and the person accepted ${JSON.stringify(accepted.resolvedCommand)}`)
  }
  if (accepted.resolvedShell !== start.resolvedShell) {
    return changed('resolved', `the command runs through ${describeShell(start.resolvedShell)}, and the person accepted it run through ${describeShell(accepted.resolvedShell)}`)
  }
  return undefined
}

/**
 * The words naming the command shell that runs a start's executable in a reason.
 * @param shell - the shell's canonical path, or `undefined` for an executable that runs directly.
 * @returns the quoted shell, or the words for no shell.
 */
function describeShell(shell: string | undefined): string {
  return shell === undefined ? 'no command shell' : `the command shell ${JSON.stringify(shell)}`
}

/**
 * Whether a version 4 acceptance covers a start exactly: the same arguments, working directory, resolved executable
 * path, working directory and command shell, and environment for its command.
 * @param record - the version 4 acceptance of the start's command.
 * @param start - the start.
 * @returns true when every part matches.
 */
export function coversExactly(record: CommandKeyedAcceptance, start: ServerStart): boolean {
  return sameArgs(record.args, start.args) && record.cwd === start.cwd && record.resolvedCommand === start.resolvedCommand
    && record.resolvedCwd === start.resolvedCwd && record.resolvedShell === start.resolvedShell && record.envDigest === envDigest(start.env)
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
    super(`the store's version is ${String(version)}, written before an acceptance covered the resolved executable path, command shell and working directory`)
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
 * Whether a value is a list of strings.
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
 * Whether a value is a digest's text.
 * @param value - the value to check.
 * @returns true for `sha256:` and 64 lowercase hexadecimal digits.
 */
function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value)
}

/**
 * Check that an entry is an object holding only the given fields.
 * @param named - the entry, as a refusal names it.
 * @param value - the store's value for it.
 * @param fields - the fields it may hold.
 * @returns the entry's fields.
 * @throws {AcceptanceStoreError} when the value is not an object or sets another field.
 */
function fieldsOf(named: string, value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new AcceptanceStoreError(`${named} is not an object`)
  const extra = Object.keys(value).filter(key => !fields.includes(key))
  if (extra.length > 0) throw new AcceptanceStoreError(`${named} sets ${extra.join(', ')}`)
  return value
}

/**
 * Check an acceptance time.
 * @param named - the entry, as a refusal names it.
 * @param acceptedAt - the stored time.
 * @returns the time.
 * @throws {AcceptanceStoreError} when it is not a finite number.
 */
function acceptedAtOf(named: string, acceptedAt: unknown): number {
  if (typeof acceptedAt !== 'number' || !Number.isFinite(acceptedAt)) throw new AcceptanceStoreError(`${named} does not hold a number acceptance time`)
  return acceptedAt
}

/**
 * The resolved paths an entry holds: an absolute executable path and working directory, and an optional absolute
 * command shell.
 * @param named - the entry, as a refusal names it.
 * @param entry - the entry's fields.
 * @returns the paths, with no `resolvedShell` key when the entry holds none.
 * @throws {AcceptanceStoreError} when a path is missing, not a string or not absolute.
 */
function resolvedPathsIn(named: string, entry: Record<string, unknown>): Pick<ServerStart, 'resolvedCommand' | 'resolvedCwd' | 'resolvedShell'> {
  const { resolvedCommand, resolvedCwd, resolvedShell } = entry
  if (typeof resolvedCommand !== 'string' || !isAbsolute(resolvedCommand)) {
    throw new AcceptanceStoreError(`${named} does not hold an absolute resolved executable path`)
  }
  if (typeof resolvedCwd !== 'string' || !isAbsolute(resolvedCwd)) {
    throw new AcceptanceStoreError(`${named} does not hold an absolute resolved working directory`)
  }
  if (!('resolvedShell' in entry)) return { resolvedCommand, resolvedCwd }
  if (typeof resolvedShell !== 'string' || !isAbsolute(resolvedShell)) {
    throw new AcceptanceStoreError(`${named} does not hold an absolute resolved command shell`)
  }
  return { resolvedCommand, resolvedCwd, resolvedShell }
}

/**
 * One server's acceptance as the store holds it.
 * @param serverName - the server name, named in the reason.
 * @param value - the store's value for it.
 * @returns the acceptance.
 * @throws {AcceptanceStoreError} when the value is not an object holding only the command, the argument list, the
 *   working directory, the absolute resolved executable path and working directory, an optional absolute command
 *   shell, the environment's digests and the acceptance time, with the right types.
 */
function acceptanceOf(serverName: string, value: unknown): ServerAcceptance {
  const named = `the acceptance of the server ${JSON.stringify(serverName)}`
  const entry = fieldsOf(named, value, ACCEPTANCE_FIELDS)
  const { command, args, cwd, env, acceptedAt } = entry
  if (typeof command !== 'string' || command.length === 0) throw new AcceptanceStoreError(`${named} does not hold a command`)
  if (!isStringList(args)) throw new AcceptanceStoreError(`${named} does not hold a list of argument strings`)
  if (typeof cwd !== 'string') throw new AcceptanceStoreError(`${named} does not hold a working directory string`)
  const resolved = resolvedPathsIn(named, entry)
  if (!isRecord(env) || !Object.values(env).every(isDigest)) {
    throw new AcceptanceStoreError(`${named} does not hold a sha256 digest for each environment variable`)
  }
  const digests = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => isDigest(entry[1])))
  return { command, args, cwd, ...resolved, env: digests, acceptedAt: acceptedAtOf(named, acceptedAt) }
}

/**
 * One version 4 acceptance as the store holds it.
 * @param command - the accepted command, named in the reason.
 * @param value - the store's value for it.
 * @returns the acceptance.
 * @throws {AcceptanceStoreError} when the value is not an object holding only the argument list, the working
 *   directory, the absolute resolved executable path and working directory, an optional absolute command shell, the
 *   environment's names and digest, and the acceptance time, with the right types.
 */
function commandKeyedOf(command: string, value: unknown): CommandKeyedAcceptance {
  const named = `the acceptance of the command ${JSON.stringify(command)}`
  if (command.length === 0) throw new AcceptanceStoreError('the store holds an acceptance with an empty command')
  const entry = fieldsOf(named, value, COMMAND_KEYED_FIELDS)
  const { args, cwd, envNames, envDigest: digest, acceptedAt } = entry
  if (!isStringList(args)) throw new AcceptanceStoreError(`${named} does not hold a list of argument strings`)
  if (typeof cwd !== 'string') throw new AcceptanceStoreError(`${named} does not hold a working directory string`)
  const resolved = resolvedPathsIn(named, entry)
  if (!isStringList(envNames)) throw new AcceptanceStoreError(`${named} does not hold a list of environment variable names`)
  if (!isDigest(digest)) throw new AcceptanceStoreError(`${named} does not hold a sha256 environment digest`)
  return { args, cwd, ...resolved, envNames, envDigest: digest, acceptedAt: acceptedAtOf(named, acceptedAt) }
}

/**
 * One server's set-aside start as the store holds it.
 * @param serverName - the server name, named in the reason.
 * @param value - the store's value for it.
 * @returns the set-aside start.
 * @throws {AcceptanceStoreError} when the value is not an object holding only the state and the start's digest.
 */
function setAsideOf(serverName: string, value: unknown): SetAsideStart {
  const named = `the set-aside start of the server ${JSON.stringify(serverName)}`
  const { state, start } = fieldsOf(named, value, SET_ASIDE_FIELDS)
  if (state !== 'declined' && state !== 'revoked') throw new AcceptanceStoreError(`${named} does not hold the state declined or revoked`)
  if (!isDigest(start)) throw new AcceptanceStoreError(`${named} does not hold a sha256 start digest`)
  return { state, start }
}

/**
 * Read one keyed section of a store.
 * @param document - the store's document.
 * @param field - the section's field.
 * @param read - reads one entry.
 * @param keyed - checks one key, throwing when the store may not hold it.
 * @returns the section's entries.
 * @throws {AcceptanceStoreError} when the section is not an object, or an entry or key is refused.
 */
function sectionOf<T>(document: Record<string, unknown>, field: string, read: (key: string, value: unknown) => T, keyed: (key: string) => void): Map<string, T> {
  const section = document[field]
  if (!isRecord(section)) throw new AcceptanceStoreError(`the store does not hold a ${field} object`)
  const entries = new Map<string, T>()
  for (const [key, value] of Object.entries(section)) {
    keyed(key)
    entries.set(key, read(key, value))
  }
  return entries
}

/**
 * Check a key that names a server.
 * @param serverName - the key.
 * @throws {AcceptanceStoreError} when it is not a server name the mcp-client's configuration admits.
 */
function serverNameKey(serverName: string): void {
  if (!SERVER_NAME_PATTERN.test(serverName)) throw new AcceptanceStoreError(`the store holds an entry for ${JSON.stringify(serverName)}, which is not a server name`)
}

/**
 * Parse the store's text.
 * @param text - the store file's text.
 * @returns the store: of this version as written, or of {@link COMMAND_KEYED_STORE_VERSION} with no acceptance and its
 *   acceptances kept as command-keyed records.
 * @throws {SupersededStoreError} when the store is of a {@link SUPERSEDED_STORE_VERSIONS} version.
 * @throws {AcceptanceStoreError} when the text is not this version's or version 4's format: no JSON document, not an
 *   object, another version, an unknown field, or an entry whose fields are wrong.
 */
export function parseAcceptanceStore(text: string): AcceptanceStore {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    throw new AcceptanceStoreError('the store holds no JSON document')
  }
  if (!isRecord(document)) throw new AcceptanceStoreError('the store is not a JSON object')
  const version = document['v']
  if (typeof version === 'number' && SUPERSEDED_STORE_VERSIONS.includes(version)) throw new SupersededStoreError(version)
  const fields = version === COMMAND_KEYED_STORE_VERSION ? ['v', 'acceptances'] : STORE_FIELDS
  if (version !== ACCEPTANCE_STORE_VERSION && version !== COMMAND_KEYED_STORE_VERSION) {
    throw new AcceptanceStoreError(`the store's version is ${JSON.stringify(version)}, not ${String(ACCEPTANCE_STORE_VERSION)}`)
  }
  const extra = Object.keys(document).filter(key => !fields.includes(key))
  if (extra.length > 0) throw new AcceptanceStoreError(`the store sets ${extra.join(', ')}`)
  const anyKey = (): void => {}
  if (version === COMMAND_KEYED_STORE_VERSION) {
    return { acceptances: new Map(), setAside: new Map(), commandKeyed: sectionOf(document, 'acceptances', commandKeyedOf, anyKey) }
  }
  return {
    acceptances: sectionOf(document, 'acceptances', acceptanceOf, serverNameKey),
    setAside: sectionOf(document, 'setAside', setAsideOf, serverNameKey),
    commandKeyed: sectionOf(document, 'commandKeyed', commandKeyedOf, anyKey),
  }
}

/**
 * A section's entries as a JSON object sorted by key, each entry written by a function that lists its fields in order.
 * @param entries - the entries.
 * @param write - writes one entry.
 * @returns the object.
 */
function sorted<T>(entries: ReadonlyMap<string, T>, write: (entry: T) => object): Record<string, object> {
  const section: Record<string, object> = {}
  for (const [key, entry] of [...entries].sort(([left], [right]) => (left < right ? -1 : 1))) section[key] = write(entry)
  return section
}

/**
 * The store's text: one JSON object of this version whose sections are sorted by key, with a trailing newline.
 * @param store - the store's content.
 * @returns the text to write.
 */
export function serializeAcceptanceStore(store: AcceptanceStore): string {
  return `${JSON.stringify({
    v: ACCEPTANCE_STORE_VERSION,
    acceptances: sorted(store.acceptances, accepted => ({
      command: accepted.command,
      args: [...accepted.args],
      cwd: accepted.cwd,
      ...resolvedPathsOf(accepted),
      env: Object.fromEntries(Object.keys(accepted.env).sort().map(name => [name, accepted.env[name]])),
      acceptedAt: accepted.acceptedAt,
    })),
    setAside: sorted(store.setAside, ({ state, start }) => ({ state, start })),
    commandKeyed: sorted(store.commandKeyed, record => ({
      args: [...record.args],
      cwd: record.cwd,
      ...resolvedPathsOf(record),
      envNames: [...record.envNames],
      envDigest: record.envDigest,
      acceptedAt: record.acceptedAt,
    })),
  }, null, 2)}\n`
}

/** What reading the store found. */
export type AcceptanceStoreRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'readable', readonly store: AcceptanceStore }
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
  /* v8 ignore next -- the protected-file read and the parser throw only Error instances; the words cover any other value. */
  return error instanceof Error ? error.message : 'the file could not be read'
}

/**
 * Read the store from its path, applying contract C1's protected-file refusal rule.
 * @param path - the store's absolute path.
 * @returns `absent` while no store exists, `readable` with its content, `superseded` with the version of a store
 *   written before an acceptance covered everything a review compares, or `refused` with the reason a
 *   store that exists could not be read as this version's or version 4's format — a laxer mode, a symbolic link,
 *   another format, or a filesystem failure.
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
    return { kind: 'readable', store: parseAcceptanceStore(bytes.toString('utf8')) }
  } catch (error) {
    if (error instanceof SupersededStoreError) return { kind: 'superseded', version: error.version }
    return { kind: 'refused', problem: problemOf(error) }
  }
}

/**
 * Write the store at its path through contract C1's protected-file write: a sibling temporary file at mode 0600,
 * flushed and renamed over the path. The store's directory is created at the private directory mode when missing.
 * @param path - the store's absolute path.
 * @param store - the content to write.
 */
export async function writeAcceptanceStore(path: string, store: AcceptanceStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE })
  await writeProtectedFile(path, serializeAcceptanceStore(store))
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
