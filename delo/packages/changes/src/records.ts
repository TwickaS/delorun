/**
 * Readers and writers of the records of Changes, and the proof that a person is at their computer that changing the
 * protection setting and opening or closing a work session require.
 *
 * Every reader validates what it reads: the schema tag, each field's type and allowed values and no unknown field, so
 * a record that is not one Delo wrote throws `RECORD_UNREADABLE` and nothing decides from it. A missing file reads as
 * the documented default. The records under `changes/` are protected files: written at mode 0600 by an atomic rename,
 * and refused on read when another user could read them, with their directories created at mode 0700. The approved
 * record lives in the profile's `package.json` under `delo.changes`, so profile history holds it.
 *
 * @module @delo/changes/records
 */
import { randomBytes } from 'node:crypto'
import { link, mkdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { PRIVATE_DIR_MODE, PROTECTED_FILE_MODE } from '@delo/contract-home-layout'
import { checkPrivateDirectory, readProtectedFile, writeProtectedFile } from '@delo/home'
import { ChangesError } from './errors.ts'
import { CHANGE_ID_PATTERN } from './ids.ts'
import { CHANGES_ENTRIES, changesDirectory, profileChangesDirectory, protectionPath } from './paths.ts'
import {
  ACTIVE_RECORD_SCHEMA,
  APPROVED_RECORD_SCHEMA,
  CHANGE_KINDS,
  CHANGE_LOG_SCHEMA,
  CHANGE_STATES,
  DEFAULT_PROTECTION,
  PROTECTION_LEVELS,
  PROTECTION_RECORD_SCHEMA,
  WORK_SESSION_SCHEMA,
  type ActiveRecord,
  type ApprovedPlugin,
  type ApprovedRecord,
  type ChangeEntry,
  type ChangeId,
  type ChangeLog,
  type ContentVersion,
  type ProtectionLevel,
  type ProtectionRecord,
  type WorkSessionRecord,
} from './types.ts'

/** What a {@link ContentVersion} is: a SHA-256 in lowercase hexadecimal. */
export const CONTENT_VERSION_PATTERN = /^[0-9a-f]{64}$/

/** What a package name under Changes is: npm's form, with an optional scope. */
export const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/

/** The brand of {@link AtComputer}; not exported, so no other module can write it. */
const AT_COMPUTER: unique symbol = Symbol('AtComputer')

/**
 * Proof that the caller acts for a person at their computer: issued only by {@link attestTerminal} and
 * {@link attestStudio}, and checked at run time against the values they issued, so an object that merely looks like one
 * is refused.
 */
export interface AtComputer {
  /** Where the person is. */
  readonly kind: 'terminal' | 'studio'
  readonly [AT_COMPUTER]: true
}

/** Every {@link AtComputer} the two attest functions issued. */
const issued = new WeakSet<AtComputer>()

/**
 * @param kind - where the person is.
 * @returns a new, frozen proof.
 */
function issue(kind: AtComputer['kind']): AtComputer {
  const presence: AtComputer = Object.freeze({ kind, [AT_COMPUTER]: true as const })
  issued.add(presence)
  return presence
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
 * Attest that a studio request comes from the person at their computer.
 * @param facts - whether the request reached the studio's loopback address, carried the studio's credential, and came
 * through a remote session.
 * @returns the proof.
 * @throws {ChangesError} `NOT_AT_COMPUTER` unless the request is a loopback one with the credential and not remote.
 */
export function attestStudio(facts: { readonly loopback: boolean, readonly credential: boolean, readonly remoteSession: boolean }): AtComputer {
  if (!facts.loopback || !facts.credential || facts.remoteSession) {
    throw new ChangesError('NOT_AT_COMPUTER', 'studio', 'This needs you at your computer: open the studio on this computer, not through a remote session.')
  }
  return issue('studio')
}

/**
 * @param presence - a claimed proof.
 * @param subject - what it is for, for the refusal.
 * @throws {ChangesError} `NOT_AT_COMPUTER` when the attest functions did not issue it.
 */
function requirePresence(presence: AtComputer, subject: string): void {
  if (!issued.has(presence)) throw new ChangesError('NOT_AT_COMPUTER', subject, 'This needs you at your computer, and the request did not come from a terminal or the studio on this computer.')
}

/**
 * @param path - the record's path.
 * @param detail - what is wrong with it.
 * @param cause - the underlying error.
 * @returns the refusal.
 */
function unreadable(path: string, detail: string, cause?: unknown): ChangesError {
  return new ChangesError('RECORD_UNREADABLE', path, `${path} is not a record Delo wrote: ${detail}.`, cause === undefined ? undefined : { cause })
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
 * @param home - the Delo home.
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
function byPackageName(rules: Readonly<Record<string, FieldRule>>): FieldRule {
  return {
    expected: 'an object by package name',
    test: (value, path, where) => {
      for (const [name, entry] of Object.entries(objectAt(value, path, where))) {
        if (!PACKAGE_NAME_PATTERN.test(name)) throw unreadable(path, `${where} names ${JSON.stringify(name)}, which is not a package name`)
        checkFields(entry, path, `${where}[${JSON.stringify(name)}]`, rules)
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
  lastLoaded: optional.version,
}

const ENTRY_RULES: Readonly<Record<string, FieldRule>> = {
  id: { test: matching(CHANGE_ID_PATTERN), expected: 'a change id' },
  kind: { test: oneOf(CHANGE_KINDS), expected: 'a change kind' },
  state: { test: oneOf(CHANGE_STATES), expected: 'a change state' },
  subject: nested({ plugin: optional.string, source: optional.string, file: optional.string, setting: optional.string, spec: optional.string }, 'a change subject'),
  from: optional.version,
  to: optional.version,
  summary: required.string,
  createdAt: required.iso,
  decidedAt: optional.iso,
  decidedFrom: { test: oneOf(['terminal', 'studio', 'upgrade', 'start']), expected: 'terminal, studio, upgrade or start', optional: true },
  historyVersion: optional.string,
  leftOut: { ...nested({ at: required.iso, failure: required.string }, 'a failure report'), optional: true },
  shownAt: optional.iso,
  lastFailure: { ...nested({ at: required.iso, failure: required.string }, 'a failure report'), optional: true },
}

const LOG_RULES: Readonly<Record<string, FieldRule>> = {
  schema: schemaRule(CHANGE_LOG_SCHEMA),
  migratedAt: optional.iso,
  entries: {
    expected: 'a list of changes with distinct ids',
    test: (value, path, where) => {
      if (!Array.isArray(value)) return false
      const entries: readonly unknown[] = value
      const ids = new Set<unknown>()
      entries.forEach((entry, index) => {
        checkFields(entry, path, `${where}[${String(index)}]`, ENTRY_RULES)
        ids.add(objectAt(entry, path, where).id)
      })
      return ids.size === entries.length
    },
  },
}

const ACTIVE_RULES: Readonly<Record<string, FieldRule>> = {
  schema: schemaRule(ACTIVE_RECORD_SCHEMA),
  plugins: byPackageName({ version: required.version, kind: { test: oneOf(['approved', 'work-session', 'unapproved']), expected: 'approved, work-session or unapproved' } }),
}

const APPROVED_RULES: Readonly<Record<string, FieldRule>> = {
  schema: schemaRule(APPROVED_RECORD_SCHEMA),
  plugins: byPackageName({ source: required.string, version: required.version, approvedAt: required.iso, approvedAtUpgrade: { test: isTrue, expected: 'true', optional: true } }),
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
 * @param home - the Delo home.
 * @returns the level; {@link DEFAULT_PROTECTION} when the home has no protection record.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the record cannot be read, has a mode others can read, or is not one
 * Delo wrote.
 */
export async function readProtection(home: string): Promise<ProtectionLevel> {
  const path = protectionPath(home)
  const value = await readRecordFile(path)
  if (value === undefined) return DEFAULT_PROTECTION
  assertProtection(value, path)
  return value.level
}

/**
 * Change the protection setting. Only the terminal command changes it: a studio proof is refused.
 * @param home - the Delo home.
 * @param level - the new level.
 * @param presence - proof from {@link attestTerminal}.
 * @returns the record written.
 * @throws {ChangesError} `NOT_AT_COMPUTER` for a proof the attest functions did not issue or one from the studio.
 * @throws {HomeLayoutError} `HOME_MODE` when `changes/` is laxer than 0700.
 */
export async function setProtection(home: string, level: ProtectionLevel, presence: AtComputer): Promise<ProtectionRecord> {
  requirePresence(presence, 'protection')
  if (presence.kind !== 'terminal') throw new ChangesError('NOT_AT_COMPUTER', 'protection', 'The protection setting changes only with `delorun changes protection` in a terminal on this computer.')
  const record: ProtectionRecord = { schema: PROTECTION_RECORD_SCHEMA, level, setAt: new Date().toISOString() }
  await makeChangesDirectory(home, changesDirectory(home))
  await writeProtectedFile(protectionPath(home), jsonText(record))
  return record
}

/**
 * @param home - the Delo home.
 * @param profile - the profile's name.
 * @returns the work-session record's path.
 */
function workSessionPath(home: string, profile: string): string {
  return join(profileChangesDirectory(home, profile), CHANGES_ENTRIES.workSession)
}

/**
 * Read the profile's open work session.
 * @param home - the Delo home.
 * @param profile - the profile's name.
 * @returns the record, or undefined when no work session is open.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the record is not one Delo wrote.
 */
export async function readWorkSession(home: string, profile: string): Promise<WorkSessionRecord | undefined> {
  const path = workSessionPath(home, profile)
  const value = await readRecordFile(path)
  if (value === undefined) return undefined
  assertWorkSession(value, path)
  return value
}

/** What the caller states when it opens a work session; the start time and place come from the call. */
export type WorkSessionStart = Pick<WorkSessionRecord, 'plugin' | 'source' | 'from'>

/**
 * Open a work session. The record is written completely to a temporary file and then linked to its name, which fails
 * when the name exists, so two openings never both succeed.
 * @param home - the Delo home.
 * @param profile - the profile's name.
 * @param start - the plugin, its folder and its approved content.
 * @param presence - proof from {@link attestTerminal} or {@link attestStudio}; its kind is recorded as `startedFrom`.
 * @returns the record written.
 * @throws {ChangesError} `NOT_AT_COMPUTER` for a proof the attest functions did not issue; `WORK_SESSION_OPEN` when the
 * profile has a work session already.
 */
export async function openWorkSession(home: string, profile: string, start: WorkSessionStart, presence: AtComputer): Promise<WorkSessionRecord> {
  requirePresence(presence, start.plugin)
  const record: WorkSessionRecord = { schema: WORK_SESSION_SCHEMA, plugin: start.plugin, source: start.source, from: start.from, startedAt: new Date().toISOString(), startedFrom: presence.kind }
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
 * @param home - the Delo home.
 * @param profile - the profile's name.
 * @param plugin - the plugin's package name.
 * @param presence - proof from {@link attestTerminal} or {@link attestStudio}.
 * @returns the closed record.
 * @throws {ChangesError} `NOT_AT_COMPUTER` for a proof the attest functions did not issue; `NO_WORK_SESSION` when no
 * work session is open or it is another plugin's; `RECORD_UNREADABLE` when the record is not one Delo wrote.
 */
export async function closeWorkSession(home: string, profile: string, plugin: string, presence: AtComputer): Promise<WorkSessionRecord> {
  requirePresence(presence, plugin)
  const record = await readWorkSession(home, profile)
  if (record?.plugin !== plugin) throw new ChangesError('NO_WORK_SESSION', plugin, `No work session on ${plugin} is open in profile ${profile}.`)
  await unlink(workSessionPath(home, profile))
  return record
}

/**
 * Record the content that last loaded in the open work session, which a failed reload goes back to. The Host records
 * what it loaded, so no proof of presence is needed. The caller holds the profile's lock.
 * @param home - the Delo home.
 * @param profile - the profile's name.
 * @param version - the content that loaded.
 * @returns the updated record.
 * @throws {ChangesError} `NO_WORK_SESSION` when none is open; `RECORD_UNREADABLE` when the record is not one Delo wrote.
 */
export async function noteLoaded(home: string, profile: string, version: ContentVersion): Promise<WorkSessionRecord> {
  const record = await readWorkSession(home, profile)
  if (record === undefined) throw new ChangesError('NO_WORK_SESSION', profile, `No work session is open in profile ${profile}.`)
  const updated: WorkSessionRecord = { ...record, lastLoaded: version }
  await writeProtectedFile(workSessionPath(home, profile), jsonText(updated))
  return updated
}

/**
 * @param home - the Delo home.
 * @param profile - the profile's name.
 * @returns the change log's path.
 */
function logPath(home: string, profile: string): string {
  return join(profileChangesDirectory(home, profile), CHANGES_ENTRIES.log)
}

/**
 * Read the profile's change log.
 * @param home - the Delo home.
 * @param profile - the profile's name.
 * @returns the log; an empty one when the profile has none.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the log is not one Delo wrote.
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
 * @param home - the Delo home.
 * @param profile - the profile's name.
 * @param log - the whole log.
 * @throws {HomeLayoutError} `HOME_MODE` when `changes/` is laxer than 0700.
 */
export async function writeChangeLog(home: string, profile: string, log: ChangeLog): Promise<void> {
  await makeChangesDirectory(home, profileChangesDirectory(home, profile))
  await writeProtectedFile(logPath(home, profile), jsonText(log))
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
 * @param home - the Delo home.
 * @param profile - the profile's name.
 * @returns the active record's path.
 */
function activePath(home: string, profile: string): string {
  return join(profileChangesDirectory(home, profile), CHANGES_ENTRIES.activeRecord)
}

/**
 * Read what the profile's active directories hold.
 * @param home - the Delo home.
 * @param profile - the profile's name.
 * @returns the record; an empty one when the profile has none.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the record is not one Delo wrote.
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
 * @param home - the Delo home.
 * @param profile - the profile's name.
 * @param record - the whole record.
 * @throws {HomeLayoutError} `HOME_MODE` when `changes/` is laxer than 0700.
 */
export async function writeActiveRecord(home: string, profile: string, record: ActiveRecord): Promise<void> {
  await makeChangesDirectory(home, profileChangesDirectory(home, profile))
  await writeProtectedFile(activePath(home, profile), jsonText(record))
}

/** The key under `delo` in the profile's `package.json` that holds the {@link ApprovedRecord}. */
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
 * @returns the `delo` object, empty when absent.
 * @throws {ChangesError} `RECORD_UNREADABLE` when `delo` is not an object.
 */
function deloSection(manifest: Readonly<Record<string, unknown>>, path: string): Readonly<Record<string, unknown>> {
  return Object.hasOwn(manifest, 'delo') ? objectAt(manifest.delo, path, 'the manifest.delo') : {}
}

/**
 * Read the profile's approved plugins from its `package.json`.
 * @param profileDir - the profile's directory.
 * @returns the record; an empty one when the manifest has none.
 * @throws {ChangesError} `RECORD_UNREADABLE` when `package.json` cannot be read or the record is not one Delo wrote.
 */
export async function readApproved(profileDir: string): Promise<ApprovedRecord> {
  const path = join(profileDir, 'package.json')
  const delo = deloSection(await readManifest(path), path)
  if (!Object.hasOwn(delo, APPROVED_KEY)) return { schema: APPROVED_RECORD_SCHEMA, plugins: {} }
  const value = delo[APPROVED_KEY]
  assertApproved(value, path, `the manifest.delo.${APPROVED_KEY}`)
  return value
}

/**
 * Write the profile's approved plugins into its `package.json`, keeping every other field and writing 2-space JSON
 * with one trailing newline at mode 0600. The caller holds the profile's write lock, upstream's
 * `withFileLock(join(profileDir, 'package.json'), …)`, so the read and the rewrite see no other writer.
 * @param profileDir - the profile's directory.
 * @param record - the whole record.
 * @throws {ChangesError} `RECORD_UNREADABLE` when `package.json` cannot be read or `delo` is not an object.
 */
export async function writeApproved(profileDir: string, record: ApprovedRecord): Promise<void> {
  const path = join(profileDir, 'package.json')
  const manifest = await readManifest(path)
  const delo = deloSection(manifest, path)
  await writeFileAtomic(path, jsonText({ ...manifest, delo: { ...delo, [APPROVED_KEY]: record } }), { mode: PROTECTED_FILE_MODE })
}

/**
 * @param record - the profile's approved record.
 * @param plugin - a package name.
 * @returns the plugin's approval, or undefined when it has none.
 */
export function approvedOf(record: ApprovedRecord, plugin: string): ApprovedPlugin | undefined {
  return Object.hasOwn(record.plugins, plugin) ? record.plugins[plugin] : undefined
}
