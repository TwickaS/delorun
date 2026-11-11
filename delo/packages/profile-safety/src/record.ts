/**
 * Delo's own record inside a profile: the plugins the person ejected, the plugins a restore kept disabled with their
 * reason, and the last update the profile saw. The file is one of the history's tracked files, so an undo, a restore or
 * a rollback brings the record back with the profile it describes, and an ejected plugin stays ejected across all three.
 *
 * @module @delo/profile-safety/record
 */
import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { ProfileSafetyError } from './errors.ts'
import { SAFETY_RECORD_FILENAME, SAFETY_RECORD_SCHEMA } from './files.ts'

/** What an ejected plugin is, in the profile's own terms. */
export type EjectedKind =
  /** A bundle that left `dsh.profile.bundles`; the person's rows for it stay in the patch layer. */
  | 'bundle'
  /** A plugin dependency that left the manifest's dependencies; its rows and settings stay. */
  | 'plugin'

/** One plugin the person ejected, with why. */
export interface EjectedPlugin {
  /** The package name. */
  readonly name: string
  /** Whether the profile listed it as a bundle or as a plugin dependency. */
  readonly kind: EjectedKind
  /** What the person said, in their own words. */
  readonly reason: string
  /** When they ejected it, ISO 8601. */
  readonly at: string
}

/** One plugin a restore brought back disabled, with the reason contract C3 requires it to show. */
export interface DisabledPlugin {
  /** The package name. */
  readonly name: string
  /** The version that was restored. */
  readonly version: string
  /** The revocation's reason code, when a revocation is why it is disabled. */
  readonly reason: string
  /** The message shown beside it. */
  readonly message: string
}

/** The last update the profile went through, for `delorun recover` and safe mode. */
export interface LastUpdate {
  /** The Delo version the profile was on. */
  readonly from: string
  /** The Delo version the update installed. */
  readonly to: string
  /** When the update applied, ISO 8601. */
  readonly at: string
  /**
   * The state the update ended in: one of contract C3's states, `applying` from the snapshot until it commits, or
   * `committed` once the update committed.
   */
  readonly state: string
  /** Why the update failed or rolled back, when it did. */
  readonly failure?: string
  /** The history version holding the snapshot taken before the update. */
  readonly snapshot?: string
}

/** The record {@link SAFETY_RECORD_FILENAME} holds. */
export interface SafetyRecord {
  /** Always {@link SAFETY_RECORD_SCHEMA}. */
  readonly schema: typeof SAFETY_RECORD_SCHEMA
  /** Every plugin the person ejected, oldest first. */
  readonly ejected: readonly EjectedPlugin[]
  /** Every plugin a restore kept disabled, oldest first. */
  readonly disabled: readonly DisabledPlugin[]
  /** The last update, when one applied or failed. */
  readonly update?: LastUpdate
}

