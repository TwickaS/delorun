/**
 * What a profile holds that belongs to the person: the bundle list and plugin dependencies the manifest names, the rows
 * their patch layers add, the settings they wrote for rows, the local plugins they installed from this machine, and the
 * ejections and disabled plugins of Delo's record. The inventory is a value read from files, so a check can compare the
 * profile before an update with the profile as the target would leave it without writing either.
 *
 * Rows come from the two patch layers a person edits — the profile's own `cordis.patch.yml` and the Harness home's,
 * which applies over every profile. A patch entry with `insert` adds rows; an entry with an `id` and no `insert` sets
 * fields of a row some layer already declares, which is the configuration the check must not lose.
 *
 * @module @delo/profile-safety/inventory
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { ProfileSafetyError } from './errors.ts'
import {
  HOME_PATCH_FILENAME,
  PROFILE_MANIFEST_FILENAME,
  PROFILE_PATCH_FILENAME,
} from './files.ts'
import { readSafetyRecord } from './record.ts'

/** Which of a person's two patch layers a row or a setting lives in. */
export type PatchLayer = 'profile-patch' | 'home-patch'

/** A row the person added to a patch layer. */
export interface PersonRow {
  /** The row's id, when it declares one; a row without one is identified by its plugin name. */
  readonly id?: string
  /** The plugin the row loads. */
  readonly name: string
  /** The layer that adds it. */
  readonly layer: PatchLayer
  /** Whether the person's own patch marks it disabled, which is a choice that has to survive too. */
  readonly disabled: boolean
}

/** A set of fields the person set on a row some bundle declares. */
export interface PersonConfiguration {
  /** The row's id. */
  readonly rowId: string
  /** The layer holding the setting. */
  readonly layer: PatchLayer
  /** The fields the person set, sorted. */
  readonly keys: readonly string[]
  /** The values, serialized, so a changed value compares unequal without a deep walk. */
  readonly value: string
}

/** A plugin the person installed from this machine rather than from a registry. */
export interface PersonPlugin {
  /** The package name. */
  readonly name: string
  /** The dependency spec, such as `file:../my-plugin`. */
  readonly spec: string
  /** Whether the profile's bundle list also selects it. */
  readonly selected: boolean
}

/** Everything in a profile that belongs to the person, as one value. */
export interface ProfileInventory {
  /** The profile's bundle list, in order. */
  readonly bundles: readonly string[]
  /** The rows the person's patch layers add. */
  readonly rows: readonly PersonRow[]
  /** The settings the person wrote for rows. */
  readonly configurations: readonly PersonConfiguration[]
  /** The plugins the person installed from this machine. */
  readonly localPlugins: readonly PersonPlugin[]
  /** The packages the person ejected, from Delo's record. */
  readonly ejected: readonly string[]
}

/** What {@link readInventory} reads. */
export interface InventoryOptions {
  /** The profile directory. */
  readonly profileDir: string
  /** The Harness home, whose `cordis.patch.yml` applies over every profile; omitted reads no home layer. */
  readonly homeDir?: string
}

/** Dependency specs that name a directory on this machine rather than a registry. */
const LOCAL_SPEC = /^(?:file:|link:|portal:|workspace:|\.{0,2}\/|\/)/

/**
 * Whether a dependency spec names something on this machine.
 * @param spec - a `dependencies` value.
 * @returns true for a `file:`, `link:`, `portal:` or `workspace:` spec, or a path.
 */
export function isLocalSpec(spec: string): boolean {
  return LOCAL_SPEC.test(spec)
}

/**
 * Read a profile's inventory.
 * @param options - the profile directory and, when there is one, the Harness home.
 * @returns the rows, settings, local plugins, bundle list and ejections the profile holds.
 * @throws {ProfileSafetyError} `PROFILE_UNREADABLE` when the manifest or a patch layer cannot be read or parsed, so no
 *   check over it would mean anything.
 */
export function readInventory(options: InventoryOptions): ProfileInventory {
  const { profileDir, homeDir } = options
  const manifest = readManifest(join(profileDir, PROFILE_MANIFEST_FILENAME))
  const bundles = bundleListOf(manifest, join(profileDir, PROFILE_MANIFEST_FILENAME))
  const rows: PersonRow[] = []
  const configurations: PersonConfiguration[] = []
  readLayer(join(profileDir, PROFILE_PATCH_FILENAME), 'profile-patch', rows, configurations)
  if (homeDir !== undefined) readLayer(join(homeDir, HOME_PATCH_FILENAME), 'home-patch', rows, configurations)
  const dependencies = dependenciesOf(manifest)
  return {
    bundles,
    rows,
    configurations,
    localPlugins: Object.entries(dependencies)
      .filter(([, spec]) => isLocalSpec(spec))
      .map(([name, spec]) => ({ name, spec, selected: bundles.includes(name) })),
    ejected: readSafetyRecord(profileDir).ejected.map(ejected => ejected.name),
  }
}

