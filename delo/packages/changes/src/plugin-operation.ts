/**
 * The plugin operation applying an agent's plugin request runs (`applyInstallChange`'s `run`), for `delorun changes
 * apply` and for the studio's Apply alike: upstream's `runProfilePnpm`, run as the plugin manager's
 * `installBundle` runs it, with the checks `installBundle` runs around it. `applyInstallChange` already holds the
 * profile's write lock, puts the profile's `package.json` and `pnpm-lock.yaml` back when the operation fails, and
 * records the build scripts pnpm held back.
 *
 * - pnpm runs without a terminal and with the plugin manager's scrubbed environment (`execution: 'service'`) and with
 *   no option that allows a build script, so the profile's `pnpm-workspace.yaml` `allowBuilds` entries alone decide
 *   which scripts run, and pnpm cannot ask at a terminal.
 * - `runProfilePnpm` refuses a version incompatible with this Delo or DSH before or after pnpm runs; the refusal is
 *   reported in the person's words.
 * - An install must change exactly one dependency, and that package must be a plugin bundle (`dsh.bundle.patch`), as
 *   `installBundle` requires.
 * - A spec that names a folder links the plugin to its active directory, whose content the person has not applied yet,
 *   so the folder's own `package.json` is checked instead: it must be a compatible plugin bundle.
 *
 * The caller names where pnpm's output goes (the terminal's streams, or the Host's log), the installation anchor and
 * the invocation directory, and, in a packaged application, the pnpm executable the profile launcher supplies.
 * Upstream's optional `pluginAudit` service is not consulted: no Delo composition mounts one.
 *
 * @module @delo/changes/plugin-operation
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PackageOperationContext, PackageOperationOptions } from '@deepseek-ai/dsh-plugin-manager/operations'
import type { ChangesContext } from './actions.ts'
import type { PluginOperation, PluginOperationResult } from './install-actions.ts'

/** Output a profile plugin operation keeps for its result, as `dsh plugin` keeps it. */
const OUTPUT_BYTES = 16_384

/** How long an operation waits for pnpm's package lookups, as `dsh plugin` waits. */
const LOOKUP_WAIT_MS = 120_000

/** A package manifest as the checks read it. */
interface PluginManifest {
  readonly dsh?: { readonly bundle?: { readonly patch?: unknown } }
}

/** What `runProfilePnpm` reports. */
interface UpstreamRun {
  readonly exitCode: number
  readonly logPath: string
  readonly output: string
  /** The packages upstream refused as incompatible with this Delo or DSH. */
  readonly incompatible?: readonly { readonly name: string, readonly version: string }[]
}

/** Upstream's operation and checks. */
export interface UpstreamChecks {
  /** Upstream's `runProfilePnpm`, which refuses a version incompatible with this Delo or DSH before or after pnpm runs. */
  readonly runProfilePnpm: (context: PackageOperationContext, args: readonly string[], options: PackageOperationOptions) => Promise<UpstreamRun>
  /**
   * Upstream's `bundleManifest`.
   * @param name - an installed dependency.
   * @param dir - the profile's directory.
   * @param anchor - the installation anchor.
   * @returns its manifest when it is a plugin bundle, otherwise undefined.
   */
  readonly bundleManifest: (name: string, dir: string, anchor: string) => PluginManifest | undefined
  /**
   * Upstream's compatibility check, with the profile's exact-version exemptions.
   * @param manifest - a package's manifest.
   * @param profileDir - the profile's directory.
   * @returns upstream's warning when this Delo or DSH cannot run the package, otherwise undefined.
   * @throws Error for a manifest whose requirements cannot be read.
   */
  readonly incompatibility: (manifest: object, profileDir: string) => string | undefined
}

/** Upstream's operation, checks and the installation anchor the caller runs from. */
export interface UpstreamOperation extends UpstreamChecks {
  /** The installation anchor `dsh plugin` passes, from which installed packages resolve. */
  readonly installAnchor: string
}

/**
 * Load upstream's pnpm operation and checks. A process that sets launch variables imports them only after they are
 * set, so upstream resolves the Delo home and Delo's version; a running Host has them set already.
 * @returns upstream's operation and checks.
 */
export async function loadUpstreamChecks(): Promise<UpstreamChecks> {
  const { bundleManifest, readProfileVersionExemptions, runProfilePnpm } = await import('@deepseek-ai/dsh-plugin-manager/operations')
  const { evaluatePluginCompatibility, pluginCompatibilityWarning } = await import('@deepseek-ai/dsh-app-boot')
  return {
    runProfilePnpm,
    bundleManifest,
    incompatibility: (manifest, profileDir) => {
      const issue = evaluatePluginCompatibility(manifest, readProfileVersionExemptions(profileDir))
      return issue === undefined || issue.exempted ? undefined : pluginCompatibilityWarning(issue)
    },
  }
}

