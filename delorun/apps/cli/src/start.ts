/**
 * `delorun start` and the start half of a bare `delorun` (contract C19, "Commands"): the home process of
 * [`@delorun/home-process`](../../../packages/home-process/README.md) for the CLI profile, whose Host is the profile
 * booted through upstream's profile runner in the same process.
 *
 * - `delorun start --foreground` runs the home process in this terminal: it takes the profile's home lock, writes a
 *   new start token, listens on the update channel and boots the profile, logging to the `home-<profile>` surface
 *   while the terminal also shows its output.
 * - `delorun start` starts the same command detached from the terminal, with standard input closed and its output
 *   in its log, and waits at most 120 seconds for the update channel to report `running`. Detached means the home
 *   process outlives the terminal; nothing starts it at login.
 * - Without either option the profile's setup answer chooses; `--background` detaches this start whatever setup
 *   answered, and a start that runs in this terminal because of that answer ends with how to start in the background.
 * - `--patch <file>`, repeatable, adds the person's overlays to the composition, as `dsh --patch` does: they apply over
 *   the profile's layers and under Delorun's sandbox overlay, the composition's checks hold over them, safe mode refuses
 *   them, and the successor process an update starts runs without them.
 * - `--inspect` opens Node's inspector on 127.0.0.1:9229 in the home process before the profile boots, after the person
 *   confirms at a terminal or with `--yes`, and never in safe mode ([inspector](./inspector.ts)).
 *
 * Before the profile boots, the pre-start steps run ([pre-start](./pre-start.ts)): among them, a fresh start from C1's
 * store refuses a runtime whose files differ from the signed release, and each plugin the profile links from a folder
 * is made to load the content Changes allows ([`@delorun/changes`](../../../packages/changes/src/enforce.ts)).
 *
 * A second start for a profile whose home process answers prints that process and exits 0. A profile that skipped a
 * Delorun bundle is refused before it boots, and one in which a row of a Delorun bundle did not activate is shut down and
 * refused after it boots ([delorun-bundles](./delorun-bundles.ts)). An optional plugin pack of the running release is not a
 * Delorun bundle there: a skipped pack prints a notice, and a pack whose row did not activate is logged as not running while
 * the studio starts. A fresh start that fails right after a change starts once more, in a new process, without that change
 * ([retry](./changes/retry.ts)).
 *
 * Run from `runtimes/<version>/` of C1's store, the home process gets the update support of [update](./update/support.ts);
 * its Host counts running chats and runs C3's health check ([host](./update/host.ts)). A process whose descriptor 3
 * is a socket or a pipe was started by an update as the successor and takes over through `HomeProcess.takeOver`.
 *
 * @module @delorun/cli/start
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, fstatSync, openSync, readSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ResolvedProfileRuntime, RunProfileOptions } from '@deepseek-ai/dsh/profile-boot'
import { assertDelorunInvariants, composeDelorunProfile, type ApprovedPluginContent, type ServiceProvider } from './compose.ts'
import { DELORUN_START_CHECK_ENV, HEADLESS_PROFILE, HOME_STATUS_TIMEOUT_MS, type RuntimeVersion } from '@delorun/contract-home-layout'
import type { ReachConfigRows } from '@delorun/contract-reach-providers'
import { START_WAIT_MS, type ChangesReloadOutcome } from '@delorun/contract-home-process'
import { localDeviceApproval } from './devices/host.ts'
import { localConsents } from './consents/host.ts'
import { localAgentAccounts } from './agents/host.ts'
import { CountingChatGate, HomeProcess, HostNotStoppedError, listenProcessSignals, openHomeLog, captureHomeOutput, queryHomeStatus, refuseBootedHost, updateChannelProbe, type HandoverPipe, type HomeLog, type HomeProcessOptions, type LocalAgentAccounts, type LocalConsents, type LocalDeviceApproval, type LocalReach, type RestartControl, type RunningHost, type StudioLinkResult, type UpdateChannelAccess, type UpdateSupport } from '@delorun/home-process'
import { appliedReachConfig, localReach } from './reach/host.ts'
import { readReachRow } from './reach/row.ts'
import { REACH_ROW_ID, reachRowsOf, type TailscalePrivateRow } from '@delorun/setup-apply'
import { resolveSurface, type DelorunLogger } from '@delorun/logs'
import { afterChangesBoot, changesApprovedContent, recordChangesBoot, repointingBoot } from './changes/start.ts'
import { updateSource } from './changes/update-baseline.ts'
import { reloadProfile } from './changes/reload.ts'
import { runningComposition, type HarnessContext, type RunningComposition } from '@delorun/changes'
import { checkRunningRuntime, handOffToComposedTree, handsOff, harnessContextOf, processHandOff, startEntry, type HandOff } from './changes/harness-start.ts'
import { provideChangesHarness } from './changes/harness-service.ts'
import { provideChangesRestart, restartSupport, type RunningHolder } from './changes/restart-service.ts'
import { provideUpdateChannel } from './update/channel-service.ts'
import { relaunchForeground, retryDetached, retryForeground, retryHandOff, startRetry, type DetachedOutcome, type ForegroundRelaunch, type StartRetry } from './changes/retry.ts'
import { CliError, EXIT } from './exit.ts'
import { parseOptions, prepareHome, type CliCommand, type CommandOutput, type CommandResult } from './command.ts'
import { holderAlive, HomeLayoutError, isFailClosedStub, newStartId, readHomeLock, runDirectory, type HolderProbe } from '@delorun/home'
import { DEFAULT_WORKSPACE_ENV, defaultWorkspaceRequest, resolveDefaultWorkspace } from './default-workspace.ts'
import { DELORUN_PROFILE_BUNDLES, NPM_MIRROR_ENV } from '@delorun/bundle-local/profile'
import { delorunRowIds, inactiveDelorunRows, insertedRowsByLayer, inactivePackRows, inactivePackWarning, inactiveRowsRefusal, type BootedRow, type RowState } from './delorun-bundles.ts'
import { registerHomeProcess } from './home-exclusion.ts'
import { inspectorConsent, openDebugger, terminalInspectorConfirm } from './inspector.ts'
import { announceStudio } from './open/announce.ts'
import { hostStudioLink } from './open/host-link.ts'
import { computerOpener, profileFlag, type StudioOpener } from './open/studio.ts'
import { shippedPackageManager } from './package-manager.ts'
import { hasCliProfile, profileDirectory } from './profile.ts'
import { readBackgroundAnswer } from './setup/background.ts'
import { dangerousModeLine } from './setup/dangerous.ts'
import { openSetupLog, upstreamLinking } from './setup/index.ts'
import { addStudioBundle } from './studio-bundle.ts'
import { preStartSteps, runPreStartSteps, type PreStartStep } from './pre-start.ts'
import { runningReleasePacks, type ReleasePacks } from './release-packs.ts'
import { fetchPacksFromRelease } from './profile-packs.ts'
import { addHeadlessBundle, headlessBundleMigration } from './headless-bundle.ts'
import { studioBundleMigration } from './profile-migrations.ts'
import { checkInstalledPlugins } from './plugin-install-check.ts'
import { copyImportMigration } from './pnpm-import.ts'
import { removeSandboxOverlay, sandboxOverlayPath } from './sandbox-protection.ts'
import { configSchemasOf, guardSecretFields, reportSecretSettlement, settleSecretValues, type SecretSettlement } from './secret-fields.ts'
import { secretFieldAdmission, type ConfigSchemasOf } from '@delorun/profile-safety'
import type { VersionAdmission } from '@deepseek-ai/dsh-plugin-manager/history'
import { bootProtectionOf, bootRowsOf, checkHealth, inactiveRows, personRowsOf, serveHealth, watchChats, withAppliedConfig, type HostHealthFacts } from './update/host.ts'
import { signedSettingChanges } from './update/release-settings.ts'
import { inheritedHandover, runtimeOfFile, type RunningRuntime } from './update/runtime.ts'
import { checkStoredRuntime, fullCheckDaysOf, storeUpdateSupport, successorStartCheckRecord } from './update/store-support.ts'
import { launcherAnchor } from './update/trusted-root.ts'
import { loadDelorunEnvironment } from './launch-environment.ts'
import { attachHomeLogs, registerEnvironment } from './log-secrets.ts'
import { registerFatalRelease } from './last-resort.ts'
import { runtimePlatformOf } from './update/channel.ts'
import { startNoticeLine, watchUpdates, type UpdateWatchOptions } from './update/notice-host.ts'
import { hostTrustOptions, PROCESS_FETCH, TRUST_STAGES, watchTrust, type TrustWatchOptions } from './verify/trust-host.ts'
import { studioAddress } from './status.ts'
import { commandRows, startSpinner, styleOf } from './style.ts'

/**
 * Adds `@delorun/bundle-studio` to a profile setup created before it existed ({@link addStudioBundle}).
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @param output - where pnpm's output goes.
 * @returns whether the bundle was added.
 */
