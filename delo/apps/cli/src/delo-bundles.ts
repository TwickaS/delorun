/**
 * Delo's bundles in a CLI profile: making setup's bundles importable, and
 * refusing a start whose composition lost any of them.
 *
 * Upstream's profile loader skips a bundle it cannot resolve, read or accept,
 * and its startup audit only warns about a plugin row that did not activate;
 * in both cases the profile starts with what is left. A Delo profile without
 * `@delo/bundle-local`'s layer would run with upstream's defaults, which turn
 * DeepSeek session-log upload back on, and one whose `delo-privacy` row did not
 * import would run without the Privacy section that states and switches those
 * defaults. `delorun` therefore refuses both. A Delo bundle is any bundle in
 * the `@delo/` scope; a skipped upstream bundle and an inactive upstream row
 * are reported as upstream reports them and do not stop the start.
 *
 * @module @delo/cli/delo-bundles
 */
import type { Profile, RuntimeResolution } from '@deepseek-ai/dsh-app-boot'
import type { PackageOperationContext, PackageOperationOptions } from '@deepseek-ai/dsh-plugin-manager/operations'
import { LineCapture, type SurfaceLog } from '@delo/logs'
import { CliError, EXIT } from './exit.ts'
import { runsFromClosure } from './package-manager.ts'

/** The npm scope of Delorun's bundles and plugins. */
export const DELO_BUNDLE_SCOPE = '@delo/'

/** Profile plugin operations wait for the profile's package lock and pnpm's package lookups this long, as `dsh plugin` does. */
const PLUGIN_OPERATION_WAIT_MS = 120_000

/** Output a profile plugin operation keeps for its result, as `dsh plugin` does. */
const PLUGIN_OPERATION_OUTPUT_BYTES = 16_384

/**
 * Whether a package name is in Delo's scope.
 * @param packageName - the package name.
 * @returns true for `@delo/…`.
 */
export function isDeloPackage(packageName: string): boolean {
  return packageName.startsWith(DELO_BUNDLE_SCOPE)
}

/**
 * The directory of a Delo package that this installation of `delorun` carries,
 * which a source checkout links into the profile. A runtime closure offers none:
 * its directory is a version of the runtime store that an update replaces, so a
 * link to it would break, and the closure's install anchor declares Delo's
 * bundles instead.
 * @param packageName - the package name.
 * @returns the package directory, or `undefined` when `delorun` runs from a
 *   runtime closure or cannot resolve the package.
 */
export function carriedPackageDirectory(packageName: string): string | undefined {
  if (runsFromClosure()) return undefined
  try {
    return new URL('.', import.meta.resolve(`${packageName}/package.json`)).pathname
  } catch {
    // ERR_MODULE_NOT_FOUND or ERR_PACKAGE_PATH_NOT_EXPORTED: this installation does not carry it, so no link is offered.
    return undefined
  }
}

/**
 * The command that makes a Delo package available to a profile again.
 * @param profile - the CLI profile.
 * @param packageName - the package.
 * @returns the fix, as a phrase that follows "To fix it, ".
 */
function packageFix(profile: string, packageName: string): string {
  const directory = carriedPackageDirectory(packageName)
  return directory === undefined
    ? `reinstall Delorun, or run: delorun plugin --profile ${profile} install`
    : `run: delorun plugin --profile ${profile} add link:${directory}`
}

/** What {@link linkDeloBundles} uses from upstream, passed in so specs can observe it. */
export interface BundleLinking {
  /** Upstream's runtime resolution of the profile, which decides what its plugin rows can import. */
  readonly resolve: () => Promise<{ readonly profile: Profile, readonly resolution: RuntimeResolution }>
  /** Upstream's profile package operation, the one `dsh plugin` runs. */
  readonly runPluginCommand: (context: PackageOperationContext, args: readonly string[], options: PackageOperationOptions) => Promise<{ readonly exitCode: number, readonly logPath: string }>
  /** The installation anchor that `dsh plugin` passes. */
  readonly installAnchor: string
}

