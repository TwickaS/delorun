/**
 * The one lock-file implementation of Delo's locks (contract C1): the home lock `run/<profile>/home.lock` and the
 * runtime store's `runtimes/store.lock`. Each lock is one JSON record file at mode 0600 naming its holder
 * ([holder](./holder.ts)) and a random id that is never reused.
 *
 * Every file this module creates is written to a temporary file and hard-linked to its path, so it appears with its
 * whole record or not at all, and of any number of contenders exactly one link succeeds.
 *
 * A record whose holder is dead is removed under a takeover guard, `<lock>.takeover-<id>`, named after the dead
 * record's id and created the same way, so one contender at a time may remove that one record. Holding the guard, it
 * removes the file only when the file still holds that id. An id is never reused, and only the guard holder may remove
 * that record, so a contender never removes a lock other than the dead one it found, however late it runs. A guard left
 * by a contender that died is itself removed under a guard named after its own id.
 *
 * @module @delo/home/lock-file
 */
import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { PROTECTED_FILE_MODE } from '@delo/contract-home-layout'
import { currentHolder, holderAlive, parseHolder, type ProcessHolder } from './holder.ts'

/** The largest lock or guard record read; a valid record is far smaller. */
const MAX_RECORD_BYTES = 4096

/** Nested takeovers of guards left by dead contenders before giving up; each level needs another contender to have died mid-removal. */
const MAX_TAKEOVER_DEPTH = 8

const RANDOM_ID = /^[0-9a-f]{32}$/u

/**
 * A new random identifier: 16 bytes as 32 lowercase hexadecimal digits.
 * @returns the identifier.
 */
export function randomLockId(): string {
  return randomBytes(16).toString('hex')
}

/**
 * Whether a value is an identifier of {@link randomLockId}'s form.
 * @param value - the value.
 * @returns true for 32 lowercase hexadecimal digits.
 */
export function isLockId(value: unknown): value is string {
  return typeof value === 'string' && RANDOM_ID.test(value)
}

/** What distinguishes one lock: its record, how the person is told about a file it refuses, and the record's id. */
export interface LockFileKind<R extends ProcessHolder> {
  /** The lock's name in messages, such as `home lock`. */
  readonly label: string
  /** When a refused file may be removed, completing `remove it …`, such as `once no delorun process runs for this profile`. */
  readonly remedy: string
  /**
   * Parse a record.
   * @param record - the file's JSON object.
   * @returns the record, or `undefined` when the object is not one.
   */
  readonly parse: (record: Readonly<Record<string, unknown>>) => R | undefined
  /**
   * The record's random id, which names its takeover guard.
   * @param record - the record.
   * @returns the id.
   */
  readonly id: (record: R) => string
}

/** The contents of a takeover guard: its holder and its own id. Guards written without `v` are read too. */
interface GuardRecord extends ProcessHolder {
  /** The guard's own random id, which names the guard that removes it. */
  readonly id: string
}

/**
 * Parse JSON text into an object, or `undefined` when it is not a JSON object.
 * @param text - the text.
 * @returns the object.
 */
function parseObject(text: string): Readonly<Record<string, unknown>> | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (_notJson) {
    // Not JSON: the caller reports the file as not a record.
    return undefined
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined
}

/**
 * Parse a guard record.
 * @param record - the guard file's JSON object.
 * @returns the record, or `undefined` when the object is not one.
 */
function parseGuard(record: Readonly<Record<string, unknown>>): GuardRecord | undefined {
  const holder = parseHolder(record)
  if (holder === undefined || (record.v !== undefined && record.v !== 1) || !isLockId(record.id)) return undefined
  return { ...holder, id: record.id }
}

/**
 * Write text to a new sibling file created exclusively at mode 0600 and flushed.
 * @param path - the file the sibling is for.
 * @param text - its contents.
 * @returns the sibling's path.
 */
function writeCandidate(path: string, text: string): string {
  const candidate = `${path}.new-${randomBytes(8).toString('hex')}`
  const fd = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, PROTECTED_FILE_MODE)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return candidate
}

/**
 * Create a file with its whole contents at mode 0600 unless the path exists: the text goes to a temporary sibling,
 * which is hard-linked to the path and then removed.
 * @param path - the file to create.
 * @param text - its contents.
 * @returns true when this call created the file, false when the path existed.
 */
