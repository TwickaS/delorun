/**
 * Readers and writers of the records of Changes, and the proof that a person is at their computer that changing the
 * protection setting and opening or closing a work session require.
 *
 * Every reader validates what it reads: the schema tag, each field's type and allowed values and no unknown field, so
 * a record that is not one Delorun wrote throws `RECORD_UNREADABLE` and nothing decides from it. A missing file reads as
 * the documented default. The records under `changes/` are protected files: written at mode 0600 by an atomic rename,
 * and refused on read when another user could read them, with their directories created at mode 0700. The approved
 * record lives in the profile's `package.json` under `delorun.changes`, so profile history holds it.
 *
 * @module @delorun/changes/records
 */
import { randomBytes } from 'node:crypto'
import { link, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { PRIVATE_DIR_MODE, PROTECTED_FILE_MODE } from '@delorun/contract-home-layout'
import { checkPrivateDirectory, readProtectedFile, writeProtectedFile } from '@delorun/home'
import { withProfileWriteLock } from './profile-lock.ts'
import { ChangesError } from './errors.ts'
import { CHANGE_ID_PATTERN } from './ids.ts'
import { CHANGES_ENTRIES, changesDirectory, harnessDirectory, harnessLogPath, harnessRecordPath, migrationPath, PACKAGE_NAME_PATTERN, profileChangesDirectory, protectionPath } from './paths.ts'
import {
  ACTIVE_KINDS,
  ACTIVE_RECORD_SCHEMA,
  APPROVED_RECORD_SCHEMA,
  AGENT_LOG_SCHEMA,
  CHANGE_KINDS,
  CHANGE_LOG_SCHEMA,
  LOG_CHANGE_KINDS,
  CHANGE_STATES,
  DECIDED_FROM,
  DEFAULT_PROTECTION,
  HARNESS_RECORD_SCHEMA,
  MIGRATION_RECORD_SCHEMA,
  PROTECTION_LEVELS,
  PROTECTION_RECORD_SCHEMA,
  WORK_SESSION_SCHEMA,
  type ActiveRecord,
  type ApprovedPlugin,
  type ApprovedRecord,
  type ChangeEntry,
  type ChangeId,
  type AgentLog,
  type ChangeLog,
  type ContentVersion,
  type HarnessRecord,
  type MigrationRecord,
  type ProtectionLevel,
  type ProtectionRecord,
  type WorkSessionRecord,
  type DecidedFrom,
  type StudioDevice,
} from './types.ts'

/** What a {@link ContentVersion} is: a SHA-256 in lowercase hexadecimal. */
export const CONTENT_VERSION_PATTERN = /^[0-9a-f]{64}$/

/** What a package name under Changes is; kept here for the modules that read it with the records. */
export { PACKAGE_NAME_PATTERN }

/** The brand of {@link AtComputer}; not exported, so no other module can write it. */
const AT_COMPUTER: unique symbol = Symbol('AtComputer')

/**
 * Proof that the caller acts for a person at their computer: issued only by {@link attestTerminal}, {@link attestDevice} and
 * {@link attestStudio}, and checked at run time against the values they issued, so an object that merely looks like one
 * is refused.
 *
 * A terminal proof says only that the command's standard input and output are terminals. A model's own terminal tool
 * gives its commands a real pseudo-terminal, so the proof does not tell a person from a model: a confined command cannot
 * use it, because the sandbox denies it every write under the Delorun home, `changes/` included (C1), while a command the
 * person runs with full access acts with the person's own authority. A studio proof says that a request reached the
 * loopback listener under a loopback `Host`, carried the studio's credential and was not admitted for a remote session,
 * or, from {@link attestDevice}, that a paired device's studio holds an unlock the person entered (a code or a PIN, never
 * the approval grace). A device's proof is logged as `studio`, as the computer's is, with the device in the entry's
 * `decidedOn` ({@link decisionOf}). Neither proof is a barrier to code running inside the Host.
 */
export interface AtComputer {
  /** Where the person is: a terminal, or the studio at the computer or on an unlocked paired device. */
  readonly kind: 'terminal' | 'studio'
  /** The paired device a studio proof came from; absent at the computer and in a terminal. */
  readonly device?: StudioDevice
  readonly [AT_COMPUTER]: true
}

export type { StudioDevice }

/** The fields of an entry that say when, where and on which paired device its last decision was made. */
export type DecisionFields = Pick<ChangeEntry, 'decidedAt' | 'decidedFrom' | 'decidedOn'>

/**
 * The fields of a new decision. Spread them over {@link withoutDecision} of the entry, so a device named by an earlier
 * decision is not left on this one.
 * @param at - when, ISO 8601.
 * @param from - the person's proof, or where Delorun decided.
 * @returns the fields; `decidedOn` only for a proof from a paired device.
 */
export function decisionOf(at: string, from: AtComputer | Exclude<DecidedFrom, AtComputer['kind']>): DecisionFields {
  if (typeof from === 'string') return { decidedAt: at, decidedFrom: from }
  return { decidedAt: at, decidedFrom: from.kind, ...from.device === undefined ? {} : { decidedOn: { id: from.device.id, label: from.device.label } } }
}

/**
 * @param entry - a log entry.
 * @returns it without its last decision's fields.
 */
export function withoutDecision(entry: ChangeEntry): Omit<ChangeEntry, keyof DecisionFields> {
  const { decidedAt: _decidedAt, decidedFrom: _decidedFrom, decidedOn: _decidedOn, ...rest } = entry
  return rest
}

/** Every {@link AtComputer} the attest functions issued. */
const issued = new WeakSet<AtComputer>()

/**
 * @param kind - where the person is.
 * @returns a new, frozen proof, recorded as issued.
 */
function issue(kind: AtComputer['kind'], device?: StudioDevice): AtComputer {
  const presence: AtComputer = Object.freeze({ kind, ...device === undefined ? {} : { device: Object.freeze({ id: device.id, label: device.label }) }, [AT_COMPUTER]: true as const })
  issued.add(presence)
  return presence
}

/** What the studio's route knows about where a request came from, decided before its body is read. */
export interface StudioArrival {
  /** The request reached the loopback listener and its `Host` names a loopback authority. */
  readonly loopback: boolean
  /** Connection admitted the request with the studio's credential. */
  readonly credential: boolean
  /** A reach listener admitted the request for a remote session. */
  readonly remoteSession: boolean
}

/**
 * Attest that a studio request comes from the person at their computer. Only the studio's Changes routes
 * (`@delorun/plugin-changes`) call it.
 * @param facts - where the request arrived and what admitted it.
 * @returns the proof.
 * @throws {ChangesError} `NOT_AT_COMPUTER` unless the request is a loopback one with the credential and not remote.
 */
export function attestStudio(facts: StudioArrival): AtComputer {
  if (!facts.loopback || !facts.credential || facts.remoteSession) {
    throw new ChangesError('NOT_AT_COMPUTER', 'studio', 'This needs you at your computer: open the studio on this computer, not through a remote session.')
  }
  return issue('studio')
}

/** What the studio's route knows about a paired device's request, decided before its body is read. */
export interface DeviceArrival {
  /** A reach listener admitted the request for this paired device's session. */
  readonly remoteSession: true
  /** The device. */
  readonly device: StudioDevice
  /**
   * Whether the device holds an unlock the person entered for it: a code approved at the computer or a PIN page. False
   * for a locked device and for one that holds only the approval grace.
   */
  readonly freshUnlock: boolean
  /** The control is one any approved device may use with no unlock (class `free`), so the proof does not claim an unlock. */
  readonly freeControl?: true
}

/**
 * Attest that a paired device's studio request comes from the person, with an unlock they entered. Only the studio's
 * Changes routes (`@delorun/plugin-changes`) call it, and only for an action a device may take with that unlock or a
 * grant; the proof is recorded as `studio`.
 * @param facts - the device and its unlock.
 * @returns the proof, naming the device.
 * @throws {ChangesError} `NOT_AT_COMPUTER` unless the device holds a fresh unlock or the control is free.
 */
export function attestDevice(facts: DeviceArrival): AtComputer {
  if (facts.remoteSession !== true || (facts.freshUnlock !== true && facts.freeControl !== true) || facts.device.id === '') {
    throw new ChangesError('NOT_AT_COMPUTER', 'studio', 'Confirm this with Face ID or your PIN when asked, or do it at your computer.')
  }
  return issue('studio', facts.device)
}

/**
 * Attest that a `delorun` command runs at a terminal the person types in.
 * @param streams - the command's standard input and output.
 * @returns the proof.
 * @throws {ChangesError} `NOT_AT_COMPUTER` unless both streams are terminals.
 */
export function attestTerminal(streams: { readonly stdin: { readonly isTTY?: boolean }, readonly stdout: { readonly isTTY?: boolean } }): AtComputer {
  if (streams.stdin.isTTY !== true || streams.stdout.isTTY !== true) {
    throw new ChangesError('NOT_AT_COMPUTER', 'terminal', 'This needs you at your computer: run the command in a terminal, not with its input or output redirected.')
  }
  return issue('terminal')
}

/**
 * Refuse a claimed proof of presence that {@link attestTerminal}, {@link attestStudio} or {@link attestDevice} did not issue. Every writer
 * that needs the person at their computer calls it before it reads or writes anything.
 * @param presence - a claimed proof.
 * @param subject - what it is for, for the refusal.
 * @throws {ChangesError} `NOT_AT_COMPUTER` when the attest functions did not issue it.
 */
export function requirePresence(presence: AtComputer, subject: string): void {
  if (!issued.has(presence)) throw new ChangesError('NOT_AT_COMPUTER', subject, 'This needs you at your computer, and the request did not come from a terminal, the studio on this computer or an unlocked device.')
}

/**
 * @param path - the record's path.
 * @param detail - what is wrong with it.
 * @param cause - the underlying error.
 * @returns the refusal.
 */
function unreadable(path: string, detail: string, cause?: unknown): ChangesError {
  return new ChangesError('RECORD_UNREADABLE', path, `${path} is not a record Delorun wrote: ${detail}.`, cause === undefined ? undefined : { cause })
}

/**
 * @param error - a thrown value.
 * @param code - an errno code.
 * @returns whether it is a filesystem error with the code.
 */
function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code
}

