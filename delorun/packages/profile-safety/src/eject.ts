/**
 * Eject: take a plugin out of a profile's bundle list and dependencies while keeping everything the person wrote about
 * it — every row that loads it, every setting for those rows, and the record that it was ejected — so that an update,
 * a rollback or a start in safe mode does not put it back and does not lose what the person configured for it. Ejecting
 * is the person's answer to a plugin an update cannot carry: the plugin leaves, the profile keeps its shape.
 *
 * @module @delorun/profile-safety/eject
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { ProfileSafetyError } from './errors.ts'
import {
  PROFILE_MANIFEST_FILENAME,
  SAFETY_RECORD_FILENAME,
} from './files.ts'
import { bundleListOf, dependenciesOf, readInventory } from './inventory.ts'
import { readSafetyRecord, withEjection, writeSafetyRecord, type EjectedKind, type SafetyRecord } from './record.ts'

/** Delorun's own bundle, which a profile cannot eject: the privacy defaults of contract C11 hold only while it loads. */
export const DELORUN_BUNDLE = '@delorun/bundle-local'

/** What {@link ejectPlugin} needs. */
export interface EjectRequest {
  /** The profile directory. */
  readonly profileDir: string
  /** The Harness home, whose patch layer also holds rows; omitted reads the profile's layer only. */
  readonly homeDir?: string
  /** The package name to eject. */
  readonly name: string
  /** What the person said, in their own words. */
  readonly reason: string
  /** When they ejected it; now by default. */
  readonly now?: Date
}

/** What an ejection did. */
export interface EjectResult {
  /** Whether the package was a bundle the profile selected, or a plugin it depended on. */
  readonly kind: EjectedKind
  /** The record after the ejection. */
  readonly record: SafetyRecord
  /** Whether the manifest changed, which it does whenever the profile held the package. */
  readonly manifestChanged: boolean
  /** The rows and settings the profile keeps, which the ejection left untouched. */
  readonly keptRows: readonly string[]
}

/**
 * Eject a plugin from a profile.
 * @param request - the profile, the package and the person's reason.
 * @returns what left the manifest and what stayed.
 * @throws {ProfileSafetyError} `EJECT_REFUSED` when the package is Delorun's own bundle, or when the profile neither
 *   selects nor depends on it; the profile is unchanged when it throws.
 * @throws {ProfileSafetyError} `PROFILE_UNREADABLE` when the profile's manifest cannot be read.
 */
export async function ejectPlugin(request: EjectRequest): Promise<EjectResult> {
  if (request.name === DELORUN_BUNDLE) {
    throw new ProfileSafetyError(
      'EJECT_REFUSED',
      request.profileDir,
      `${DELORUN_BUNDLE} cannot be ejected: Delorun's privacy defaults hold only while it loads. Turn the settings it writes off instead.`,
      ['keep'],
      [{ kind: 'bundle', name: request.name }],
    )
  }
  const path = join(request.profileDir, PROFILE_MANIFEST_FILENAME)
  const manifest = readManifest(path)
  const bundles = bundleListOf(manifest, path)
  const dependencies = dependenciesOf(manifest)
  const selected = bundles.includes(request.name)
  const declared = Object.hasOwn(dependencies, request.name)
  if (!selected && !declared) {
    throw new ProfileSafetyError(
      'EJECT_REFUSED',
      path,
      `the profile neither selects nor depends on ${request.name}, so there is nothing to eject.`,
      ['repair-profile'],
      [{ kind: 'bundle', name: request.name }],
    )
  }
  const kind: EjectedKind = selected ? 'bundle' : 'plugin'
  const next: Record<string, unknown> = { ...manifest }
  const dsh = recordOf(next['dsh'])
  const profile = recordOf(dsh['profile'])
  profile['bundles'] = bundles.filter(bundle => bundle !== request.name)
  dsh['profile'] = profile
  next['dsh'] = dsh
  next['dependencies'] = Object.fromEntries(Object.entries(dependencies).filter(([name]) => name !== request.name))
  await writeFileAtomic(path, JSON.stringify(next, undefined, 2) + '\n', { mode: 0o600, dirMode: 0o700 })
  const kept = readInventory({ profileDir: request.profileDir, ...request.homeDir === undefined ? {} : { homeDir: request.homeDir } })
    .rows.filter(row => row.name === request.name).map(row => row.id ?? row.name)
  const record = withEjection(readSafetyRecord(request.profileDir), {
    name: request.name,
    kind,
    reason: request.reason,
    at: (request.now ?? new Date()).toISOString(),
  })
  await writeSafetyRecord(request.profileDir, record)
  return {
    kind,
    record,
    manifestChanged: true,
    keptRows: kept,
  }
}

function readManifest(path: string): Record<string, unknown> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new ProfileSafetyError('PROFILE_UNREADABLE', path, `${PROFILE_MANIFEST_FILENAME} cannot be read: ${String(error)}`, ['repair-profile'], [{ kind: 'configuration', name: SAFETY_RECORD_FILENAME }], { cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ProfileSafetyError('PROFILE_UNREADABLE', path, `${PROFILE_MANIFEST_FILENAME} is not JSON: ${String(error)}`, ['repair-profile'], [{ kind: 'configuration', name: SAFETY_RECORD_FILENAME }], { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProfileSafetyError('PROFILE_UNREADABLE', path, `${PROFILE_MANIFEST_FILENAME} is not a JSON object.`, ['repair-profile'], [{ kind: 'configuration', name: SAFETY_RECORD_FILENAME }])
  }
  return parsed as Record<string, unknown>
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
