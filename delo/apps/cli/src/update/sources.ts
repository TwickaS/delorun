/**
 * The readers behind contract C3's report for the CLI home: the running and the staged target runtime from C1's store,
 * the profile's plugins, bundle list, patch layers and exemption files, both installations' status records, and both
 * releases' data facts. Every fact is read from a file; no plugin module is imported. The target's bundle tables are
 * upstream's `@deepseek-ai/dsh-official-bundles`, read by the target runtime's own Node from its verified files.
 *
 * Not read yet, and named in the report's `notChecked`: the bundles' own layers (only the profile patch and the home
 * patch are walked), the bundles the target would skip, and the catalogue's revocation list, which no 0.1.0 release
 * publishes.
 *
 * @module @delo/cli/update/sources
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { brandString } from '@deepseek-ai/dsh-brand'
import { DELO_HOME_ENTRIES, STATUS_FILES, type RuntimeVersion } from '@delo/contract-home-layout'
import { EXEMPTION_FILES, type ExemptionRecord, type VersionAxis } from '@delo/contract-plugin-versions'
import type { SemanticVersion, Sha256Hex, UtcTimestamp } from '@delo/contract-release-manifest'
import type { InstallationStatus, ReportVersions } from '@delo/contract-update-report'
import { bundleListOf, dependenciesOf, readInventory } from '@delo/profile-safety'
import { readStoredRoot, type RuntimeStore, type VerifiedRuntime } from '@delo/runtime-store'
import { planDataCopy, readDataFormats, readInstalledPlugin, type BundleFacts, type DataFacts, type InstallationStatusFacts, type InstalledPluginFact, type LayerFact, type ProfileFacts, type ReportSources, type TargetFacts } from '@delo/update'
import semver from 'semver'
import { z } from 'zod'

const run = promisify(execFile)

/** How long the target's Node has to print its bundle tables. */
const BUNDLE_TABLES_TIMEOUT_MS = 30_000

/** What {@link storeReportSources} reads. */
export interface StoreSourcesOptions {
  /** The resolved Delo home. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
  /** C1's runtime store of the home. */
  readonly store: RuntimeStore
  /** The version this process runs. */
  readonly running: RuntimeVersion
  /**
   * Read the target runtime's bundle tables; {@link readBundleTables} by default.
   * @param runtime - the installed runtime's directory.
   * @param node - its Node executable.
   * @returns the tables.
   */
  readonly bundleTables?: (runtime: string, node: string) => Promise<BundleTables>
}

/** Upstream's bundle tables in one release (`@deepseek-ai/dsh-official-bundles`). */
export interface BundleTables {
  /** `RETIRED_BUNDLES`. */
  readonly retired: readonly string[]
  /** `INSTALLATION_OWNED_PROFILE_TUPLES`. */
  readonly tuples: Readonly<Record<string, readonly string[]>>
  /** `PROFILE_TEMPLATES`, the lists that replace a matching tuple. */
  readonly templates: Readonly<Record<string, readonly string[]>>
}

const tablesSchema = z.strictObject({
  retired: z.array(z.string()),
  tuples: z.record(z.string(), z.array(z.string())),
  templates: z.record(z.string(), z.array(z.string())),
})

/** The module the target's Node runs to print its tables; it imports upstream's data module and nothing else. */
const TABLES_SCRIPT = [
  "const m = await import('@deepseek-ai/dsh-official-bundles')",
  'process.stdout.write(JSON.stringify({ retired: [...m.RETIRED_BUNDLES], tuples: m.INSTALLATION_OWNED_PROFILE_TUPLES, templates: m.PROFILE_TEMPLATES }))',
].join('\n')

/**
 * Read an installed runtime's bundle tables with its own Node, from its `app/` directory, with an empty environment.
 * @param runtime - the installed runtime's directory, which passed C2's start check.
 * @param node - its Node executable.
 * @returns the tables.
 * @throws {Error} when the runtime has no such module or prints something else.
 */