/**
 * @param text - a file's text.
 * @param path - its path.
 * @returns the parsed JSON.
 * @throws {ChangesError} `RECORD_UNREADABLE` when it is not JSON.
 */
function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw unreadable(path, 'it is not JSON', error)
  }
}

/**
 * Read a protected record file.
 * @param path - its path.
 * @returns its parsed JSON, or undefined when the file does not exist.
 * @throws {ChangesError} `RECORD_UNREADABLE` when it cannot be read, has a mode others can read, or is not JSON.
 */
async function readRecordFile(path: string): Promise<unknown> {
  let bytes: Buffer
  try {
    bytes = await readProtectedFile(path)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined
    throw unreadable(path, `it cannot be read (${String(error)})`, error)
  }
  return parseJson(bytes.toString('utf8'), path)
}

/**
 * @param value - a record.
 * @returns its file text: 2-space JSON and one trailing newline.
 */
function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * Create a directory under `changes/` at mode 0700 and check `changes/` itself.
 * @param home - the Delorun home.
 * @param directory - the directory.
 * @throws {HomeLayoutError} `HOME_MODE` when `changes/` is laxer than 0700, a symbolic link or another user's.
 */
async function makeChangesDirectory(home: string, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE })
  await checkPrivateDirectory(changesDirectory(home))
}

/** A field's test: true when the value is allowed; a nested test may throw its own refusal instead. */
type FieldTest = (value: unknown, path: string, where: string) => boolean

