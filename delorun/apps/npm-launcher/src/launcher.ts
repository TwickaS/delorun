/**
 * The launch flow: start the installed runtime, or install the release the channel names and then start it. A start
 * needs no network and runs contract C2's start check inside the store first, so a runtime that no longer matches its
 * signed file list does not start. An install runs contract C1's download rule, contract C2's client verification and
 * contract C18's online check through `@delorun/install`, and leaves nothing under `~/.delorun/runtimes/` when any of them
 * refuses. A launcher never switches `current`: the store's install sets it only when the store has no runtime at all.
 * When `current` fails its start check and `previous` passes it, a run that starts Delorun (see {@link mayStartPrevious})
 * starts `previous` with `delorun recover rollback`, the one way back contract C3 defines, which switches the pointers
 * only through its rollback table; every other command is refused with that command as its remedy, and runs nothing.
 *
 * @module @delorun/npm-launcher/launcher
 */
import { join } from 'node:path'
import { DELORUN_HOME_ENTRIES, DELORUN_PROFILE_ENV, DELORUN_START_CHECK_ENV, PROFILE_NAME_PATTERN, profileNameProblem, TRUST_FILES, type RuntimeVersion } from '@delorun/contract-home-layout'
import type { RootMetadata, RuntimePlatform } from '@delorun/contract-release-manifest'
import type { VerificationMode } from '@delorun/contract-verification-checks'
import { codedReason, profileOption } from '@delorun/home'
import { messageOf, readStoredRootBytes, readStoredRootChain, trustFile, verifyStoredRoot } from '@delorun/install'
import type { DelorunLogger } from '@delorun/logs'
import type { StartCheckResult } from '@delorun/release-verify/start'
import { RuntimeStoreError, START_CHECK_SCHEMA, startCheckHandoffText, SUPPORTED, type ChannelRelease, type InstallRequest, type LaunchCommand, type LaunchPlan, type LaunchRequest, type RetentionResult, type RuntimeChannel, type RuntimePointers, type StartCheckSummary, type VerifiedRuntime } from '@delorun/runtime-store'
import type { LauncherProgress } from './progress.ts'
import { checkRepairRecord, REPAIR_RECORD_FILE, staleRepairText } from './repair-record.ts'
import { LAUNCHER_EXIT, refusalFor, renderLauncherRefusal, type RemedyContext } from './refusals.ts'

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

  /**
   * Read `current` and `previous`.
   * @returns the pointers; `previous` is absent unless it names an installed version.
   * @throws {RuntimeStoreError} `NO_ACTIVE_RUNTIME` when `current` is missing, malformed or names no installed version.
   */
  pointers(): Promise<RuntimePointers>

  /**
   * Run contract C2's start check on an installed version.
   * @param version - the installed version.
   * @param root - the trusted root.
   * @returns the verified runtime.
   * @throws {RuntimeStoreError} `RUNTIME_CHANGED` when a file, the manifest or the file list does not verify.
   */
  checkRuntime(version: RuntimeVersion, root: RootMetadata): Promise<VerifiedRuntime>

  /**
   * The command that starts an installed version by launch protocol 1, without checking it.
   * @param version - the installed version.
   * @param profile - the CLI profile, which the command passes in `DELORUN_PROFILE`.
   * @param args - the arguments for `delorun`.
   * @returns the command.
   */
  launchCommand(version: RuntimeVersion, profile: string, args: readonly string[]): LaunchCommand
}

/** Runs an installed runtime and resolves with its exit status. */
export type SpawnRuntime = (command: LaunchCommand) => Promise<number>

