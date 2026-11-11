/**
 * Upstream's profile commands that `delorun` offers: `delorun plugin …` runs upstream's `dsh plugin` command line in
 * this process, with the Delo home as `DSH_HOME` and an installed Delo's own pnpm
 * ([package manager](./package-manager.ts)); upstream's parser refuses the desktop app's profile for
 * `plugin`, as it does for `dsh`. `delorun headless …` boots upstream's `headless` profile through Delo's composition
 * ([headless](./headless.ts)), not through upstream's command line.
 * `delorun plugin check` is Delo's own and reaches upstream's command line not at all.
 *
 * `delorun plugin` boots no Host and has no composition: no sandbox overlay, no sandbox invariants and no pre-start
 * steps. Under upstream's profile file lock it runs pnpm in the profile directory with the person's arguments and this
 * process's environment, unconfined, and then records the bundle list in the profile's `package.json`; pnpm runs a
 * dependency's install scripts only when the profile's `pnpm-workspace.yaml` allows its build, and runs whatever a
 * pnpm command such as `exec` or `dlx` names. The bundle check reads each new bundle's manifest and patch files and
 * imports no plugin code.
 *
 * After upstream's plugin operation, whether it succeeded or not, `delorun plugin` makes the plugins that the profile
 * it selects ([profile](./profile.ts)) links from folders, missing ones included, load from their active directories at once, as the running Host checks before every
 * reload (`prepareReload` of `@delo/changes`): `delorun plugin add link:<folder>` leaves the plugin linked to its empty
 * active directory and its folder's content waiting for review, and says so on standard error. A profile whose first
 * start under Changes has not run is left to that start. The command exits 0 when upstream's operation succeeded and
 * the profile is what Changes keeps, and 1 otherwise.
 *
 * Both commands register as shared users of the home's stores first and refuse while `delorun trash`, `export`,
 * `import` or an offline `delorun recover rollback` runs, or an update, a rollback or a restore of the chat data is in
 * progress ([home exclusion](./home-exclusion.ts)); an update's prepare, copy, restore and rollback, and those
 * commands, refuse while either runs. `delorun headless` writes chat data beside the home processes; `delorun plugin`
 * changes a profile that an update snapshots and a rollback restores.
 *
 * @module @delo/cli/upstream
 */
import { isChangesError, prepareReload, readChangeLog, startNotice } from '@delo/changes'
import { isCarriedPackage } from './changes/start.ts'
import { prepareHome, type CliCommand, type CommandContext, type CommandResult } from './command.ts'
import { EXIT } from './exit.ts'
import { refuseLauncherOptions, runHeadless, type HeadlessDependencies } from './headless.ts'
import { useHomeShared } from './home-exclusion.ts'
import { hasCliProfile, profileDirectory, selectCommandProfile } from './profile.ts'
import { runUpstreamProfile, upstreamDependencies } from './start.ts'
import { shippedPackageManager } from './package-manager.ts'
import { runPluginCheck } from './plugin-check.ts'

/**
 * Run upstream's command line with these arguments.
 * @param argv - the arguments `dsh` would receive.
 */
async function runUpstreamCli(argv: readonly string[]): Promise<void> {
  // Loaded after the launch variables are set, so upstream resolves the Delo home.
  const { runCli } = await import('@deepseek-ai/dsh/lib/bin.js')
  const packageManager = shippedPackageManager()
  await runCli(packageManager === undefined ? { argv } : { argv, packageManager })
}

/** What upstream's command line threw in place of exiting the process, so the plugin command can finish its part. */
class UpstreamExit extends Error {
  /** The exit code upstream asked for. */
  readonly code: number

  /**
   * @param code - the exit code upstream asked for.
   */
  constructor(code: number) {
    super(`upstream exited with ${String(code)}`)
    this.code = code
  }
}

/**
 * Run upstream's command line, which ends by exiting the process, and keep its exit code instead.
 * @param argv - the arguments `dsh` would receive.
 * @param runUpstream - runs upstream's command line.
 * @returns the exit code upstream asked for; 0 when it returned without exiting.
 */
async function upstreamExitCode(argv: readonly string[], runUpstream: (argv: readonly string[]) => Promise<void>): Promise<number> {
  const exit = process.exit
  process.exit = ((code?: number | string | null) => { throw new UpstreamExit(Number(code ?? 0)) }) as typeof process.exit
  try {
    await runUpstream(argv)
    return 0
  } catch (error) {
    if (!(error instanceof UpstreamExit)) throw error
    return error.code
  } finally {
    process.exit = exit
  }
}

/**
 * After upstream's plugin operation, move the profile's links to folders to their active directories, as the running
 * Host's check before a reload does, and say what waits for review.
 * @param home - the Delo home.
 * @param profile - the profile the operation changed.
 * @param context - the command's output.
 * @returns whether the profile is what Changes keeps.
 */
