/**
 * Upstream's profile commands that `delorun` offers: `delorun plugin …` runs upstream's `dsh plugin` command line in
 * this process unchanged, with the Delo home as `DSH_HOME` and an installed Delo's own pnpm
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
 * imports no plugin code. Before pnpm runs, the profile's `pnpm-workspace.yaml` gets `packageImportMethod: copy` where it
 * names no import method ([pnpm import](./pnpm-import.ts)); an operation that installs packages is resolved, checked by
 * the install check of the profile's `delo-plugin-install-check` row, and only then installed, and each plugin it
 * installed is recorded ([install check](./plugin-install-check.ts)); `--allow-advisory <id>` lets a known critical
 * advisory through. `delorun plugin mirror on|off` sets the profile's npm mirror.
 *
 * Both commands register as shared users of the home's stores first and refuse while `delorun trash`, `export`,
 * `import` or an offline `delorun recover rollback` runs, or an update, a rollback or a restore of the chat data is in
 * progress ([home exclusion](./home-exclusion.ts)); an update's prepare, copy, restore and rollback, and those
 * commands, refuse while either runs. `delorun headless` writes chat data beside the home processes; `delorun plugin`
 * changes a profile that an update snapshots and a rollback restores.
 *
 * @module @delo/cli/upstream
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prepareHome, type CliCommand, type CommandContext, type CommandResult } from './command.ts'
import { EXIT, type ExitCode } from './exit.ts'
import { refuseLauncherOptions, runHeadless, type HeadlessDependencies } from './headless.ts'
import { useHomeShared } from './home-exclusion.ts'
import { carriedOptions, checkResolved, forgetRemovedPlugins, installsPackages, profileCheckSettings, recordAfterInstall, registryUrls, resolveOnly, runMirror, takeAllowedAdvisories, withProfile, type ProfileCheckSettings } from './plugin-install-check.ts'
import { readProfileRegistry } from '@deepseek-ai/dsh-plugin-manager/operations'
import { ensureCopyImport } from './pnpm-import.ts'
import { profileDirectory, selectCommandProfile } from './profile.ts'
import { runUpstreamProfile, upstreamDependencies } from './start.ts'
import { shippedPackageManager } from './package-manager.ts'
import { runPluginCheck } from './plugin-check.ts'

/** What `delorun plugin` runs outside this module; specs replace it. */
export interface PluginDependencies {
  /**
   * Run upstream's `dsh plugin` package operation in this process, without ending it.
   * @param argv - the arguments `dsh` would receive, `plugin` first.
   * @param operation - bundle activation and the baseline of an earlier resolution-only run, for an installation split
   *   into resolution and installation.
   * @returns pnpm's exit code.
   */
  readonly runUpstream: (argv: readonly string[], operation?: UpstreamOperation) => Promise<number>
  /**
   * The install check's settings for a profile, from its composed `delo-plugin-install-check` row.
   * @param home - the Delo home.
   * @param profileDir - the profile directory.
   * @returns the settings, or `undefined` when the check is off.
   */
  readonly checkSettings: (home: string, profileDir: string) => Promise<ProfileCheckSettings | undefined>
  /**
   * The registry pnpm's own configuration names in the profile.
   * @param profileDir - the profile directory.
   * @returns its URL, or `null` when pnpm did not answer with one.
   */
  readonly profileRegistry: (profileDir: string) => Promise<string | null>
  /** The installation's `package.json`, as upstream's profile boot names it, for `delorun plugin mirror`. */
  readonly installAnchor: () => Promise<string>
  /** Registers the shared registration's release for this process's exit. */
  readonly onExit: (listener: () => void) => void
}

/** What upstream's plugin command takes for one step of an installation split into resolution and installation. */
export interface UpstreamOperation {
  /** `false` for the resolution, which installs nothing a bundle could be activated from. */
  readonly activateNewBundles?: boolean
  /** For the installation: the profile's `package.json` and lockfile text from before the resolution. */
  readonly baseline?: { readonly manifest: string | undefined, readonly lockfile: string | undefined }
}