/** One field of a record. */
interface FieldRule {
  readonly test: FieldTest
  /** What the field must be, as the refusal says it. */
  readonly expected: string
  readonly optional?: true
}

const isString: FieldTest = value => typeof value === 'string'
const isIso: FieldTest = value => typeof value === 'string' && !Number.isNaN(Date.parse(value))
const isTrue: FieldTest = value => value === true

/**
 * @param pattern - the pattern.
 * @returns a test for a string matching it.
 */
function matching(pattern: RegExp): FieldTest {
  return value => typeof value === 'string' && pattern.test(value)
}

/**
 * @param values - the allowed values.
 * @returns a test for one of them.
 */
function oneOf(values: readonly unknown[]): FieldTest {
  return value => values.includes(value)
}

/**
 * @param value - a value read from a record.
 * @param path - the record's path.
 * @param where - the value's place in the record, for the refusal.
 * @returns the value's fields.
 * @throws {ChangesError} `RECORD_UNREADABLE` when it is not a JSON object.
 */
function objectAt(value: unknown, path: string, where: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw unreadable(path, `${where} is not an object`)
  return value as Readonly<Record<string, unknown>>
}

/**
 * Check an object against its rules: no unknown field, every required field present, every present field allowed.
 * @param value - the value.
 * @param path - the record's path.
 * @param where - the value's place in the record.
 * @param rules - its fields.
 * @returns true.
 * @throws {ChangesError} `RECORD_UNREADABLE` naming the first field that breaks a rule.
 */
function checkFields(value: unknown, path: string, where: string, rules: Readonly<Record<string, FieldRule>>): true {
  const fields = objectAt(value, path, where)
  const unknown = Object.keys(fields).find(key => !Object.hasOwn(rules, key))
  if (unknown !== undefined) throw unreadable(path, `${where} has the unknown field ${JSON.stringify(unknown)}`)
  for (const [key, rule] of Object.entries(rules)) {
    if (!Object.hasOwn(fields, key)) {
      if (rule.optional === true) continue
      throw unreadable(path, `${where}.${key} is missing`)
    }
    if (!rule.test(fields[key], path, `${where}.${key}`)) throw unreadable(path, `${where}.${key} is not ${rule.expected}`)
  }
  return true
}

/**
 * @param rules - an object's fields.
 * @param expected - what it is, as a refusal says it.
 * @returns the rule for a field holding such an object.
 */
function nested(rules: Readonly<Record<string, FieldRule>>, expected: string): FieldRule {
  return { test: (value, path, where) => checkFields(value, path, where, rules), expected }
}

/**
 * @param rules - the fields of each value.
 * @returns the rule for an object of such values by package name.
 */
function byPackageName(rules: Readonly<Record<string, FieldRule>> | ((entry: unknown) => Readonly<Record<string, FieldRule>>)): FieldRule {
  return {
    expected: 'an object by package name',
    test: (value, path, where) => {
      for (const [name, entry] of Object.entries(objectAt(value, path, where))) {
        if (!PACKAGE_NAME_PATTERN.test(name)) throw unreadable(path, `${where} names ${JSON.stringify(name)}, which is not a package name`)
        checkFields(entry, path, `${where}[${JSON.stringify(name)}]`, typeof rules === 'function' ? rules(entry) : rules)
      }
      return true
    },
  }
}

/**
 * @param tag - the schema tag.
 * @returns the rule for the `schema` field.
 */
function schemaRule(tag: string): FieldRule {
  return { test: value => value === tag, expected: JSON.stringify(tag) }
}

const required = {
  string: { test: isString, expected: 'a string' },
  iso: { test: isIso, expected: 'an ISO 8601 time' },
  version: { test: matching(CONTENT_VERSION_PATTERN), expected: 'a content version' },
} as const satisfies Record<string, FieldRule>

const optional = {
  string: { ...required.string, optional: true },
  iso: { ...required.iso, optional: true },
  version: { ...required.version, optional: true },
} as const satisfies Record<string, FieldRule>

const PROTECTION_RULES: Readonly<Record<string, FieldRule>> = {
  schema: schemaRule(PROTECTION_RECORD_SCHEMA),
  level: { test: oneOf(PROTECTION_LEVELS), expected: `one of ${PROTECTION_LEVELS.join(', ')}` },
  setAt: required.iso,
}

const WORK_SESSION_RULES: Readonly<Record<string, FieldRule>> = {
  schema: schemaRule(WORK_SESSION_SCHEMA),
  plugin: { test: matching(PACKAGE_NAME_PATTERN), expected: 'a package name' },
  source: required.string,
  from: required.version,
  startedAt: required.iso,
  startedFrom: { test: oneOf(['terminal', 'studio']), expected: 'terminal or studio' },
  endsAt: required.iso,
  lastLoaded: optional.version,
  lastFailed: optional.version,
}

const ENTRY_RULES: Readonly<Record<string, FieldRule>> = {
  id: { test: matching(CHANGE_ID_PATTERN), expected: 'a change id' },
  kind: { test: oneOf(LOG_CHANGE_KINDS), expected: 'a change kind' },
  state: { test: oneOf(CHANGE_STATES), expected: 'a change state' },
  subject: nested({ plugin: optional.string, source: optional.string, file: optional.string, runtime: optional.string, setting: optional.string, spec: optional.string }, 'a change subject'),
  from: optional.version,
  to: optional.version,
  summary: required.string,
  createdAt: required.iso,
  decidedAt: optional.iso,
  decidedFrom: { test: oneOf(DECIDED_FROM), expected: DECIDED_FROM.join(', '), optional: true },
  decidedOn: { ...nested({ id: required.string, label: required.string }, 'a paired device'), optional: true },
  historyVersion: optional.string,
  leftOut: { ...nested({ at: required.iso, failure: required.string }, 'a failure report'), optional: true },
  shownAt: optional.iso,
  lastFailure: { ...nested({ at: required.iso, failure: required.string }, 'a failure report'), optional: true },
}