export async function readBundleTables(runtime: string, node: string): Promise<BundleTables> {
  const { stdout } = await run(node, ['--input-type=module', '-e', TABLES_SCRIPT], { cwd: join(runtime, 'app'), env: {}, timeout: BUNDLE_TABLES_TIMEOUT_MS, maxBuffer: 1024 * 1024 })
  return tablesSchema.parse(JSON.parse(stdout))
}

/**
 * The target's facts about the profile's bundle list: the retired bundles, and the template that replaces a list
 * equal to an installation-owned tuple.
 * @param bundles - the profile's bundle list.
 * @param tables - the target's tables.
 * @returns the facts; no bundle is reported as skipped.
 */
export function bundleFactsOf(bundles: readonly string[], tables: BundleTables): BundleFacts {
  const owned = Object.entries(tables.tuples).find(([, tuple]) => tuple.length === bundles.length && tuple.every((bundle, at) => bundles[at] === bundle))
  const template = owned === undefined ? undefined : tables.templates[owned[0]]
  return { retired: tables.retired.filter(bundle => bundles.includes(bundle)), ...template === undefined ? {} : { template }, skipped: [] }
}

/**
 * Parse JSON text.
 * @param text - the text.
 * @returns its value, or `undefined` when it is not JSON.
 */
function parseOrUndefined(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch (_notJson) {
    // Not JSON: the caller states what an absent value means.
    return undefined
  }
}

/**
 * Read a JSON file.
 * @param path - the file.
 * @returns its value, or `undefined` when it is missing or not JSON.
 */
async function readJson(path: string): Promise<unknown> {
  try {
    return parseOrUndefined(await readFile(path, 'utf8'))
  } catch (_missing) {
    // Missing: each caller states what an absent value means.
    return undefined
  }
}

const exemptionSchema = z.record(z.string(), z.array(z.string()))

/**
 * Read one exemption file; a missing or malformed file grants nothing, so every item it would have kept is reported.
 * @param profileDir - the profile directory.
 * @param axis - the axis.
 * @returns the grants.
 */
async function readExemptions(profileDir: string, axis: VersionAxis): Promise<ExemptionRecord> {
  const parsed = exemptionSchema.safeParse(await readJson(join(profileDir, EXEMPTION_FILES[axis])))
  return parsed.success ? Object.fromEntries(Object.entries(parsed.data).map(([key, versions]) => [key, versions.map(text => brandString<SemanticVersion>(text))])) : {}
}

/**
 * Read one installed plugin of the profile from its own `package.json`.
 * @param profileDir - the profile directory.
 * @param name - the package name.
 * @param spec - the dependency spec the profile writes.
 * @returns the plugin; with no requirements when its manifest cannot be read.
 */
async function readPlugin(profileDir: string, name: string, spec: string): Promise<InstalledPluginFact> {
  let bytes = ''
  try {
    bytes = await readFile(join(profileDir, 'node_modules', name, 'package.json'), 'utf8')
  } catch (_missing) {
    // An unreadable manifest is the fact `manifest-unreadable` states.
  }
  const declared = z.object({ version: z.string() }).safeParse(parseOrUndefined(bytes))
  const version = declared.success && semver.valid(declared.data.version) !== null ? declared.data.version : semver.valid(spec) ?? '0.0.0'
  return readInstalledPlugin(name, brandString<SemanticVersion>(version), bytes)
}

const statusSchema = z.strictObject({
  id: z.enum(['cli-home', 'desktop-host']),
  delo: z.string().optional(),
  dsh: z.string().optional(),
  state: z.enum(['current', 'available', 'downloading', 'verifying', 'reporting', 'awaiting-confirmation', 'waiting-for-chats', 'applying', 'health-check', 'rolling-back', 'rolled-back', 'failed', 'unknown']),
  target: z.string().optional(),
})

/**
 * Read one installation's status record (C3); an absent or unreadable record is left out and shows as `unknown`.
 * @param path - the record.
 * @param id - the installation it must name.
 * @returns the status, or `undefined`.
 */
async function readStatus(path: string, id: InstallationStatus['id']): Promise<InstallationStatus | undefined> {
  const parsed = statusSchema.safeParse(await readJson(path))
  if (!parsed.success || parsed.data.id !== id) return undefined
  const { delo, dsh, target, state } = parsed.data
  return {
    id, state,
    ...delo === undefined ? {} : { delo: brandString<SemanticVersion>(delo) },
    ...dsh === undefined ? {} : { dsh: brandString<SemanticVersion>(dsh) },
    ...target === undefined ? {} : { target: brandString<SemanticVersion>(target) },
  }
}