export type AddStudioBundle = (home: string, profile: string, output: CommandOutput) => Promise<boolean>

/** What the foreground start calls outside this module; specs replace them. */
export interface StartDependencies {
  /** Loads the profile and reports its skipped bundles as upstream's boot does; upstream's `prepareProfile` by default. */
  readonly prepareProfile: (profile: string) => Promise<ResolvedProfileRuntime>
  /** Boots the profile; upstream's `runProfile` by default, with its rows and its shutdown. */
  readonly runProfile: (options: RunProfileOptions) => Promise<BootedProfile>
  /** Loads the launch environment with upstream's `.env` layers, refusing a `DELORUN_` name in one ({@link loadDelorunEnvironment}). */
  readonly loadEnvironment: () => RunProfileOptions['environment']
  /** Asks a live lock holder for its status; the update channel's `status` request by default. */
  readonly probe: (home: string, profile: string) => HolderProbe
  /** Routes this process's termination signals to the home process, which owns the one handler. */
  readonly onSignal: HomeProcessOptions['onSignal']
  /**
   * Registers the teardown that the process's one last-resort handler ([last-resort](./last-resort.ts)), installed by
   * the entry point, awaits before its fatal exit, across every Host the home process boots; {@link registerFatalRelease}
   * by default.
   * @param release - disposes the current Host.
   * @returns the disposer that unregisters it.
   */
  readonly fatalRelease: (release: () => Promise<void>) => () => void
  /** Registers a listener for this process's exit. */
  readonly onExit: (listener: () => void) => void
  /** Ends the process after a stop or a handover. */
  readonly exit: (code: number) => void
  /**
   * Captures this process's output into the home log, also passing it to the terminal.
   * @returns the disposer that restores both streams.
   */
  readonly captureOutput: (log: HomeLog) => () => void
  /**
   * The runtime this process runs: the store's version when it runs from `runtimes/<version>/`, otherwise this
   * package's version with no store.
   * @param home - the resolved Delorun home.
   * @returns the version and whether it runs from the store.
   */
  readonly runtime: (home: string) => RunningRuntime
  /**
   * The update support of a home process that runs from the store; {@link storeUpdateSupport} by default.
   * @param home - the resolved Delorun home.
   * @param profile - the CLI profile.
   * @param running - the version this process runs.
   * @param logger - the home process's logger.
   * @param env - the environment `delorun` was started with, read for the launcher's release roots.
   * @param admitVersion - decides whether an update's snapshot may be saved: the running Host's secret-field check.
   * @returns the support.
   */
  readonly updates: (home: string, profile: string, running: RuntimeVersion, logger: DelorunLogger, env: Readonly<Record<string, string | undefined>>, admitVersion: VersionAdmission) => UpdateSupport
  /**
   * C1's start check of the stored runtime a fresh start runs from, run by the pre-start step `changes` and by C3's
   * health check H1 after the boot; {@link checkRunningRuntime} by default, which also checks the composed tree a
   * process runs from when the person's harness changes are in place.
   * @param home - the resolved Delorun home.
   * @param version - the installed version this process runs.
   * @param logger - the home process's logger.
   * @param root - the stored root, anchored on the launcher's roots.
   * @param fullCheckDays - the interval of the start check's full hash in days.
   * @param composed - the composed tree this process runs from, when it runs one.
   * @throws {RuntimeStoreError} when the version's files do not match its signed file list.
   * @throws {ChangesError} `HARNESS_CHANGED` when the composed tree differs.
   */
  readonly checkRuntime: typeof checkRunningRuntime
  /**
   * The start-check record a successor runs with ({@link successorStartCheckRecord}); the predecessor, which may be an
   * older release, starts it without one.
   */
  readonly successorStartCheck: typeof successorStartCheckRecord
  /**
   * Hand the start off to the composed tree of its runtime before anything else runs ([harness start](./changes/harness-start.ts));
   * {@link handOffToComposedTree} for this process in a real start.
   * @param request - the start.
   * @returns what the hand-off did when the start handed off; undefined when it runs here.
   */
  readonly handOff: (request: StartRequest) => Promise<HandOff | undefined>
  /**
   * The handover pipe when this process was started as an update's successor, which inherits it as file descriptor 3.
   * @returns the pipe, or `undefined` for a fresh start.
   */
  readonly handover: () => Promise<HandoverPipe | undefined>
  /** How a start that opens the studio asks the home process for a link and opens it ({@link computerOpener}). */
  readonly opener: StudioOpener
  /** The composition's approved plugin content step ([compose](./compose.ts)); {@link changesApprovedContent} in a real start. */
  readonly approvedPluginContent: ApprovedPluginContent
  /** The running release's optional plugin packs, which the composition holds to no Delorun row rule ([release packs](./release-packs.ts)); {@link runningReleasePacks} in a real start. */
  readonly releasePacks: ReleasePacks
  /** The ordered steps before any Host boots ([pre-start](./pre-start.ts)); {@link realPreStartSteps} in a real start. */
  readonly preStartSteps: readonly PreStartStep[]
  /** The second start after a start left a change out ([retry](./changes/retry.ts)); {@link relaunchForeground} in a real start. */
  readonly relaunch: ForegroundRelaunch
}

/**
 * Links Delorun's headless bundle into the home's `headless` profile ({@link addHeadlessBundle}).
 * @param home - the Delorun home.
 * @param output - where pnpm's output goes.
 * @returns whether the profile's bundle list did not name the bundle before.
 */
export type AddHeadlessBundle = (home: string, output: CommandOutput) => Promise<boolean>

/**
 * The real pre-start steps: the CLI profile's migration adds Delorun's studio bundle to a profile set up before it
 * shipped, and the `headless` profile's links Delorun's headless bundle; both then set the profile's package import method
 * to copies, and the plugin change check compares the profile's installed plugins with their install records.
 * @param add - links the studio bundle into a CLI profile; upstream's resolution and `dsh plugin add` in a real start.
 * @param addHeadless - links the headless bundle into the `headless` profile, the same way in a real run.
 * @returns the steps.
 */
export function realPreStartSteps(add: AddStudioBundle, addHeadless: AddHeadlessBundle): readonly PreStartStep[] {
  return preStartSteps({
    migrations: context => [
      context.kind === 'headless'
        ? headlessBundleMigration(() => addHeadless(context.home, context.output), context.output)
        : studioBundleMigration(() => add(context.home, context.profile, context.output), context.output, context.profile),
      copyImportMigration(profileDirectory(context.home, context.profile), context.output),
    ],
    fetchPacks: fetchPacksFromRelease,
    pluginChanges: async (context) => {
      const { INSTALL_ANCHOR } = await import('@deepseek-ai/dsh/profile-boot')
      await checkInstalledPlugins({ home: context.home, profile: context.profile, profileDir: profileDirectory(context.home, context.profile), installAnchor: INSTALL_ANCHOR, full: false, output: context.output })
    },
  })
}