/** An entry of the agent-action log: the entry fields of `log.json`, with every kind and the version before the action. */
const AGENT_ENTRY_RULES: Readonly<Record<string, FieldRule>> = {
  ...ENTRY_RULES,
  kind: { test: oneOf(CHANGE_KINDS), expected: 'a change kind' },
  historyBefore: optional.string,
}

/**
 * @param rules - the entry rules a list holds.
 * @returns the rule of a list of entries with distinct ids.
 */
function entriesRule(rules: Readonly<Record<string, FieldRule>>): FieldRule {
  return {
    expected: 'a list of changes with distinct ids',
    test: (value, path, where) => {
      if (!Array.isArray(value)) return false
      const entries: readonly unknown[] = value
      const ids = new Set<unknown>()
      entries.forEach((entry, index) => {
        checkFields(entry, path, `${where}[${String(index)}]`, rules)
        ids.add(objectAt(entry, path, where).id)
      })
      return ids.size === entries.length
    },
  }
}

const AGENT_LOG_RULES: Readonly<Record<string, FieldRule>> = {
  schema: schemaRule(AGENT_LOG_SCHEMA),
  entries: entriesRule(AGENT_ENTRY_RULES),
}

const LOG_RULES: Readonly<Record<string, FieldRule>> = {
  schema: schemaRule(CHANGE_LOG_SCHEMA),
  migratedAt: optional.iso,
  entries: entriesRule(ENTRY_RULES),
}

const ACTIVE_RULES: Readonly<Record<string, FieldRule>> = {
  schema: schemaRule(ACTIVE_RECORD_SCHEMA),
  // Only content a failed start left out may hold nothing: the plugin's install, or turning it on, was left out.
  plugins: byPackageName(entry => ({
    version: typeof entry === 'object' && entry !== null && (entry as Readonly<Record<string, unknown>>).kind === 'left-out' ? optional.version : required.version,
    kind: { test: oneOf(ACTIVE_KINDS), expected: ACTIVE_KINDS.join(', ') },
  })),
}

const APPROVED_RULES: Readonly<Record<string, FieldRule>> = {
  schema: schemaRule(APPROVED_RECORD_SCHEMA),
  plugins: byPackageName({ source: required.string, version: required.version, approvedAt: required.iso, approvedAtUpgrade: { test: isTrue, expected: 'true', optional: true } }),
}

/** A `/` followed by an empty, `.` or `..` segment; matched rather than split, because a read checks every file of a copy. */
const UNSAFE_HARNESS_SEGMENT = /\/\.{0,2}(?:\/|$)/u

/**
 * Whether a path names a harness file Changes may hold.
 * @param path - the path.
 * @returns whether it is relative to the runtime's root, `/`-separated, under `app/`, and without an empty, `.` or `..`
 *   segment.
 */
export function isHarnessPath(path: string): boolean {
  return path.startsWith('app/') && !path.includes('\\') && !path.includes('\0') && !UNSAFE_HARNESS_SEGMENT.test(path)
}

const HARNESS_RULES: Readonly<Record<string, FieldRule>> = {
  schema: schemaRule(HARNESS_RECORD_SCHEMA),
  runtime: required.string,
  files: {
    expected: 'an object by harness path',
    test: (value, path, where) => {
      for (const [file, entry] of Object.entries(objectAt(value, path, where))) {
        if (!isHarnessPath(file)) throw unreadable(path, `${where} names ${JSON.stringify(file)}, which is not a path under app/`)
        checkFields(entry, path, `${where}[${JSON.stringify(file)}]`, { version: required.version, signed: optional.version, change: { test: matching(CHANGE_ID_PATTERN), expected: 'a change id' }, approvedAt: required.iso })
      }
      return true
    },
  },
}

/**
 * @param value - a parsed protection record.
 * @param path - its path.
 * @throws {ChangesError} `RECORD_UNREADABLE` unless it is one.
 */
function assertProtection(value: unknown, path: string): asserts value is ProtectionRecord {
  checkFields(value, path, 'the record', PROTECTION_RULES)
}

/**
 * @param value - a parsed work-session record.
 * @param path - its path.
 * @throws {ChangesError} `RECORD_UNREADABLE` unless it is one.
 */
function assertWorkSession(value: unknown, path: string): asserts value is WorkSessionRecord {
  checkFields(value, path, 'the record', WORK_SESSION_RULES)
}

/**
 * @param value - a parsed change log.
 * @param path - its path.
 * @throws {ChangesError} `RECORD_UNREADABLE` unless it is one.
 */
function assertChangeLog(value: unknown, path: string): asserts value is ChangeLog {
  checkFields(value, path, 'the record', LOG_RULES)
}

/**
 * @param value - a parsed agent-action log.
 * @param path - its path.
 * @throws {ChangesError} `RECORD_UNREADABLE` unless it is one.
 */
function assertAgentLog(value: unknown, path: string): asserts value is AgentLog {
  checkFields(value, path, 'the record', AGENT_LOG_RULES)
}

/**
 * @param value - a parsed active record.
 * @param path - its path.
 * @throws {ChangesError} `RECORD_UNREADABLE` unless it is one.
 */
function assertActive(value: unknown, path: string): asserts value is ActiveRecord {
  checkFields(value, path, 'the record', ACTIVE_RULES)
}

/**
 * @param value - a parsed approved record.
 * @param path - its path.
 * @param where - its place in the file.
 * @throws {ChangesError} `RECORD_UNREADABLE` unless it is one.
 */
function assertApproved(value: unknown, path: string, where: string): asserts value is ApprovedRecord {
  checkFields(value, path, where, APPROVED_RULES)
}

/**
 * Read the protection setting.
 * @param home - the Delorun home.
 * @returns the level; {@link DEFAULT_PROTECTION} when the home has no protection record.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the record cannot be read, has a mode others can read, or is not one
 * Delorun wrote.
 */
