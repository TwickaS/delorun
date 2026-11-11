/**
 * Upstream's profile commands that `delorun` offers: `delorun plugin …` runs upstream's `dsh plugin` command line in
 * this process, with the Delo home as `DSH_HOME` and an installed Delo's own pnpm
 * ([package manager](./package-manager.ts)); upstream's parser refuses the desktop app's profile for
 * `plugin`, as it does for `dsh`. `delorun headless …` boots upstream's `headless` profile through Delo's composition
 * ([headless](./headless.ts)), not through upstream's command line.
 * `delorun plugin check`, `new` and `dev` are Delo's own ([plugin check](./plugin-check.ts),
 * [plugin new](./plugin-new/index.ts), [plugin dev](./plugin-dev.ts)).
 *
 * `delorun plugin` without `--profile` manages the CLI profile every `delorun` command uses, `DELO_PROFILE` or
 * `default`, as if `--profile <that name>` led its arguments; upstream's `dsh plugin` requires the option.
 *
 * `delorun plugin` boots no Host and has no composition: no sandbox overlay, no sandbox invariants and no pre-start
 * steps. Under upstream's profile file lock it runs pnpm in the profile directory with the person's arguments and this
 * process's environment, unconfined, and then records the bundle list in the profile's `package.json`; pnpm runs a
 * dependency's install scripts only when the profile's `pnpm-workspace.yaml` allows its build, and runs whatever a
 * pnpm command such as `exec` or `dlx` names. The bundle check reads each new bundle's manifest and patch files and
 * imports no plugin code. When pnpm refuses a build, `delorun plugin` offers to allow that one package's build at the
 * terminal, or allows it for `--allow-build <name>`, and runs the operation once more ([plugin builds](./plugin-builds.ts)).
 *
 * Both commands register as shared users of the home's stores first and refuse while `delorun trash`, `export`,
 * `import` or an offline `delorun recover rollback` runs, or an update, a rollback or a restore of the chat data is in
 * progress ([home exclusion](./home-exclusion.ts)); an update's prepare, copy, restore and rollback, and those
 * commands, refuse while either runs. `delorun headless` writes chat data beside the home processes; `delorun plugin`
 * changes a profile that an update snapshots and a rollback restores.
 *
 * @module @delo/cli/upstream
 */
import { join } from 'node:path'
import { runDirectory } from '@delo/home'
import { prepareHome, type CliCommand, type CommandContext, type CommandResult } from './command.ts'
import { CliError, EXIT } from './exit.ts'
import { refuseLauncherOptions, runHeadless, type HeadlessDependencies } from './headless.ts'
import { useHomeShared } from './home-exclusion.ts'
import { profileDirectory, profileOptionValues, selectCommandProfile } from './profile.ts'
import { runUpstreamProfile, upstreamDependencies } from './start.ts'
import { shippedPackageManager } from './package-manager.ts'
import { capturesOutput, capturingPackageManager, decideBuilds, takeAllowBuild, takeCapture, terminalConfirm, type ConfirmBuild } from './plugin-builds.ts'
import { runPluginCheck } from './plugin-check.ts'
import { realDevDependencies, runPluginDev } from './plugin-dev.ts'
import { runPluginNew } from './plugin-new/index.ts'
import { printable } from './terminal-text.ts'

/**
 * Run upstream's command line with these arguments.
 * @param argv - the arguments `dsh` would receive.
 * @param capture - the file that keeps pnpm's output ([plugin builds](./plugin-builds.ts)); none by default.
 */