/** A booted profile, as the start's audit of Delorun's rows reads it. */
export interface BootedProfile {
  /** The Loader's rows after startup settled, with their configs; empty when the tree was already disposed. */
  readonly rows: () => readonly BootedRow[]
  /**
   * Who provides a service in the booted root context.
   * @param name - the service's name.
   * @returns the provider ({@link serviceProvider}), or `undefined` when no active fiber provides it.
   */
  readonly providerOf: (name: string) => ServiceProvider | undefined
  /**
   * Release the turn gate's start hold, so turns that wait for the start's check go on: called once the booted Host
   * passed it. A Host without the `delorunTurnGate` service holds no turn, and this does nothing.
   */
  readonly releaseTurns: () => void
  /**
   * Dispose the application and let the process end with this code, through upstream's bounded shutdown: it ends the
   * process at once when the teardown fails or overruns its 5 seconds.
   * @param code - the exit code.
   * @returns when disposal finished.
   */
  readonly shutdown: (code: number) => Promise<void>
  /**
   * Dispose the application's root context and keep the process: the teardown an update's switch runs, which arms no
   * process exit. Upstream's process-wide proxy dispatcher stays installed, and the next boot in this process
   * installs its own over it.
   * @returns when disposal finished.
   */
  readonly dispose: () => Promise<void>
  /**
   * Count the Host's running chats into the home process's gate ([host](./update/host.ts)).
   * @param gate - the gate.
   */
  readonly watchChats: (gate: CountingChatGate) => void
  /**
   * Attach the update check to the Host ([notice-host](./update/notice-host.ts)).
   * @param options - the home, the profile, the platform, the running version and the terminal line.
   * @returns once the check is attached, or its record removed when the person switched it off.
   */
  readonly watchUpdates: (options: UpdateWatchOptions) => Promise<void>
  /**
   * Attach the trust bill's source to the Host ([trust host](./verify/trust-host.ts)); absent where the Host serves no
   * bill.
   * @param options - the home, the profile, the platform, the running version, the environment, the log and the fetch.
   */
  readonly watchTrust?: (options: TrustWatchOptions) => void
  /**
   * The studio's loopback listener.
   * @returns its host and port, or `undefined` when the profile serves no studio.
   */
  readonly studio: () => { readonly host: string, readonly port: number } | undefined
  /**
   * Mint a studio sign-in link for one opening ([host link](./open/host-link.ts)).
   * @param port - a loopback port that forwards to the studio, or `undefined` for the studio's own port.
   * @returns the link, or why none can be made for this computer.
   */
  readonly studioLink: (port: number | undefined) => StudioLinkResult
  /** The local device approval of `@delorun/home-auth`, when the profile loads it. */
  readonly devices?: () => LocalDeviceApproval | undefined
  /** The consents of `@delorun/plugin-permission-defaults` and `@delorun/plugin-mcp-consent`, each read per operation. */
  readonly consents?: () => LocalConsents
  /** The external agents' account operations of `@delorun/external-agents`, each read per operation. */
  readonly agents?: () => LocalAgentAccounts
  /** The Config schemas of the Loader's rows, which the secret-field checks read ([secret fields](./secret-fields.ts)). */
  readonly configSchemas: ConfigSchemasOf
  /**
   * Move each value for a secret-role field out of the profile patch and the home patch into the credentials store,
   * where the plugin can name it ([secret fields](./secret-fields.ts)).
   * @param home - the Delorun home.
   * @param profile - the profile.
   * @returns what was moved and what stays.
   */
  readonly settleSecretValues: (home: string, profile: string) => Promise<SecretSettlement>
  /**
   * The reach service of `@delorun/reach`, when the profile loads it ([reach host](./reach/host.ts)).
   * @param rows - reads the profile's `delorun-reach` row when `reach.apply` arrives.
   * @returns the reach operations, or undefined without the service.
   */
  readonly reach?: (rows: () => ReachConfigRows) => LocalReach | undefined
  /**
   * Load what the profile's files now name through upstream's hot reload: C19's `changes.reload`
   * ([reload](./changes/reload.ts)).
   * @returns `ok`, or why the running Host does not run what the files name.
   */
  readonly reload: () => Promise<ChangesReloadOutcome>
}

/**
 * The Loader fiber states the audit reads, by name: Cordis's `FiberState` is a `const enum`, which a module run from
 * its emitted JavaScript cannot import, so its numbers are mirrored here, and a spec compares them with Cordis's source.
 */
export const FIBER_STATES = { PENDING: 0, ACTIVE: 2, DISPOSED: 4 } as const

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
    } catch (_disabledThrew) {
      // A `disabled` expression that throws leaves the row unmounted; upstream's audit reports it as failed.
      return { id: entry.options.id, name: entry.options.name, disabled: false, state: 'failed', ...configOf(entry.options.config) }
    }
    const fiber = entry.fiber
    const state: RowState = fiber === undefined || fiber.state === FIBER_STATES.DISPOSED
      ? 'not-imported'
      : fiber.state === FIBER_STATES.ACTIVE ? 'active' : fiber.state === FIBER_STATES.PENDING ? 'pending' : 'failed'
    return { id: entry.options.id, name: entry.options.name, disabled, state, ...configOf(entry.options.config) }
  })
}

/**
 * A row's config field, present only when the row has a config.
 * @param config - the Loader entry's config.
 * @returns the field to spread into the row.
 */
function configOf(config: unknown): { readonly config?: unknown } {
  return config === undefined ? {} : { config }
}

/**
 * Who provides a service in a booted root context: the Loader row whose fiber registered it, or whose fiber is an
 * ancestor of the fiber that did, so a plugin that provides through a child plugin still counts as its row.
 * @param ctx - the root context.
 * @param name - the service's name.
 * @returns `undefined` when no active fiber provides the service; otherwise the provider, whose `row` is `undefined`
 *   when no Loader row's fiber is the registering fiber or one of its ancestors.
 */
export function serviceProvider(ctx: Context, name: string): ServiceProvider | undefined {
  const provision = ctx.reflect._getImpl(name)
  if (provision === undefined) return undefined
  // By uid: the Loader's entries are read through a context proxy, so their fibers are not the provision's objects. A
  // disposed fiber has no uid and provides nothing.
  const rowOf = new Map<number, string>()
  for (const entry of ctx.get('loader')?.entries() ?? []) {
    const uid = entry.fiber?.uid
    if (uid !== undefined && uid !== null) rowOf.set(uid, entry.options.id)
  }
  const failClosed = isFailClosedStub(ctx.get(name))
  const seen = new Set<number>()
  for (let fiber: Fiber = provision.ctx.fiber; fiber.uid !== null && !seen.has(fiber.uid); fiber = fiber.parent.fiber) {
    seen.add(fiber.uid)
    const row = rowOf.get(fiber.uid)
    if (row !== undefined) return { row, ...failClosed && { failClosed } }
  }
  return { row: undefined, ...failClosed && { failClosed } }
}

/** What a foreground start runs. */
export interface StartRequest {
  /** The prepared Delorun home. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
  /** Whether the studio opens in the browser, through the home process's `studio.open-token`, once it runs. */
  readonly open: boolean
  /** Where the start writes. */
  readonly output: CommandOutput
  /**
   * The environment `delorun` was started with, captured once in `main` before any `.env` layer applies: the launcher's
   * release roots and the Docker context are read from it, never from this process's environment.
   */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The person's `--patch` overlays, absolute, in order ([compose](./compose.ts)); none by default. */
  readonly patchFiles?: readonly string[]
  /**
   * Work that runs once after the studio announcement ({@link announceStudio}), while the home process keeps running; it
   * does not run when the start hands over to a home that already runs, hands off to another runtime, or refuses. It must
   * not stop the process: a failure is reported on standard error and in the home log, and the process runs on.
   */
  readonly afterStart?: () => Promise<void>
}

/** The level of the home process's log. */
const HOME_LOG_LEVEL = 'info'

/** Which of upstream's per-run process handlers its profile runner installs. */
export interface UpstreamProcessHandlers {
  /**
   * Its SIGTERM and SIGINT handlers: false under a home process, whose one signal listener serves every Host it boots,
   * and true for a one-shot run such as `delorun headless`, which upstream's runner ends.
   */
  readonly signals: boolean
  /**
   * Its fail-loud handlers. Always false under the CLI: the entry point's one last-resort handler reports a crash and
   * ends the process after the teardown registered through `registerFatalRelease`, so the booted Host is disposed
   * within the bound instead of after the CLI's handler already ended the process.
   */
  readonly failLoud: false
}

/**
 * Boot a profile with upstream's profile runner and read it as the start reads a booted profile, with H2's health route
 * on its web server ({@link serveHealth}) and the refusals that keep secret-role values out of its patch files and
 * history ({@link guardSecretFields}).
 * @param options - the runner's options.
 * @param handlers - which of upstream's per-run process handlers the runner installs.
 * @returns the booted profile.
 */