/**
 * Run upstream's `dsh plugin` package operation in this process: its parser, which ends the process for `--help` and a
 * wrong command line as `dsh` does, then its plugin command.
 * @param argv - the arguments `dsh` would receive, `plugin` first.
 * @param operation - as {@link PluginDependencies.runUpstream} takes it.
 * @returns pnpm's exit code.
 */
async function runUpstreamPlugin(argv: readonly string[], operation?: UpstreamOperation): Promise<number> {
  // Loaded after the launch variables are set, so upstream resolves the Delo home.
  const { getDshRuntimeVersion } = await import('@deepseek-ai/dsh-app-boot')
  const { parseDshArgs } = await import('@deepseek-ai/dsh/lib/args.js')
  const { runPlugin } = await import('@deepseek-ai/dsh/lib/plugin.js')
  const invocation = parseDshArgs(argv, getDshRuntimeVersion())
  if (invocation.mode !== 'plugin') throw new Error(`delorun plugin: upstream read ${JSON.stringify(argv)} as a ${invocation.mode} command`)
  return runPlugin(invocation.profile, invocation.args, shippedPackageManager(), operation)
}

/** The time pnpm gets to name the profile's registry. */
const REGISTRY_LOOKUP_MS = 20_000

/** The real dependencies: upstream's plugin command and profile boot, and this process's exit. */
const UPSTREAM_PLUGIN: PluginDependencies = {
  runUpstream: runUpstreamPlugin,
  checkSettings: async (home, profileDir) => profileCheckSettings(home, profileDir, (await import('@deepseek-ai/dsh/profile-boot')).INSTALL_ANCHOR),
  profileRegistry: profileDir => readProfileRegistry(profileDir, { ...shippedPackageManager(), timeoutMs: REGISTRY_LOOKUP_MS }),
  installAnchor: async () => (await import('@deepseek-ai/dsh/profile-boot')).INSTALL_ANCHOR,
  onExit: (listener) => { process.once('exit', listener) },
}

/** The profile files a refused installation puts back. */
const RESTORED_FILES = ['package.json', 'pnpm-lock.yaml'] as const

/**
 * Read the profile files a refused installation puts back.
 * @param profileDir - the profile directory.
 * @returns each file's text, `undefined` for one that does not exist.
 */
function readRestoredFiles(profileDir: string): Map<string, string | undefined> {
  return new Map(RESTORED_FILES.map(file => [file, existsSync(join(profileDir, file)) ? readFileSync(join(profileDir, file), 'utf8') : undefined]))
}

/**
 * Run `delorun plugin`: register as a shared user of the home's stores, set the profile's package import method to
 * copies ([pnpm import](./pnpm-import.ts)), and run upstream's `dsh plugin` with these arguments, `--profile` first
 * with the selected profile when they name none. With the profile's
 * install check on, an operation that installs packages runs in three steps ([install check](./plugin-install-check.ts)):
 * pnpm resolves it into the lockfile only, the check reads the lockfile, and pnpm then installs the lockfile and runs the
 * builds the profile allows, with the options that restrict pnpm repeated ([carried options](./plugin-install-check.ts)),
 * after which each checked plugin is recorded. An operation that `--lockfile-only` limits to the
 * lockfile is resolved and checked, and installs nothing. A known critical advisory that no `--allow-advisory <id>`
 * names puts the profile's `package.json` and lockfile back as they were, before anything was fetched into the profile or
 * any script ran, and fails the command.
 * @param args - the arguments after `plugin`.
 * @param context - the environment and output.
 * @param dependencies - upstream's plugin command and profile boot, and the exit hook; the real ones by default.
 * @returns pnpm's exit code as the command's, or {@link EXIT.failed} for a refused installation.
 * @throws {CliError} while an exclusive user runs or an update, a rollback or a restore is in progress, or for a wrong
 *   `--allow-advisory`; upstream's command line has not run then.
 */