export async function readProtection(home: string): Promise<ProtectionLevel> {
  const path = protectionPath(home)
  const value = await readRecordFile(path)
  if (value === undefined) return DEFAULT_PROTECTION
  assertProtection(value, path)
  return value.level
}

/**
 * Change the protection setting, from a terminal or the studio. The studio's route asks the person a second time before
 * it turns protection off and decides whether a device may; this writer checks only the proof.
 * @param home - the Delorun home.
 * @param level - the new level.
 * @param presence - proof from {@link attestTerminal}, {@link attestStudio} or {@link attestDevice}.
 * @returns the record written.
 * @throws {ChangesError} `NOT_AT_COMPUTER` for a proof the attest functions did not issue.
 * @throws {HomeLayoutError} `HOME_MODE` when `changes/` is laxer than 0700.
 */
export async function setProtection(home: string, level: ProtectionLevel, presence: AtComputer): Promise<ProtectionRecord> {
  requirePresence(presence, 'protection')
  const record: ProtectionRecord = { schema: PROTECTION_RECORD_SCHEMA, level, setAt: new Date().toISOString() }
  await makeChangesDirectory(home, changesDirectory(home))
  await writeProtectedFile(protectionPath(home), jsonText(record))
  return record
}

/**
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @returns the work-session record's path.
 */
function workSessionPath(home: string, profile: string): string {
  return join(profileChangesDirectory(home, profile), CHANGES_ENTRIES.workSession)
}

/**
 * Read the profile's open work session.
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @returns the record, or undefined when no work session is open.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the record is not one Delorun wrote.
 */
export async function readWorkSession(home: string, profile: string): Promise<WorkSessionRecord | undefined> {
  const path = workSessionPath(home, profile)
  const value = await readRecordFile(path)
  if (value === undefined) return undefined
  assertWorkSession(value, path)
  return value
}

/**
 * What the caller states when it opens a work session: the plugin, its folder, its approved content and how many minutes
 * the session lasts, which the caller checked; the start time and place come from the call.
 */
export type WorkSessionStart = Pick<WorkSessionRecord, 'plugin' | 'source' | 'from'> & { readonly minutes: number }

/**
 * Open a work session. The record is written completely to a temporary file and then linked to its name, which fails
 * when the name exists, so two openings never both succeed.
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @param start - the plugin, its folder, its approved content and the session's length in minutes.
 * @param presence - proof from {@link attestTerminal} or {@link attestStudio}; its kind is recorded as `startedFrom`.
 * @returns the record written.
 * @throws {ChangesError} `NOT_AT_COMPUTER` for a proof the attest functions did not issue; `WORK_SESSION_OPEN` when the
 * profile has a work session already.
 */
export async function openWorkSession(home: string, profile: string, start: WorkSessionStart, presence: AtComputer): Promise<WorkSessionRecord> {
  requirePresence(presence, start.plugin)
  const startedAt = new Date()
  const endsAt = new Date(startedAt.getTime() + start.minutes * 60_000)
  const record: WorkSessionRecord = { schema: WORK_SESSION_SCHEMA, plugin: start.plugin, source: start.source, from: start.from, startedAt: startedAt.toISOString(), startedFrom: presence.kind, endsAt: endsAt.toISOString() }
  const path = workSessionPath(home, profile)
  await makeChangesDirectory(home, profileChangesDirectory(home, profile))
  const temporary = `${path}.open-${randomBytes(8).toString('hex')}`
  await writeProtectedFile(temporary, jsonText(record))
  try {
    await link(temporary, path)
  } catch (error) {
    if (hasCode(error, 'EEXIST')) throw new ChangesError('WORK_SESSION_OPEN', start.plugin, `A work session is already open in profile ${profile}; close it before opening another.`, { cause: error })
    throw error
  } finally {
    await unlink(temporary)
  }
  return record
}

/**
 * Close the profile's work session on a plugin. The caller holds the profile's lock, so no other writer changes the
 * record between its read and its removal.
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @param plugin - the plugin's package name.
 * @param presence - proof from {@link attestTerminal} or {@link attestStudio}.
 * @returns the closed record.
 * @throws {ChangesError} `NOT_AT_COMPUTER` for a proof the attest functions did not issue; `NO_WORK_SESSION` when no
 * work session is open or it is another plugin's; `RECORD_UNREADABLE` when the record is not one Delorun wrote.
 */
export async function closeWorkSession(home: string, profile: string, plugin: string, presence: AtComputer): Promise<WorkSessionRecord> {
  requirePresence(presence, plugin)
  const record = await readWorkSession(home, profile)
  if (record?.plugin !== plugin) throw new ChangesError('NO_WORK_SESSION', plugin, `No work session on ${plugin} is open in profile ${profile}.`)
  await unlink(workSessionPath(home, profile))
  return record
}

/**
 * Record the content that last loaded in the open work session, which a failed reload goes back to, and forget an
 * earlier failure. The Host records what it loaded, so no proof of presence is needed. The caller holds the profile's
 * lock.
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @param version - the content that loaded.
 * @returns the updated record.
 * @throws {ChangesError} `NO_WORK_SESSION` when none is open; `RECORD_UNREADABLE` when the record is not one Delorun wrote.
 */
export async function noteLoaded(home: string, profile: string, version: ContentVersion): Promise<WorkSessionRecord> {
  const { lastFailed: _lastFailed, ...record } = await openSession(home, profile)
  return rewriteSession(home, profile, { ...record, lastLoaded: version })
}

/**
 * Record folder content whose reload failed in the open work session, so ending the session approves the content that
 * last loaded instead. The Host records what failed, so no proof of presence is needed. The caller holds the profile's
 * lock.
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @param version - the content that failed to load.
 * @returns the updated record.
 * @throws {ChangesError} `NO_WORK_SESSION` when none is open; `RECORD_UNREADABLE` when the record is not one Delorun wrote.
 */
