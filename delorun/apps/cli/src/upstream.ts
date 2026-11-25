/**
 * Upstream's profile commands that `delorun` offers: `delorun plugin …` runs upstream's `dsh plugin` command line in
 * this process, with the Delorun home as `DSH_HOME` and an installed Delorun's own pnpm
 * ([package manager](./package-manager.ts)); upstream's parser refuses the desktop app's profile for
 * `plugin`, as it does for `dsh`. `delorun headless …` boots upstream's `headless` profile through Delorun's composition
 * ([headless](./headless.ts)), not through upstream's command line.
 * `delorun plugin check`, `new` and `dev` are Delorun's own ([plugin check](./plugin-check.ts),
 * [plugin new](./plugin-new/index.ts), [plugin dev](./plugin-dev.ts)) and reach upstream's command line not at all.
 *
 * `delorun plugin` boots no Host and has no composition: no sandbox overlay, no sandbox invariants and no pre-start
 * steps. Under upstream's profile file lock it runs pnpm in the profile directory with the person's arguments and this
 * process's environment, unconfined, and then records the bundle list in the profile's `package.json`; pnpm runs a
 * dependency's install scripts only when the profile's `pnpm-workspace.yaml` allows its build, and runs whatever a
 * pnpm command such as `exec` or `dlx` names. The bundle check reads each new bundle's manifest and patch files and
 * imports no plugin code. Before pnpm runs, the profile's `pnpm-workspace.yaml` gets `packageImportMethod: copy` where it
 * names no import method ([pnpm import](./pnpm-import.ts)); an operation that installs packages is resolved, checked by
 * the install check of the profile's `delorun-plugin-install-check` row, and only then installed, and each plugin it
 * installed is recorded ([install check](./plugin-install-check.ts)); `--allow-advisory <id>` lets a known critical
 * advisory through. `delorun plugin mirror on|off` sets the profile's npm mirror.
 *
 * After upstream's plugin operation, whether it succeeded or not, `delorun plugin` makes the plugins that the profile
 * it selects ([profile](./profile.ts)) links from folders, missing ones included, load from their active directories at once, as the running Host checks before every
 * reload (`prepareReload` of `@delorun/changes`): with protection off, `delorun plugin --profile <name> add link:<folder>`
 * links the plugin to its active directory holding the folder's content, approved and logged as loaded without review;
 * with protection on, to its empty active directory with the folder's content waiting for review. Either is said on
 * standard error. A profile whose first
 * start under Changes has not run is left to that start. The command exits 0 when upstream's operation succeeded and
 * the profile is what Changes keeps, and 1 otherwise.
 *
 * Both commands register as shared users of the home's stores first and refuse while `delorun trash`, `export`,
 * `import` or an offline `delorun recover rollback` runs, or an update, a rollback or a restore of the chat data is in
 * progress ([home exclusion](./home-exclusion.ts)); an update's prepare, copy, restore and rollback, and those
 * commands, refuse while either runs. `delorun headless` writes chat data beside the home processes; `delorun plugin`
 * changes a profile that an update snapshots and a rollback restores.
 *
 * @module @delorun/cli/upstream
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runDirectory } from '@delorun/home'
import { isChangesError, prepareReload, readChangeLog, startNotice } from '@delorun/changes'
import { isCarriedPackage, runningRelease } from './changes/start.ts'
import { prepareHome, type CliCommand, type CommandContext, type CommandResult } from './command.ts'
import { CliError, EXIT, type ExitCode } from './exit.ts'
import { HEADLESS_PROFILE, refuseLauncherOptions, runHeadless, type HeadlessDependencies } from './headless.ts'
import { useHomeShared } from './home-exclusion.ts'
import { requiredModelKey, resolveModelKey } from './model-key.ts'
import { carriedOptions, checkResolved, forgetRemovedPlugins, installsPackages, pnpmCommand, profileCheckSettings, recordAfterInstall, registryUrls, resolveOnly, runMirror, takeAllowedAdvisories, withProfile, type ProfileCheckSettings } from './plugin-install-check.ts'
import { readProfileRegistry } from '@deepseek-ai/dsh-plugin-manager/operations'
import { ensureCopyImport } from './pnpm-import.ts'
import { hasCliProfile, profileDirectory, selectCommandProfile } from './profile.ts'
import { runUpstreamProfile, upstreamDependencies } from './start.ts'
import { shippedPackageManager } from './package-manager.ts'
import { withBrandedStderr } from './upstream-output.ts'
import { runPluginCheck } from './plugin-check.ts'
import { realDevDependencies, runPluginDev } from './plugin-dev.ts'
import { runPluginNew } from './plugin-new/index.ts'
import { capturesOutput, capturingPackageManager, decideBuilds, takeAllowBuild, takeCapture, terminalConfirm, type ConfirmBuild } from './plugin-builds.ts'
import { printable } from './terminal-text.ts'

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
   * The install check's settings for a profile, from its composed `delorun-plugin-install-check` row.
   * @param home - the Delorun home.
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
  /** Asks the person whether to allow one build pnpm refused; when the field is absent, the terminal's, none without one. */
  readonly confirmBuild?: ConfirmBuild | undefined
}