/** Where {@link linkDeloBundles} reports. */
export interface LinkReport {
  /** The operational log that receives the plugin operation's output, one captured record per line. */
  readonly log: SurfaceLog
  /** Receives the progress line, written in two parts: {@link LINKING_PROGRESS}, then `done` or `failed` with the line's end. */
  readonly progress: (text: string) => void
}

/** The start of the progress line a link prints. */
export const LINKING_PROGRESS = 'Linking Delorun\'s parts into the profile… '

/**
 * Make each Delo bundle of a new CLI profile importable the way upstream makes
 * its own bundles importable. A bundle that upstream's runtime resolution
 * already supplies, as a released installation carries it beside upstream's
 * packages, is left alone. One that it does not supply, but that this `delorun`
 * carries, as a source checkout does, is added to the profile with upstream's
 * `dsh plugin add link:<directory>` operation, which records the dependency in
 * the profile's `package.json` and installs it with pnpm. The operation runs with
 * its output captured, not on the terminal: each line goes to `report.log`, and
 * the terminal gets one progress line, which ends in `failed` when an operation
 * fails or rejects. Nothing is printed when no bundle needs linking.
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @param bundles - the profile's bundle list.
 * @param linking - upstream's resolution and plugin operation.
 * @param report - the log for the output and the writer of the progress line.
 * @throws {CliError} when a Delo bundle is neither supplied nor carried, or the operation exits non-zero; the message names the log file.
 */
export async function linkDeloBundles(
  home: string, profile: string, bundles: readonly string[], linking: BundleLinking, report: LinkReport,
): Promise<void> {
  const { profile: loaded, resolution } = await linking.resolve()
  const importable = new Set([...resolution.entries.map(entry => entry.name), ...resolution.localPackageNames])
  const links = bundles.filter(isDeloPackage).flatMap((bundle) => {
    const layered = loaded.layers.some(layer => layer.packageName === bundle)
    if (layered && importable.has(bundle)) return []
    const directory = carriedPackageDirectory(bundle)
    if (directory === undefined) {
      throw new CliError(EXIT.failed, `delorun setup: this installation of Delorun does not carry ${bundle}, which the CLI profile ${profile} needs; reinstall Delorun`)
    }
    return [{ bundle, directory }]
  })
  if (links.length === 0) return
  report.progress(LINKING_PROGRESS)
  // Captured as the home process captures its own output: standard output at `info`, standard error at `warn`.
  const captures = { stdout: new LineCapture(report.log, 'stdout', 'info'), stderr: new LineCapture(report.log, 'stderr', 'warn') }
  const onOutput = (text: string, stream: 'stdout' | 'stderr'): void => { captures[stream].write(text) }
  try {
    for (const { bundle, directory } of links) {
      const result = await linking.runPluginCommand(
        { profile, installAnchor: linking.installAnchor, cwd: process.cwd(), home },
        ['add', `link:${directory}`],
        // A service run pipes pnpm's output to onOutput and gives it no terminal; a CLI run would hand it the terminal.
        { execution: 'service', outputBytes: PLUGIN_OPERATION_OUTPUT_BYTES, lockWaitMs: PLUGIN_OPERATION_WAIT_MS, lookupTimeoutMs: PLUGIN_OPERATION_WAIT_MS, onOutput },
      )
      if (result.exitCode !== 0) {
        throw new CliError(EXIT.failed, `delorun setup: could not add ${bundle} to the CLI profile ${profile} (pnpm exited ${String(result.exitCode)}); its output is in ${report.log.location.file}`)
      }
    }
  } catch (error) {
    report.progress('failed\n')
    throw error
  } finally {
    captures.stdout.end()
    captures.stderr.end()
  }
  report.progress('done\n')
}

/**
 * Refuse a loaded profile when it skipped a Delo bundle.
 * @param profile - the profile as upstream's loader returned it.
 * @throws {CliError} with the failure code, naming each skipped Delo bundle, its reason and the command that fixes it.
 */