function createWhole(path: string, text: string): boolean {
  const candidate = writeCandidate(path, text)
  try {
    linkSync(candidate, path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    unlinkSync(candidate)
  }
}

/**
 * Remove a file, ignoring one that is already gone.
 * @param path - the file.
 */
function removeIfPresent(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** One lock file and its takeover guards. */
export class LockFile<R extends ProcessHolder> {
  /**
   * @param path - the lock file's path, which also names every takeover guard.
   * @param kind - the record, the messages and the record's id.
   */
  constructor(readonly path: string, private readonly kind: LockFileKind<R>) {}

  /**
   * Create the lock with a record unless a lock exists.
   * @param record - the record.
   * @returns true when this call created the lock.
   */
  create(record: R): boolean {
    return createWhole(this.path, JSON.stringify(record))
  }

  /**
   * Read the lock's record.
   * @returns the record, or `undefined` when no lock exists.
   * @throws {Error} naming the path when the file is not a record of this lock.
   */
  read(): R | undefined {
    return this.readFile(this.path, this.kind.parse, 'record')
  }

  /**
   * Replace the lock's record atomically, by renaming a flushed sibling over it: a lock its holder hands to a
   * successor. The caller holds the lock, so no contender creates or removes it meanwhile.
   * @param record - the new record.
   */
  replace(record: R): void {
    const candidate = writeCandidate(this.path, JSON.stringify(record))
    try {
      renameSync(candidate, this.path)
    } catch (error) {
      removeIfPresent(candidate)
      throw error
    }
  }

  /**
   * Remove the lock while it holds the record with an id. A file that is not a record of this lock is not that
   * record, so it is left for whoever wrote it.
   * @param id - the id of the record to remove.
   */
  release(id: string): void {
    let found: R | undefined
    try {
      found = this.read()
    } catch (_notARecord) {
      // Not a record of this lock: not the releasing holder's, so it is left as it is.
      return
    }
    if (found !== undefined && this.kind.id(found) === id) removeIfPresent(this.path)
  }

  /**
   * Remove the lock when it still holds the record with an id and that record's holder is dead, under the record's
   * takeover guard. A contender that found the record dead calls this however late it runs: a lock created since, by
   * any process, is left as it is.
   * @param id - the id of the record found dead.
   * @returns `done` when that record is gone, by this call or another, or its holder lives; `busy` when a live
   *   contender holds its guard.
   * @throws {Error} when the lock or a takeover guard is not a record of this lock, or after too many nested guards of
   *   contenders that died.
   */
  async removeDead(id: string): Promise<'done' | 'busy'> {
    const found = this.read()
    if (found === undefined || this.kind.id(found) !== id || holderAlive(found)) return 'done'
    return this.removeUnderGuard(this.path, 'record', id, 0)
  }

  /**
   * Remove a lock or guard whose holder was found dead, under the takeover guard named after its id. The file is
   * removed only when it still holds that id.
   * @param path - the file found dead: the lock or a guard.
   * @param kind - which record it holds.
   * @param id - the dead record's id.
   * @param depth - how many guards of dead contenders this removal is nested in.
   * @returns `done` when the dead record is gone, `busy` when a live contender holds its guard.
   */
  private async removeUnderGuard(path: string, kind: 'record' | 'guard', id: string, depth: number): Promise<'done' | 'busy'> {
    if (depth > MAX_TAKEOVER_DEPTH) throw new Error(`could not take ${this.path}: ${String(depth)} nested takeovers were abandoned by processes that died; remove ${this.path}.takeover-* ${this.kind.remedy}`)
    const guardPath = `${this.path}.takeover-${id}`
    const guard: GuardRecord & { readonly v: 1 } = { v: 1, ...currentHolder(), id: randomLockId() }
    for (;;) {
      if (createWhole(guardPath, JSON.stringify(guard))) {
        try {
          if (this.currentId(path, kind) === id) unlinkSync(path)
        } finally {
          unlinkSync(guardPath)
        }
        return 'done'
      }
      const holder = this.readFile(guardPath, parseGuard, 'takeover guard')
      if (holder === undefined) continue
      if (holderAlive(holder)) return 'busy'
      if (await this.removeUnderGuard(guardPath, 'guard', holder.id, depth + 1) === 'busy') return 'busy'
    }
  }

  /**
   * The id a lock or guard file holds now.
   * @param path - the file.
   * @param kind - which record it holds.
   * @returns the id, or `undefined` when the file does not exist.
   */
  private currentId(path: string, kind: 'record' | 'guard'): string | undefined {
    if (kind === 'guard') return this.readFile(path, parseGuard, 'takeover guard')?.id
    const record = this.readFile(path, this.kind.parse, 'record')
    return record === undefined ? undefined : this.kind.id(record)
  }

  /**
   * Read a small record file without following a symbolic link.
   * @param path - the file.
   * @param parse - its record's parser.
   * @param noun - what the file is, for the refusal.
   * @returns the record, or `undefined` when the file does not exist.
   * @throws {Error} naming the path when the file is not a regular file of at most {@link MAX_RECORD_BYTES} bytes holding a record.
   */
  private readFile<T>(path: string, parse: (record: Readonly<Record<string, unknown>>) => T | undefined, noun: string): T | undefined {
    const refusal = (): Error => new Error(`${path} is not a ${this.kind.label} ${noun}; remove it ${this.kind.remedy}`)
    let fd: number
    try {
      fd = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    let text: string
    try {
      const stats = fstatSync(fd)
      if (!stats.isFile() || stats.size > MAX_RECORD_BYTES) throw refusal()
      text = readFileSync(fd, 'utf8')
    } finally {
      closeSync(fd)
    }
    const object = parseObject(text)
    const record = object === undefined ? undefined : parse(object)
    if (record === undefined) throw refusal()
    return record
  }
}