export async function noteFailed(home: string, profile: string, version: ContentVersion): Promise<WorkSessionRecord> {
  return rewriteSession(home, profile, { ...await openSession(home, profile), lastFailed: version })
}

/**
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @returns the open work session.
 * @throws {ChangesError} `NO_WORK_SESSION` when none is open; `RECORD_UNREADABLE` when the record is not one Delorun wrote.
 */
async function openSession(home: string, profile: string): Promise<WorkSessionRecord> {
  const record = await readWorkSession(home, profile)
  if (record === undefined) throw new ChangesError('NO_WORK_SESSION', profile, `No work session is open in profile ${profile}.`)
  return record
}

/**
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @param record - the open session's new record.
 * @returns the record written.
 */
async function rewriteSession(home: string, profile: string, record: WorkSessionRecord): Promise<WorkSessionRecord> {
  await writeProtectedFile(workSessionPath(home, profile), jsonText(record))
  return record
}

/**
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @returns the change log's path.
 */
function logPath(home: string, profile: string): string {
  return join(profileChangesDirectory(home, profile), CHANGES_ENTRIES.log)
}

/**
 * Read the profile's change log.
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @returns the log; an empty one when the profile has none.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the log is not one Delorun wrote.
 */
export async function readChangeLog(home: string, profile: string): Promise<ChangeLog> {
  const path = logPath(home, profile)
  const value = await readRecordFile(path)
  if (value === undefined) return { schema: CHANGE_LOG_SCHEMA, entries: [] }
  assertChangeLog(value, path)
  return value
}

/**
 * Write the profile's change log. The caller holds the profile's lock.
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @param log - the whole log.
 * @throws {HomeLayoutError} `HOME_MODE` when `changes/` is laxer than 0700.
 */
export async function writeChangeLog(home: string, profile: string, log: ChangeLog): Promise<void> {
  await makeChangesDirectory(home, profileChangesDirectory(home, profile))
  await writeProtectedFile(logPath(home, profile), jsonText(log))
}

/**
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @returns the agent-action log's path.
 */
function agentLogPath(home: string, profile: string): string {
  return join(profileChangesDirectory(home, profile), CHANGES_ENTRIES.agentLog)
}

/**
 * Read the profile's agent-action log ([agent actions](./agent-actions.ts)). Starting a profile never calls this: a log that
 * cannot be read stops the Changes commands that list or undo, not the start.
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @returns the log; an empty one when the profile has none.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the file is not one Delorun wrote.
 */
export async function readAgentLog(home: string, profile: string): Promise<AgentLog> {
  const path = agentLogPath(home, profile)
  const value = await readRecordFile(path)
  if (value === undefined) return { schema: AGENT_LOG_SCHEMA, entries: [] }
  assertAgentLog(value, path)
  return value
}

/**
 * Write the profile's agent-action log. The caller holds the profile's lock.
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @param log - the whole log.
 * @throws {HomeLayoutError} `HOME_MODE` when `changes/` is laxer than 0700.
 */
export async function writeAgentLog(home: string, profile: string, log: AgentLog): Promise<void> {
  await makeChangesDirectory(home, profileChangesDirectory(home, profile))
  await writeProtectedFile(agentLogPath(home, profile), jsonText(log))
}

/**
 * The profile's change log with its agent-action entries added, for the commands that list and undo changes. The result is
 * for reading only: writing it to `log.json` would put agent entries there.
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @returns the log's entries and the agent's, by when each was created, the log's first on a tie.
 * @throws {ChangesError} `RECORD_UNREADABLE` when either file is not one Delorun wrote.
 */
export async function readChangeLogWithAgent(home: string, profile: string): Promise<ChangeLog> {
  return withAgentEntries(await readChangeLog(home, profile), (await readAgentLog(home, profile)).entries)
}

/**
 * @param log - a change log.
 * @param agent - the entries of the agent-action log.
 * @returns the log's entries and the agent's, by when each was created, the log's first on a tie; for reading only.
 */
export function withAgentEntries(log: ChangeLog, agent: readonly ChangeEntry[]): ChangeLog {
  if (agent.length === 0) return log
  const ordered = [...log.entries, ...agent].map((entry, index) => ({ entry, index, at: Date.parse(entry.createdAt) }))
  ordered.sort((left, right) => left.at - right.at || left.index - right.index)
  return { ...log, entries: ordered.map(({ entry }) => entry) }
}

/**
 * @param log - a change log.
 * @param entry - an entry.
 * @returns the log with the entry in place of the one with its id, or appended when none has it.
 */
export function withEntry(log: ChangeLog, entry: ChangeEntry): ChangeLog {
  const at = log.entries.findIndex(existing => existing.id === entry.id)
  return { ...log, entries: at < 0 ? [...log.entries, entry] : log.entries.with(at, entry) }
}

/**
 * @param log - a change log.
 * @param id - a change id.
 * @returns the entry with the id, or undefined.
 */
export function findEntry(log: ChangeLog, id: ChangeId): ChangeEntry | undefined {
  return log.entries.find(entry => entry.id === id)
}

/**
 * @param entry - a logged change.
 * @returns whether the first start under Changes approved it as it was and no terminal has shown that yet.
 */
export function unshownAtUpgrade(entry: ChangeEntry): boolean {
  return entry.decidedFrom === 'upgrade' && entry.state === 'applied' && entry.shownAt === undefined
}

/** The profile whose log records what a terminal showed, and how long to wait for its write lock. */
export interface ShownTarget {
  /** The Delorun home. */
  readonly home: string
  /** The profile's name. */
  readonly profile: string
  /** The profile's directory, whose `package.json` file lock is upstream's profile write lock. */
  readonly profileDir: string
  /** How long to wait for the lock, in milliseconds. */
  readonly lockWaitMs: number
}