/** The pnpm executable a packaged application supplies, as the profile launcher's `packageManager` names it. */
export interface PnpmInvocation {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** Where an operation runs and where its output goes. */
export interface PluginOperationSettings {
  /** The directory a relative path in a spec resolves against: the command's own, or the Host's. */
  readonly cwd: string
  /**
   * Receives pnpm's output as it arrives.
   * @param text - a chunk.
   * @param stream - the stream pnpm wrote it to.
   */
  readonly output: (text: string, stream: 'stdout' | 'stderr') => void
  /** The pnpm a packaged application supplies; absent, `pnpm` on `PATH`, as `dsh plugin` runs it. */
  readonly packageManager?: PnpmInvocation
  /** Loads upstream's operation and checks with the installation anchor. */
  readonly upstream: () => Promise<UpstreamOperation>
}

/**
 * @param dir - a directory with a `package.json`.
 * @returns its parsed manifest.
 * @throws Error when it cannot be read or holds no JSON object.
 */
async function manifestOf(dir: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${join(dir, 'package.json')} holds no JSON object`)
  return parsed as Record<string, unknown>
}

/**
 * @param profileDir - the profile's directory.
 * @returns its `dependencies`, name to spec.
 */
async function dependenciesOf(profileDir: string): Promise<Readonly<Record<string, unknown>>> {
  const { dependencies } = await manifestOf(profileDir)
  return typeof dependencies === 'object' && dependencies !== null ? dependencies as Record<string, unknown> : {}
}

/**
 * @param manifest - a package's manifest.
 * @returns whether it declares a bundle patch, as upstream's `bundleManifest` requires of a plugin bundle.
 */
function isBundle(manifest: PluginManifest | undefined): boolean {
  return manifest?.dsh?.bundle?.patch !== undefined
}

/**
 * Check the package a folder holds as `installBundle` checks an installed one.
 * @param folder - the folder.
 * @param profileDir - the profile's directory.
 * @param upstream - upstream's checks.
 * @returns why it is refused, or undefined.
 */
async function folderRefusal(folder: string, profileDir: string, upstream: UpstreamChecks): Promise<string | undefined> {
  try {
    const manifest = await manifestOf(folder)
    if (!isBundle(manifest)) return `the package in ${folder} is no DSH plugin bundle: its package.json declares no dsh.bundle.patch`
    const incompatible = upstream.incompatibility(manifest, profileDir)
    return incompatible === undefined ? undefined : `${incompatible} Nothing was installed.`
  } catch (error) {
    return `the package in ${folder} cannot be checked: ${String(error)}`
  }
}

/**
 * The operation for one profile.
 * @param ctx - the profile.
 * @param settings - where it runs, where its output goes and how upstream is loaded.
 * @returns the operation.
 */
export function upstreamPluginOperation(ctx: ChangesContext, settings: PluginOperationSettings): PluginOperation {
  return async (args, folder): Promise<PluginOperationResult> => {
    const loaded = await settings.upstream()
    if (folder !== undefined) {
      const refused = await folderRefusal(folder, ctx.profileDir, loaded)
      if (refused !== undefined) return { exitCode: 1, failure: refused }
    }
    const before = await dependenciesOf(ctx.profileDir)
    const run = await loaded.runProfilePnpm(
      { profile: ctx.profile, dir: ctx.profileDir, installAnchor: loaded.installAnchor, cwd: settings.cwd, home: ctx.home },
      args,
      { execution: 'service', ...settings.packageManager, outputBytes: OUTPUT_BYTES, lookupTimeoutMs: LOOKUP_WAIT_MS, onOutput: settings.output },
    )
    const ran = { exitCode: run.exitCode, logPath: run.logPath, output: run.output }
    if (run.incompatible !== undefined && run.incompatible.length > 0) {
      const names = run.incompatible.map(plugin => `${plugin.name}@${plugin.version}`).join(', ')
      return { ...ran, exitCode: 1, failure: `this Delo cannot run ${names}: its requirements are not met, so nothing was installed` }
    }
    if (run.exitCode !== 0 || args[0] !== 'add' || folder !== undefined) return ran
    const after = await dependenciesOf(ctx.profileDir)
    const installed = Object.keys(after).filter(name => before[name] !== after[name])
    if (installed.length > 1) return { ...ran, exitCode: 1, failure: `the operation changed ${installed.join(', ')}, not one plugin, so nothing was installed` }
    const [name] = installed
    if (name === undefined) return ran
    let bundle: boolean
    try {
      bundle = isBundle(loaded.bundleManifest(name, ctx.profileDir, loaded.installAnchor))
    } catch (error) {
      return { ...ran, exitCode: 1, failure: `${name} cannot be checked: ${String(error)}` }
    }
    return bundle ? ran : { ...ran, exitCode: 1, failure: `${name} is no DSH plugin bundle: its package.json declares no dsh.bundle.patch, so nothing was installed` }
  }
}
