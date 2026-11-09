/**
 * The launch flow: start the installed runtime, or install the release the channel names and then start it. A start
 * needs no network and runs contract C2's start check inside the store first, so a runtime that no longer matches its
 * signed file list does not start. An install runs contract C1's download rule, contract C2's client verification and
 * contract C18's online check through `@delo/install`, and leaves nothing under `~/.delo/runtimes/` when any of them
 * refuses. A launcher never switches `current`: the store's install sets it only when the store has no runtime at all.
 *
 * @module @delo/npm-launcher/launcher
 */
import { join } from 'node:path'
import { DELO_HOME_ENTRIES, DELO_PROFILE_ENV, TRUST_FILES, type RuntimeVersion } from '@delo/contract-home-layout'
import type { RootMetadata, RuntimePlatform } from '@delo/contract-release-manifest'
import type { VerificationMode } from '@delo/contract-verification-checks'
import { messageOf, readStoredRootBytes, trustFile, verifyStoredRoot } from '@delo/install'
import type { DeloLogger } from '@delo/logs'
import { RuntimeStoreError, SUPPORTED, type ChannelRelease, type InstallRequest, type LaunchCommand, type LaunchPlan, type LaunchRequest, type RetentionResult, type RuntimeChannel, type VerifiedRuntime } from '@delo/runtime-store'
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
  /** The root files this launcher ships, oldest first: the only roots a start trusts. */
  readonly roots: readonly Uint8Array[]
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
 * @throws when a start, install or a named release refuses, for {@link runLauncher} to print.
 */
async function startOrInstall(options: LauncherOptions): Promise<number> {
  let plan: LaunchPlan | undefined
  try {
    plan = await prepare(options)
  } catch (error) {
    if (!(error instanceof RuntimeStoreError && error.code === 'NO_ACTIVE_RUNTIME')) throw error
  }
  if (plan === undefined) {
    await install(options)
    return options.spawn(await prepare(options))
  }
  // A release named with `--release` is installed, and this launcher installs one only when the store holds no
  // runtime: it never replaces the runtime a person already has. Starting the installed runtime instead would
  // silently drop what was asked for, so the run stops and names both versions.
  if (options.target !== undefined) throw installedRefusal(options, plan.version)
  return options.spawn(plan)
}

/**
 * Run contract C2's start check through the store and build the command it names, writing nothing.
 * @param options - the launch's inputs.
 * @returns the command that starts `current`.
 * @throws {RuntimeStoreError} `NO_ACTIVE_RUNTIME`, `RUNTIME_CHANGED`, `RUNTIME_INCOMPATIBLE`, `STORE_BUSY`.
 */
async function prepare(options: LauncherOptions): Promise<LaunchPlan> {
  const root = await storedRoot(options.home, options.roots)
  return options.store.prepareLaunch({ launcher: SUPPORTED, root, mode: options.mode, profile: options.profile, args: options.args })
}

/**
 * The refusal for a `--release` a store with an installed runtime never installs: it names the release that was
 * asked for and the runtime that is installed, and offers the runtime's own update instead.
 * @param options - the launch's inputs, whose `target` is defined.
 * @param installed - the version `current` names.
 * @returns the refusal.
 */
function installedRefusal(options: LauncherOptions, installed: RuntimeVersion): RuntimeStoreError {
  const target = String(options.target)
  return new RuntimeStoreError(
    'RUNTIME_INCOMPATIBLE',
    join(options.home, DELO_HOME_ENTRIES.runtimes),
    `--release ${target} asks for release ${target}, and runtime ${String(installed)} is already installed; this launcher installs a release only when this home holds no runtime, so it installed nothing and started nothing`,
    ['update'],
  )
}

/**
 * Read `trust/root.json`, the root this home last verified, and trust it by the roots the launcher ships: the
 * start check anchors on it, so a root an install did not verify may not reach the store. A home with no stored root
 * is a store without a runtime, because nothing on it was verified yet.
 * @param home - the resolved Delo home.
 * @param shipped - the root files this launcher ships, oldest first.
 * @returns the stored root's metadata.
 * @throws {RuntimeStoreError} `NO_ACTIVE_RUNTIME` when no trusted root is stored or it does not read; `RUNTIME_CHANGED`
 *   when the stored root is not one this launcher trusts.
 */
async function storedRoot(home: string, shipped: readonly Uint8Array[]): Promise<RootMetadata> {
  const path = trustFile(home, TRUST_FILES.root)
  let stored: Uint8Array | undefined
  try {
    stored = await readStoredRootBytes(home)
  } catch (error) {
    throw new RuntimeStoreError('NO_ACTIVE_RUNTIME', path, `no trusted release root is stored beside this home (${messageOf(error)}), so no installed runtime can be checked`, ['reinstall'], { cause: error })
  }
  if (stored === undefined) {
    throw new RuntimeStoreError('NO_ACTIVE_RUNTIME', path, `no trusted release root is stored beside this home (${path} holds none), so no installed runtime can be checked`, ['reinstall'])
  }
  try {
    return verifyStoredRoot({ stored, shipped, source: path }).metadata
  } catch (error) {
    throw new RuntimeStoreError('RUNTIME_CHANGED', path, `the root stored at ${path} is not one this launcher trusts, so the runtime installed beside it cannot be checked: ${messageOf(error)}`, ['reinstall'], { cause: error })
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

/** A profile name: what the launcher resolves to one directory under the home's profiles, and what a shell passes safely. */
export const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/u

/**
 * The profile a launch runs, from the option or `DELO_PROFILE`, refusing the desktop app's own profile and any name
 * that is not one (contract C1). The name becomes a directory under the home's `profiles/`, so a name with a path
 * segment would leave the home and reach the runtime as its profile.
 * @param named - the `--profile` value, when one was given.
 * @param env - the environment.
 * @returns the profile's name.
 * @throws {Error} when the profile is `desktop`, or is not a profile name.
 */
export function launcherProfile(named: string | undefined, env: NodeJS.ProcessEnv): string {
  const profile = named ?? (env[DELO_PROFILE_ENV] === undefined || env[DELO_PROFILE_ENV].trim() === '' ? 'default' : env[DELO_PROFILE_ENV].trim())
  if (profile === 'desktop') throw new Error('the profile desktop belongs to the Delo desktop app, which builds it itself')
  if (!PROFILE_NAME.test(profile)) {
    throw new Error(`the profile ${JSON.stringify(profile)} is not a profile name: a profile is 1 to 32 lowercase letters, digits, hyphens or underscores, starting with a letter or digit`)
  }
  return profile
}