/**
 * The versions a verified runtime's manifest names.
 * @param runtime - the verified runtime.
 * @returns its Delo, DSH and channel.
 */
function versionsOf(runtime: VerifiedRuntime): ReportVersions {
  return { delo: runtime.manifest.version, dsh: runtime.manifest.dsh, channel: runtime.manifest.channel }
}

/**
 * The report's sources over C1's store and the profile on disk.
 * @param options - the home, the profile, the store and the running version.
 * @returns the sources.
 */
export function storeReportSources(options: StoreSourcesOptions): ReportSources {
  const { home, profile, store } = options
  const profileDir = join(home, 'profiles', profile)
  const tables = options.bundleTables ?? readBundleTables
  const verified = async (version: string): Promise<VerifiedRuntime> => store.checkRuntime(brandString<RuntimeVersion>(version), await readStoredRoot(home))
  const profileFacts = async (): Promise<ProfileFacts> => {
    const manifest = await readJson(join(profileDir, 'package.json'))
    const inventory = readInventory({ profileDir, homeDir: home })
    const layers: LayerFact[] = (['profile-patch', 'home-patch'] as const).map(layer => ({
      layer: layer === 'profile-patch' ? 'profile patch' : 'home patch',
      rows: inventory.rows.filter(row => row.layer === layer && !row.disabled).map(row => ({ ...row.id === undefined ? {} : { id: row.id }, name: row.name, plugins: [row.name] })),
    }))
    return {
      plugins: await Promise.all(Object.entries(dependenciesOf(manifest)).map(([name, spec]) => readPlugin(profileDir, name, spec))),
      bundles: bundleListOf(manifest, join(profileDir, 'package.json')),
      layers,
      exemptions: { dsh: await readExemptions(profileDir, 'dsh'), delo: await readExemptions(profileDir, 'delo') },
    }
  }
  return {
    running: async () => versionsOf(await verified(options.running)),
    statuses: async (): Promise<InstallationStatusFacts> => {
      const [cli, desktop] = await Promise.all([
        readStatus(join(home, DELO_HOME_ENTRIES.status, STATUS_FILES.cliHome), 'cli-home'),
        readStatus(join(home, DELO_HOME_ENTRIES.status, STATUS_FILES.desktopHost), 'desktop-host'),
      ])
      return { ...cli === undefined ? {} : { 'cli-home': cli }, ...desktop === undefined ? {} : { 'desktop-host': desktop } }
    },
    profile: profileFacts,
    target: async (version): Promise<TargetFacts> => {
      const runtime = await verified(version)
      const directory = store.paths.version(runtime.version)
      const command = store.launchCommand(runtime.version, profile, [])
      const manifestBytes = await readFile(store.paths.releaseFiles(runtime.version).manifest)
      const manifest = await readJson(join(profileDir, 'package.json'))
      return {
        versions: versionsOf(runtime),
        // The store verified the signature now; the install verified freshness and the log before the files landed.
        release: { manifest: brandString<Sha256Hex>(createHash('sha256').update(manifestBytes).digest('hex')), signature: 'passed', freshness: 'passed', log: 'passed' },
        bundles: bundleFactsOf(bundleListOf(manifest, join(profileDir, 'package.json')), await tables(directory, command.command)),
        revocations: [],
        notChecked: ['revocations', 'bundle-layers', 'skipped-bundles'],
      }
    },
    data: async (version): Promise<DataFacts> => {
      const [from, to] = await Promise.all([verified(options.running), verified(version)])
      return {
        from: { dsh: from.manifest.dsh, formats: await readDataFormats(store.paths.version(from.version)) },
        to: { dsh: to.manifest.dsh, formats: await readDataFormats(store.paths.version(to.version)) },
        copy: await planDataCopy(home),
      }
    },
    now: () => brandString<UtcTimestamp>(new Date().toISOString()),
  }
}
