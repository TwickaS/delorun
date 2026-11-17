/**
 * The notices Changes keeps for the person at the computer (C21, "Who may do what from where"): a change of the
 * protection setting made from a paired device. The studio at the computer shows each until the person dismisses it, and
 * `delorun changes list` prints it. They live in their own record, `changes/notices.json`, so the change log keeps its
 * schema and an older runtime that reads the log after a rollback still reads it.
 *
 * @module @delorun/changes/notices
 */
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { PRIVATE_DIR_MODE } from '@delorun/contract-home-layout'
import { checkPrivateDirectory, readProtectedFile, writeProtectedFile } from '@delorun/home'
import { ChangesError } from './errors.ts'
import { changesDirectory, noticesPath } from './paths.ts'
import { requirePresence, type AtComputer, type StudioDevice } from './records.ts'
import { PROTECTION_LEVELS, type ProtectionLevel } from './types.ts'

/** Schema tag of the notices record. */
export const NOTICES_SCHEMA = 'delorun.changes-notices/1'

/** The most notices the record keeps; the oldest goes first. */
export const MAX_NOTICES = 20

/** What a notice's id is. */
const NOTICE_ID_PATTERN = /^n[0-9a-f]{12}$/

/** One change of the protection setting made from a paired device. */
export interface ProtectionNotice {
  readonly id: string
  readonly kind: 'protection'
  /** The level it was set to. */
  readonly level: ProtectionLevel
  /** When, ISO 8601. */
  readonly at: string
  /** The device's id. */
  readonly deviceId: string
  /** The name the person gave the device. */
  readonly device: string
}

/** The file `changes/notices.json`. */
interface NoticesRecord {
  readonly schema: typeof NOTICES_SCHEMA
  /** Oldest first. */
  readonly notices: readonly ProtectionNotice[]
}

/**
 * @param path - the record's path.
 * @param detail - what is wrong.
 * @returns the refusal.
 */
function unreadable(path: string, detail: string): ChangesError {
  return new ChangesError('RECORD_UNREADABLE', path, `${path} is not a record Delorun wrote: ${detail}.`)
}

/**
 * @param value - one parsed notice.
 * @param path - the record's path.
 * @returns the notice.
 * @throws {ChangesError} `RECORD_UNREADABLE` unless it is one.
 */
function noticeOf(value: unknown, path: string): ProtectionNotice {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw unreadable(path, 'a notice is not an object')
  const fields = value as Readonly<Record<string, unknown>>
  const { id, kind, level, at, deviceId, device } = fields
  if (Object.keys(fields).length !== 6 || typeof id !== 'string' || !NOTICE_ID_PATTERN.test(id) || kind !== 'protection'
    || !(PROTECTION_LEVELS as readonly unknown[]).includes(level) || typeof at !== 'string' || Number.isNaN(Date.parse(at))
    || typeof deviceId !== 'string' || typeof device !== 'string') {
    throw unreadable(path, 'a notice does not have the fields of a protection notice')
  }
  return { id, kind, level: level as ProtectionLevel, at, deviceId, device }
}

/**
 * Read the notices, oldest first.
 * @param home - the Delorun home.
 * @returns them; none when the home has no record.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the record cannot be read, has a mode others can read, or is not one
 *   Delorun wrote.
 */
export async function readNotices(home: string): Promise<readonly ProtectionNotice[]> {
  const path = noticesPath(home)
  let text: string
  try {
    text = (await readProtectedFile(path)).toString('utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw unreadable(path, `it cannot be read (${String(error)})`)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (_notJson) {
    // The refusal names what the file must be.
    throw unreadable(path, 'it is not JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw unreadable(path, 'it is not an object')
  const record = value as Readonly<Record<string, unknown>>
  if (Object.keys(record).length !== 2 || record.schema !== NOTICES_SCHEMA || !Array.isArray(record.notices)) throw unreadable(path, `it is not ${NOTICES_SCHEMA}`)
  return record.notices.map(notice => noticeOf(notice, path))
}

/**
 * Rewrite the notices under the record's lock.
 * @param home - the Delorun home.
 * @param change - what to make of the notices read.
 * @returns what `change` returned.
 */
async function withNotices<T>(home: string, change: (notices: readonly ProtectionNotice[]) => { readonly notices: readonly ProtectionNotice[], readonly result: T }): Promise<T> {
  await mkdir(changesDirectory(home), { recursive: true, mode: PRIVATE_DIR_MODE })
  await checkPrivateDirectory(changesDirectory(home))
  return withFileLock(noticesPath(home), async () => {
    const { notices, result } = change(await readNotices(home))
    const record: NoticesRecord = { schema: NOTICES_SCHEMA, notices }
    await writeProtectedFile(noticesPath(home), `${JSON.stringify(record, null, 2)}\n`)
    return result
  })
}

/**
 * Record that a paired device changed the protection setting. `changeProtection` calls it for a proof that names a device.
 * @param home - the Delorun home.
 * @param level - the level it set.
 * @param device - the device.
 * @param at - when, ISO 8601.
 * @returns the notice.
 * @throws {ChangesError} `RECORD_UNREADABLE` for a record that is not one Delorun wrote.
 */
export async function addProtectionNotice(home: string, level: ProtectionLevel, device: StudioDevice, at: string): Promise<ProtectionNotice> {
  const notice: ProtectionNotice = { id: `n${randomBytes(6).toString('hex')}`, kind: 'protection', level, at, deviceId: device.id, device: device.label }
  return withNotices(home, notices => ({ notices: [...notices, notice].slice(-MAX_NOTICES), result: notice }))
}

/**
 * Dismiss one notice: the person at the computer has seen it. A device's proof is refused, so a phone cannot hide what
 * it changed from the computer.
 * @param home - the Delorun home.
 * @param id - the notice.
 * @param presence - proof from a terminal or the studio at the computer.
 * @returns whether the record held it.
 * @throws {ChangesError} `NOT_AT_COMPUTER` for a proof the attest functions did not issue or one that names a device.
 */
export async function dismissNotice(home: string, id: string, presence: AtComputer): Promise<boolean> {
  requirePresence(presence, 'notice')
  if (presence.device !== undefined) throw new ChangesError('NOT_AT_COMPUTER', 'notice', 'A notice is dismissed at your computer, where it is shown.')
  return withNotices(home, notices => ({ notices: notices.filter(notice => notice.id !== id), result: notices.some(notice => notice.id === id) }))
}
