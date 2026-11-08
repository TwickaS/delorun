/**
 * The launch flow: start the installed runtime, or install the release the channel names and then start it. A start
 * needs no network and runs contract C2's start check inside the store first, so a runtime that no longer matches its
 * signed file list does not start. An install runs contract C1's download rule, contract C2's client verification and
 * contract C18's online check through `@delo/install`, and leaves nothing under `~/.delo/runtimes/` when any of them
 * refuses. A launcher never switches `current`: the store's install sets it only when the store has no runtime at all.
 *
 * @module @delo/npm-launcher/launcher
 */
import { DELO_PROFILE_ENV, TRUST_FILES, type RuntimeVersion } from '@delo/contract-home-layout'
import type { RuntimePlatform } from '@delo/contract-release-manifest'
import type { VerificationMode } from '@delo/contract-verification-checks'
import { messageOf, trustFile } from '@delo/install'
import type { DeloLogger } from '@delo/logs'
import { readStoredRoot, RuntimeStoreError, SUPPORTED, type ChannelRelease, type InstallRequest, type LaunchCommand, type LaunchPlan, type LaunchRequest, type RetentionResult, type RuntimeChannel, type VerifiedRuntime } from '@delo/runtime-store'
import { refusalFor, type RemedyContext } from './refusals.ts'

/** The runtime-store operations the launcher drives; `RuntimeStore` satisfies it. */
export interface LauncherStore {
  /**
   * Run contract C2's start check on `current` and build its launch command.
   * @param request - the launcher's support, the trusted root, the mode, the profile and the arguments.
   * @returns the command that starts `current`.
   * @throws {RuntimeStoreError} `NO_ACTIVE_RUNTIME` when the store holds no usable runtime; `RUNTIME_CHANGED` or
   *   `RUNTIME_INCOMPATIBLE` when the runtime may not start.
   */
  prepareLaunch(request: LaunchRequest): Promise<LaunchPlan>

  /**
   * Install a verified runtime closure.
   * @param request - the version, the root and the fill step.
   * @returns the installed, verified runtime.
   * @throws {RuntimeStoreError} `INSTALL_VERIFY_FAILED`, `RUNTIME_INCOMPATIBLE` or `STORE_BUSY`.
   */
  install(request: InstallRequest): Promise<VerifiedRuntime>

  /**
   * Keep the two versions the pointers name and remove the rest.
   * @returns what was removed and what the next run retries.
   */
  retain(): Promise<RetentionResult>
}

/** Runs an installed runtime and resolves with its exit status. */
export type SpawnRuntime = (command: LaunchCommand) => Promise<number>

/** Where the launcher writes. */
export interface LauncherOutput {
  /**
   * Write to standard output.
   * @param text - what to write.
   */
  stdout(text: string): void

  /**
   * Write to standard error.
   * @param text - what to write.
   */
  stderr(text: string): void
}

/** What one launch is given. */
export interface LauncherOptions {
  /** The resolved Delo home, whose tree exists. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
  /** The platform whose runtime closure this machine installs. */
  readonly platform: RuntimePlatform
  /** The arguments for the runtime, which the launcher does not interpret. */
  readonly args: readonly string[]
  /** The person's verification mode, which a refusal names; the start check runs in every mode. */
  readonly mode: VerificationMode
  /** The store, this home's `RuntimeStore` in a real run. */
  readonly store: LauncherStore
  /** The release channel, `@delo/install`'s `LauncherChannel` in a real run. */
  readonly channel: RuntimeChannel
  /** Where a removal the store could not finish is reported. */
  readonly logger: DeloLogger
  /** Starts the runtime. */
  readonly spawn: SpawnRuntime
  /** Where refusals are printed. */
  readonly output: LauncherOutput
  /** The release a person named, when one was named. */
  readonly target?: RuntimeVersion
}

/**
 * Start the installed runtime, or install and then start it.
 * @param options - the home, profile, platform, arguments, mode, store, channel, logger, spawn and output.
 * @returns the runtime's exit status, or `1` for a refusal the launcher printed.
 */
export async function runLauncher(options: LauncherOptions): Promise<number> {
  const context: RemedyContext = { home: options.home, profile: options.profile }
  try {
    return await startOrInstall(options)
  } catch (error) {
    const refusal = refusalFor(error, context)
    options.output.stderr(refusal.text)
    return refusal.exit
  }
}

/**
 * Start the installed runtime, and install the channel's release first when the store holds none.
 * @param options - the launch's inputs.
 * @returns the runtime's exit status.
 * @throws when a start or install step refuses, for {@link runLauncher} to print.
 */
async function startOrInstall(options: LauncherOptions): Promise<number> {
  try {
    return await start(options)
  } catch (error) {
    if (!(error instanceof RuntimeStoreError && error.code === 'NO_ACTIVE_RUNTIME')) throw error
  }
  await install(options)
  return start(options)
}

/**
 * Run contract C2's start check through the store and start the runtime it names.
 * @param options - the launch's inputs.
 * @returns the runtime's exit status.
 * @throws {RuntimeStoreError} `NO_ACTIVE_RUNTIME`, `RUNTIME_CHANGED`, `RUNTIME_INCOMPATIBLE`, `STORE_BUSY`.
 */
async function start(options: LauncherOptions): Promise<number> {
  const root = await storedRoot(options.home)
  const plan = await options.store.prepareLaunch({ launcher: SUPPORTED, root, mode: options.mode, profile: options.profile, args: options.args })
  return options.spawn(plan)
}

/**
 * Read `trust/root.json`, the root the launcher last verified, and refuse a start that has none as a store without a
 * runtime: the store's own start check needs a root, and nothing was verified on this home yet.
 * @param home - the resolved Delo home.
 * @returns the stored root's metadata.
 * @throws {RuntimeStoreError} `NO_ACTIVE_RUNTIME` when no trusted root is stored or it does not read.
 */
async function storedRoot(home: string): Promise<Awaited<ReturnType<typeof readStoredRoot>>> {
  try {
    return await readStoredRoot(home)
  } catch (error) {
    throw new RuntimeStoreError('NO_ACTIVE_RUNTIME', trustFile(home, TRUST_FILES.root), `no trusted release root is stored beside this home (${messageOf(error)}), so no installed runtime can be checked`, ['reinstall'], { cause: error })
  }
}

/**
 * Install the release the channel names, then keep the versions the pointers name.
 * @param options - the launch's inputs.
 * @throws {RuntimeStoreError} when the store refuses the install; `InstallError` when the channel or a check does.
 */
async function install(options: LauncherOptions): Promise<void> {
  const release: ChannelRelease = await options.channel.resolve(options.target)
  await options.store.install({ version: release.version, root: release.root, fill: directory => options.channel.fill(release, directory) })
  await options.store.retain().catch((error: unknown) => {
    options.logger.warn('the runtime store could not finish its retention after an install; the next run retries it', { err: error })
  })
}

/**
 * The profile a launch runs, from the option or `DELO_PROFILE`, refusing the desktop app's own profile (contract C1).
 * @param named - the `--profile` value, when one was given.
 * @param env - the environment.
 * @returns the profile's name.
 * @throws {Error} when the profile is `desktop`.
 */
export function launcherProfile(named: string | undefined, env: NodeJS.ProcessEnv): string {
  const profile = named ?? (env[DELO_PROFILE_ENV] === undefined || env[DELO_PROFILE_ENV].trim() === '' ? 'default' : env[DELO_PROFILE_ENV].trim())
  if (profile === 'desktop') throw new Error('the profile desktop belongs to the Delo desktop app, which builds it itself')
  return profile
}