/** A record of a profile on which nothing has happened: no ejections, nothing disabled, no update. */
export const EMPTY_SAFETY_RECORD: SafetyRecord = Object.freeze({
  schema: SAFETY_RECORD_SCHEMA,
  ejected: Object.freeze([]),
  disabled: Object.freeze([]),
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Read a profile's safety record.
 * @param profileDir - the profile directory.
 * @returns the record; {@link EMPTY_SAFETY_RECORD} when the profile has none, which is every profile Delo has not
 *   ejected from or restored into.
 * @throws {ProfileSafetyError} `PROFILE_UNREADABLE` when the file exists but is not a record Delo wrote.
 */
export function readSafetyRecord(profileDir: string): SafetyRecord {
  const path = join(profileDir, SAFETY_RECORD_FILENAME)
  if (!existsSync(path)) return EMPTY_SAFETY_RECORD
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw unreadableRecord(path, 'it is not JSON', error)
  }
  if (!isRecord(parsed) || parsed['schema'] !== SAFETY_RECORD_SCHEMA) {
    throw unreadableRecord(path, `its schema is not ${SAFETY_RECORD_SCHEMA}`, undefined)
  }
  return {
    schema: SAFETY_RECORD_SCHEMA,
    ejected: ejectedOf(parsed['ejected'], path),
    disabled: disabledOf(parsed['disabled'], path),
    ...parsed['update'] === undefined ? {} : { update: updateOf(parsed['update'], path) },
  }
}

/**
 * Write a profile's safety record whole.
 * @param profileDir - the profile directory.
 * @param record - the record to write.
 * @returns a promise that resolves when the file is in place.
 */
export async function writeSafetyRecord(profileDir: string, record: SafetyRecord): Promise<void> {
  await writeFileAtomic(join(profileDir, SAFETY_RECORD_FILENAME), JSON.stringify(record, undefined, 2) + '\n', {
    mode: 0o600,
    dirMode: 0o700,
  })
}

/**
 * The record with one plugin added to its ejections, replacing an earlier ejection of the same package.
 * @param record - the record to extend.
 * @param ejected - the ejection to add.
 * @returns the new record; the argument is unchanged.
 */
export function withEjection(record: SafetyRecord, ejected: EjectedPlugin): SafetyRecord {
  return {
    ...record,
    ejected: [...record.ejected.filter(entry => entry.name !== ejected.name), ejected],
  }
}

/**
 * The record with one plugin added to the plugins a restore kept disabled.
 * @param record - the record to extend.
 * @param disabled - the disabled plugin to add.
 * @returns the new record; the argument is unchanged.
 */
export function withDisabled(record: SafetyRecord, disabled: DisabledPlugin): SafetyRecord {
  return {
    ...record,
    disabled: [...record.disabled.filter(entry => entry.name !== disabled.name), disabled],
  }
}

/**
 * The record with the last update replaced.
 * @param record - the record to extend.
 * @param update - the update to record.
 * @returns the new record; the argument is unchanged.
 */
export function withUpdate(record: SafetyRecord, update: LastUpdate): SafetyRecord {
  return { ...record, update }
}

function unreadableRecord(path: string, why: string, cause: unknown): ProfileSafetyError {
  return new ProfileSafetyError(
    'PROFILE_UNREADABLE',
    path,
    `${SAFETY_RECORD_FILENAME} cannot be read: ${why}; repair or remove it, then run the command again.`,
    ['repair-profile'],
    [{ kind: 'configuration', name: SAFETY_RECORD_FILENAME }],
    cause === undefined ? undefined : { cause },
  )
}

function ejectedOf(value: unknown, path: string): EjectedPlugin[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw unreadableRecord(path, 'its ejected list is not a list', undefined)
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry['name'] !== 'string' || typeof entry['reason'] !== 'string'
      || typeof entry['at'] !== 'string' || (entry['kind'] !== 'bundle' && entry['kind'] !== 'plugin')) {
      throw unreadableRecord(path, 'an ejection is not a name, kind, reason and time', undefined)
    }
    return { name: entry['name'], kind: entry['kind'], reason: entry['reason'], at: entry['at'] }
  })
}

function disabledOf(value: unknown, path: string): DisabledPlugin[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw unreadableRecord(path, 'its disabled list is not a list', undefined)
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry['name'] !== 'string' || typeof entry['version'] !== 'string'
      || typeof entry['reason'] !== 'string' || typeof entry['message'] !== 'string') {
      throw unreadableRecord(path, 'a disabled plugin is not a name, version, reason and message', undefined)
    }
    return { name: entry['name'], version: entry['version'], reason: entry['reason'], message: entry['message'] }
  })
}

function updateOf(value: unknown, path: string): LastUpdate {
  if (!isRecord(value) || typeof value['from'] !== 'string' || typeof value['to'] !== 'string'
    || typeof value['at'] !== 'string' || typeof value['state'] !== 'string') {
    throw unreadableRecord(path, 'its update record is not a from, to, time and state', undefined)
  }
  const failure = value['failure']
  const snapshot = value['snapshot']
  return {
    from: value['from'],
    to: value['to'],
    at: value['at'],
    state: value['state'],
    ...typeof failure === 'string' ? { failure } : {},
    ...typeof snapshot === 'string' ? { snapshot } : {},
  }
}
