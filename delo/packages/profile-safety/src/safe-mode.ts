/**
 * Safe mode: the start that loads Delo's own bundles and leaves every third-party bundle and every row the person added
 * for one out, so a plugin that cannot load no longer keeps the home from starting. The mode changes no profile file —
 * the marker lives outside the profile, under the home's `run/<profile>/`, and the plan that says what to skip is a
 * value the launcher passes to the loader — so the rows, local plugins, settings and bundle order the person has are
 * exactly as they were when safe mode ends, and an update or a rollback in between keeps them too.
 *
 * @module @delo/profile-safety/safe-mode
 */
import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { ProfileSafetyError } from './errors.ts'
import type { ProfileInventory } from './inventory.ts'

/** The schema of the safe-mode marker. */
export const SAFE_MODE_SCHEMA = 'delo.safe-mode/1'

/** The marker filename, inside the profile's run directory. */
export const SAFE_MODE_FILENAME = 'safe-mode.json'

/** The marker that says the home is in safe mode. */
export interface SafeModeMarker {
  /** Always {@link SAFE_MODE_SCHEMA}. */
  readonly schema: typeof SAFE_MODE_SCHEMA
  /** When safe mode started, ISO 8601. */
  readonly since: string
  /** Why the person or the recovery path started it. */
  readonly reason: string
  /** The bundles the start leaves out. */
  readonly skipped: readonly string[]
}

/** What {@link startInSafeMode} needs. */
export interface SafeModeStartOptions {
  /** The profile's inventory as the person left it. */
  readonly inventory: ProfileInventory
  /** The bundles the installation itself ships, such as Delo's CLI profile template's; all others are third-party. */
  readonly installationBundles: readonly string[]
}

/** What the launcher loads in safe mode. */
export interface SafeModeStart {
  /** The bundle list to load, in the person's order, without the third-party bundles. */
  readonly bundles: readonly string[]
  /** The bundles left out. */
  readonly skipped: readonly string[]
  /** The rows to leave out: the person's rows whose plugin is third-party, identified by id, else by plugin name. */
  readonly skippedRows: readonly string[]
}

/**
 * The safe-mode marker's path.
 * @param homeDir - the Harness home.
 * @param profile - the profile name.
 * @returns the path under the home's `run/<profile>/`.
 */
export function safeModePath(homeDir: string, profile: string): string {
  return join(homeDir, 'run', profile, SAFE_MODE_FILENAME)
}

/**
 * Read the safe-mode marker.
 * @param homeDir - the Harness home.
 * @param profile - the profile name.
 * @returns the marker, or undefined when the home is not in safe mode.
 * @throws {ProfileSafetyError} `SAFE_MODE_UNREADABLE` when the marker exists but is not one Delo wrote, so the start
 *   cannot tell the mode apart from a damaged home.
 */
export function readSafeMode(homeDir: string, profile: string): SafeModeMarker | undefined {
  const path = safeModePath(homeDir, profile)
  if (!existsSync(path)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    throw unreadable(path, 'it is not JSON', error)
  }
  if (!isRecord(parsed) || parsed['schema'] !== SAFE_MODE_SCHEMA) throw unreadable(path, `its schema is not ${SAFE_MODE_SCHEMA}`, undefined)
  const { since, reason, skipped } = parsed
  if (typeof since !== 'string' || typeof reason !== 'string' || !Array.isArray(skipped) || !skipped.every(name => typeof name === 'string')) {
    throw unreadable(path, 'it is not a start time, a reason and a list of bundles', undefined)
  }
  return { schema: SAFE_MODE_SCHEMA, since, reason, skipped }
}

/**
 * Start safe mode: write the marker under the home's run directory and leave the profile alone.
 * @param options - the Harness home, the profile name, the reason and the third-party bundles being skipped.
 * @returns the marker that was written.
 */
export async function enterSafeMode(options: {
  readonly homeDir: string
  readonly profile: string
  readonly reason: string
  readonly skipped: readonly string[]
  readonly now?: Date
}): Promise<SafeModeMarker> {
  const marker: SafeModeMarker = {
    schema: SAFE_MODE_SCHEMA,
    since: (options.now ?? new Date()).toISOString(),
    reason: options.reason,
    skipped: [...options.skipped],
  }
  await writeFileAtomic(safeModePath(options.homeDir, options.profile), JSON.stringify(marker, undefined, 2) + '\n', { mode: 0o600, dirMode: 0o700 })
  return marker
}

/**
 * End safe mode by removing the marker.
 * @param options - the Harness home and the profile name.
 * @returns whether a marker was there to remove.
 */
export async function exitSafeMode(options: { readonly homeDir: string, readonly profile: string }): Promise<boolean> {
  const path = safeModePath(options.homeDir, options.profile)
  if (!existsSync(path)) return false
  await rm(path, { force: true })
  return true
}

/**
 * What a safe-mode start loads: the person's bundle order without the third-party bundles, and the rows left out.
 * @param options - the profile's inventory and the installation's own bundle list.
 * @returns the bundle list, the skipped bundles and the skipped rows; nothing is written.
 */
export function startInSafeMode(options: SafeModeStartOptions): SafeModeStart {
  const installation = new Set(options.installationBundles)
  const skipped = options.inventory.bundles.filter(bundle => !installation.has(bundle))
  const thirdParty = new Set(skipped)
  return {
    bundles: options.inventory.bundles.filter(bundle => installation.has(bundle)),
    skipped,
    skippedRows: options.inventory.rows
      .filter(row => thirdParty.has(row.name) || row.name.startsWith('.') || row.name.startsWith('/'))
      .map(row => row.id ?? row.name),
  }
}

function unreadable(path: string, why: string, cause: unknown): ProfileSafetyError {
  return new ProfileSafetyError(
    'SAFE_MODE_UNREADABLE',
    path,
    `${SAFE_MODE_FILENAME} cannot be read: ${why}; delete it to start normally, or repair it.`,
    ['repair-profile'],
    [{ kind: 'configuration', name: SAFE_MODE_FILENAME }],
    cause === undefined ? undefined : { cause },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
