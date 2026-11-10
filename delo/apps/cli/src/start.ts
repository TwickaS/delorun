/**
 * `delorun start` and the start half of a bare `delorun` (contract C19, "Commands"): the home process of
 * [`@delo/home-process`](../../../packages/home-process/README.md) for the CLI profile, whose Host is the profile
 * booted through upstream's profile runner in the same process.
 *
 * - `delorun start --foreground` runs the home process in this terminal: it takes the profile's home lock, writes a
 *   new start token, listens on the update channel and boots the profile, logging to the `home-<profile>` surface
 *   while the terminal also shows its output.
 * - `delorun start` starts the same command detached from the terminal, with standard input closed and its output
 *   in its log, and waits at most 120 seconds for the update channel to report `running`.
 *
 * A second start for a profile whose home process answers prints that process and exits 0. A profile that skipped a
 * Delo bundle is refused before it boots, and one in which a row of a Delo bundle did not activate is shut down and
 * refused after it boots ([delo-bundles](./delo-bundles.ts)).
 *
 * @module @delo/cli/start
 */
import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { brandString } from '@deepseek-ai/dsh-brand'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedProfileRuntime, RunProfileOptions } from '@deepseek-ai/dsh/profile-boot'
import { HOME_STATUS_TIMEOUT_MS, type RuntimeVersion } from '@delo/contract-home-layout'
import { START_WAIT_MS } from '@delo/contract-home-process'
import { CountingChatGate, HomeProcess, openHomeLog, captureHomeOutput, queryHomeStatus, updateChannelProbe, type HomeLog, type RunningHost } from '@delo/home-process'
import { resolveSurface } from '@delo/logs'
import { CliError, EXIT } from './exit.ts'
import { parseOptions, prepareHome, type CliCommand, type CommandOutput, type CommandResult } from './command.ts'
import { HomeLayoutError, newStartId, readHomeLock, runDirectory, type HolderProbe } from '@delo/home'
import { deloRowIds, inactiveDeloRows, inactiveRowsRefusal, refuseSkippedDeloBundles, type BootedRow, type RowState } from './delo-bundles.ts'
import { hasCliProfile, profileDirectory } from './profile.ts'
import { readBackgroundAnswer } from './setup/background.ts'
import { safeModeNotice, safeModeStart } from './safe-mode.ts'
import { removeSandboxOverlay, sandboxOverlayPath, sandboxProtection, writeSandboxOverlay } from './sandbox-protection.ts'

/** What the foreground start calls outside this module; specs replace them. */
export interface StartDependencies {
  /** Loads the profile and reports its skipped bundles as upstream's boot does; upstream's `prepareProfile` by default. */
  readonly prepareProfile: (profile: string) => Promise<ResolvedProfileRuntime>
  /** Boots the profile; upstream's `runProfile` by default, with its rows and its shutdown. */
  readonly runProfile: (options: RunProfileOptions) => Promise<BootedProfile>
  /** Loads the launch environment with upstream's `.env` layers; upstream's `loadLayeredEnv` by default. */
  readonly loadEnvironment: () => RunProfileOptions['environment']
  /** Asks a live lock holder for its status; the update channel's `status` request by default. */
  readonly probe: (home: string, profile: string) => HolderProbe
  /** Registers a listener for this process's exit. */
  readonly onExit: (listener: () => void) => void
  /** Ends the process after a stop or a handover. */
  readonly exit: (code: number) => void
  /**
   * Captures this process's output into the home log, also passing it to the terminal.
   * @returns the disposer that restores both streams.
   */
  readonly captureOutput: (log: HomeLog) => () => void
}

/** A booted profile, as the start's audit of Delo's rows reads it. */
export interface BootedProfile {
  /** The Loader's rows after startup settled; empty when the tree was already disposed. */
  readonly rows: () => readonly BootedRow[]
  /**
   * Dispose the application and let the process end with this code.
   * @param code - the exit code.
   * @returns when disposal finished.
   */
  readonly shutdown: (code: number) => Promise<void>
}