/** The launcher as the start-check record names it, and the clock the record's time comes from. */
export interface LauncherIdentity {
  /** The launcher package's version, or `null` when its `package.json` does not read. */
  readonly version: string | null
  /** The launcher package's directory. */
  readonly path: string
  /**
   * The clock.
   * @returns milliseconds since the epoch.
   */
  readonly now: () => number
}

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
  /** The resolved Delorun home, whose tree exists. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
  /** The platform whose runtime closure this machine installs. */
  readonly platform: RuntimePlatform
  /** The arguments for the runtime, which the launcher does not interpret. */
  readonly args: readonly string[]
  /**
   * The arguments the person passed after `--`, which the launcher read no option from: they are at the end of
   * {@link LauncherOptions.args}, and a run that has any is never a start {@link mayStartPrevious} accepts.
   */
  readonly passedThrough: readonly string[]
  /** The person's verification mode, which a refusal names; the start check runs in every mode. */
  readonly mode: VerificationMode
  /** The interval of the start check's full hash in days, as `resolveFullCheckDays` resolves it. */
  readonly fullCheckDays: number
  /** The seconds a repair mark that does not parse still counts as a running repair, as `resolveRepairMarkGraceSeconds` resolves it. */
  readonly repairMarkGraceSeconds: number
  /** The store, this home's `RuntimeStore` in a real run. */
  readonly store: LauncherStore
  /**
   * The release channel, `@delorun/install`'s `LauncherChannel` in a real run. A channel that has `recordInstalled` is told
   * of each release the store installed, so it records the release's log check only for a release that landed.
   */
  readonly channel: RuntimeChannel & { readonly recordInstalled?: (release: ChannelRelease) => Promise<void> }
  /** The root files this launcher ships, oldest first: the only roots a start trusts. */
  readonly roots: readonly Uint8Array[]
  /** Where a removal the store could not finish is reported. */
  readonly logger: DelorunLogger
  /** Starts the runtime. */
  readonly spawn: SpawnRuntime
  /** Where refusals are printed. */
  readonly output: LauncherOutput
  /** The release a person named, when one was named. */
  readonly target?: RuntimeVersion
  /** Told of the steps the launcher itself reports, `installing`, `installed`, `starting` and `failed`; the channel reports the others. Nothing by default. */
  readonly report?: (event: LauncherProgress) => void
  /**
   * Contract C18's start check of the installed runtime's release: its stored release-log bundle offline and, with a
   * network, the online check, with the state recorded. A start of a runtime the launcher just installed runs none,
   * because the install checked the release. No check runs when this is absent.
   */
  readonly startCheck?: (version: RuntimeVersion, root: RootMetadata) => Promise<LauncherStartCheck>
  /**
   * The launcher that hands the runtime the record of its start check in `DELORUN_START_CHECK`, which the runtime reports
   * without hashing again, and the clock the record's time comes from.
   */
  readonly identity: LauncherIdentity
}

/**
 * The result of {@link LauncherOptions.startCheck}: contract C18's start check, and the bundle's path when the release
 * has no stored bundle, which every install through the store keeps, so the refusal can name the file to restore.
 */
export type LauncherStartCheck = StartCheckResult & { readonly missingBundle?: string }

/**
 * Start the installed runtime, or install and then start it.
 * @param options - the home, profile, platform, arguments, mode, store, channel, logger, spawn and output.
 * @returns the runtime's exit status, or `1` for a refusal the launcher printed.
 */
export async function runLauncher(options: LauncherOptions): Promise<number> {
  const context: RemedyContext = { home: options.home, profile: options.profile }
  try {
    if (await refuseDuringRepair(options)) return LAUNCHER_EXIT.failed
    return await startOrInstall(options)
  } catch (error) {
    options.report?.({ step: 'failed' })
    const refusal = refusalFor(error, context)
    options.output.stderr(refusal.text)
    return refusal.exit
  }
}

/**
 * Refuse to start while `delorun repair` runs on this home, for any profile, new or not: the repair replaces the
 * program a start would launch. A mark left by a repair that no longer runs is reported and removed, and the start goes on.
 * @param options - the launch's inputs.
 * @returns whether the start was refused, with the refusal already printed.
 */
async function refuseDuringRepair(options: LauncherOptions): Promise<boolean> {
  const state = await checkRepairRecord(options.home, options.repairMarkGraceSeconds)
  if (state.kind === 'stale') options.output.stderr(`${await staleRepairText(state.record, options.home)}\n`)
  if (state.kind === 'writing') {
    options.output.stderr(renderLauncherRefusal({
      lead: 'Delorun is being repaired; wait for it to finish.',
      reason: 'REPAIR_RUNNING: a repair is writing its mark',
      remedies: [`Run the same command again when delorun repair has finished. If no repair is running, remove ${REPAIR_RECORD_FILE} from the home's run folder.`],
    }))
    return true
  }
  if (state.kind !== 'running') return false
  options.output.stderr(renderLauncherRefusal({
    lead: 'Delorun is being repaired; wait for it to finish.',
    reason: `REPAIR_RUNNING: process ${String(state.record.pid)} began the repair at ${state.record.startedAt}`,
    remedies: [`Run the same command again when delorun repair has finished. If no repair is running, remove ${REPAIR_RECORD_FILE} from the home's run folder.`],
  }))
  return true
}