export async function runUpstreamProfile(options: RunProfileOptions, handlers: UpstreamProcessHandlers): Promise<BootedProfile> {
  // Loaded after the launch variables are set, so upstream resolves the Delorun home.
  const { runProfile } = await import('@deepseek-ai/dsh/profile-boot')
  // An installed Delorun's plugin manager runs the pnpm its closure carries ([package manager](./package-manager.ts)).
  const packageManager = shippedPackageManager()
  const { ctx, shutdown } = await runProfile({
    ...options, signals: handlers.signals, failLoud: handlers.failLoud, ...packageManager === undefined ? {} : { packageManager },
    // Before the Loader mounts its first row, so an edit a plugin saves while it starts is guarded too.
    prepare: (root) => {
      guardSecretFields(root, configSchemasOf(root))
      options.prepare?.(root)
    },
  })
  serveHealth(ctx)
  const configSchemas = configSchemasOf(ctx)
  return {
    configSchemas,
    settleSecretValues: (home, profile) => settleSecretValues(ctx, home, profile, configSchemas),
    rows: () => bootedRows(ctx),
    providerOf: name => serviceProvider(ctx, name),
    shutdown: code => shutdown.shutdown(code),
    dispose: async () => { await ctx.fiber.dispose() },
    watchChats: (gate) => { watchChats(ctx, gate) },
    devices: () => localDeviceApproval(ctx),
    consents: () => localConsents(ctx),
    agents: () => localAgentAccounts(ctx),
    reach: rows => localReach(ctx, rows),
    watchUpdates: async options => watchUpdates(ctx, options),
    watchTrust: (options) => { watchTrust(ctx, options, TRUST_STAGES) },
    // The CLI profile's invariants require the service, so it is absent only in a profile that holds no turn.
    releaseTurns: () => { ctx.get('delorunTurnGate')?.release() },
    studio: () => {
      const server = ctx.get('webServer')
      return server?.port === undefined ? undefined : { host: server.host, port: server.port }
    },
    studioLink: port => hostStudioLink(ctx, port),
    reload: () => reloadProfile(ctx.get('hmr')),
  }
}

/**
 * Add the studio bundle through upstream's resolution and `dsh plugin add`.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @param output - where the progress line goes; pnpm's output goes to the profile's `home-<profile>` log.
 * @returns whether the bundle was added.
 */
export async function upstreamAddStudioBundle(home: string, profile: string, output: CommandOutput): Promise<boolean> {
  const log = openSetupLog(home, profile)
  try {
    return await addStudioBundle(home, profile, () => upstreamLinking(home, profile), { log, progress: (text) => { output.stdout(text) } })
  } finally {
    log.close()
  }
}

/**
 * Link the headless bundle through upstream's resolution and `dsh plugin add`.
 * @param home - the Delorun home.
 * @param output - where the progress line goes; pnpm's output goes to the `headless` profile's `home-headless` log.
 * @returns whether the profile's bundle list did not name the bundle before.
 */
export async function upstreamAddHeadlessBundle(home: string, output: CommandOutput): Promise<boolean> {
  const log = openSetupLog(home, HEADLESS_PROFILE)
  try {
    return await addHeadlessBundle(home, () => upstreamLinking(home, HEADLESS_PROFILE), { log, progress: (text) => { output.stderr(text) } })
  } finally {
    log.close()
  }
}

/**
 * The dependencies of a real start.
 * @returns no approved plugin content, the real pre-start steps, upstream's profile preparation, profile runner,
 *   `.env` loader, the last-resort handler's teardown, the update channel's probe, the process's exit event and exit,
 *   and the output capture.
 */
export function upstreamDependencies(): StartDependencies {
  return {
    approvedPluginContent: changesApprovedContent,
    releasePacks: runningReleasePacks,
    preStartSteps: realPreStartSteps(upstreamAddStudioBundle, upstreamAddHeadlessBundle),
    async prepareProfile(profile) {
      // Loaded after the launch variables are set, so upstream resolves the Delorun home.
      const { INSTALL_ANCHOR, prepareProfile } = await import('@deepseek-ai/dsh/profile-boot')
      return { profile: prepareProfile(profile), installAnchor: INSTALL_ANCHOR }
    },
    // The home process's signal listener and the entry point's last-resort handler serve every Host it boots, so
    // upstream's runner installs neither per boot.
    runProfile: options => runUpstreamProfile(options, { signals: false, failLoud: false }),
    loadEnvironment: () => loadDelorunEnvironment(),
    probe: updateChannelProbe,
    onSignal: listenProcessSignals,
    fatalRelease: registerFatalRelease,
    onExit(listener) {
      process.on('exit', listener)
    },
    exit: (code) => { process.exit(code) },
    captureOutput: log => captureHomeOutput(log.log, true),
    runtime: home => runtimeOfFile(home, fileURLToPath(import.meta.url)),
    updates: storeUpdateSupport,
    checkRuntime: checkRunningRuntime,
    successorStartCheck: successorStartCheckRecord,
    handOff: request => handOffToComposedTree(request, processHandOff(runtimeOfFile(request.home, fileURLToPath(import.meta.url)), request.output)),
    handover: () => inheritedHandover(),
    opener: computerOpener(process.env),
    relaunch: request => relaunchForeground(request),
  }
}

/**
 * Run the home process for the CLI profile in this process: take the home lock, write a new start token, listen on
 * the update channel, and load and boot the profile as its Host. A profile that skipped a Delorun bundle is refused
 * before it boots; one in which a row of a Delorun bundle did not activate is shut down after its startup settles and
 * refused, which can come after the studio has opened in the browser. On success the profile's plugins keep the
 * process alive, and the lock, the token and the socket go when it exits; a refusal or a failed boot removes them
 * at once. A fresh start that failed right after a change starts once more without it ([retry](./changes/retry.ts)).
 * Run from the signed installation of a runtime whose harness has approved files, it first hands off to the composed
 * tree ([harness start](./changes/harness-start.ts)) and returns what that start returned; when the tree's `delorun`
 * failed before its start ran, this process leaves the newest harness change out and starts once more through the same
 * hand-off ([retry](./changes/retry.ts)).
 * @param request - the home, profile, studio choice and output.
 * @param dependencies - the profile preparation and runner, environment loader, holder probe, exit hooks, output
 *   capture and second start.
 * @returns `undefined` once the profile has booted: upstream's profile runner sets the exit code when the process ends;
 *   {@link EXIT.ok} when a home process for the profile already runs; the second start's result when a change was
 *   left out.
 * @throws {CliError} when the home has no CLI profile, the profile skipped a Delorun bundle, a row of a Delorun bundle did not
 *   activate, or the profile fails to boot.
 * @throws {HomeLayoutError} `HOME_UNRESPONSIVE` when the lock's holder lives but does not answer.
 * @throws {HostNotStoppedError} when a refused or failed start's Host did not stop; the process then ends with
 *   {@link EXIT.failed} in the next turn of the event loop, once the refusal has been reported.
 */
export async function startForeground(request: StartRequest, dependencies: StartDependencies = upstreamDependencies()): Promise<CommandResult> {
  const handed = await dependencies.handOff(request)
  if (handed === undefined) return retryForeground(request, () => startHomeProcess(request, dependencies), dependencies.relaunch)
  if (handed.kind === 'ran') return handed.ran
  const next = await retryHandOff(request, handed)
  if (next.kind === 'again') return startForeground({ ...request, env: next.env }, dependencies)
  process.exitCode = next.code
  return undefined
}

/**
 * The request a successor boots with: its environment carries the record of the start check the successor ran on its own
 * release.
 * @param request - the start.
 * @param running - the release this process runs.
 * @param logger - the home process's logger.
 * @param check - the successor's start check ({@link successorStartCheckRecord} in a real start).
 * @returns the request to boot with.
 * @throws whatever the check throws; the successor then does not boot.
 */
export async function successorRequest(request: StartRequest, running: RuntimeVersion, logger: DelorunLogger, check: typeof successorStartCheckRecord): Promise<StartRequest> {
  const record = await check(request.home, running, logger, request.env, Date.now())
  return { ...request, env: { ...request.env, [DELORUN_START_CHECK_ENV]: record } }
}

/**
 * {@link startForeground}'s one start in this process.
 * @param request - the home, profile, studio choice and output.
 * @param dependencies - the start's dependencies.
 * @returns as {@link startForeground}, without the second start.
 */