export async function plugin(args: readonly string[], context: CommandContext, dependencies: PluginDependencies = UPSTREAM_PLUGIN): Promise<number> {
  // Upstream's parser reads `--profile` under its own, looser rule, so every value it could read is held to C1's first.
  const profile = selectCommandProfile('plugin', args, context.env)
  const { allowed, rest } = takeAllowedAdvisories(args)
  const { home } = await prepareHome(context, undefined)
  const release = await useHomeShared(home.path, 'plugin')
  dependencies.onExit(release)
  try {
    const profileDir = profileDirectory(home.path, profile)
    await ensureCopyImport(profileDir)
    const check = await dependencies.checkSettings(home.path, profileDir)
    if (check === undefined || !installsPackages(rest)) {
      const code = await dependencies.runUpstream(['plugin', ...withProfile(rest, profile)])
      if (code === 0 && check !== undefined) await forgetRemovedPlugins(profileDir, context)
      return code
    }
    const before = readRestoredFiles(profileDir)
    const resolved = await dependencies.runUpstream(['plugin', ...resolveOnly(withProfile(rest, profile))], { activateNewBundles: false })
    if (resolved !== 0) return resolved
    const urls = registryUrls(rest)
    const own = urls.length > 0 ? null : await dependencies.profileRegistry(profileDir)
    const outcome = await checkResolved({ profileDir, check, allowedAdvisories: allowed, registries: [...urls, ...own === null ? [] : [own]], output: context })
    if (outcome.refused.length > 0) {
      for (const [file, text] of before) {
        if (text === undefined) rmSync(join(profileDir, file), { force: true })
        else writeFileSync(join(profileDir, file), text)
      }
      context.stderr(`delorun plugin: the profile ${profile} is back as it was before this command; nothing was installed into it and no install script ran\n`)
      return EXIT.failed
    }
    // A person who asked for the lockfile only gets it checked, and nothing installed.
    if (rest.includes('--lockfile-only')) return EXIT.ok
    // Upstream compares, restores, and activates bundles against the profile as it was before the resolution.
    const baseline = { manifest: before.get('package.json'), lockfile: before.get('pnpm-lock.yaml') }
    const installed = await dependencies.runUpstream(['plugin', '--profile', profile, 'install', '--frozen-lockfile', ...carriedOptions(rest)], { baseline })
    if (installed !== 0) return installed
    await recordAfterInstall(profileDir, outcome.pending, check.settings.maxFiles, context)
    return EXIT.ok
  } finally {
    release()
  }
}

/**
 * Run `delorun plugin mirror on|off` for the selected profile.
 * @param args - the arguments after `mirror`.
 * @param context - the environment and output.
 * @param dependencies - the installation anchor's source.
 * @returns {@link EXIT.ok}.
 * @throws {CliError} for a wrong command line, or a profile without Delo's install check row.
 */
export async function pluginMirror(args: readonly string[], context: CommandContext, dependencies: Pick<PluginDependencies, 'installAnchor'> = UPSTREAM_PLUGIN): Promise<ExitCode> {
  const profile = selectCommandProfile('plugin mirror', args, context.env)
  const { home } = await prepareHome(context, undefined)
  return runMirror(args, { home: home.path, profile, profileDir: profileDirectory(home.path, profile), installAnchor: await dependencies.installAnchor(), output: context })
}

/**
 * `delorun plugin --profile <name> <pnpm-args…>`: upstream's plugin management; `delorun plugin check <directory>` is
 * Delo's own ([plugin check](./plugin-check.ts)), which needs no profile.
 */
export const pluginCommand: CliCommand = {
  name: 'plugin',
  summary: 'Manage a profile\'s plugins, as dsh plugin does; check <directory> shows what a plugin\'s version ranges admit; mirror on|off',
  run: async (args, context) => {
    if (args[0] === 'check') return runPluginCheck(args.slice(1), context)
    if (args[0] === 'mirror') return pluginMirror(args.slice(1), context)
    // pnpm's exit code is the command's, which the CLI's exit codes do not list, so the process ends with it here.
    const code = await plugin(args, context)
    process.exit(code)
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