/** The arguments the launcher starts `previous` with when `current` fails its start check. */
export const ROLLBACK_ARGS = ['recover', 'rollback'] as const

/**
 * The commands, once every `--profile` option is removed, whose run starts `previous` with {@link ROLLBACK_ARGS} when
 * `current` fails its start check: a bare `delorun`, `delorun start`, and `delorun recover rollback`, the command the
 * refusal of every other command names.
 */
const FALLBACK_COMMANDS: readonly (readonly string[])[] = [[], ['start'], ROLLBACK_ARGS]

/**
 * Whether a run whose `current` fails its start check may start `previous` with {@link ROLLBACK_ARGS} in place of its
 * arguments. The fallback drops every argument but the profile, which the launch command passes in `DELORUN_PROFILE`, so it
 * is taken only when the arguments are `--profile <name>` or `--profile=<name>` options, anywhere and any number of
 * times, around exactly one of {@link FALLBACK_COMMANDS}. Any other argument, `--foreground`, `--open` and `--help`
 * included, and a `--profile` with no value make the run a different command, which the launcher refuses. So does any
 * argument after `--`: the launcher read no `--profile` there, so the profile it would roll back could differ from the
 * one those arguments name.
 * @param args - the runtime's arguments.
 * @param passedThrough - the arguments after `--`.
 * @returns `true` for `delorun`, `delorun start` and `delorun recover rollback` with only profile options and nothing
 *   after `--`.
 */
export function mayStartPrevious(args: readonly string[], passedThrough: readonly string[]): boolean {
  return runsOneOf(args, passedThrough, FALLBACK_COMMANDS)
}

/**
 * Whether the arguments are `--profile` options around exactly one of the commands, with nothing after `--`.
 * @param args - the runtime's arguments.
 * @param passedThrough - the arguments after `--`.
 * @param commands - the commands, as their words.
 * @returns `true` when the arguments run one of them.
 */
function runsOneOf(args: readonly string[], passedThrough: readonly string[], commands: readonly (readonly string[])[]): boolean {
  if (passedThrough.length > 0) return false
  const words: string[] = []
  for (let at = 0; at < args.length; at++) {
    const argument = args[at]!
    if (argument === '--profile') {
      if (at + 1 === args.length) return false
      at++
    } else if (!argument.startsWith('--profile=')) {
      words.push(argument)
    }
  }
  return commands.some(command => command.length === words.length && command.every((word, at) => words[at] === word))
}

/** A command to start, with the release and the root its start check verified it under, and when that check began. */
type CheckedPlan = LaunchPlan & { readonly root: RootMetadata, readonly checkedAt: number }

/**
 * The command with the record of its start check in `DELORUN_START_CHECK`.
 * @param options - the launch's inputs.
 * @param plan - the checked command.
 * @returns the command to spawn.
 */
function handedOver(options: Pick<LauncherOptions, 'identity'>, plan: CheckedPlan): LaunchCommand {
  const record = startCheckHandoffText({
    schema: START_CHECK_SCHEMA,
    release: String(plan.version),
    at: plan.checkedAt,
    ...plan.check,
    launcher: { version: options.identity.version, path: options.identity.path },
  })
  return { command: plan.command, args: plan.args, env: { ...plan.env, [DELORUN_START_CHECK_ENV]: record } }
}

/**
 * Start the installed runtime, and install the channel's release first when the store holds none. When `current`
 * fails its start check and `previous` passes its own (see {@link previousRollback}), a run {@link mayStartPrevious}
 * accepts starts `previous` with {@link ROLLBACK_ARGS}; any other run prints {@link rollbackRefusalText} and starts
 * nothing.
 * @param options - the launch's inputs.
 * @returns the runtime's exit status, or {@link LAUNCHER_EXIT.failed} when the run is refused.
 * @throws when a start, install or a named release refuses, for {@link runLauncher} to print.
 */