async function startHomeProcess(request: StartRequest, dependencies: StartDependencies): Promise<CommandResult> {
  if (!hasCliProfile(request.home, request.profile)) {
    throw new CliError(EXIT.failed, `delorun: the CLI profile ${request.profile} is not set up in ${request.home}; run: delorun setup`)
  }
  // The chat data and the runtime pointers are the whole home's: this process is a user of them for its whole life, so
  // another profile's update, copy, restore or rollback refuses while it runs ([home exclusion](./home-exclusion.ts)).
  dependencies.onExit(await registerHomeProcess(request.home, request.profile))
  // A successor reads its handover first: the start id it logs and locks under is the one the predecessor chose.
  const handover = await dependencies.handover()
  const startId = handover?.handover.startId ?? newStartId()
  const updatedFrom = updateSource(handover?.handover)
  const homeLog = openHomeLog({ home: request.home, profile: request.profile, startId, level: HOME_LOG_LEVEL, onFailure: () => {} })
  const restoreOutput = dependencies.captureOutput(homeLog)
  const dropEnvironment = registerEnvironment(request.env, homeLog.redactor)
  const closeLog = (): void => {
    dropEnvironment()
    restoreOutput()
    homeLog.log.close()
  }
  const runtime = dependencies.runtime(request.home)
  // The last-resort handler's fatal exit disposes the latest Host this process booted.
  let current: BootedProfile | undefined
  const unregisterRelease = dependencies.fatalRelease(async () => { await current?.dispose() })
  const tracked: StartDependencies = { ...dependencies, runProfile: async options => (current = await dependencies.runProfile(options)) }
  const retry = startRetry({ home: request.home, profile: request.profile, env: request.env, successor: handover !== undefined, output: request.output, logger: homeLog.logger, ...runtime.store ? { runtime: runtime.version } : {} })
  const booted: RunningHolder = { current: { kind: 'unknown' }, read: false }
  try {
    const running = handover?.handover.to ?? runtime.version
    // A successor that fails its own start check does not boot, so the predecessor's health check fails and it rolls back.
    const startRequest = handover !== undefined && runtime.store ? await successorRequest(request, running, homeLog.logger, dependencies.successorStartCheck) : request
    const options: HomeProcessOptions = {
      home: request.home,
      profile: request.profile,
      running,
      startId,
      // A Host booted again after the first, as after a failed switch, finds its active copies pointed at the release
      // that failed; a successor's first boot finds them pointed at its predecessor's.
      host: repointingBoot({ home: request.home, profile: request.profile, ...updatedFrom === undefined ? {} : { updatedFrom }, write: text => { homeLog.logger.info(text.trimEnd()) } }, handover !== undefined, async (access: Parameters<HomeProcessOptions['host']['boot']>[0], controls: Parameters<HomeProcessOptions['host']['boot']>[1]) => bootProfile(handover === undefined ? startRequest : { ...startRequest, open: false }, tracked, runtime.store ? { version: running, composed: runtime.composed } : undefined, homeLog, retry, { control: controls.restart, running: booted, channel: access })),
      ...runtime.store ? { restart: restartSupport(request.home, running, booted) } : {},
      preStart: () => runPreStartSteps(dependencies.preStartSteps, {
        home: request.home,
        profile: request.profile,
        kind: 'cli',
        successor: handover !== undefined,
        output: request.output,
        // A successor's runtime was checked by the update that started it.
        ...runtime.store && handover === undefined ? { storedRuntime: { version: running, check: () => dependencies.checkRuntime(request.home, running, homeLog.logger, launcherAnchor(request.home, request.env).root, fullCheckDaysOf(request.env), runtime.composed) } } : {},
      }),
      probe: dependencies.probe(request.home, request.profile),
      logger: homeLog.logger,
      redactor: homeLog.redactor,
      // An update's snapshot is held to the secret-field check of the Host that runs when it is taken.
      updates: runtime.store ? dependencies.updates(request.home, request.profile, running, homeLog.logger, request.env, files => current === undefined || current.rows().length === 0
        ? 'no Host is running to read which plugin settings are secret, so the snapshot is not saved'
        : secretFieldAdmission(current.configSchemas)(files)) : undefined,
      supervisor: undefined,
      onSignal: dependencies.onSignal,
      onExit: dependencies.onExit,
      exit: dependencies.exit,
    }
    if (handover === undefined) await HomeProcess.start(options)
    else await HomeProcess.takeOver(options, handover)
  } catch (error) {
    closeLog()
    unregisterRelease()
    if (error instanceof HostNotStoppedError) {
      // `main` reports the refusal in this turn of the event loop; the process then ends, and the Host that may still
      // run on the profile's data ends with it.
      setImmediate(() => { dependencies.exit(EXIT.failed) })
      throw error
    }
    if (!(error instanceof HomeLayoutError) || error.code !== 'HOME_RUNNING') {
      retry.stopped()
      throw error
    }
    const holder = readHomeLock(runDirectory(request.home, request.profile))
    request.output.stdout(`Delorun is already running for the profile ${request.profile}${holder === undefined ? '' : ` (process ${String(holder.pid)}, started ${holder.startedAt})`}.\n`)
    await announceStudio(request.home, request.profile, request.open, request.output, dependencies.opener)
    return EXIT.ok
  }
  if (handover === undefined) {
    const dangerous = await dangerousModeLine(request.home, profileDirectory(request.home, request.profile))
    if (dangerous !== undefined) request.output.stdout(`${dangerous}\n`)
    await announceStudio(request.home, request.profile, request.open, request.output, dependencies.opener)
  }
  dependencies.onExit(() => {
    closeLog()
    rmSync(sandboxOverlayPath(request.home, request.profile), { force: true })
  })
  if (handover === undefined) await runAfterStart(request, homeLog.logger)
  return undefined
}

/**
 * Run the start's {@link StartRequest.afterStart} work. A failure never stops the home process.
 * @param request - the start.
 * @param logger - the home process's logger.
 */
export async function runAfterStart(request: StartRequest, logger: Pick<DelorunLogger, 'error'>): Promise<void> {
  if (request.afterStart === undefined) return
  try {
    await request.afterStart()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`a step after the start failed: ${message}`, { err: error })
    request.output.stderr(`delorun: a step after the start failed: ${message}\nDelorun keeps running.\n`)
  }
}

/**
 * Settle a booted Host's patch files before it serves ([secret fields](./secret-fields.ts)) and report what was done; a
 * failure is reported as a notice and starts nothing over, because the configuration editor and the profile history
 * refuse the value meanwhile.
 * @param booted - the booted profile.
 * @param home - the Delorun home.
 * @param profile - the profile.
 * @param output - where the lines go.
 * @param log - the home process's log, when the command keeps one.
 */
export async function settleSecrets(booted: Pick<BootedProfile, 'settleSecretValues'>, home: string, profile: string, output: CommandOutput, log?: DelorunLogger): Promise<void> {
  let settlement: SecretSettlement
  try {
    settlement = await booted.settleSecretValues(home, profile)
  } catch (error) {
    settlement = { moved: [], notices: [`Delorun could not check the patch files of the profile ${profile} for plugin keys: ${error instanceof Error ? error.message : String(error)}. The profile history saves no version that holds one.`] }
  }
  reportSecretSettlement(settlement, output, log)
}

/**
 * Run the composed profile as the home process's Host, with the home log attached: the `.env` layers load, their
 * secret-named values are registered with the log's redactor, and the Host's root context receives `ctx.delorunSecrets`,
 * the credential registrations, the Cordis logger exporter, `ctx.changesHarness` and `ctx.changesRestart` before its first entry mounts.
 * @param dependencies - the environment loader and the profile runner.
 * @param homeLog - the home process's log.
 * @param options - the run options except the environment and the preparation hook, which this function supplies.
 * @param harness - the running runtime's harness, which the studio's Changes routes decide changes to Delorun itself
 *   against; undefined outside the runtime store.
 * @param restart - the home process's restart and what this Host boots with, which the studio's Restart route uses;
 *   undefined, or a control of undefined, outside the runtime store; `channel` is the home process's update channel,
 *   which the studio's update routes use.
 * @returns the booted profile.
 */