/** Loader fiber states, mirrored as upstream's startup audit mirrors them because Cordis's enum is `const`. */
const FIBER_PENDING = 0
const FIBER_ACTIVE = 2
const FIBER_DISPOSED = 4

/**
 * Read the Loader's rows from a booted root context, as upstream's startup audit reads them.
 * @param ctx - the root context `runProfile` returned.
 * @returns each row's id, module, disabled flag and startup state.
 */
export function bootedRows(ctx: Context): BootedRow[] {
  const loader = ctx.get('loader')
  if (loader === undefined) return []
  return [...loader.entries()].map((entry): BootedRow => {
    let disabled: boolean
    try {
      disabled = Boolean(entry.disabled)
    } catch {
      // A `disabled` expression that throws leaves the row unmounted; upstream's audit reports it as failed.
      return { id: entry.options.id, name: entry.options.name, disabled: false, state: 'failed' }
    }
    const fiber = entry.fiber
    const state: RowState = fiber === undefined || fiber.state === FIBER_DISPOSED
      ? 'not-imported'
      : fiber.state === FIBER_ACTIVE ? 'active' : fiber.state === FIBER_PENDING ? 'pending' : 'failed'
    return { id: entry.options.id, name: entry.options.name, disabled, state }
  })
}

/** What a foreground start runs. */
export interface StartRequest {
  /** The prepared Delo home. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
  /** Whether the studio opens in the browser once the profile has booted. */
  readonly open: boolean
  /** Where the start writes. */
  readonly output: CommandOutput
}

/** The level of the home process's log. */
const HOME_LOG_LEVEL = 'info'

/**
 * The runtime version recorded in the lock: this package's version, until the runtime store names the running version.
 * @returns the version.
 */
function runningVersion(): RuntimeVersion {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  return brandString<RuntimeVersion>(manifest.version)
}

/**
 * The dependencies of a real start.
 * @returns upstream's profile preparation, profile runner and `.env` loader, the update channel's probe, the process's
 *   exit event and exit, and the output capture.
 */
export function upstreamDependencies(): StartDependencies {
  return {
    async prepareProfile(profile) {
      // Loaded after the launch variables are set, so upstream resolves the Delo home.
      const { INSTALL_ANCHOR, prepareProfile } = await import('@deepseek-ai/dsh/profile-boot')
      return { profile: prepareProfile(profile), installAnchor: INSTALL_ANCHOR }
    },
    async runProfile(options) {
      // Loaded after the launch variables are set, so upstream resolves the Delo home.
      const { runProfile } = await import('@deepseek-ai/dsh/profile-boot')
      const { ctx, shutdown } = await runProfile(options)
      return { rows: () => bootedRows(ctx), shutdown: code => shutdown.shutdown(code) }
    },
    loadEnvironment: () => loadLayeredEnv('delorun'),
    probe: updateChannelProbe,
    onExit(listener) {
      process.on('exit', listener)
    },
    exit: (code) => { process.exit(code) },
    captureOutput: log => captureHomeOutput(log.log, true),
  }
}

/**
 * Run the home process for the CLI profile in this process: take the home lock, write a new start token, listen on
 * the update channel, and load and boot the profile as its Host. A profile that skipped a Delo bundle is refused
 * before it boots; one in which a row of a Delo bundle did not activate is shut down after its startup settles and
 * refused, which can come after the studio has opened in the browser. On success the profile's plugins keep the
 * process alive, and the lock, the token and the socket go when it exits; a refusal or a failed boot removes them
 * at once.
 * @param request - the home, profile, studio choice and output.
 * @param dependencies - the profile preparation and runner, environment loader, holder probe, exit hooks and output
 *   capture.
 * @returns `undefined` once the profile has booted: upstream's profile runner sets the exit code when the process ends;
 *   {@link EXIT.ok} when a home process for the profile already runs.
 * @throws {CliError} when the home has no CLI profile, the profile skipped a Delo bundle, a row of a Delo bundle did not
 *   activate, or the profile fails to boot.
 * @throws {HomeLayoutError} `HOME_UNRESPONSIVE` when the lock's holder lives but does not answer.
 */