async function keepPluginChanges(home: string, profile: string, context: Pick<CommandContext, 'stderr'>): Promise<boolean> {
  if (!hasCliProfile(home, profile)) return true
  try {
    if ((await readChangeLog(home, profile)).migratedAt === undefined) return true
    context.stderr(startNotice(await prepareReload({ home, profile, profileDir: profileDirectory(home, profile), harnessLink: isCarriedPackage })))
    return true
  } catch (error) {
    context.stderr(`delorun: ${isChangesError(error) ? error.detail : String(error)}\n`)
    return false
  }
}

/**
 * Run `delorun plugin`: register as a shared user of the home's stores, run upstream's `dsh plugin` with these
 * arguments, then Changes' check of the profile. The registration's release also runs at this process's exit.
 * @param args - the arguments after `plugin`.
 * @param context - the environment and output.
 * @param runUpstream - runs upstream's command line; {@link runUpstreamCli} by default.
 * @param onExit - registers the shared registration's release for this process's exit.
 * @returns 0 when upstream's operation succeeded and the profile is what Changes keeps, otherwise 1.
 * @throws {CliError} while an exclusive user runs or an update, a rollback or a restore is in progress; upstream's
 *   command line has not run then.
 */
export async function plugin(args: readonly string[], context: CommandContext, runUpstream: (argv: readonly string[]) => Promise<void> = runUpstreamCli, onExit: (listener: () => void) => void = (listener) => { process.once('exit', listener) }): Promise<CommandResult> {
  // Upstream's parser reads `--profile` under its own, looser rule, so every value it could read is held to C1's first.
  const profile = selectCommandProfile('plugin', args, context.env)
  const { home } = await prepareHome(context, undefined)
  const release = await useHomeShared(home.path, 'plugin')
  onExit(release)
  try {
    const code = await upstreamExitCode(['plugin', ...args], runUpstream)
    const kept = await keepPluginChanges(home.path, profile, context)
    return code === 0 && kept ? EXIT.ok : EXIT.failed
  } finally {
    release()
  }
}

/**
 * `delorun plugin --profile <name> <pnpm-args…>`: upstream's plugin management, then Changes' check of the profile;
 * `delorun plugin check <directory>` is Delo's own ([plugin check](./plugin-check.ts)), which needs no profile.
 */
export const pluginCommand: CliCommand = {
  name: 'plugin',
  summary: 'Manage a profile\'s plugins, as dsh plugin does; check <directory> shows what a plugin\'s version ranges admit',
  run: async (args, context) => args[0] === 'check' ? runPluginCheck(args.slice(1), context) : plugin(args, context),
}

/**
 * The dependencies of a real headless run: upstream's profile preparation, runner and `.env` loader, the approved
 * plugin content step and the pre-start steps, as `delorun start` uses them.
 * @returns the dependencies.
 */
export function headlessDependencies(): HeadlessDependencies {
  const upstream = upstreamDependencies()
  // No home process runs beside a headless task, so upstream's runner keeps its own signal handlers; a crash is the
  // CLI's last-resort handler's, which disposes the Host through the registered teardown.
  return {
    prepareProfile: upstream.prepareProfile,
    approvedPluginContent: upstream.approvedPluginContent,
    preStartSteps: upstream.preStartSteps,
    cwd: () => process.cwd(),
    runProfile: options => runUpstreamProfile(options, { signals: true, failLoud: false }),
    loadEnvironment: upstream.loadEnvironment,
    fatalRelease: upstream.fatalRelease,
  }
}

/**
 * Run `delorun headless`: refuse upstream's launcher options, register as a shared user of the chat data, and boot the
 * headless profile through Delo's composition.
 * @param args - the arguments after `headless`.
 * @param context - the environment and output.
 * @param dependencies - the headless run's dependencies; upstream's by default.
 * @param onExit - registers the shared registration's release for this process's exit.
 * @returns `undefined`: upstream's profile runner sets the exit code.
 */
export async function headless(args: readonly string[], context: CommandContext, dependencies: HeadlessDependencies = headlessDependencies(), onExit: (listener: () => void) => void = (listener) => { process.once('exit', listener) }): Promise<CommandResult> {
  refuseLauncherOptions(args)
  const { home } = await prepareHome(context, undefined)
  onExit(await useHomeShared(home.path, 'headless'))
  return runHeadless({ home: home.path, args, output: context, env: context.env }, dependencies)
}

/** `delorun headless <task>`: upstream's one-task headless profile, composed as every Delo Host is. */
export const headlessCommand: CliCommand = {
  name: 'headless',
  summary: 'Answer one task and exit, as dsh headless does, under Delo\'s protections',
  run: (args, context) => headless(args, context),
}
