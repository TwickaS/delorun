/**
 * The plugin operation `delorun changes apply` runs for the agent's plugin requests: upstream's `runProfilePnpm`, run
 * as the plugin manager's `installBundle` runs it, with the checks `installBundle` runs around it. `applyInstallChange`
 * already holds the profile's write lock, puts the profile's `package.json` and `pnpm-lock.yaml` back when the operation
 * fails, and records the build scripts pnpm held back.
 *
 * - pnpm runs without a terminal and with the plugin manager's scrubbed environment (`execution: 'service'`) and with
 *   no option that allows a build script, so the profile's `pnpm-workspace.yaml` `allowBuilds` entries alone decide
 *   which scripts run, and pnpm cannot ask at the terminal.
 * - `runProfilePnpm` refuses a version incompatible with this Delo or DSH before or after pnpm runs; the refusal is
 *   reported in the person's words.
 * - An install must change exactly one dependency, and that package must be a plugin bundle (`dsh.bundle.patch`), as
 *   `installBundle` requires.
 * - A spec that names a folder links the plugin to its active directory, whose content the person has not applied yet,
 *   so the folder's own `package.json` is checked instead: it must be a compatible plugin bundle.
 *
 * Upstream's optional `pluginAudit` service lives in the Host; this operation runs in the terminal and audits nothing,
 * as no Delo composition mounts one.
 *
 * @module @delo/cli/changes/plugin-operation
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChangesContext, PluginOperation, PluginOperationResult } from '@delo/changes'
import type { PackageOperationContext, PackageOperationOptions } from '@deepseek-ai/dsh-plugin-manager/operations'
import type { CommandContext } from '../command.ts'

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

/** Upstream's operation, checks and installation anchor; loaded once the launch variables are set. */
export interface UpstreamOperation {
  /** The installation anchor `dsh plugin` passes, from which installed packages resolve. */
  readonly installAnchor: string
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

/**
 * Load upstream's pnpm operation, checks and installation anchor, imported after the launch variables are set so
 * upstream resolves the Delo home and Delo's version.
 * @returns upstream's operation, checks and installation anchor.
 */
export async function loadUpstream(): Promise<UpstreamOperation> {
  const { INSTALL_ANCHOR } = await import('@deepseek-ai/dsh/profile-boot')
  const { bundleManifest, readProfileVersionExemptions, runProfilePnpm } = await import('@deepseek-ai/dsh-plugin-manager/operations')
  const { evaluatePluginCompatibility, pluginCompatibilityWarning } = await import('@deepseek-ai/dsh-app-boot')
  return {
    installAnchor: INSTALL_ANCHOR,
    runProfilePnpm,
    bundleManifest,
    incompatibility: (manifest, profileDir) => {
      const issue = evaluatePluginCompatibility(manifest, readProfileVersionExemptions(profileDir))
      return issue === undefined || issue.exempted ? undefined : pluginCompatibilityWarning(issue)
    },
  }
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
async function folderRefusal(folder: string, profileDir: string, upstream: UpstreamOperation): Promise<string | undefined> {
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
 * The operation for one profile, printing pnpm's output on the command's streams.
 * @param ctx - the profile.
 * @param context - the command's output.
 * @param upstream - loads upstream's operation and checks; the installed ones by default.
 * @returns the operation.
 */
export function upstreamPluginOperation(ctx: ChangesContext, context: Pick<CommandContext, 'stdout' | 'stderr'>, upstream: () => Promise<UpstreamOperation> = loadUpstream): PluginOperation {
  return async (args, folder): Promise<PluginOperationResult> => {
    const loaded = await upstream()
    if (folder !== undefined) {
      const refused = await folderRefusal(folder, ctx.profileDir, loaded)
      if (refused !== undefined) return { exitCode: 1, failure: refused }
    }
    const before = await dependenciesOf(ctx.profileDir)
    const run = await loaded.runProfilePnpm(
      { profile: ctx.profile, dir: ctx.profileDir, installAnchor: loaded.installAnchor, cwd: process.cwd(), home: ctx.home },
      args,
      { execution: 'service', outputBytes: OUTPUT_BYTES, lookupTimeoutMs: LOOKUP_WAIT_MS, onOutput: (text, stream) => context[stream](text) },
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
