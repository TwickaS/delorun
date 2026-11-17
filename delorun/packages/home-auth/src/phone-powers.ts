/**
 * Phone powers (C14, "Phone powers"): how much an unlocked phone may do, a choice of two levels the person makes at the
 * computer. **Careful** keeps a terminal, turning Changes' protection off, and applying, undoing or restarting into a
 * change to Delorun itself at the computer. **Full** lets an unlocked phone do them too, each with a fresh unlock: the
 * approval grace never counts.
 *
 * The choice is one record, `phone-powers.json` in `~/.delorun/secrets/home-auth/`, mode 0600. The person's own commands
 * (`delorun devices powers`, `delorun setup`) and the studio at the computer write it; no device does. The Host reads it
 * on every check through {@link PhonePowersReader}, which re-reads the file only when it changed on disk, so a command
 * that writes it while the home runs takes effect at once.
 *
 * A home with no record has made no choice: {@link UNCHOSEN_PHONE_POWERS} applies. A record that exists but cannot be
 * read applies Careful and says why, so a damaged file never widens what a phone may do.
 *
 * @module @delorun/home-auth/phone-powers
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkProtectedFileSync } from '@delorun/home'
import { readStoreFile, writeStoreFile, isRecord, isTime } from './files.ts'
import { HomeAuthError } from './errors.ts'
import { PHONE_POWERS_LEVELS, type PhonePowersLevel } from './wire.ts'

export { PHONE_POWERS_LEVELS, type PhonePowersLevel }

/** The record's file name in `~/.delorun/secrets/home-auth/`. */
export const PHONE_POWERS_FILE = 'phone-powers.json'

/** The version of the record's fields. */
export const PHONE_POWERS_VERSION = 1 as const

/** The level a home applies while the person has chosen none. */
export const UNCHOSEN_PHONE_POWERS: PhonePowersLevel = 'careful'

/** The record as the file holds it. */
interface PhonePowersRecord {
  readonly v: typeof PHONE_POWERS_VERSION
  readonly level: PhonePowersLevel
  /** When it was chosen, in milliseconds since the epoch. */
  readonly setAt: number
}

/** The level in force and where it comes from. */
export interface PhonePowers {
  readonly level: PhonePowersLevel
  /** Whether the person chose it; false while no record exists, or while the record cannot be read. */
  readonly chosen: boolean
  /** Why the record cannot be read, when it cannot; the level is then Careful. */
  readonly problem?: string
}

/**
 * @param value - a value.
 * @returns whether it names a level.
 */
export function isPhonePowersLevel(value: unknown): value is PhonePowersLevel {
  return typeof value === 'string' && (PHONE_POWERS_LEVELS as readonly string[]).includes(value)
}

/**
 * @param directory - `~/.delorun/secrets/home-auth/`.
 * @returns the record's path.
 */
export function phonePowersPath(directory: string): string {
  return join(directory, PHONE_POWERS_FILE)
}

/**
 * @param value - the file's parsed JSON.
 * @returns the record.
 * @throws {HomeAuthError} `STORE_INVALID` for anything that is not this record.
 */
function recordOf(value: unknown): PhonePowersRecord {
  if (!isRecord(value) || value.v !== PHONE_POWERS_VERSION || !isPhonePowersLevel(value.level) || !isTime(value.setAt) || Object.keys(value).length !== 3) {
    throw new HomeAuthError('STORE_INVALID', `${PHONE_POWERS_FILE} is not a Phone powers record`)
  }
  return { v: PHONE_POWERS_VERSION, level: value.level, setAt: value.setAt }
}

/**
 * @param record - the record, or undefined when none exists.
 * @returns the level in force.
 */
function powersOf(record: PhonePowersRecord | undefined): PhonePowers {
  return record === undefined ? { level: UNCHOSEN_PHONE_POWERS, chosen: false } : { level: record.level, chosen: true }
}

/**
 * Read the choice, for a command that runs with or without the home.
 * @param directory - `~/.delorun/secrets/home-auth/`.
 * @returns the level in force.
 * @throws {HomeAuthError} `STORE_INVALID` for a file that is exposed, not JSON or not this record.
 */
export async function readPhonePowers(directory: string): Promise<PhonePowers> {
  const value = await readStoreFile(phonePowersPath(directory))
  return powersOf(value === undefined ? undefined : recordOf(value))
}

/**
 * Record the person's choice. Only the person's own command and the studio at the computer call it.
 * @param directory - `~/.delorun/secrets/home-auth/`, which must exist.
 * @param level - the level chosen.
 * @param now - the clock, in milliseconds.
 * @returns the level now in force.
 * @throws the failure of the protected write.
 */
export async function writePhonePowers(directory: string, level: PhonePowersLevel, now: () => number = Date.now): Promise<PhonePowers> {
  const record: PhonePowersRecord = { v: PHONE_POWERS_VERSION, level, setAt: now() }
  await writeStoreFile(phonePowersPath(directory), record)
  return powersOf(record)
}

/**
 * The Host's synchronous view of the choice, read on every access check. It re-reads the file when its identity, size
 * or modification time changed since the last read, so a command's write takes effect at the next check.
 */
export class PhonePowersReader {
  private readonly path: string
  private seen: string | undefined
  private powers: PhonePowers = { level: UNCHOSEN_PHONE_POWERS, chosen: false }

  /**
   * @param directory - `~/.delorun/secrets/home-auth/`.
   */
  constructor(directory: string) {
    this.path = phonePowersPath(directory)
  }

  /**
   * The level in force now.
   * @returns it; Careful with the reason when the record exists but cannot be read.
   */
  current(): PhonePowers {
    let stamp: string
    try {
      const stats = checkProtectedFileSync(this.path)
      stamp = `${String(stats.ino)}:${String(stats.size)}:${String(stats.mtimeMs)}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.seen = undefined
        this.powers = powersOf(undefined)
        return this.powers
      }
      return this.refuse(error)
    }
    if (stamp === this.seen) return this.powers
    try {
      this.powers = powersOf(recordOf(JSON.parse(readFileSync(this.path, 'utf8'))))
      this.seen = stamp
    } catch (error) {
      return this.refuse(error)
    }
    return this.powers
  }

  /**
   * @param error - why the record cannot be read.
   * @returns Careful, with the reason; nothing is cached, so a repaired file is read at the next check.
   */
  private refuse(error: unknown): PhonePowers {
    this.seen = undefined
    this.powers = { level: 'careful', chosen: false, problem: error instanceof HomeAuthError ? error.message : `${PHONE_POWERS_FILE} cannot be read (${error instanceof Error ? error.message : String(error)})` }
    return this.powers
  }
}
