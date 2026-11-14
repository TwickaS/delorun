/**
 * Fixtures for the profile-safety specs: a throwaway Harness home with one profile carrying the bundle list, patch
 * layers, dependencies and record a person's profile has, plus the builders for the inventories and update reports the
 * checks compare. Every directory is created under the system temporary directory and removed by the spec.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ReportItem, UpdateReport } from '@delorun/contract-update-report'
import type { SemanticVersion, Sha256Hex, UtcTimestamp } from '@delorun/contract-release-manifest'
import type { ProfileInventory } from '../src/inventory.ts'
import { readInventory } from '../src/inventory.ts'
import { HOME_PATCH_FILENAME, PROFILE_PATCH_FILENAME, SAFETY_RECORD_SCHEMA } from '../src/files.ts'
import type { SafetyRecord } from '../src/record.ts'

/** A profile fixture: a home, a profile under it, and the paths the specs write. */
export interface Fixture {
  /** The temporary root holding the home. */
  readonly root: string
  /** The Harness home: `$DSH_HOME`. */
  readonly homeDir: string
  /** The profile directory, `<home>/profiles/default`. */
  readonly profileDir: string
  /** Remove the whole fixture tree. */
  remove(): void
}

/** What {@link fixture} writes. */
export interface FixtureOptions {
  /** The profile's bundle list. */
  readonly bundles?: readonly string[]
  /** The profile's dependencies. */
  readonly dependencies?: Readonly<Record<string, string>> | undefined
  /** The profile patch's parsed patch entries. */
  readonly profilePatch?: readonly unknown[] | undefined
  /** The home patch's parsed patch entries. */
  readonly homePatch?: readonly unknown[] | undefined
  /** The profile's `pnpm-workspace.yaml`. */
  readonly workspace?: string | undefined
  /** The profile's safety record. */
  readonly record?: SafetyRecord | undefined
  /** The profile's `compatibility.json`, as text. */
  readonly compatibility?: string | undefined
  /** The profile's `delorun-compatibility.json`, as text. */
  readonly delorunCompatibility?: string | undefined
}

/**
 * Create a fixture home with one profile.
 * @param options - the profile's files.
 * @returns the fixture's paths and its cleanup.
 */
export function fixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'delorun-profile-safety-'))
  const homeDir = join(root, 'home')
  const profileDir = join(homeDir, 'profiles', 'default')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-default',
    private: true,
    dependencies: options.dependencies ?? {},
    dsh: { profile: { bundles: [...options.bundles ?? ['@deepseek-ai/dsh-base', '@delorun/bundle-local']] } },
  }, undefined, 2) + '\n')
  writeFileSync(join(profileDir, PROFILE_PATCH_FILENAME), options.profilePatch === undefined ? '[]\n' : JSON.stringify(options.profilePatch) + '\n')
  if (options.homePatch !== undefined) writeFileSync(join(homeDir, HOME_PATCH_FILENAME), JSON.stringify(options.homePatch) + '\n')
  if (options.workspace !== undefined) writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), options.workspace)
  if (options.compatibility !== undefined) writeFileSync(join(profileDir, 'compatibility.json'), options.compatibility)
  if (options.delorunCompatibility !== undefined) writeFileSync(join(profileDir, 'delorun-compatibility.json'), options.delorunCompatibility)
  if (options.record !== undefined) writeFileSync(join(profileDir, 'delorun-safety.json'), JSON.stringify(options.record, undefined, 2) + '\n')
  return { root, homeDir, profileDir, remove: () => { rmSync(root, { recursive: true, force: true }) } }
}

/**
 * The fixture profile's inventory.
 * @param profile - the fixture.
 * @param withHome - whether the home patch layer takes part; true by default.
 * @returns the profile's rows, settings, local plugins, bundles and ejections.
 */
export function inventoryOf(profile: Fixture, withHome = true): ProfileInventory {
  return readInventory({ profileDir: profile.profileDir, ...withHome ? { homeDir: profile.homeDir } : {} })
}