export function refuseSkippedDeloBundles(profile: Pick<Profile, 'name' | 'skippedBundles'>): void {
  const skipped = profile.skippedBundles.filter(bundle => isDeloPackage(bundle.packageName))
  if (skipped.length === 0) return
  throw new CliError(EXIT.failed, [
    `delorun: the profile ${profile.name} could not load Delorun's ${skipped.length === 1 ? 'bundle' : 'bundles'}, so Delorun did not start:`,
    ...skipped.map(({ packageName, reason }) => `  ${packageName}: ${reason}\n  To fix it, ${packageFix(profile.name, packageName)}`),
    'Without them the profile would start with DeepSeek Harness\'s own defaults: no Delorun guard, and session logs uploaded to DeepSeek.',
  ].join('\n'))
}

/** How a booted plugin row ended its startup. */
export type RowState = 'active' | 'failed' | 'pending' | 'not-imported'

/** One plugin row of a booted profile, as the start's audit reads it. */
export interface BootedRow {
  /** The row's entry id. */
  readonly id: string
  /** The module the row imports. */
  readonly name: string
  /** Whether the row is disabled; a row whose `disabled` expression threw counts as enabled and failed. */
  readonly disabled: boolean
  /** How its startup ended. */
  readonly state: RowState
  /** The config the Loader mounted the row with, after every patch layer; absent when the row has none. */
  readonly config?: unknown
}

/**
 * The Delo rows that are opt-in: a bundle inserts them disabled, and the person turns them on in the sidebar's Plugins page.
 * A start does not require them to be enabled; once enabled they must be active like every other Delo row.
 */
export const OPT_IN_ROWS: ReadonlySet<string> = new Set(['delo-cost-meter', 'delo-thinking-rsvp'])

/**
 * The ids of the rows that Delo bundles insert into a profile.
 * @param profile - the loaded profile.
 * @returns the ids, from every `insert` list of each Delo layer's patches, nested lists included.
 */
export function deloRowIds(profile: Pick<Profile, 'layers'>): Set<string> {
  const ids = new Set<string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (typeof value !== 'object' || value === null) return
    const record = value as Record<string, unknown>
    if (typeof record.id === 'string' && typeof record.name === 'string') ids.add(record.id)
    for (const child of Object.values(record)) if (typeof child === 'object') visit(child)
  }
  for (const layer of profile.layers) {
    if (!isDeloPackage(layer.packageName)) continue
    for (const patch of layer.patches) visit((patch as { insert?: unknown }).insert)
  }
  return ids
}

/**
 * The enabled Delo rows that did not activate: the rows Delo bundles insert,
 * and any row whose module is in Delo's scope.
 * @param rows - the booted profile's rows.
 * @param deloIds - the ids Delo bundles insert ({@link deloRowIds}).
 * @returns the inactive Delo rows.
 */
export function inactiveDeloRows(rows: readonly BootedRow[], deloIds: ReadonlySet<string>): BootedRow[] {
  return rows.filter(row => (deloIds.has(row.id) || isDeloPackage(row.name)) && !row.disabled && row.state !== 'active')
}

/**
 * The refusal for a booted profile whose Delo rows did not all activate.
 * @param profile - the CLI profile.
 * @param rows - the inactive Delo rows ({@link inactiveDeloRows}); not empty.
 * @returns the error to stop the start with.
 */
export function inactiveRowsRefusal(profile: string, rows: readonly BootedRow[]): CliError {
  const describe: Record<RowState, string> = { 'active': 'active', 'failed': 'failed to start', 'pending': 'waits for a service that never came', 'not-imported': 'failed to import' }
  return new CliError(EXIT.failed, [
    `delorun: ${rows.length === 1 ? 'a plugin' : 'plugins'} of Delorun's bundles did not start in the CLI profile ${profile}, so Delorun stopped:`,
    ...rows.map((row) => {
      const directory = carriedPackageDirectory(row.name)
      const fix = directory === undefined
        ? packageFix(profile, row.name)
        : `build it in this source checkout with: pnpm --filter ${row.name} run build, then start again; if the profile does not list it, run: delorun plugin --profile ${profile} add link:${directory}`
      return `  ${row.id} (${row.name}) ${describe[row.state]}\n  To fix it, ${fix}`
    }),
    'The warning above names the cause. Without these plugins Delorun would run without its privacy settings and statements.',
  ].join('\n'))
}