async function runUpstreamCli(argv: readonly string[], capture?: string): Promise<void> {
  // Loaded after the launch variables are set, so upstream resolves the Delo home.
  const { runCli } = await import('@deepseek-ai/dsh/lib/bin.js')
  const shipped = shippedPackageManager()
  const packageManager = capture === undefined ? shipped : capturingPackageManager(shipped, capture)
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
 * @param runUpstream - runs upstream's command line.
 * @returns the exit code upstream asked for; 0 when it returned without exiting.
 */
async function upstreamExitCode(runUpstream: () => Promise<void>): Promise<number> {
  const exit = process.exit
  process.exit = ((code?: number | string | null) => { throw new UpstreamExit(Number(code ?? 0)) }) as typeof process.exit
  try {
    await runUpstream()
    return 0
  } catch (error) {
    if (!(error instanceof UpstreamExit)) throw error
    return error.code
  } finally {
    process.exit = exit
  }
}

/**
 * Run `delorun plugin`: register as a shared user of the home's stores, then run upstream's `dsh plugin` with these
 * arguments for the CLI profile. When the operation fails because pnpm refused a build, each refused package whose
 * build the person allows, at the terminal or with `--allow-build`, is allowed and the operation runs again, once for
 * each newly allowed set. The registration's release also runs at this process's exit.
 * @param args - the arguments after `plugin`.
 * @param context - the environment and output.
 * @param runUpstream - runs upstream's command line, keeping pnpm's output in the file given; {@link runUpstreamCli} by
 *   default.
 * @param onExit - registers the shared registration's release for this process's exit.
 * @param confirm - asks the person whether to allow one build; the terminal's by default, none without a terminal.
 * @returns 0 when upstream's operation succeeded, otherwise 1.
 * @throws {CliError} for a refused profile name or `--allow-build` value, and while an exclusive user runs or an update,
 *   a rollback or a restore is in progress; upstream's command line has not run then. Also when pnpm refused a build
 *   and the profile's `pnpm-workspace.yaml` cannot record the decision; the operation has failed then.
 */
export async function plugin(args: readonly string[], context: CommandContext, runUpstream: (argv: readonly string[], capture?: string) => Promise<void> = runUpstreamCli, onExit: (listener: () => void) => void = (listener) => { process.once('exit', listener) }, confirm: ConfirmBuild | undefined = terminalConfirm()): Promise<CommandResult> {
  const { args: forwarded, allowed } = takeAllowBuild(args)
  // Upstream's parser reads `--profile` under its own, looser rule, so every value it could read is held to C1's first.
  const profile = selectCommandProfile('plugin', forwarded, context.env)
  const { home } = await prepareHome(context, profile)
  const release = await useHomeShared(home.path, 'plugin')
  onExit(release)
  try {
    const argv = ['plugin', ...profileOptionValues(forwarded).length === 0 ? ['--profile', profile] : [], ...forwarded]
    const profileDir = profileDirectory(home.path, profile)
    const capture = capturesOutput(forwarded) ? join(runDirectory(home.path, profile), `plugin-output-${String(process.pid)}.log`) : undefined
    const decided = new Set<string>()
    for (;;) {
      const code = await upstreamExitCode(() => capture === undefined ? runUpstream(argv) : runUpstream(argv, capture))
      const output = capture === undefined ? '' : await takeCapture(capture)
      if (code === 0) return EXIT.ok
      let decision
      try {
        decision = await decideBuilds({ profileDir, output, allowed, confirm, stderr: context.stderr })
      } catch (error) {
        throw new CliError(EXIT.failed, `delorun plugin: pnpm refused a build, and the build decision cannot be recorded in ${join(profileDir, 'pnpm-workspace.yaml')}: ${printable(error instanceof Error ? error.message : String(error))}; correct its allowBuilds mapping and run the command again`)
      }
      const fresh = decision.allowed.filter(key => !decided.has(key))
      if (fresh.length === 0 || decision.undecided.length > 0) return EXIT.failed
      for (const key of fresh) decided.add(key)
      context.stderr(`delorun plugin: running the operation again with the build of ${fresh.map(key => printable(key)).join(', ')} allowed.\n`)
    }
  } finally {
    release()
  }
}

/**
 * `delorun plugin [--profile <name>] <pnpm-args…>`: upstream's plugin management for the CLI profile;
 * `check <directory>`, `new <name>` and `dev <folder>` are Delo's own and handle their options themselves.
 */
export const pluginCommand: CliCommand = {
  name: 'plugin',
  summary: 'Manage a profile\'s plugins, as dsh plugin does; new, dev and check help you write one',
  run: async (args, context) => {
    switch (args[0]) {
      case 'check':
        return runPluginCheck(args.slice(1), context)
      case 'new':
        return runPluginNew(args.slice(1), context)
      case 'dev':
        return runPluginDev(args.slice(1), context, realDevDependencies(context, plugin))
      default:
        return plugin(args, context)
    }
  },
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