async function startOrInstall(options: LauncherOptions): Promise<number> {
  let plan: CheckedPlan | undefined
  try {
    plan = await prepare(options)
  } catch (error) {
    if (error instanceof RuntimeStoreError && error.code === 'RUNTIME_CHANGED') {
      const rollback = await previousRollback(options)
      if (rollback === undefined) throw error
      // Any other command would run on `previous` as a rollback the person did not ask for, so it runs nothing.
      if (!mayStartPrevious(options.args, options.passedThrough)) {
        options.output.stderr(rollbackRefusalText(options, error, rollback.current, rollback.previous))
        return LAUNCHER_EXIT.failed
      }
      options.output.stderr(`Delorun did not start release ${String(rollback.current)}: it failed its start check. Starting release ${String(rollback.previous)}, the version before the last update, to roll back to it: delorun ${ROLLBACK_ARGS.join(' ')}\n`)
      return start(options, { ...options.store.launchCommand(rollback.previous, options.profile, ROLLBACK_ARGS), version: rollback.previous, root: rollback.root, check: rollback.check, checkedAt: rollback.checkedAt }, ROLLBACK_ARGS)
    }
    if (!(error instanceof RuntimeStoreError && error.code === 'NO_ACTIVE_RUNTIME')) throw error
  }
  if (plan === undefined) {
    await install(options)
    const prepared = await prepare(options)
    options.report?.({ step: 'starting' })
    return options.spawn(handedOver(options, prepared))
  }
  // A release named with `--release` is installed, and this launcher installs one only when the store holds no
  // runtime: it never replaces the runtime a person already has. Starting the installed runtime instead would
  // silently drop what was asked for, so the run stops and names both versions.
  if (options.target !== undefined) throw installedRefusal(options, plan.version)
  return start(options, plan, options.args)
}

/**
 * Run contract C18's start check of a checked release, then start it.
 * @param options - the launch's inputs.
 * @param plan - the command, with the release and the root its start check verified it under.
 * @param args - the arguments the runtime is started with, which name its command.
 * @returns the runtime's exit status, or {@link LAUNCHER_EXIT.failed} when the release-log check stops the start.
 */
async function start(options: LauncherOptions, plan: CheckedPlan, args: readonly string[]): Promise<number> {
  if (options.startCheck !== undefined) {
    const check = await options.startCheck(plan.version, plan.root)
    for (const notice of check.notices ?? []) options.output.stderr(`Release log: ${notice}\n`)
    if (check.warning !== undefined) options.output.stderr(`${check.warning}${check.detail === undefined ? '' : ` (${check.detail})`}\n`)
    // Contract C18 R5: a verifiable release-log failure stops the start in every mode; a check that did not complete
    // never does. `delorun verify` itself still runs, so the person can see every check.
    if (check.stop) {
      // A release whose bundle is missing can be left by `delorun recover rollback`, which then starts `previous` as a
      // failed start check of `current` does; the rollback checks `previous`'s own release log first.
      if (check.missingBundle !== undefined && runsOneOf(args, options.passedThrough, [ROLLBACK_ARGS])) {
        const rollback = await previousRollback(options)
        // `previous` naming this same release (a kill between the store's two pointer writes) is no release to roll back to.
        if (rollback !== undefined && rollback.current === plan.version && rollback.previous !== plan.version) {
          options.output.stderr(`Delorun did not start release ${String(plan.version)}: its release-log bundle is missing. Starting release ${String(rollback.previous)}, the version before the last update, to roll back to it: delorun ${ROLLBACK_ARGS.join(' ')}\n`)
          return start(options, { ...options.store.launchCommand(rollback.previous, options.profile, ROLLBACK_ARGS), version: rollback.previous, root: rollback.root, check: rollback.check, checkedAt: rollback.checkedAt }, ROLLBACK_ARGS)
        }
      }
      options.output.stderr(failedStartText(plan.version, check, options.profile))
      if (runtimeCommand(args) !== 'verify') return LAUNCHER_EXIT.failed
    }
  }
  return options.spawn(handedOver(options, plan))
}

/**
 * The `previous` to start with {@link ROLLBACK_ARGS} after `current` failed its start check: contract C3's one
 * rollback, which reads the update record, applies the rollback table and switches the pointers, and which refuses
 * with `NO_UPDATE_RECORD` when no update to `current` is recorded. It exists only when no release was named, the stored
 * root is anchored on the roots this launcher ships, the store names a `previous`, and `previous` passes contract C2's
 * start check under that root. Finding it reads the home and writes nothing; the launcher switches no pointer itself.
 * @param options - the launch's inputs.
 * @returns the version `previous` names, the root it passed its start check under and the version `current` names, or
 *   `undefined` when there is no usable `previous`, so the start's own refusal stands.
 */