export function runHost(dependencies: Pick<StartDependencies, 'loadEnvironment' | 'runProfile'>, homeLog: HomeLog, options: Omit<RunProfileOptions, 'environment' | 'prepare'>, harness?: HarnessContext, restart?: { readonly control: RestartControl | undefined, readonly running: RunningComposition, readonly channel?: UpdateChannelAccess }): Promise<BootedProfile> {
  const environment = dependencies.loadEnvironment()
  // The `.env` layers apply their names to this process's environment, so the secret-named values they add are read from it.
  registerEnvironment(process.env, homeLog.redactor)
  return dependencies.runProfile({ ...options, environment, prepare: (root) => {
    attachHomeLogs(root, homeLog)
    provideChangesHarness(root, harness)
    if (restart !== undefined) {
      provideChangesRestart(root, restart.control, restart.running)
      provideUpdateChannel(root, restart.control === undefined ? undefined : restart.channel)
    }
  } })
}

/**
 * Compose the CLI profile and boot it: the home process's Host. The composition is the one every Host over a Delorun home
 * goes through ([compose](./compose.ts)), with C1's confinement on its sandbox row, whose overlay exists while the Host
 * runs; the booted Host is held to the composition's invariants before it serves. Changes records which of its plugins
 * loaded, or the boot's failure, and the Host follows work sessions until it stops ([changes](./changes/start.ts)).
 * @param request - the home, profile, studio choice and output.
 * @param dependencies - the profile preparation, runner and environment loader.
 * @param stored - the version this process runs from the store, whose files H1 checks, and the composed tree it runs
 *   from, which H1 checks too; `undefined` outside the store.
 * @param homeLog - the home process's log: its logger, and its redactor with which the Host registers its secrets.
 * @param retry - what leaves the newest change out when the boot fails or the booted Host is refused.
 * @param restart - the home process's restart, and the holder this boot records the composition it runs in.
 * @returns the running Host, whose running chats feed the home process's gate and whose health check is C3's.
 * Before the boot it sets {@link DEFAULT_WORKSPACE_ENV} to the studio's first-use workspace folder
 * ([default workspace](./default-workspace.ts)), and {@link NPM_MIRROR_ENV} to the profile's npm mirror setting.
 * @throws {CliError} when the profile skipped a Delorun bundle, no folder can hold the default workspace, the profile fails
 *   to boot, a row of a Delorun bundle did not activate, or the composed or booted profile breaks an invariant; a refused
 *   Host is first torn down within the home process's bound, without ending the process. Before the Host serves, the
 *   values for secret-role fields its patch files hold are moved into the credentials store ({@link settleSecrets}).
 * @throws {HostNotStoppedError} carrying the refusal when that teardown failed or overran.
 */
async function bootProfile(request: StartRequest, dependencies: StartDependencies, stored: { readonly version: RuntimeVersion, readonly composed: string | undefined } | undefined, homeLog: HomeLog, retry: StartRetry, restart: { readonly control: RestartControl, readonly running: RunningHolder, readonly channel: UpdateChannelAccess }): Promise<RunningHost> {
  const logger = homeLog.logger
  // What this process runs, read before its first Host boots: its tree never changes, so a Host it boots again after a
  // failed restart runs the same files. A record that cannot be read leaves it unknown, so every change waits for a restart.
  if (!restart.running.read) {
    restart.running.read = true
    restart.running.current = stored === undefined ? { kind: 'unknown' } : await runningComposition(request.home, stored.version, stored.composed).catch((error: unknown) => {
      logger.warn(`Delorun could not read which changes to Delorun itself this start runs; the studio counts each as waiting for a restart: ${error instanceof Error ? error.message : String(error)}`)
      return { kind: 'unknown' } as const
    })
  }
  const composed = await composeDelorunProfile({ home: request.home, profile: request.profile, kind: 'cli', output: request.output, env: request.env, ...request.patchFiles === undefined ? {} : { patchFiles: request.patchFiles } }, {
    prepareProfile: dependencies.prepareProfile,
    approvedPluginContent: dependencies.approvedPluginContent,
    releasePacks: dependencies.releasePacks,
  }).catch(async (error: unknown) => {
    await removeSandboxOverlay(request.home, request.profile)
    throw error
  })
  // The Host boots in this process, so `@delorun/bundle-local`'s `plugin-manager` row reads the mirror setting from here.
  process.env[NPM_MIRROR_ENV] = composed.npmMirror ? 'on' : 'off'
  // The Host boots in this process, so `@delorun/bundle-local`'s `workspace-controller` row reads the folder from here.
  try {
    const workspace = await resolveDefaultWorkspace(defaultWorkspaceRequest(request.home, composed.resolvedProfile.profile.patchPath))
    if (workspace.kind === 'resolved') process.env[DEFAULT_WORKSPACE_ENV] = workspace.directory
  } catch (error) {
    await removeSandboxOverlay(request.home, request.profile)
    throw error
  }
  let booted: BootedProfile
  try {
    booted = await runHost(dependencies, homeLog, {
      profile: request.profile,
      resolvedProfile: composed.resolvedProfile,
      patchFiles: composed.patchFiles,
      // The studio opens through the home process's `studio.open-token`, never through upstream's browser handoff.
      args: ['--no-open'],
    }, harnessContextOf(request.home, dependencies.runtime(request.home), request.env, logger), stored === undefined ? undefined : { control: restart.control, running: restart.running.current, channel: restart.channel })
  } catch (error) {
    await recordChangesBoot({ home: request.home, profile: request.profile, logger }, [], error)
    await removeSandboxOverlay(request.home, request.profile)
    await retry.afterFailure(error)
    throw new CliError(EXIT.failed, `delorun: the CLI profile ${request.profile} failed to start: ${error instanceof Error ? error.message : String(error)}`)
  }
  await recordChangesBoot({ home: request.home, profile: request.profile, logger }, booted.rows(), undefined, insertedRowsByLayer(composed.resolvedProfile.profile))
  try {
    const inactive = inactiveDelorunRows(booted.rows(), delorunRowIds(composed.resolvedProfile.profile, composed.packBundles), composed.packBundles)
    if (inactive.length > 0) throw inactiveRowsRefusal(request.profile, inactive)
    for (const pack of inactivePackRows(composed.resolvedProfile.profile, booted.rows(), composed.packBundles)) logger.warn(inactivePackWarning(request.profile, pack))
    assertDelorunInvariants(composed, booted)
    await retry.checkRows(booted.rows())
  } catch (error) {
    // The refused Host stops through its own teardown, which ends no process, so the home process's failed start runs.
    await refuseBootedHost(() => booted.dispose(), error).catch(async (failure: unknown) => {
      // The overlay stays while the refused Host may still run.
      if (failure instanceof HostNotStoppedError) throw failure
      await removeSandboxOverlay(request.home, request.profile)
      await retry.afterFailure(failure)
      throw failure
    })
  }
  await settleSecrets(booted, request.home, request.profile, request.output, logger)
  booted.releaseTurns()
  if (stored !== undefined) {
    await booted.watchUpdates({ home: request.home, profile: request.profile, platform: runtimePlatformOf(process.platform, process.arch), running: stored.version, anchor: launcherAnchor(request.home, request.env), line: (text) => { request.output.stdout(`${text}\n`) }, log: (text) => { logger.warn(text) } })
    booted.watchTrust?.(hostTrustOptions({ home: request.home, profile: request.profile, platform: `${process.platform}-${process.arch}`, running: stored.version, env: request.env, logger, node: process.execPath, fetch: PROCESS_FETCH, now: () => Math.floor(Date.now() / 1000), elapsed: () => performance.now() }))
  }
  return runningHost(booted, request, composed.startOnlySockets, async () => {
    if (stored !== undefined) await dependencies.checkRuntime(request.home, stored.version, logger, launcherAnchor(request.home, request.env).root, fullCheckDaysOf(request.env), stored.composed)
  }, afterChangesBoot({ home: request.home, profile: request.profile, logger }, booted), stored === undefined ? undefined : {
    version: stored.version,
    settings: previous => signedSettingChanges({ home: request.home, bundles: DELORUN_PROFILE_BUNDLES, running: stored.version, check: version => checkStoredRuntime(request.home, version, logger, launcherAnchor(request.home, request.env).root, fullCheckDaysOf(request.env)) }, previous),
  })
}