/**
 * Record that a terminal showed the person the plugins the first start under Changes approved as they were. Until
 * then every start that reaches a terminal, `delorun status` and `delorun changes list` name them. Runs under the
 * profile's write lock.
 * @param target - the profile and the lock wait.
 * @param plugins - the plugins shown.
 * @param at - when, ISO 8601.
 * @returns whether the log changed.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the log is not one Delorun wrote.
 */
export async function markShownAtUpgrade(target: ShownTarget, plugins: readonly string[], at: string): Promise<boolean> {
  const { home, profile } = target
  return withProfileWriteLock(target.profileDir, async () => {
    const log = await readChangeLog(home, profile)
    let changed = false
    const entries = log.entries.map((entry): ChangeEntry => {
      if (!unshownAtUpgrade(entry) || entry.subject.plugin === undefined || !plugins.includes(entry.subject.plugin)) return entry
      changed = true
      return { ...entry, shownAt: at }
    })
    if (changed) await writeChangeLog(home, profile, { ...log, entries })
    return changed
  }, { waitMs: target.lockWaitMs })
}

const MIGRATION_RULES: Readonly<Record<string, FieldRule>> = {
  schema: schemaRule(MIGRATION_RECORD_SCHEMA),
  at: required.iso,
  profiles: {
    expected: 'a list of distinct profile names',
    test: value => Array.isArray(value) && value.every(name => typeof name === 'string') && new Set(value).size === value.length,
  },
}

/**
 * Read the record of the profiles the first start under Changes found.
 * @param home - the Delorun home.
 * @returns the record, or undefined when no start has brought a profile under Changes.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the record is not one Delorun wrote.
 */
export async function readMigration(home: string): Promise<MigrationRecord | undefined> {
  const path = migrationPath(home)
  const value = await readRecordFile(path)
  if (value === undefined) return undefined
  checkFields(value, path, 'the record', MIGRATION_RULES)
  return value as MigrationRecord
}

/**
 * The profiles a profiles directory holds: each directory with a `package.json`.
 * @param profilesDir - the directory holding the profiles.
 * @returns their names, sorted.
 */
async function profilesIn(profilesDir: string): Promise<string[]> {
  const names = await readdir(profilesDir, { withFileTypes: true })
  const found: string[] = []
  for (const entry of names) {
    if (entry.isDirectory() && await isFile(join(profilesDir, entry.name, 'package.json'))) found.push(entry.name)
  }
  return found.sort()
}

/**
 * @param path - a path.
 * @returns whether a regular file is there.
 */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (_absent) {
    // Missing or unreachable: no profile manifest there.
    return false
  }
}

/**
 * Whether this start of a profile approves the profile's linked plugins as they are: the profile's log has no
 * `migratedAt`, and the profile is one the home held when a start first brought a profile under Changes. The first
 * such start writes that record, `changes/migration.json`, naming every profile in the profile's directory then, by an
 * exclusive create, so two starts at once record one list. A profile created after it waits for review like any new
 * plugin link, so a second profile's links are never approved silently. The caller holds the profile's lock.
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @param profileDir - its directory; the directory holding it holds the home's profiles.
 * @param log - its change log.
 * @param at - the start's time, ISO 8601.
 * @returns whether the start approves the linked plugins as they are.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the record is not one Delorun wrote.
 * @throws {HomeLayoutError} `HOME_MODE` when `changes/` is laxer than 0700.
 */
export async function migratesAtUpgrade(home: string, profile: string, profileDir: string, log: ChangeLog, at: string): Promise<boolean> {
  if (log.migratedAt !== undefined) return false
  const record = await readMigration(home) ?? await recordMigration(home, dirname(profileDir), at)
  return record.profiles.includes(profile)
}

/**
 * Write the record of the profiles the home holds now, unless another start wrote one first.
 * @param home - the Delorun home.
 * @param profilesDir - the directory holding the profiles.
 * @param at - when, ISO 8601.
 * @returns the record that holds.
 */
async function recordMigration(home: string, profilesDir: string, at: string): Promise<MigrationRecord> {
  const record: MigrationRecord = { schema: MIGRATION_RECORD_SCHEMA, at, profiles: await profilesIn(profilesDir) }
  const path = migrationPath(home)
  await makeChangesDirectory(home, changesDirectory(home))
  const temporary = `${path}.new-${randomBytes(8).toString('hex')}`
  await writeProtectedFile(temporary, jsonText(record))
  try {
    await link(temporary, path)
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error
    // Another start recorded the profiles first; its list holds.
    return (await readMigration(home))!
  } finally {
    await unlink(temporary)
  }
  return record
}

/**
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @returns the active record's path.
 */
function activePath(home: string, profile: string): string {
  return join(profileChangesDirectory(home, profile), CHANGES_ENTRIES.activeRecord)
}

/**
 * Read what the profile's active directories hold.
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @returns the record; an empty one when the profile has none.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the record is not one Delorun wrote.
 */
export async function readActiveRecord(home: string, profile: string): Promise<ActiveRecord> {
  const path = activePath(home, profile)
  const value = await readRecordFile(path)
  if (value === undefined) return { schema: ACTIVE_RECORD_SCHEMA, plugins: {} }
  assertActive(value, path)
  return value
}

/**
 * Write what the profile's active directories hold. The caller holds the profile's lock.
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @param record - the whole record.
 * @throws {HomeLayoutError} `HOME_MODE` when `changes/` is laxer than 0700.
 */
export async function writeActiveRecord(home: string, profile: string, record: ActiveRecord): Promise<void> {
  await makeChangesDirectory(home, profileChangesDirectory(home, profile))
  await writeProtectedFile(activePath(home, profile), jsonText(record))
}

/** The key under `delorun` in the profile's `package.json` that holds the {@link ApprovedRecord}. */
export const APPROVED_KEY = 'changes'

/**
 * Read the profile's `package.json`.
 * @param path - its path.
 * @returns its fields.
 * @throws {ChangesError} `RECORD_UNREADABLE` when it cannot be read or is not a JSON object.
 */