async function previousRollback(options: LauncherOptions): Promise<{ readonly previous: RuntimeVersion, readonly root: RootMetadata, readonly current: RuntimeVersion, readonly check: StartCheckSummary, readonly checkedAt: number } | undefined> {
  if (options.target !== undefined) return undefined
  // A refusal at any step leaves no version to start the rollback from, and the refusal of `current` is what the
  // person sees: a root this launcher does not anchor, pointers that do not read, or a `previous` that fails its own
  // start check.
  const root = await storedRoot(options.home, options.roots).catch(() => undefined)
  if (root === undefined) return undefined
  const pointers = await options.store.pointers().catch(() => undefined)
  if (pointers?.previous === undefined) return undefined
  const previous = pointers.previous
  const checkedAt = options.identity.now()
  const verified = await options.store.checkRuntime(previous, root).catch(() => undefined)
  if (verified === undefined) return undefined
  // `checkRuntime` outside a shared scope hashes every file of the version.
  const files = verified.files.files
  const check: StartCheckSummary = { full: true, hashed: files.length, files: files.length, fullCheckAt: checkedAt }
  return { previous, root, current: pointers.current, check, checkedAt }
}

/**
 * What a run that is not a start prints when `current` failed its start check and `previous` passed its own: the
 * release that failed and the check's reason, and `delorun recover rollback`, which starts `previous` to roll back to it.
 * @param options - the launch's inputs, whose arguments name the command that was refused.
 * @param error - the start check's refusal of `current`.
 * @param current - the version `current` names.
 * @param previous - the version `previous` names.
 * @returns the refusal in `@delorun/home`'s format, every line ending with a newline.
 */
function rollbackRefusalText(options: Pick<LauncherOptions, 'args' | 'profile'>, error: RuntimeStoreError, current: RuntimeVersion, previous: RuntimeVersion): string {
  const command = ['delorun', ...options.args].join(' ')
  return renderLauncherRefusal({
    lead: `Delorun did not run ${command}: release ${String(current)} failed its start check, so Delorun ran no release.`,
    reason: codedReason(error.code, error.detail),
    remedies: [`Start release ${String(previous)}, the version before the last update, to roll back to it: delorun ${ROLLBACK_ARGS.join(' ')}${profileOption({ profile: options.profile })}`],
  })
}

/**
 * What a start stopped by a release-log failure prints: the refusal and how to proceed, in the launcher's refusal format
 * and through its redactor, since the check's detail can quote what a server or a file held. A missing bundle names its
 * path and offers the rollback and the restored file; reinstalling does not apply, because the launcher installs only
 * into an empty store.
 * @param version - the release.
 * @param check - the failed check.
 * @param profile - the CLI profile, which the rollback remedy names.
 * @returns the redacted text, every line ending with a newline.
 */
export function failedStartText(version: RuntimeVersion, check: LauncherStartCheck, profile: string): string {
  if (check.missingBundle !== undefined) {
    return renderLauncherRefusal({
      lead: `Delorun did not start release ${String(version)}: the release-log bundle stored beside it is missing.`,
      reason: codedReason(String(check.refusal), `no release-log bundle is stored at ${check.missingBundle}, and every install through the runtime store keeps the bundle it verified`),
      remedies: [
        `If an update installed release ${String(version)}, go back to the version before it: delorun ${ROLLBACK_ARGS.join(' ')}${profileOption({ profile })}`,
        `Or put the bundle back: restore ${check.missingBundle} from a backup of this home, or download delorun-${String(version)}.manifest.log.json from the release page of v${String(version)} to that path; the next start checks it.`,
      ],
    })
  }
  return renderLauncherRefusal({
    lead: `Delorun did not start release ${String(version)}: its release-log check failed.`,
    reason: codedReason(String(check.refusal), check.detail),
    remedies: [
      'Run delorun verify to see every check of this release, and run npx delorun@latest repair if the failure stays.',
      'Deleting files under the home\'s trust/ directory does not repair this: the next check finds the same failure, or starts without the record that caught it.',
    ],
  })
}

/**
 * The runtime command the arguments name: the first argument that is not an option, skipping `--profile`'s value.
 * @param args - the runtime's arguments.
 * @returns the command, or `undefined` for a bare `delorun`.
 */
export function runtimeCommand(args: readonly string[]): string | undefined {
  for (let at = 0; at < args.length; at++) {
    const argument = args[at]!
    if (argument === '--profile') at++
    else if (!argument.startsWith('-')) return argument
  }
  return undefined
}