/**
 * A profile's bundle list as its manifest states it; `[]` when it states none.
 * @param manifest - the parsed profile manifest.
 * @returns the bundle names, in order.
 */
export function bundleListOf(manifest: unknown, path: string): string[] {
  const dsh = recordOf(recordOf(manifest)['dsh'])
  const profile = recordOf(dsh['profile'])
  const bundles = profile['bundles']
  if (bundles === undefined) return []
  if (!Array.isArray(bundles) || !bundles.every(name => typeof name === 'string')) {
    throw new ProfileSafetyError('PROFILE_UNREADABLE', path, `${PROFILE_MANIFEST_FILENAME}: dsh.profile.bundles is not a list of package names.`, ['repair-profile'], [{ kind: 'bundle-list', name: PROFILE_MANIFEST_FILENAME }])
  }
  return bundles
}

/**
 * A profile manifest's declared dependencies.
 * @param manifest - the parsed profile manifest.
 * @returns each dependency name with its spec; an unreadable `dependencies` value reads as none.
 */
export function dependenciesOf(manifest: unknown): Record<string, string> {
  const dependencies = recordOf(manifest)['dependencies']
  return Object.fromEntries(Object.entries(recordOf(dependencies))
    .flatMap(([name, spec]) => typeof spec === 'string' ? [[name, spec]] : []))
}

/**
 * Read one patch layer into rows and settings.
 * @param path - the patch file.
 * @param layer - which layer it is.
 * @param rows - the row list to append to.
 * @param configurations - the settings list to append to.
 * @throws {ProfileSafetyError} `PROFILE_UNREADABLE` when the file is not a list of patch entries.
 */
function readLayer(path: string, layer: PatchLayer, rows: PersonRow[], configurations: PersonConfiguration[]): void {
  if (!existsSync(path)) return
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new ProfileSafetyError('PROFILE_UNREADABLE', path, `${path} cannot be read: ${String(error)}`, ['repair-profile'], [{ kind: 'configuration', name: path, layer }], { cause: error })
  }
  let parsed: unknown
  try {
    parsed = parse(text)
  } catch (error) {
    throw new ProfileSafetyError('PROFILE_UNREADABLE', path, `${path} is not YAML: ${String(error)}`, ['repair-profile'], [{ kind: 'configuration', name: path, layer }], { cause: error })
  }
  // An empty file is the template's `[]`, and a file of comments parses as null.
  if (parsed === null || parsed === undefined) return
  if (!Array.isArray(parsed)) {
    throw new ProfileSafetyError('PROFILE_UNREADABLE', path, `${path} is not a list of patch entries.`, ['repair-profile'], [{ kind: 'configuration', name: path, layer }])
  }
  for (const entry of parsed) {
    if (!isRecord(entry)) {
      throw new ProfileSafetyError('PROFILE_UNREADABLE', path, `${path} holds a patch entry that is not a mapping.`, ['repair-profile'], [{ kind: 'configuration', name: path, layer }])
    }
    const inserted = entry['insert']
    if (Array.isArray(inserted)) {
      for (const row of inserted) {
        if (!isRecord(row) || typeof row['name'] !== 'string') {
          throw new ProfileSafetyError('PROFILE_UNREADABLE', path, `${path} inserts a row that declares no plugin name.`, ['repair-profile'], [{ kind: 'row', name: String(row), layer }])
        }
        rows.push({
          ...typeof row['id'] === 'string' ? { id: row['id'] } : {},
          name: row['name'],
          layer,
          disabled: row['disabled'] === true,
        })
      }
      continue
    }
    const id = entry['id']
    if (typeof id !== 'string') {
      throw new ProfileSafetyError('PROFILE_UNREADABLE', path, `${path} holds a patch entry with neither an id nor an insert list.`, ['repair-profile'], [{ kind: 'configuration', name: path, layer }])
    }
    const fields = Object.entries(entry).filter(([key]) => key !== 'id' && key !== 'name' && key !== 'insert')
    const keys = fields.map(([key]) => key).sort()
    configurations.push({
      rowId: id,
      layer,
      keys,
      value: JSON.stringify(Object.fromEntries(keys.map(key => [key, entry[key]]))),
    })
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readManifest(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new ProfileSafetyError('PROFILE_UNREADABLE', path, `${PROFILE_MANIFEST_FILENAME} cannot be read: ${String(error)}`, ['repair-profile'], [{ kind: 'configuration', name: PROFILE_MANIFEST_FILENAME }], { cause: error })
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new ProfileSafetyError('PROFILE_UNREADABLE', path, `${PROFILE_MANIFEST_FILENAME} is not JSON: ${String(error)}`, ['repair-profile'], [{ kind: 'configuration', name: PROFILE_MANIFEST_FILENAME }], { cause: error })
  }
}