/** What upstream's plugin command takes for one step of an installation split into resolution and installation. */
export interface UpstreamOperation {
  /** `false` for the resolution, which installs nothing a bundle could be activated from. */
  readonly activateNewBundles?: boolean
  /** For the installation: the profile's `package.json` and lockfile text from before the resolution. */
  readonly baseline?: { readonly manifest: string | undefined, readonly lockfile: string | undefined }
  /** The file that keeps pnpm's output ([plugin builds](./plugin-builds.ts)); pnpm owns the terminal without it. */
  readonly capture?: string
}

/**
 * Run upstream's `dsh plugin` package operation in this process: its parser, which ends the process for `--help` and a
 * wrong command line as `dsh` does, then its plugin command.
 * @param argv - the arguments `dsh` would receive, `plugin` first.
 * @param operation - as {@link PluginDependencies.runUpstream} takes it.
 * @returns pnpm's exit code.
 */
async function runUpstreamPlugin(argv: readonly string[], operation?: UpstreamOperation): Promise<number> {
  // Loaded after the launch variables are set, so upstream resolves the Delorun home.
  const { getDshRuntimeVersion } = await import('@deepseek-ai/dsh-app-boot')
  const { parseDshArgs } = await import('@deepseek-ai/dsh/lib/args.js')
  const { runPlugin } = await import('@deepseek-ai/dsh/lib/plugin.js')
  const invocation = parseDshArgs(argv, getDshRuntimeVersion())
  if (invocation.mode !== 'plugin') throw new Error(`delorun plugin: upstream read ${JSON.stringify(argv)} as a ${invocation.mode} command`)
  const { capture, ...upstreamOperation } = operation ?? {}
  const shipped = shippedPackageManager()
  return withBrandedStderr(() => runPlugin(invocation.profile, invocation.args, capture === undefined ? shipped : capturingPackageManager(shipped, capture), operation === undefined ? undefined : upstreamOperation))
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

/** The words pnpm's list command answers to; pnpm prints nothing for a profile with no plugins. */
const LIST_COMMANDS = new Set(['list', 'ls', 'la', 'll'])

/**
 * Whether a profile has no plugin in its `package.json`, the state in which pnpm's list prints nothing; a profile with no
 * manifest has none either.
 * @param profileDir - the profile directory.
 * @returns true when the manifest is missing or lists no dependency.
 */
function hasNoPlugins(profileDir: string): boolean {
  const manifest = join(profileDir, 'package.json')
  if (!existsSync(manifest)) return true
  const { dependencies = {} } = JSON.parse(readFileSync(manifest, 'utf8')) as { readonly dependencies?: Readonly<Record<string, string>> }
  return Object.keys(dependencies).length === 0
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
 * Put the profile files back as they were before the resolution of an operation that was refused or did not install.
 * @param profileDir - the profile directory.
 * @param before - each file's text before the resolution, `undefined` for a file that did not exist.
 */
function restoreProfileFiles(profileDir: string, before: ReadonlyMap<string, string | undefined>): void {
  for (const [file, text] of before) {
    if (text === undefined) rmSync(join(profileDir, file), { force: true })
    else writeFileSync(join(profileDir, file), text)
  }
}

/**
 * Run one upstream step. When the step's output is kept ([plugin builds](./plugin-builds.ts)), the file is read back and
 * removed, also when upstream throws.
 * @param dependencies - upstream's plugin command.
 * @param argv - the arguments `dsh` would receive.
 * @param operation - the step's options.
 * @param capture - the file that keeps pnpm's output; none to leave pnpm the terminal.
 * @returns pnpm's exit code and the output kept, empty without a file.
 */
async function runStep(dependencies: PluginDependencies, argv: readonly string[], operation: UpstreamOperation | undefined, capture: string | undefined): Promise<{ readonly code: number, readonly output: string }> {
  if (capture === undefined) return { code: await dependencies.runUpstream(argv, operation), output: '' }
  let code: number
  try {
    code = await dependencies.runUpstream(argv, { ...operation, capture })
  } catch (error) {
    await takeCapture(capture)
    throw error
  }
  return { code, output: await takeCapture(capture) }
}

/**
 * Record the builds pnpm refused and allow the ones the person allows.
 * @param profileDir - the profile directory.
 * @param output - pnpm's output of the failed step.
 * @param allowed - the names `--allow-build` gave.
 * @param confirm - the confirmation, or `undefined` without a terminal.
 * @param context - the environment and output.
 * @returns the decision: both lists empty when pnpm refused no build.
 * @throws {CliError} when the profile's `pnpm-workspace.yaml` cannot record the decision.
 */
async function decideRefusedBuilds(profileDir: string, output: string, allowed: readonly string[], confirm: ConfirmBuild | undefined, context: CommandContext): ReturnType<typeof decideBuilds> {
  try {
    return await decideBuilds({ profileDir, output, allowed, confirm, stderr: context.stderr })
  } catch (error) {
    throw new CliError(EXIT.failed, `delorun plugin: pnpm refused a build, and the build decision cannot be recorded in ${join(profileDir, 'pnpm-workspace.yaml')}: ${printable(error instanceof Error ? error.message : String(error))}; correct its allowBuilds mapping and run the command again`)
  }
}

/**
 * After upstream's plugin operation, move the profile's links to folders to their active directories, as the running
 * Host's check before a reload does, and say what waits for review.
 * @param home - the Delorun home.
 * @param profile - the profile the operation changed.
 * @param context - the command's output.
 * @returns whether the profile is what Changes keeps.
 */
async function keepPluginChanges(home: string, profile: string, context: Pick<CommandContext, 'stderr'>): Promise<boolean> {
  if (!hasCliProfile(home, profile)) return true
  try {
    if ((await readChangeLog(home, profile)).migratedAt === undefined) return true
    context.stderr(startNotice(await prepareReload({ home, profile, profileDir: profileDirectory(home, profile), harnessLink: isCarriedPackage, ...runningRelease() })))
    return true
  } catch (error) {
    context.stderr(`delorun: ${isChangesError(error) ? error.detail : String(error)}\n`)
    return false
  }
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
 * names, or a check that cannot run, puts the profile's `package.json` and lockfile back as they were, before anything was
 * fetched into the profile or any script ran, and fails the command.
 *
 * When pnpm refuses a package's build, `delorun plugin` keeps pnpm's output, records the refusal, and allows the build
 * only when the person confirms it or `--allow-build <name>` names the package ([plugin builds](./plugin-builds.ts)).
 * With the check on, only the installation step is kept and run again, installing the same checked lockfile; the
 * resolution and the check never run twice, and a lockfile that differs from the checked one is refused and the profile
 * put back. With the check off the whole operation runs again.
 * @param args - the arguments after `plugin`.
 * @param context - the environment and output.
 * @param dependencies - upstream's plugin command and profile boot, and the exit hook; the real ones by default.
 * @returns pnpm's exit code as the command's, or {@link EXIT.failed} for a refused installation.
 * @throws {CliError} while an exclusive user runs or an update, a rollback or a restore is in progress, or for a wrong
 *   `--allow-advisory` or `--allow-build`; upstream's command line has not run then. Also when pnpm refused a build
 *   and the profile's `pnpm-workspace.yaml` cannot record the decision.
 */
export async function plugin(args: readonly string[], context: CommandContext, dependencies: PluginDependencies = UPSTREAM_PLUGIN): Promise<number> {
  const { args: withoutBuilds, allowed: allowedBuilds } = takeAllowBuild(args)
  // Upstream's parser reads `--profile` under its own, looser rule, so every value it could read is held to C1's first.
  const profile = selectCommandProfile('plugin', withoutBuilds, context.env)
  const taken = takeAllowedAdvisories(withoutBuilds)
  const { home } = await prepareHome(context, undefined, true)
  const release = await useHomeShared(home.path, 'plugin')
  dependencies.onExit(release)
  try {
    const code = await operatePlugin(home.path, profile, taken, allowedBuilds, context, dependencies)
    const kept = await keepPluginChanges(home.path, profile, context)
    return code === EXIT.ok && !kept ? EXIT.failed : code
  } finally {
    release()
  }
}

/**
 * Run upstream's plugin operation with the install check and the build decisions around it.
 * @param home - the Delorun home.
 * @param profile - the selected profile.
 * @param taken - the arguments after `plugin`, without and with the `--allow-advisory` values.
 * @param allowedBuilds - the package names `--allow-build` named.
 * @param context - the environment and output.
 * @param dependencies - upstream's plugin command and profile boot.
 * @returns pnpm's exit code, or {@link EXIT.failed} for a refused installation.
 */
async function operatePlugin(home: string, profile: string, taken: ReturnType<typeof takeAllowedAdvisories>, allowedBuilds: readonly string[], context: CommandContext, dependencies: PluginDependencies): Promise<number> {
  const { allowed, rest } = taken
  const profileDir = profileDirectory(home, profile)
  await ensureCopyImport(profileDir)
  const confirm = 'confirmBuild' in dependencies ? dependencies.confirmBuild : terminalConfirm()
  const capture = capturesOutput(rest) ? join(runDirectory(home, profile), `plugin-output-${String(process.pid)}.log`) : undefined
  if (capture !== undefined) mkdirSync(runDirectory(home, profile), { recursive: true })
  const check = await dependencies.checkSettings(home, profileDir)
  if (check === undefined || !installsPackages(rest)) {
    const decided = new Set<string>()
    for (;;) {
      const { code, output } = await runStep(dependencies, ['plugin', ...withProfile(rest, profile)], undefined, capture)
      if (code === 0) {
        if (check !== undefined) await forgetRemovedPlugins(profileDir, context)
        if (LIST_COMMANDS.has(pnpmCommand(rest) ?? '') && hasNoPlugins(profileDir)) context.stdout(`No plugins added to the profile ${profile}.\n`)
        return code
      }
      if (capture === undefined) return code
      const decision = await decideRefusedBuilds(profileDir, output, allowedBuilds, confirm, context)
      if (decision.allowed.length === 0 && decision.undecided.length === 0) return code
      const fresh = decision.allowed.filter(key => !decided.has(key))
      if (fresh.length === 0 || decision.undecided.length > 0) return EXIT.failed
      for (const key of fresh) decided.add(key)
      context.stderr(`delorun plugin: running the operation again with the build of ${fresh.map(key => printable(key)).join(', ')} allowed.\n`)
    }
  }
  // The registry is read before the resolution, so between the resolution and the installation only the check runs,
  // and it refuses on any error.
  const urls = registryUrls(rest)
  const own = urls.length > 0 ? null : await dependencies.profileRegistry(profileDir)
  const before = readRestoredFiles(profileDir)
  const resolved = await dependencies.runUpstream(['plugin', ...resolveOnly(withProfile(rest, profile))], { activateNewBundles: false })
  if (resolved !== 0) return resolved
  const outcome = await checkResolved({ profileDir, check, allowedAdvisories: allowed, registries: [...urls, ...own === null ? [] : [own]], output: context })
  if (outcome.refused.length > 0 || outcome.checkFailed) {
    restoreProfileFiles(profileDir, before)
    context.stderr(`delorun plugin: the profile ${profile} is back as it was before this command; nothing was installed into it and no install script ran\n`)
    return EXIT.failed
  }
  // A person who asked for the lockfile only gets it checked, and nothing installed.
  if (rest.includes('--lockfile-only')) return EXIT.ok
  // Upstream compares, restores, and activates bundles against the profile as it was before the resolution.
  const baseline = { manifest: before.get('package.json'), lockfile: before.get('pnpm-lock.yaml') }
  const checkedLockfile = readRestoredFiles(profileDir).get('pnpm-lock.yaml')
  const installation = ['plugin', '--profile', profile, 'install', '--frozen-lockfile', ...carriedOptions(rest)]
  const lockfileChanged = (): boolean => readRestoredFiles(profileDir).get('pnpm-lock.yaml') !== checkedLockfile
  let installed: number
  try {
    const decided = new Set<string>()
    let run = await runStep(dependencies, installation, { baseline }, capture)
    for (;;) {
      installed = run.code
      if (run.code === 0 || capture === undefined) break
      const decision = await decideRefusedBuilds(profileDir, run.output, allowedBuilds, confirm, context)
      const fresh = decision.allowed.filter(key => !decided.has(key))
      if (fresh.length === 0 || decision.undecided.length > 0) break
      for (const key of fresh) decided.add(key)
      if (lockfileChanged()) break
      context.stderr(`delorun plugin: installing the checked lockfile again with the build of ${fresh.map(key => printable(key)).join(', ')} allowed.\n`)
      run = await runStep(dependencies, installation, { baseline }, capture)
    }
    if (decided.size > 0 && lockfileChanged()) {
      restoreProfileFiles(profileDir, before)
      context.stderr(`delorun plugin: the lockfile of the profile ${profile} differs from the one the install check read, so the command was refused and the profile is back as it was before it\n`)
      return EXIT.failed
    }
  } catch (error) {
    // A failed installation must not leave the resolved plugin in package.json and the lockfile, unrecorded.
    restoreProfileFiles(profileDir, before)
    throw error
  }
  if (installed !== 0) {
    restoreProfileFiles(profileDir, before)
    context.stderr(`delorun plugin: the installation failed, so the profile ${profile} is back as it was before this command\n`)
    return installed
  }
  await recordAfterInstall(profileDir, outcome.pending, check.settings.maxFiles, context)
  return EXIT.ok
}

/**
 * Run `delorun plugin mirror on|off` for the selected profile.
 * @param args - the arguments after `mirror`.
 * @param context - the environment and output.
 * @param dependencies - the installation anchor's source.
 * @returns {@link EXIT.ok}.
 * @throws {CliError} for a wrong command line, or a profile without Delorun's install check row.
 */
export async function pluginMirror(args: readonly string[], context: CommandContext, dependencies: Pick<PluginDependencies, 'installAnchor'> = UPSTREAM_PLUGIN): Promise<ExitCode> {
  const profile = selectCommandProfile('plugin mirror', args, context.env)
  const { home } = await prepareHome(context, undefined, true)
  return runMirror(args, { home: home.path, profile, profileDir: profileDirectory(home.path, profile), installAnchor: await dependencies.installAnchor(), output: context })
}

/** The usage line of `delorun plugin`, shown when it is run without arguments. */
const PLUGIN_USAGE = 'Usage: delorun plugin [--profile <name>] <list | add <package> | remove <package> | update>\n       delorun plugin check <directory> [--json]\n       delorun plugin mirror on|off'

/**
 * `delorun plugin --profile <name> <pnpm-args…>`: upstream's plugin management, then Changes' check of the profile;
 * `delorun plugin check <directory>` is Delorun's own ([plugin check](./plugin-check.ts)), which needs no profile; `new <name>` and
 * `dev <folder>` are Delorun's own too and handle their options themselves.
 */
export const pluginCommand: CliCommand = {
  name: 'plugin',
  summary: 'Manage a profile\'s plugins, as dsh plugin does; check, new and dev help you write one; mirror on|off',
  run: async (args, context) => {
    if (args.length === 0) throw new CliError(EXIT.usage, `delorun plugin: name what to do.\n${PLUGIN_USAGE}`)
    if (args[0] === 'check') return runPluginCheck(args.slice(1), context)
    if (args[0] === 'new') return runPluginNew(args.slice(1), context)
    if (args[0] === 'dev') return runPluginDev(args.slice(1), context, realDevDependencies(context, plugin))
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
    releasePacks: upstream.releasePacks,
    preStartSteps: upstream.preStartSteps,
    cwd: () => process.cwd(),
    missingModelKey: async ({ home, env, output }) => {
      const required = requiredModelKey(home, HEADLESS_PROFILE, 'delorun headless')
      return required !== undefined && await resolveModelKey({ ...output, env }, home, required.variable) === undefined ? required : undefined
    },
    runProfile: options => runUpstreamProfile(options, { signals: true, failLoud: false }),
    loadEnvironment: upstream.loadEnvironment,
    fatalRelease: upstream.fatalRelease,
  }
}

/**
 * Run `delorun headless`: refuse upstream's launcher options, register as a shared user of the chat data, and boot the
 * headless profile through Delorun's composition.
 * @param args - the arguments after `headless`.
 * @param context - the environment and output.
 * @param dependencies - the headless run's dependencies; upstream's by default.
 * @param onExit - registers the shared registration's release for this process's exit.
 * @returns `undefined`: upstream's profile runner sets the exit code.
 */
export async function headless(args: readonly string[], context: CommandContext, dependencies: HeadlessDependencies = headlessDependencies(), onExit: (listener: () => void) => void = (listener) => { process.once('exit', listener) }): Promise<CommandResult> {
  refuseLauncherOptions(args)
  const { home } = await prepareHome(context, undefined, true)
  onExit(await useHomeShared(home.path, 'headless'))
  return runHeadless({ home: home.path, args, output: context, env: context.env }, dependencies)
}

/** `delorun headless <task>`: upstream's one-task headless profile, composed as every Delorun Host is. */
export const headlessCommand: CliCommand = {
  name: 'headless',
  summary: 'Answer one task and exit, as dsh headless does, under Delorun\'s protections',
  run: (args, context) => headless(args, context),
}
