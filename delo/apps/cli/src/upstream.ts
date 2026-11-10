/**
 * Upstream's profile commands that `delorun` offers: `delorun plugin …` runs upstream's `dsh` command line in this
 * process unchanged, with the Delo home as `DSH_HOME` and an installed Delo's own pnpm
 * ([package manager](./package-manager.ts)); upstream's parser refuses the desktop app's profile for
 * `plugin`, as it does for `dsh`. `delorun headless …` boots upstream's `headless` profile through Delo's composition
 * ([headless](./headless.ts)), not through upstream's command line.
 *
 * `delorun headless` writes chat data beside the home process, so it registers itself as a shared user of the home's
 * stores first and refuses while `delorun trash`, `export` or `import` runs, or an update, a rollback or a restore of
 * the chat data is in progress ([home exclusion](./home-exclusion.ts)); an update's copy and restore, and those
 * commands, refuse while it runs.
 *
 * @module @delo/cli/upstream
 */
import { prepareHome, type CliCommand, type CommandContext, type CommandResult } from './command.ts'
import { refuseLauncherOptions, runHeadless, type HeadlessDependencies } from './headless.ts'
import { useHomeShared } from './home-exclusion.ts'
import { selectCommandProfile } from './profile.ts'
import { runUpstreamProfile, upstreamDependencies } from './start.ts'
import { shippedPackageManager } from './package-manager.ts'

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

/** `delorun plugin --profile <name> <pnpm-args…>`: upstream's plugin management. */
export const pluginCommand: CliCommand = {
  name: 'plugin',
  summary: 'Manage a profile\'s plugins, as dsh plugin does',
  async run(args, context) {
    // Upstream's parser reads `--profile` under its own, looser rule, so every value it could read is held to C1's first.
    selectCommandProfile('plugin', args, context.env)
    await prepareHome(context, undefined)
    await runUpstreamCli(['plugin', ...args])
    return undefined
  },
}

/**
 * The dependencies of a real headless run: upstream's profile preparation, runner and `.env` loader, the approved
 * plugin content step and the pre-start steps, as `delorun start` uses them.
 * @returns the dependencies.
 */
export function headlessDependencies(): HeadlessDependencies {
  const upstream = upstreamDependencies()
  // No home process runs beside a headless task, so upstream's runner keeps its own signal handlers.
  return { prepareProfile: upstream.prepareProfile, approvedPluginContent: upstream.approvedPluginContent, preStartSteps: upstream.preStartSteps, runProfile: options => runUpstreamProfile(options, true), loadEnvironment: upstream.loadEnvironment }
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