export async function startForeground(request: StartRequest, dependencies: StartDependencies = upstreamDependencies()): Promise<CommandResult> {
  if (!hasCliProfile(request.home, request.profile)) {
    throw new CliError(EXIT.failed, `delorun: the CLI profile ${request.profile} is not set up in ${request.home}; run: delorun setup`)
  }
  const startId = newStartId()
  const homeLog = openHomeLog({ home: request.home, profile: request.profile, startId, level: HOME_LOG_LEVEL, onFailure: () => {} })
  const restoreOutput = dependencies.captureOutput(homeLog)
  const closeLog = (): void => {
    restoreOutput()
    homeLog.log.close()
  }
  try {
    await HomeProcess.start({
      home: request.home,
      profile: request.profile,
      running: runningVersion(),
      startId,
      host: { boot: async () => bootProfile(request, dependencies) },
      probe: dependencies.probe(request.home, request.profile),
      logger: homeLog.logger,
      redactor: homeLog.redactor,
      updates: undefined,
      supervisor: undefined,
      onExit: dependencies.onExit,
      exit: dependencies.exit,
    })
  } catch (error) {
    closeLog()
    if (!(error instanceof HomeLayoutError) || error.code !== 'HOME_RUNNING') throw error
    const holder = readHomeLock(runDirectory(request.home, request.profile))
    request.output.stdout(`Delo is already running for the profile ${request.profile}${holder === undefined ? '' : ` (process ${String(holder.pid)}, started ${holder.startedAt})`}.\n`)
    return EXIT.ok
  }
  dependencies.onExit(() => {
    closeLog()
    rmSync(sandboxOverlayPath(request.home, request.profile), { force: true })
  })
  return undefined
}

/**
 * Load the CLI profile and boot it: the home process's Host.
 * @param request - the home, profile, studio choice and output.
 * @param dependencies - the profile preparation, runner and environment loader.
 * The profile boots with C1's confinement on its sandbox row ([sandbox protection](./sandbox-protection.ts)), whose
 * overlay exists while the Host runs.
 * @returns the running Host. Its chats are not yet fed by the Host's update plugin, so they count none.
 * @throws {CliError} when the profile skipped a Delo bundle, fails to boot, or a row of a Delo bundle did not activate.
 */
async function bootProfile(request: StartRequest, dependencies: StartDependencies): Promise<RunningHost> {
  let resolvedProfile: ResolvedProfileRuntime
  try {
    resolvedProfile = await dependencies.prepareProfile(request.profile)
    refuseSkippedDeloBundles(resolvedProfile.profile)
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError(EXIT.failed, `delorun: the CLI profile ${request.profile} could not be loaded: ${error instanceof Error ? error.message : String(error)}`)
  }
  const environment = dependencies.loadEnvironment()
  const overlay = await writeSandboxOverlay(request.home, request.profile, resolvedProfile.profile.patchPath, await sandboxProtection(request.home, request.profile, process.env, homedir()))
  // Safe mode boots the same profile with its third-party layers and rows left out, and edits none of its files.
  const safe = safeModeStart({ home: request.home, profile: request.profile, resolvedProfile })
  if (safe !== undefined) {
    request.output.stdout(safeModeNotice(safe))
    resolvedProfile = safe.resolvedProfile
  }
  let booted: BootedProfile
  try {
    booted = await dependencies.runProfile({
      environment,
      profile: request.profile,
      resolvedProfile,
      patchFiles: [overlay, ...safe === undefined ? [] : safe.patchFiles],
      args: request.open ? [] : ['--no-open'],
    })
  } catch (error) {
    await removeSandboxOverlay(request.home, request.profile)
    throw new CliError(EXIT.failed, `delorun: the CLI profile ${request.profile} failed to start: ${error instanceof Error ? error.message : String(error)}`)
  }
  const inactive = inactiveDeloRows(booted.rows(), deloRowIds(resolvedProfile.profile))
  if (inactive.length > 0) {
    await booted.shutdown(EXIT.failed)
    await removeSandboxOverlay(request.home, request.profile)
    throw inactiveRowsRefusal(request.profile, inactive)
  }
  return {
    chats: new CountingChatGate(),
    disabledPlugins: () => [],
    healthy: () => Promise.resolve(true),
    close: async () => {
      await booted.shutdown(EXIT.ok)
      await removeSandboxOverlay(request.home, request.profile)
    },
  }
}

