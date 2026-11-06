/**
 * `delorun start --foreground` and the start half of a bare `delorun`: take
 * the profile's home lock (contract C1, "The home lock") and boot the CLI
 * profile through upstream's profile runner in this process, holding the lock
 * until the process exits.
 *
 * This is the foreground home process without contract C19's update channel,
 * start token, supervisor or confinement probes. Until the update channel
 * exists, a live lock holder cannot be asked for its status and counts as
 * answering. A second start for a profile whose home process runs prints that
 * process and exits 0, as contract C19's `delorun start` does.
 *
 * @module @delo/cli/start
 */
import { readFileSync } from 'node:fs'
import { brandString } from '@deepseek-ai/dsh-brand'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import type { RunProfileOptions } from '@deepseek-ai/dsh/profile-boot'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import { CliError, EXIT } from './exit.ts'
import { parseOptions, prepareHome, type CliCommand, type CommandOutput, type CommandResult } from './command.ts'
import { acquireHomeLock, HomeLayoutError, readHomeLock, runDirectory, type HolderProbe, type HomeLock } from '@delo/home'
import { hasCliProfile } from './profile.ts'

/** What the foreground start calls outside this module; specs replace them. */
export interface StartDependencies {
  /** Boots the profile; upstream's `runProfile` by default. */
  readonly runProfile: (options: RunProfileOptions) => Promise<unknown>
  /** Loads the launch environment with upstream's `.env` layers; upstream's `loadLayeredEnv` by default. */
  readonly loadEnvironment: () => RunProfileOptions['environment']
  /** Asks a live lock holder for its status. */
  readonly probe: HolderProbe
  /** Registers a listener for this process's exit. */
  readonly onExit: (listener: () => void) => void
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

/** The probe used until the update channel exists: a live holder counts as answering. */
const assumeAnswering: HolderProbe = () => Promise.resolve('answered')

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
 * @returns upstream's profile runner and `.env` loader, the probe without an update channel, and the process's exit event.
 */
function defaultDependencies(): StartDependencies {
  return {
    async runProfile(options) {
      // Loaded after the launch variables are set, so upstream resolves the Delo home.
      const { runProfile } = await import('@deepseek-ai/dsh/profile-boot')
      return runProfile(options)
    },
    loadEnvironment: () => loadLayeredEnv('delorun'),
    probe: assumeAnswering,
    onExit(listener) {
      process.on('exit', listener)
    },
  }
}

/**
 * Take the home lock and boot the CLI profile in this process. On success the
 * profile's plugins keep the process alive and the lock is released when it
 * exits; a failed boot releases it at once.
 * @param request - the home, profile, studio choice and output.
 * @param dependencies - the profile runner, environment loader, holder probe and exit hook.
 * @returns `undefined` once the profile has booted: upstream's profile runner sets the exit code when the process ends;
 *   {@link EXIT.ok} when a home process for the profile already runs.
 * @throws {CliError} when the home has no CLI profile or the profile fails to boot.
 * @throws {HomeLayoutError} `HOME_UNRESPONSIVE` when the lock's holder lives but does not answer.
 */
export async function startForeground(request: StartRequest, dependencies: StartDependencies = defaultDependencies()): Promise<CommandResult> {
  if (!hasCliProfile(request.home, request.profile)) {
    throw new CliError(EXIT.failed, `delorun: the CLI profile ${request.profile} is not set up in ${request.home}; run: delorun setup`)
  }
  const directory = runDirectory(request.home, request.profile)
  let lock: HomeLock
  try {
    lock = await acquireHomeLock({ runDirectory: directory, runtime: runningVersion(), probe: dependencies.probe })
  } catch (error) {
    if (!(error instanceof HomeLayoutError) || error.code !== 'HOME_RUNNING') throw error
    const holder = readHomeLock(directory)
    request.output.stdout(`Delo is already running for the profile ${request.profile}${holder === undefined ? '' : ` (process ${String(holder.pid)}, started ${holder.startedAt})`}.\n`)
    return EXIT.ok
  }
  dependencies.onExit(() => { lock.release() })
  try {
    await dependencies.runProfile({
      environment: dependencies.loadEnvironment(),
      profile: request.profile,
      patchFiles: [],
      args: request.open ? [] : ['--no-open'],
    })
  } catch (error) {
    lock.release()
    throw new CliError(EXIT.failed, `delorun: the CLI profile ${request.profile} failed to start: ${error instanceof Error ? error.message : String(error)}`)
  }
  return undefined
}

/** `delorun start --foreground [--profile <name>]`. */
export const startCommand: CliCommand = {
  name: 'start',
  summary: 'Start the home process in this terminal (--foreground)',
  async run(args, context) {
    const values = parseOptions('start', args, { foreground: { type: 'boolean', default: false }, profile: { type: 'string' } })
    if (values.foreground !== true) throw new CliError(EXIT.usage, 'delorun start: this build runs the home process in the terminal only; run: delorun start --foreground')
    const { home, profile } = await prepareHome(context, values.profile)
    return startForeground({ home: home.path, profile, open: false, output: context })
  },
}