/**
 * The home process's Host over a booted profile: its chats counted into the home process's gate, its studio address,
 * the rows it had at boot (with the reach option a `reach.apply` since applied), C3's health check, and its two ways to stop. `close` stops it as the process stops, through
 * upstream's bounded shutdown, which may end the process when the teardown overruns its 5 seconds. `suspend` stops it
 * for an update's or a rollback's switch through the profile's own teardown, which ends no process; the home process
 * bounds that wait itself, so a slow teardown never ends the process in the middle of a switch.
 * @param booted - the booted profile.
 * @param request - the home and profile.
 * @param startOnly - the sockets only this start denies, found on the computer and listed by no layer, which stay out
 *   of what a successor's H3 holds it to.
 * @param verifyRuntime - C3's H1, the start check of the running version from the store.
 * @param endChanges - what both ways to stop run first: Changes stops following work sessions and ends the open one
 *   without the person ([changes](./changes/start.ts)).
 * @param release - the release this process runs from the store, and its reader of what the signed bundles change in protected rows (H3).
 * @returns the Host.
 */
export function runningHost(booted: BootedProfile, request: Pick<StartRequest, 'home' | 'profile'>, startOnly: readonly string[], verifyRuntime: () => Promise<void>, endChanges: () => Promise<void>, release?: HostHealthFacts['release']): RunningHost {
  const chats = new CountingChatGate()
  booted.watchChats(chats)
  const atBoot = booted.rows()
  const failed = inactiveRows(atBoot)
  let handedRows = bootRowsOf(atBoot, personRowsOf(request.home, request.profile))
  const bootReach = atBoot.find(row => row.id === REACH_ROW_ID)?.config
  const atBootProtection = bootProtectionOf(atBoot, startOnly)
  return {
    ...withDevices(booted),
    ...booted.agents === undefined ? {} : { agents: booted.agents() },
    ...withReach(booted, request, (option) => { handedRows = withAppliedConfig(handedRows, REACH_ROW_ID, appliedReachConfig(bootReach, option)) }),
    chats,
    studio: () => {
      const address = booted.studio()
      return address === undefined ? undefined : `http://${address.host.includes(':') ? `[${address.host}]` : address.host}:${String(address.port)}/`
    },
    studioLink: booted.studioLink,
    reload: () => booted.reload(),
    failedRows: () => failed,
    rows: () => handedRows,
    protection: () => atBootProtection,
    check: expect => checkHealth({ rows: booted.rows, studio: booted.studio, profileDir: join(request.home, 'profiles', request.profile), verifyRuntime, ...release === undefined ? {} : { release } }, expect),
    close: async () => {
      await endChanges()
      await booted.shutdown(EXIT.ok)
      await removeSandboxOverlay(request.home, request.profile)
    },
    suspend: async () => {
      await endChanges()
      await booted.dispose()
      await removeSandboxOverlay(request.home, request.profile)
    },
  }
}

/**
 * The running Host's local device approval and consents, for the update channel's `devices.*`, `permission.reload` and
 * `mcp.*` operations.
 * @param booted - the booted profile.
 * @returns `devices` when the profile loads `@delorun/home-auth`, and `consents` when the booted profile offers them.
 */
function withDevices(booted: BootedProfile): { readonly devices?: LocalDeviceApproval, readonly consents?: LocalConsents } {
  const devices = booted.devices?.()
  const consents = booted.consents?.()
  return { ...devices === undefined ? {} : { devices }, ...consents === undefined ? {} : { consents } }
}

/**
 * The running Host's reach operations, for the update channel's `reach.status` and `reach.apply`: an apply reads the
 * profile's own `delorun-reach` row, which `delorun reach on|off` wrote, when it arrives.
 * @param booted - the booted profile.
 * @param request - the home and profile.
 * @param applied - receives the Tailscale private option the service restarted from, once the service ran an apply.
 * @returns `reach` when the profile loads `@delorun/reach`, otherwise nothing.
 */
function withReach(booted: BootedProfile, request: Pick<StartRequest, 'home' | 'profile'>, applied: (option: TailscalePrivateRow) => void): { readonly reach?: LocalReach } {
  let option: TailscalePrivateRow | undefined
  const reach = booted.reach?.(() => {
    option = readReachRow(request.home, request.profile)
    return reachRowsOf(option)
  })
  if (reach === undefined) return {}
  return {
    reach: {
      status: () => reach.status(),
      apply: async () => {
        option = undefined
        const options = await reach.apply()
        if (options !== undefined && option !== undefined) applied(option)
        return options
      },
    },
  }
}

/**
 * `delorun start` without `--foreground`: start the home process detached from the terminal and wait for it to report
 * `running`, then say that it keeps running, where the studio is and how to watch and stop it. When the home process
 * left a change out because it did not start with it, the words name the change and the home process starts once more
 * without it ([retry](./changes/retry.ts)).
 * @param home - the prepared Delorun home.
 * @param profile - the CLI profile.
 * @param output - where the command writes.
 * @param open - whether this command opens the studio in the browser once the home process runs.
 * @param opener - how the studio is opened; this computer's by default.
 * @param forwarded - the `--patch` and `--inspect` options the detached `delorun start --foreground` receives.
 * @returns {@link EXIT.ok} when the home process runs, {@link EXIT.failed} when it exited or did not report `running`
 *   within 120 seconds.
 * @throws {CliError} when the home has no CLI profile.
 */
export async function startDetached(home: string, profile: string, output: CommandOutput, open = false, opener: StudioOpener = computerOpener(process.env), forwarded: readonly string[] = []): Promise<CommandResult> {
  if (!hasCliProfile(home, profile)) throw new CliError(EXIT.failed, `delorun: the CLI profile ${profile} is not set up in ${home}; run: delorun setup`)
  const running = await answeringStatus(home, profile)
  if (running !== undefined) {
    output.stdout(`Delorun is already running for the profile ${profile}.\n`)
    await announceStudio(home, profile, open, output, opener)
    return EXIT.ok
  }
  const argument = process.argv[1]
  if (argument === undefined) throw new CliError(EXIT.failed, 'delorun: the command\'s own entry point is unknown, so the home process cannot be started')
  // The signed installation's entry, which hands off to the composed tree itself when the harness has approved files.
  const entry = startEntry({ node: process.execPath, entry: argument })
  const handing = await handsOff(home, profile, runtimeOfFile(home, fileURLToPath(import.meta.url)))
  return retryDetached({ home, profile, output }, async (variables) => {
    const outcome = await launchDetached(home, profile, output, { ...entry, handsOff: handing }, variables, forwarded)
    if (outcome.kind === 'running') await announceStudio(home, profile, open, output, opener, false)
    return outcome
  })
}

/**
 * Start `delorun start --foreground` detached and wait for it to report `running`, saying how it went; a home process
 * that exited with {@link EXIT.changeLeftOut} is left to its starter's words.
 * @param home - the prepared Delorun home.
 * @param profile - the CLI profile.
 * @param output - where the command writes.
 * @param entry - the Node executable and entry point to start, and whether that start hands off to a composed tree,
 *   whose home process is the child's child and so has another process id.
 * @param variables - variables added to this process's environment for the home process.
 * @param forwarded - the `--patch` and `--inspect` options the home process receives.
 * @returns how the start ended.
 */