/**
 * The interval of the start check's full hash for a run: 0 for `delorun verify`, so the files the command checks with
 * are hashed before it runs whatever the identity record says; the person's interval for every other command.
 * @param options - the launch's inputs.
 * @returns the interval in days.
 */
export function fullCheckDaysFor(options: Pick<LauncherOptions, 'args' | 'fullCheckDays'>): number {
  return runtimeCommand(options.args) === 'verify' ? 0 : options.fullCheckDays
}

/**
 * Run contract C2's start check through the store and build the command it names, writing nothing.
 * @param options - the launch's inputs.
 * @returns the command that starts `current`, with the root it was checked under and the time the check began.
 * @throws {RuntimeStoreError} `NO_ACTIVE_RUNTIME`, `RUNTIME_CHANGED`, `RUNTIME_INCOMPATIBLE`, `STORE_BUSY`.
 */
async function prepare(options: LauncherOptions): Promise<CheckedPlan> {
  const root = await storedRoot(options.home, options.roots)
  const checkedAt = options.identity.now()
  return { ...await options.store.prepareLaunch({ launcher: SUPPORTED, root, mode: options.mode, fullCheckDays: fullCheckDaysFor(options), profile: options.profile, args: options.args }), root, checkedAt }
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
    join(options.home, DELORUN_HOME_ENTRIES.runtimes),
    `--release ${target} asks for release ${target}, and runtime ${String(installed)} is already installed; this launcher installs a release only when this home holds no runtime, so it installed nothing and started nothing`,
    ['update'],
  )
}

/**
 * Read `trust/root.json`, the root this home last verified, and trust it by the roots the launcher ships: the
 * start check anchors on it, so a root an install did not verify may not reach the store. A root newer than every
 * shipped root is trusted only with the chain the install walked to it, `trust/roots/<n>.root.json`, so a root a
 * restore or a sync placed under `trust/` is not an anchor. A home with no stored root is a store without a runtime,
 * because nothing on it was verified yet. A stored root older than the newest root this launcher ships is not the
 * anchor: the newest shipped root is, so a targets key it revoked does not verify at this start.
 * @param home - the resolved Delorun home.
 * @param shipped - the root files this launcher ships, oldest first.
 * @returns the metadata of the root the start check anchors on.
 * @throws {RuntimeStoreError} `NO_ACTIVE_RUNTIME` when no trusted root is stored or it does not read; `RUNTIME_CHANGED`
 *   when the stored root is not one this launcher trusts, or the chain that should prove it cannot be read.
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
  let walked: readonly Uint8Array[]
  try {
    walked = await readStoredRootChain(home)
  } catch (error) {
    throw new RuntimeStoreError('RUNTIME_CHANGED', path, `the root chain stored beside ${path} cannot be read, so the runtime installed beside it cannot be checked: ${messageOf(error)}`, ['reinstall'], { cause: error })
  }
  try {
    return verifyStoredRoot({ stored, shipped, walked, source: path }).metadata
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
  await options.store.install({
    version: release.version,
    root: release.root,
    fill: async (directory) => {
      const files = await options.channel.fill(release, directory)
      options.report?.({ step: 'installing', version: release.version })
      return files
    },
  })
  await options.channel.recordInstalled?.(release)
  options.report?.({ step: 'installed', version: release.version })
  await options.store.retain().catch((error: unknown) => {
    options.logger.warn('the runtime store could not finish its retention after an install; the next run retries it', { err: error })
  })
}

/** A profile name: contract C1's rule, which `delorun` applies too. */
export const PROFILE_NAME = PROFILE_NAME_PATTERN

/**
 * The profile a launch runs, from the option or `DELORUN_PROFILE`, refusing the desktop app's own profile and any name
 * that is not one (contract C1). The name becomes a directory under the home's `profiles/`, so a name with a path
 * segment would leave the home and reach the runtime as its profile.
 * @param named - the `--profile` value, when one was given.
 * @param env - the environment.
 * @returns the profile's name.
 * @throws {Error} when the profile is `desktop`, or is not a profile name.
 */
export function launcherProfile(named: string | undefined, env: NodeJS.ProcessEnv): string {
  const profile = named ?? (env[DELORUN_PROFILE_ENV] === undefined || env[DELORUN_PROFILE_ENV].trim() === '' ? 'default' : env[DELORUN_PROFILE_ENV].trim())
  const problem = profileNameProblem(profile)
  if (problem !== undefined) throw new Error(`the profile ${problem}`)
  return profile
}