/**
 * An inventory that differs from another one in the ways a spec names.
 * @param inventory - the inventory to copy.
 * @param changes - the fields to replace.
 * @returns the new inventory; the argument is unchanged.
 */
export function variant(inventory: ProfileInventory, changes: Partial<ProfileInventory>): ProfileInventory {
  return { ...inventory, ...changes }
}

/**
 * A record with nothing in it.
 * @returns the empty record.
 */
export function emptyRecord(): SafetyRecord {
  return { schema: SAFETY_RECORD_SCHEMA, ejected: [], disabled: [] }
}

/**
 * A version as contract C3's report carries it.
 * @param text - the version text.
 * @returns the branded version.
 */
export function version(text: string): SemanticVersion {
  return brandString<SemanticVersion>(text)
}

/**
 * An update report naming the items a spec gives.
 * @param items - the items; everything else is a fixed value.
 * @returns the report.
 */
export function report(items: readonly ReportItem[]): UpdateReport {
  return {
    schema: 'delorun.update-report/3',
    installation: 'cli-home',
    from: { delorun: version('1.0.0'), dsh: version('0.2.2'), channel: 'stable' },
    to: { delorun: version('1.0.1'), dsh: version('0.2.2'), channel: 'stable' },
    release: { manifest: brandString<Sha256Hex>('a'.repeat(64)), signature: 'passed', freshness: 'passed', log: 'passed' },
    generated: brandString<UtcTimestamp>('2026-01-01T00:00:00.000Z'),
    installations: [{ id: 'cli-home', delorun: version('1.0.0'), dsh: version('0.2.2'), state: 'current' }],
    items: [...items],
    notChecked: [],
    counts: { disabled: 0, removed: 0, changed: 0, unverified: 0, data: 0, harness: 0 },
  }
}

/**
 * A report item about a row.
 * @param id - the row's id.
 * @param effect - what happens to it.
 * @returns the item.
 */
export function rowItem(id: string, effect: 'disabled' | 'removed' | 'changed' | 'kept' = 'disabled'): ReportItem {
  return {
    kind: 'row',
    subject: { id, name: 'some-plugin', layer: 'profile-patch' },
    reason: 'row-disabled',
    effect,
    verification: 'verified',
    detail: {},
    actions: ['keep-disabled', 'skip-update'],
  }
}

/**
 * A report item about a bundle.
 * @param packageName - the bundle's package name.
 * @param effect - what happens to it.
 * @returns the item.
 */
export function bundleItem(packageName: string, effect: 'disabled' | 'removed' | 'changed' | 'kept' = 'removed'): ReportItem {
  return {
    kind: 'bundle',
    subject: { package: packageName },
    reason: 'bundle-retired',
    effect,
    verification: 'verified',
    detail: {},
    actions: ['skip-update'],
  }
}

/**
 * A report item about a plugin.
 * @param name - the plugin's package name.
 * @param version - its installed version.
 * @returns the item.
 */
export function pluginItem(name: string, versionText = '1.0.0'): ReportItem {
  return {
    kind: 'plugin',
    subject: { name, version: version(versionText) },
    reason: 'dsh-requirement-unmet',
    effect: 'disabled',
    verification: 'verified',
    detail: { axis: 'dsh', requirement: '>=0.3.0' },
    actions: ['update-plugin', 'keep-disabled', 'skip-update'],
  }
}

/**
 * Read a file's text.
 * @param path - the file.
 * @returns its content.
 */
export function text(path: string): string {
  return readFileSync(path, 'utf8')
}

/**
 * Everything a directory holds, by path relative to it, so a spec can assert that nothing changed but the file it
 * expects to change.
 * @param dir - the directory.
 * @param skip - directory names left out, such as the profile's git history.
 * @returns each file's text, keyed by its relative path.
 */
export function readTree(dir: string, skip: readonly string[] = ['.plugin-manager']): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (skip.includes(entry.name)) continue
      const path = join(current, entry.name)
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(path, name)
      else if (entry.isFile()) files[name] = readFileSync(path, 'utf8')
    }
  }
  walk(dir, '')
  return files
}