async function readManifest(path: string): Promise<Readonly<Record<string, unknown>>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw unreadable(path, `it cannot be read (${String(error)})`, error)
  }
  return objectAt(parseJson(text, path), path, 'the manifest')
}

/**
 * @param manifest - the profile's `package.json` fields.
 * @param path - its path.
 * @returns the `delorun` object, empty when absent.
 * @throws {ChangesError} `RECORD_UNREADABLE` when `delorun` is not an object.
 */
function delorunSection(manifest: Readonly<Record<string, unknown>>, path: string): Readonly<Record<string, unknown>> {
  return Object.hasOwn(manifest, 'delorun') ? objectAt(manifest.delorun, path, 'the manifest.delorun') : {}
}

/**
 * Read the profile's approved plugins from its `package.json`.
 * @param profileDir - the profile's directory.
 * @returns the record; an empty one when the manifest has none.
 * @throws {ChangesError} `RECORD_UNREADABLE` when `package.json` cannot be read or the record is not one Delorun wrote.
 */
export async function readApproved(profileDir: string): Promise<ApprovedRecord> {
  const path = join(profileDir, 'package.json')
  const delorun = delorunSection(await readManifest(path), path)
  if (!Object.hasOwn(delorun, APPROVED_KEY)) return { schema: APPROVED_RECORD_SCHEMA, plugins: {} }
  const value = delorun[APPROVED_KEY]
  assertApproved(value, path, `the manifest.delorun.${APPROVED_KEY}`)
  return value
}

/**
 * Write the profile's approved plugins into its `package.json`, keeping every other field and writing 2-space JSON
 * with one trailing newline at mode 0600. The caller holds the profile's write lock, upstream's
 * `withFileLock(join(profileDir, 'package.json'), …)`, so the read and the rewrite see no other writer.
 * @param profileDir - the profile's directory.
 * @param record - the whole record.
 * @throws {ChangesError} `RECORD_UNREADABLE` when `package.json` cannot be read or `delorun` is not an object.
 */
export async function writeApproved(profileDir: string, record: ApprovedRecord): Promise<void> {
  const path = join(profileDir, 'package.json')
  const manifest = await readManifest(path)
  const delorun = delorunSection(manifest, path)
  await writeFileAtomic(path, jsonText({ ...manifest, delorun: { ...delorun, [APPROVED_KEY]: record } }), { mode: PROTECTED_FILE_MODE })
}

/**
 * @param record - the profile's approved record.
 * @param plugin - a package name.
 * @returns the plugin's approval, or undefined when it has none.
 */
export function approvedOf(record: ApprovedRecord, plugin: string): ApprovedPlugin | undefined {
  return Object.hasOwn(record.plugins, plugin) ? record.plugins[plugin] : undefined
}

/**
 * Hold the lock of the harness's records, `changes/harness.lock`, around one read, decision and write of a harness
 * record or the harness's change log.
 * @param home - the Delorun home.
 * @param operation - what runs under the lock.
 * @returns what the operation returned.
 * @throws the lock's timeout when another process holds it longer than two minutes.
 */
export async function withHarnessLock<T>(home: string, operation: () => Promise<T>): Promise<T> {
  await makeChangesDirectory(home, changesDirectory(home))
  return withFileLock(harnessDirectory(home), operation, { waitMs: 120_000 })
}

/**
 * Read one runtime's harness record.
 * @param home - the Delorun home.
 * @param runtime - the runtime version.
 * @returns the record; one with no file when the runtime has none.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the record is not one Delorun wrote or names another runtime;
 *   `INVALID_REQUEST` when the version is not a runtime version.
 */
export async function readHarnessRecord(home: string, runtime: string): Promise<HarnessRecord> {
  const path = harnessRecordPath(home, runtime)
  const value = await readRecordFile(path)
  if (value === undefined) return { schema: HARNESS_RECORD_SCHEMA, runtime, files: {} }
  checkFields(value, path, 'the record', HARNESS_RULES)
  const record = value as HarnessRecord
  if (record.runtime !== runtime) throw unreadable(path, `the record names runtime ${JSON.stringify(record.runtime)}, not ${runtime}`)
  return record
}

/**
 * Write one runtime's harness record. The caller holds {@link withHarnessLock}.
 * @param home - the Delorun home.
 * @param record - the whole record.
 * @throws {ChangesError} `INVALID_REQUEST` when the record names a path that is not under `app/` or a version that is
 *   not a runtime version.
 * @throws {HomeLayoutError} `HOME_MODE` when `changes/` is laxer than 0700.
 */
export async function writeHarnessRecord(home: string, record: HarnessRecord): Promise<void> {
  const path = harnessRecordPath(home, record.runtime)
  const bad = Object.keys(record.files).find(file => !isHarnessPath(file))
  if (bad !== undefined) throw new ChangesError('INVALID_REQUEST', bad, `${JSON.stringify(bad)} is not a path under the runtime's app/ directory.`)
  await makeChangesDirectory(home, dirname(path))
  await writeProtectedFile(path, jsonText(record))
}

/**
 * Read the change log of the harness's own files, which every profile shows.
 * @param home - the Delorun home.
 * @returns the log; an empty one when there is none.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the log is not one Delorun wrote.
 */
export async function readHarnessLog(home: string): Promise<ChangeLog> {
  const path = harnessLogPath(home)
  const value = await readRecordFile(path)
  if (value === undefined) return { schema: CHANGE_LOG_SCHEMA, entries: [] }
  assertChangeLog(value, path)
  return value
}

/**
 * Write the change log of the harness's own files. The caller holds {@link withHarnessLock}.
 * @param home - the Delorun home.
 * @param log - the whole log.
 * @throws {HomeLayoutError} `HOME_MODE` when `changes/` is laxer than 0700.
 */
export async function writeHarnessLog(home: string, log: ChangeLog): Promise<void> {
  await makeChangesDirectory(home, harnessDirectory(home))
  await writeProtectedFile(harnessLogPath(home), jsonText(log))
}