async function launchDetached(home: string, profile: string, output: CommandOutput, entry: { readonly node: string, readonly entry: string, readonly handsOff: boolean }, variables: Readonly<Record<string, string>>, forwarded: readonly string[]): Promise<DetachedOutcome> {
  const child = spawn(entry.node, [...process.execArgv, entry.entry, 'start', '--foreground', '--profile', profile, ...forwarded], { detached: true, stdio: 'ignore', env: { ...process.env, ...variables } })
  let exitCode: number | null | undefined
  child.once('exit', (code) => { exitCode = code })
  child.unref()
  const log = resolveSurface({ kind: 'home', home, profile }).file
  const deadline = Date.now() + START_WAIT_MS
  const style = styleOf(process.env)
  const spinner = startSpinner('Starting Delorun', style)
  while (Date.now() < deadline) {
    const status = await answeringStatus(home, profile)
    if (status?.state === 'running' && (status.pid === child.pid || (entry.handsOff && exitCode === undefined))) {
      const notice = await startNoticeLine(home, profile, process.env)
      const dangerous = await dangerousModeLine(home, profileDirectory(home, profile))
      const address = studioAddress(status.studio)
      output.stdout([
        spinner.stop('ok', `Delorun is running${profile === 'default' ? '' : ` for the profile ${profile}`}${address === undefined ? '' : ` · ${address.href}`}`),
        `  ${style.dim('It keeps running after you close this terminal.')}`,
        ...commandRows(style, [[`delorun open${profileFlag(profile)}`, 'open the studio'], [`delorun logs --follow${profileFlag(profile)}`, 'watch what it does'], [`delorun stop${profileFlag(profile)}`, 'stop it']]),
        ...dangerous === undefined ? [] : [dangerous],
        ...notice === undefined ? [] : [notice],
        '',
      ].join('\n'))
      return { kind: 'running' }
    }
    if (exitCode !== undefined) {
      spinner.stop('fail', 'Delorun did not start')
      if (exitCode !== EXIT.changeLeftOut) output.stderr(startFailure(profile, `Delorun stopped with exit code ${String(exitCode)} before it was running`, log))
      return { kind: 'exited', code: exitCode }
    }
    await sleep(100)
  }
  spinner.stop('fail', 'Delorun did not start')
  output.stderr(startFailure(profile, `Delorun was not running after ${String(START_WAIT_MS / 1000)} seconds`, log))
  return { kind: 'timeout' }
}

/** How much of the end of the home log a failed start reads for its cause. */
const FAILURE_LOG_BYTES = 65_536

/**
 * The failed-start report: what happened, a busy port when the log says so, and the commands that show why.
 * @param profile - the CLI profile.
 * @param what - what happened, as a sentence without a full stop.
 * @param log - the home log's path.
 * @returns the report, ending with a newline.
 */
export function startFailure(profile: string, what: string, log: string): string {
  const flag = profileFlag(profile)
  const tail = homeLogTail(log)
  const busy = tail.some(line => /EADDRINUSE|address already in use/i.test(line))
  const unbuilt = tail.some(line => /(?:ERR_MODULE_NOT_FOUND|Cannot find module)[^]*\/lib\//.test(line))
  return [
    `delorun start: Delorun did not start. ${what}.`,
    ...unbuilt ? ['A built file is missing. In a source checkout, run pnpm run build:artifacts and pnpm --filter @delorun/bundle-local run build, then start again.'] : [],
    ...busy ? [`Another program is using the studio's port. Choose another port with delorun setup profile${flag}, or set the port to 0 in the profile so Delorun picks a free one.`] : [],
    `Run delorun logs${flag} to see why, then delorun doctor${flag} to check your setup.`,
    '',
  ].join('\n')
}

/**
 * The last lines of the home log.
 * @param log - the log's path.
 * @returns the lines; none when the log does not read.
 */
function homeLogTail(log: string): string[] {
  let descriptor: number
  try {
    descriptor = openSync(log, 'r')
  } catch (error: unknown) {
    // A log that was never created has no cause to show; `delorun logs` says so.
    void error
    return []
  }
  try {
    const size = fstatSync(descriptor).size
    const length = Math.min(size, FAILURE_LOG_BYTES)
    const buffer = Buffer.alloc(length)
    readSync(descriptor, buffer, 0, length, size - length)
    return buffer.toString('utf8').split('\n')
  } finally {
    closeSync(descriptor)
  }
}

/**
 * The status of a profile's home process when it answers.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @returns the status, or `undefined` when no home process answers.
 */
async function answeringStatus(home: string, profile: string): Promise<{ readonly pid: number, readonly state: string, readonly studio?: string } | undefined> {
  try {
    const answer = await queryHomeStatus(home, profile, HOME_STATUS_TIMEOUT_MS)
    if (!('state' in answer) || typeof answer.pid !== 'number' || typeof answer.state !== 'string') return undefined
    return { pid: answer.pid, state: answer.state, ...typeof answer.studio === 'string' ? { studio: answer.studio } : {} }
  } catch (_notAnswering) {
    // No token file, no socket or no answer: no home process answers for the profile.
    return undefined
  }
}

/** How a start's command line asks it to run: `--foreground`, `--background`, or neither. */
export interface StartFlags {
  readonly foreground: boolean
  readonly background: boolean
}

/** What a start runs as, and whether the command line or setup's answer chose it. */
export interface StartChoice {
  readonly detached: boolean
  /** Whether the command line chose it with `--foreground` or `--background`. */
  readonly explicit: boolean
}

/**
 * Whether a start detaches from the terminal: `--background` detaches and `--foreground` does not, whatever setup
 * answered; without either the profile's setup answer chooses, and a missing answers record keeps the default.
 * @param command - the command's name, for the usage error.
 * @param flags - the options given.
 * @param profileDirectory - the CLI profile's directory.
 * @returns the choice.
 * @throws {CliError} {@link EXIT.usage} when both options are given.
 */
export function startChoice(command: string, flags: StartFlags, profileDirectory: string): StartChoice {
  if (flags.foreground && flags.background) throw new CliError(EXIT.usage, `delorun${command === '' ? '' : ` ${command}`}: --background and --foreground cannot be used together; choose one`)
  if (flags.background) return { detached: true, explicit: true }
  if (flags.foreground) return { detached: false, explicit: true }
  return { detached: readBackgroundAnswer(profileDirectory), explicit: false }
}

/**
 * What a start that runs in this terminal because of setup's answer prints last.
 * @param profile - the CLI profile, named with `--profile` unless it is the default.
 * @returns the lines.
 */
export function foregroundHint(profile: string): string {
  const flag = profileFlag(profile)
  return `Delorun runs in this terminal; closing the terminal stops it. To keep it running after the terminal closes, start it with delorun start --background${flag}, or run delorun setup background${flag} to make that the default.\n`
}

/**
 * The absolute paths of `--patch` files.
 * @param files - the values given, relative to the working directory or absolute.
 * @returns their absolute paths.
 * @throws {CliError} for a file that does not exist.
 */
export function patchFilesOf(files: readonly string[]): string[] {
  return files.map((file) => {
    const path = resolve(file)
    if (!existsSync(path)) throw new CliError(EXIT.usage, `delorun start: --patch ${file} does not exist`)
    return path
  })
}

/** `delorun start [--foreground | --background] [--open] [--profile <name>] [--patch <file>]... [--inspect [--yes]]`. */
export const startCommand: CliCommand = {
  name: 'start',
  summary: 'Start the home process: --background detaches it from the terminal, --foreground keeps it in this terminal; without either, setup\'s answer chooses; --patch adds overlays',
  async run(args, context) {
    const values = parseOptions('start', args, { foreground: { type: 'boolean', default: false }, background: { type: 'boolean', default: false }, open: { type: 'boolean', default: false }, profile: { type: 'string' }, patch: { type: 'string', multiple: true }, inspect: { type: 'boolean', default: false }, yes: { type: 'boolean', default: false } })
    if (values.yes === true && values.inspect !== true) throw new CliError(EXIT.usage, 'delorun start: --yes confirms --inspect, and is refused without it')
    const { home, profile } = await prepareHome(context, values.profile, false)
    const patchFiles = patchFilesOf(values.patch ?? [])
    const inspect = values.inspect === true
    const choice = startChoice('start', { foreground: values.foreground === true, background: values.background === true }, profileDirectory(home.path, profile))
    if (inspect) await inspectorConsent({ home: home.path, profile, yes: values.yes === true, confirm: terminalInspectorConfirm() })
    if (choice.detached) {
      // The person confirmed here, so the detached home process gets --yes.
      const forwarded = [...patchFiles.flatMap(file => ['--patch', file]), ...inspect ? ['--inspect', '--yes'] : []]
      return startDetached(home.path, profile, context, values.open === true, computerOpener(process.env), forwarded)
    }
    const holder = readHomeLock(runDirectory(home.path, profile))
    // A profile whose home process runs already gets no second inspector: this start only reports that process.
    if (inspect && (holder === undefined || !holderAlive(holder))) openDebugger(home.path, profile, context)
    const result = await startForeground({ home: home.path, profile, open: values.open === true, output: context, env: context.env, ...patchFiles.length === 0 ? {} : { patchFiles } })
    if (result === undefined && !choice.explicit) context.stdout(foregroundHint(profile))
    return result
  },
}