/**
 * `delorun start` without `--foreground`: start the home process detached from the terminal and wait for it to report
 * `running`.
 * @param home - the prepared Delo home.
 * @param profile - the CLI profile.
 * @param output - where the command writes.
 * @returns {@link EXIT.ok} when the home process runs, {@link EXIT.failed} when it exited or did not report `running`
 *   within 120 seconds.
 * @throws {CliError} when the home has no CLI profile.
 */
export async function startDetached(home: string, profile: string, output: CommandOutput): Promise<CommandResult> {
  if (!hasCliProfile(home, profile)) throw new CliError(EXIT.failed, `delorun: the CLI profile ${profile} is not set up in ${home}; run: delorun setup`)
  const running = await answeringStatus(home, profile)
  if (running !== undefined) {
    output.stdout(`Delo is already running for the profile ${profile} (process ${String(running.pid)}, ${running.state}).\n`)
    return EXIT.ok
  }
  const entry = process.argv[1]
  if (entry === undefined) throw new CliError(EXIT.failed, 'delorun: the command\'s own entry point is unknown, so the home process cannot be started')
  const child = spawn(process.execPath, [...process.execArgv, entry, 'start', '--foreground', '--profile', profile], { detached: true, stdio: 'ignore', env: process.env })
  let exitCode: number | null | undefined
  child.once('exit', (code) => { exitCode = code })
  child.unref()
  const log = resolveSurface({ kind: 'home', home, profile }).file
  const deadline = Date.now() + START_WAIT_MS
  while (Date.now() < deadline) {
    const status = await answeringStatus(home, profile)
    if (status?.state === 'running' && status.pid === child.pid) {
      output.stdout(`Delo is running for the profile ${profile} (process ${String(status.pid)}).\n`)
      return EXIT.ok
    }
    if (exitCode !== undefined) {
      output.stderr(`delorun start: the home process exited with code ${String(exitCode)} before it was running; see its log: ${log}\n`)
      return EXIT.failed
    }
    await sleep(100)
  }
  output.stderr(`delorun start: the home process did not report running within ${String(START_WAIT_MS / 1000)} seconds; see its log: ${log}\n`)
  return EXIT.failed
}

/**
 * The status of a profile's home process when it answers.
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @returns the status, or `undefined` when no home process answers.
 */
async function answeringStatus(home: string, profile: string): Promise<{ readonly pid: number, readonly state: string } | undefined> {
  try {
    const answer = await queryHomeStatus(home, profile, HOME_STATUS_TIMEOUT_MS)
    return 'state' in answer && typeof answer.pid === 'number' && typeof answer.state === 'string' ? { pid: answer.pid, state: answer.state } : undefined
  } catch (_notAnswering) {
    // No token file, no socket or no answer: no home process answers for the profile.
    return undefined
  }
}

/**
 * Whether `delorun start` detaches from the terminal: not when `--foreground` was given, and not when the profile's
 * setup answers say the person chose against running in the background. A missing answers record keeps the default.
 * @param foreground - whether `--foreground` was given.
 * @param profileDirectory - the CLI profile's directory.
 * @returns true when the home process starts detached.
 */
export function startsDetached(foreground: boolean, profileDirectory: string): boolean {
  return !foreground && readBackgroundAnswer(profileDirectory)
}

/** `delorun start [--foreground] [--profile <name>]`. */
export const startCommand: CliCommand = {
  name: 'start',
  summary: 'Start the home process in the background, or in this terminal with --foreground',
  async run(args, context) {
    const values = parseOptions('start', args, { foreground: { type: 'boolean', default: false }, profile: { type: 'string' } })
    const { home, profile } = await prepareHome(context, values.profile)
    if (startsDetached(values.foreground === true, profileDirectory(home.path, profile))) return startDetached(home.path, profile, context)
    return startForeground({ home: home.path, profile, open: false, output: context })
  },
}
