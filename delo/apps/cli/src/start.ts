/**
 * `delorun start` and the start half of a bare `delorun` (contract C19, "Commands"): the home process of
 * [`@delo/home-process`](../../../packages/home-process/README.md) for the CLI profile, whose Host is the profile
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
 *
 * A second start for a profile whose home process answers prints that process and exits 0. A profile that skipped a
 * Delo bundle is refused before it boots, and one in which a row of a Delo bundle did not activate is shut down and
 * refused after it boots ([delo-bundles](./delo-bundles.ts)).
 *
 * Run from `runtimes/<version>/` of C1's store, the home process gets the update support of [update](./update/support.ts);
 * its Host counts running chats and runs C3's health check ([host](./update/host.ts)). A process whose descriptor 3
 * is a socket or a pipe was started by an update as the successor and takes over through `HomeProcess.takeOver`.
 *
 * @module @delo/cli/start
 */
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ResolvedProfileRuntime, RunProfileOptions } from '@deepseek-ai/dsh/profile-boot'
import { assertDeloInvariants, composeDeloProfile, NO_APPROVED_CONTENT, type ApprovedPluginContent, type ServiceProvider } from './compose.ts'
import { HEADLESS_PROFILE, HOME_STATUS_TIMEOUT_MS, type RuntimeVersion } from '@delo/contract-home-layout'
import type { ReachConfigRows } from '@delo/contract-reach-providers'
import { START_WAIT_MS } from '@delo/contract-home-process'
import { localDeviceApproval } from './devices/host.ts'
import { localConsents } from './consents/host.ts'
import { CountingChatGate, HomeProcess, HostNotStoppedError, listenProcessSignals, openHomeLog, captureHomeOutput, queryHomeStatus, refuseBootedHost, updateChannelProbe, type HandoverPipe, type HomeLog, type HomeProcessOptions, type LocalConsents, type LocalDeviceApproval, type LocalReach, type RunningHost, type StudioLinkResult, type UpdateSupport } from '@delo/home-process'
import { localReach, reachRowsOf } from './reach/host.ts'
import { readReachRow } from './reach/row.ts'
import { resolveSurface, type DeloLogger } from '@delo/logs'
import { CliError, EXIT } from './exit.ts'
import { parseOptions, prepareHome, type CliCommand, type CommandOutput, type CommandResult } from './command.ts'
import { HomeLayoutError, isFailClosedStub, newStartId, readHomeLock, runDirectory, type HolderProbe } from '@delo/home'
import { DEFAULT_WORKSPACE_ENV, defaultWorkspaceRequest, resolveDefaultWorkspace } from './default-workspace.ts'
import { NPM_MIRROR_ENV } from '@delo/bundle-local/profile'
import { deloRowIds, inactiveDeloRows, inactiveRowsRefusal, type BootedRow, type RowState } from './delo-bundles.ts'
import { registerHomeProcess } from './home-exclusion.ts'
import { announceStudio } from './open/announce.ts'
import { hostStudioLink } from './open/host-link.ts'
import { computerOpener, profileFlag, type StudioOpener } from './open/studio.ts'
import { shippedPackageManager } from './package-manager.ts'
import { hasCliProfile, profileDirectory } from './profile.ts'
import { readBackgroundAnswer } from './setup/background.ts'
import { openSetupLog, upstreamLinking } from './setup/index.ts'
import { addStudioBundle } from './studio-bundle.ts'
import { preStartSteps, runPreStartSteps, type PreStartStep } from './pre-start.ts'
import { addHeadlessBundle, headlessBundleMigration } from './headless-bundle.ts'
import { studioBundleMigration } from './profile-migrations.ts'
import { checkInstalledPlugins } from './plugin-install-check.ts'
import { copyImportMigration } from './pnpm-import.ts'
import { removeSandboxOverlay, sandboxOverlayPath } from './sandbox-protection.ts'
import { configSchemasOf, guardSecretFields, reportSecretSettlement, settleSecretValues, type SecretSettlement } from './secret-fields.ts'
import { secretFieldAdmission, type ConfigSchemasOf } from '@delo/profile-safety'
import type { VersionAdmission } from '@deepseek-ai/dsh-plugin-manager/history'
import { bootProtectionOf, bootRowsOf, checkHealth, inactiveRows, serveHealth, watchChats } from './update/host.ts'
import { inheritedHandover, runtimeOfFile, type RunningRuntime } from './update/runtime.ts'
import { checkStoredRuntime, fullCheckDaysOf, storeUpdateSupport } from './update/store-support.ts'
import { launcherAnchor } from './update/trusted-root.ts'
import { loadDeloEnvironment } from './launch-environment.ts'
import { registerFatalRelease } from './last-resort.ts'
import { runtimePlatformOf } from './update/channel.ts'
import { startNoticeLine, watchUpdates, type UpdateWatchOptions } from './update/notice-host.ts'

/**
 * Adds `@delo/bundle-studio` to a profile setup created before it existed ({@link addStudioBundle}).
 * @param home - the Delo home.
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
  /** Loads the launch environment with upstream's `.env` layers, refusing a `DELO_` name in one ({@link loadDeloEnvironment}). */
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
   * @param home - the resolved Delo home.
   * @returns the version and whether it runs from the store.
   */
  readonly runtime: (home: string) => RunningRuntime
  /**
   * The update support of a home process that runs from the store; {@link storeUpdateSupport} by default.
   * @param home - the resolved Delo home.
   * @param profile - the CLI profile.
   * @param running - the version this process runs.
   * @param logger - the home process's logger.
   * @param env - the environment `delorun` was started with, read for the launcher's release roots.
   * @param admitVersion - decides whether an update's snapshot may be saved: the running Host's secret-field check.
   * @returns the support.
   */
  readonly updates: (home: string, profile: string, running: RuntimeVersion, logger: DeloLogger, env: Readonly<Record<string, string | undefined>>, admitVersion: VersionAdmission) => UpdateSupport
  /**
   * The handover pipe when this process was started as an update's successor, which inherits it as file descriptor 3.
   * @returns the pipe, or `undefined` for a fresh start.
   */
  readonly handover: () => Promise<HandoverPipe | undefined>
  /** How a start that opens the studio asks the home process for a link and opens it ({@link computerOpener}). */
  readonly opener: StudioOpener
  /** The composition's approved plugin content step ([compose](./compose.ts)); {@link NO_APPROVED_CONTENT} in a real start. */
  readonly approvedPluginContent: ApprovedPluginContent
  /** The ordered steps before any Host boots ([pre-start](./pre-start.ts)); {@link realPreStartSteps} in a real start. */
  readonly preStartSteps: readonly PreStartStep[]
}

/**
 * Links Delo's headless bundle into the home's `headless` profile ({@link addHeadlessBundle}).
 * @param home - the Delo home.
 * @param output - where pnpm's output goes.
 * @returns whether the profile's bundle list did not name the bundle before.
 */
export type AddHeadlessBundle = (home: string, output: CommandOutput) => Promise<boolean>

/**
 * The real pre-start steps: the CLI profile's migration adds Delo's studio bundle to a profile set up before it
 * shipped, and the `headless` profile's links Delo's headless bundle; both then set the profile's package import method
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
    pluginChanges: async (context) => {
      const { INSTALL_ANCHOR } = await import('@deepseek-ai/dsh/profile-boot')
      await checkInstalledPlugins({ home: context.home, profile: context.profile, profileDir: profileDirectory(context.home, context.profile), installAnchor: INSTALL_ANCHOR, full: false, output: context.output })
    },
  })
}


/** A booted profile, as the start's audit of Delo's rows reads it. */
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
   * passed it. A Host without the `deloTurnGate` service holds no turn, and this does nothing.
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
  /** The local device approval of `@delo/home-auth`, when the profile loads it. */
  readonly devices?: () => LocalDeviceApproval | undefined
  /** The consents of `@delo/plugin-permission-defaults` and `@delo/plugin-mcp-consent`, each read per operation. */
  readonly consents?: () => LocalConsents
  /** The Config schemas of the Loader's rows, which the secret-field checks read ([secret fields](./secret-fields.ts)). */
  readonly configSchemas: ConfigSchemasOf
  /**
   * Move each value for a secret-role field out of the profile patch and the home patch into the credentials store,
   * where the plugin can name it ([secret fields](./secret-fields.ts)).
   * @param home - the Delo home.
   * @param profile - the profile.
   * @returns what was moved and what stays.
   */
  readonly settleSecretValues: (home: string, profile: string) => Promise<SecretSettlement>
  /**
   * The reach service of `@delo/reach`, when the profile loads it ([reach host](./reach/host.ts)).
   * @param rows - reads the profile's `delo-reach` row when `reach.apply` arrives.
   * @returns the reach operations, or undefined without the service.
   */
  readonly reach?: (rows: () => ReachConfigRows) => LocalReach | undefined
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
  /** The prepared Delo home. */
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
  // Loaded after the launch variables are set, so upstream resolves the Delo home.
  const { runProfile } = await import('@deepseek-ai/dsh/profile-boot')
  // An installed Delo's plugin manager runs the pnpm its closure carries ([package manager](./package-manager.ts)).
  const packageManager = shippedPackageManager()
  const { ctx, shutdown } = await runProfile({
    ...options, signals: handlers.signals, failLoud: handlers.failLoud, ...packageManager === undefined ? {} : { packageManager },
    // Before the Loader mounts its first row, so an edit a plugin saves while it starts is guarded too.
    prepare: (root) => { guardSecretFields(root, configSchemasOf(root)) },
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
    reach: rows => localReach(ctx, rows),
    watchUpdates: async options => watchUpdates(ctx, options),
    // The CLI profile's invariants require the service, so it is absent only in a profile that holds no turn.
    releaseTurns: () => { ctx.get('deloTurnGate')?.release() },
    studio: () => {
      const server = ctx.get('webServer')
      return server?.port === undefined ? undefined : { host: server.host, port: server.port }
    },
    studioLink: port => hostStudioLink(ctx, port),
  }
}

/**
 * Add the studio bundle through upstream's resolution and `dsh plugin add`.
 * @param home - the Delo home.
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
 * @param home - the Delo home.
 * @param output - where the progress line goes; pnpm's output goes to the `headless` profile's `home-headless` log.
 * @returns whether the profile's bundle list did not name the bundle before.
 */
export async function upstreamAddHeadlessBundle(home: string, output: CommandOutput): Promise<boolean> {
  const log = openSetupLog(home, HEADLESS_PROFILE)
  try {
    return await addHeadlessBundle(home, () => upstreamLinking(home, HEADLESS_PROFILE), { log, progress: (text) => { output.stdout(text) } })
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
    approvedPluginContent: NO_APPROVED_CONTENT,
    preStartSteps: realPreStartSteps(upstreamAddStudioBundle, upstreamAddHeadlessBundle),
    async prepareProfile(profile) {
      // Loaded after the launch variables are set, so upstream resolves the Delo home.
      const { INSTALL_ANCHOR, prepareProfile } = await import('@deepseek-ai/dsh/profile-boot')
      return { profile: prepareProfile(profile), installAnchor: INSTALL_ANCHOR }
    },
    // The home process's signal listener and the entry point's last-resort handler serve every Host it boots, so
    // upstream's runner installs neither per boot.
    runProfile: options => runUpstreamProfile(options, { signals: false, failLoud: false }),
    loadEnvironment: () => loadDeloEnvironment(),
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
    handover: () => inheritedHandover(),
    opener: computerOpener(process.env),
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
 * @throws {HostNotStoppedError} when a refused or failed start's Host did not stop; the process then ends with
 *   {@link EXIT.failed} in the next turn of the event loop, once the refusal has been reported.
 */
export async function startForeground(request: StartRequest, dependencies: StartDependencies = upstreamDependencies()): Promise<CommandResult> {
  if (!hasCliProfile(request.home, request.profile)) {
    throw new CliError(EXIT.failed, `delorun: the CLI profile ${request.profile} is not set up in ${request.home}; run: delorun setup`)
  }
  // The chat data and the runtime pointers are the whole home's: this process is a user of them for its whole life, so
  // another profile's update, copy, restore or rollback refuses while it runs ([home exclusion](./home-exclusion.ts)).
  dependencies.onExit(await registerHomeProcess(request.home, request.profile))
  // A successor reads its handover first: the start id it logs and locks under is the one the predecessor chose.
  const handover = await dependencies.handover()
  const startId = handover?.handover.startId ?? newStartId()
  const homeLog = openHomeLog({ home: request.home, profile: request.profile, startId, level: HOME_LOG_LEVEL, onFailure: () => {} })
  const restoreOutput = dependencies.captureOutput(homeLog)
  const closeLog = (): void => {
    restoreOutput()
    homeLog.log.close()
  }
  const runtime = dependencies.runtime(request.home)
  // The last-resort handler's fatal exit disposes the latest Host this process booted.
  let current: BootedProfile | undefined
  const unregisterRelease = dependencies.fatalRelease(async () => { await current?.dispose() })
  const tracked: StartDependencies = { ...dependencies, runProfile: async options => (current = await dependencies.runProfile(options)) }
  try {
    const running = handover?.handover.to ?? runtime.version
    const options: HomeProcessOptions = {
      home: request.home,
      profile: request.profile,
      running,
      startId,
      host: {
        boot: () => bootProfile(handover === undefined ? request : { ...request, open: false }, tracked, runtime.store ? running : undefined, homeLog.logger),
      },
      preStart: () => runPreStartSteps(dependencies.preStartSteps, { home: request.home, profile: request.profile, kind: 'cli', successor: handover !== undefined, output: request.output }),
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
    if (!(error instanceof HomeLayoutError) || error.code !== 'HOME_RUNNING') throw error
    const holder = readHomeLock(runDirectory(request.home, request.profile))
    request.output.stdout(`Delo is already running for the profile ${request.profile}${holder === undefined ? '' : ` (process ${String(holder.pid)}, started ${holder.startedAt})`}.\n`)
    await announceStudio(request.home, request.profile, request.open, request.output, dependencies.opener)
    return EXIT.ok
  }
  if (handover === undefined) await announceStudio(request.home, request.profile, request.open, request.output, dependencies.opener)
  dependencies.onExit(() => {
    closeLog()
    rmSync(sandboxOverlayPath(request.home, request.profile), { force: true })
  })
  return undefined
}

/**
 * Settle a booted Host's patch files before it serves ([secret fields](./secret-fields.ts)) and report what was done; a
 * failure is reported as a notice and starts nothing over, because the configuration editor and the profile history
 * refuse the value meanwhile.
 * @param booted - the booted profile.
 * @param home - the Delo home.
 * @param profile - the profile.
 * @param output - where the lines go.
 * @param log - the home process's log, when the command keeps one.
 */
export async function settleSecrets(booted: Pick<BootedProfile, 'settleSecretValues'>, home: string, profile: string, output: CommandOutput, log?: DeloLogger): Promise<void> {
  let settlement: SecretSettlement
  try {
    settlement = await booted.settleSecretValues(home, profile)
  } catch (error) {
    settlement = { moved: [], notices: [`Delo could not check the patch files of the profile ${profile} for plugin keys: ${error instanceof Error ? error.message : String(error)}. The profile history saves no version that holds one.`] }
  }
  reportSecretSettlement(settlement, output, log)
}

/**
 * Compose the CLI profile and boot it: the home process's Host. The composition is the one every Host over a Delo home
 * goes through ([compose](./compose.ts)), with C1's confinement on its sandbox row, whose overlay exists while the Host
 * runs; the booted Host is held to the composition's invariants before it serves.
 * @param request - the home, profile, studio choice and output.
 * @param dependencies - the profile preparation, runner and environment loader.
 * @param stored - the version this process runs from the store, whose files H1 checks; `undefined` outside the store.
 * @param logger - the home process's logger.
 * @returns the running Host, whose running chats feed the home process's gate and whose health check is C3's.
 * Before the boot it sets {@link DEFAULT_WORKSPACE_ENV} to the studio's first-use workspace folder
 * ([default workspace](./default-workspace.ts)), and {@link NPM_MIRROR_ENV} to the profile's npm mirror setting.
 * @throws {CliError} when the profile skipped a Delo bundle, no folder can hold the default workspace, the profile fails
 *   to boot, a row of a Delo bundle did not activate, or the composed or booted profile breaks an invariant; a refused
 *   Host is first torn down within the home process's bound, without ending the process. Before the Host serves, the
 *   values for secret-role fields its patch files hold are moved into the credentials store ({@link settleSecrets}).
 * @throws {HostNotStoppedError} carrying the refusal when that teardown failed or overran.
 */
async function bootProfile(request: StartRequest, dependencies: StartDependencies, stored: RuntimeVersion | undefined, logger: DeloLogger): Promise<RunningHost> {
  const composed = await composeDeloProfile({ home: request.home, profile: request.profile, kind: 'cli', output: request.output, env: request.env }, {
    prepareProfile: dependencies.prepareProfile,
    approvedPluginContent: dependencies.approvedPluginContent,
  }).catch(async (error: unknown) => {
    await removeSandboxOverlay(request.home, request.profile)
    throw error
  })
  // The Host boots in this process, so `@delo/bundle-local`'s `plugin-manager` row reads the mirror setting from here.
  process.env[NPM_MIRROR_ENV] = composed.npmMirror ? 'on' : 'off'
  // The Host boots in this process, so `@delo/bundle-local`'s `workspace-controller` row reads the folder from here.
  try {
    const workspace = await resolveDefaultWorkspace(defaultWorkspaceRequest(request.home, composed.resolvedProfile.profile.patchPath))
    if (workspace.kind === 'resolved') process.env[DEFAULT_WORKSPACE_ENV] = workspace.directory
  } catch (error) {
    await removeSandboxOverlay(request.home, request.profile)
    throw error
  }
  let booted: BootedProfile
  try {
    booted = await dependencies.runProfile({
      environment: dependencies.loadEnvironment(),
      profile: request.profile,
      resolvedProfile: composed.resolvedProfile,
      patchFiles: composed.patchFiles,
      // The studio opens through the home process's `studio.open-token`, never through upstream's browser handoff.
      args: ['--no-open'],
    })
  } catch (error) {
    await removeSandboxOverlay(request.home, request.profile)
    throw new CliError(EXIT.failed, `delorun: the CLI profile ${request.profile} failed to start: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const inactive = inactiveDeloRows(booted.rows(), deloRowIds(composed.resolvedProfile.profile))
    if (inactive.length > 0) throw inactiveRowsRefusal(request.profile, inactive)
    assertDeloInvariants(composed, booted)
  } catch (error) {
    // The refused Host stops through its own teardown, which ends no process, so the home process's failed start runs.
    await refuseBootedHost(() => booted.dispose(), error).catch(async (failure: unknown) => {
      // The overlay stays while the refused Host may still run.
      if (!(failure instanceof HostNotStoppedError)) await removeSandboxOverlay(request.home, request.profile)
      throw failure
    })
  }
  await settleSecrets(booted, request.home, request.profile, request.output, logger)
  booted.releaseTurns()
  if (stored !== undefined) {
    await booted.watchUpdates({ home: request.home, profile: request.profile, platform: runtimePlatformOf(process.platform, process.arch), running: stored, anchor: launcherAnchor(request.home, request.env), line: (text) => { request.output.stdout(`${text}\n`) }, log: (text) => { logger.warn(text) } })
  }
  return runningHost(booted, request, composed.startOnlySockets, async () => {
    if (stored !== undefined) await checkStoredRuntime(request.home, stored, logger, launcherAnchor(request.home, request.env).root, fullCheckDaysOf(request.env))
  })
}

/**
 * The home process's Host over a booted profile: its chats counted into the home process's gate, its studio address,
 * the rows it had at boot, C3's health check, and its two ways to stop. `close` stops it as the process stops, through
 * upstream's bounded shutdown, which may end the process when the teardown overruns its 5 seconds. `suspend` stops it
 * for an update's or a rollback's switch through the profile's own teardown, which ends no process; the home process
 * bounds that wait itself, so a slow teardown never ends the process in the middle of a switch.
 * @param booted - the booted profile.
 * @param request - the home and profile.
 * @param startOnly - the sockets only this start denies, found on the computer and listed by no layer, which stay out
 *   of what a successor's H3 holds it to.
 * @param verifyRuntime - C3's H1, the start check of the running version from the store.
 * @returns the Host.
 */
export function runningHost(booted: BootedProfile, request: Pick<StartRequest, 'home' | 'profile'>, startOnly: readonly string[], verifyRuntime: () => Promise<void>): RunningHost {
  const chats = new CountingChatGate()
  booted.watchChats(chats)
  const atBoot = booted.rows()
  const failed = inactiveRows(atBoot)
  const atBootRows = bootRowsOf(atBoot)
  const atBootProtection = bootProtectionOf(atBoot, startOnly)
  return {
    ...withDevices(booted),
    ...withReach(booted, request),
    chats,
    studio: () => {
      const address = booted.studio()
      return address === undefined ? undefined : `http://${address.host.includes(':') ? `[${address.host}]` : address.host}:${String(address.port)}/`
    },
    studioLink: booted.studioLink,
    failedRows: () => failed,
    rows: () => atBootRows,
    protection: () => atBootProtection,
    check: expect => checkHealth({ rows: booted.rows, studio: booted.studio, profileDir: join(request.home, 'profiles', request.profile), verifyRuntime }, expect),
    close: async () => {
      await booted.shutdown(EXIT.ok)
      await removeSandboxOverlay(request.home, request.profile)
    },
    suspend: async () => {
      await booted.dispose()
      await removeSandboxOverlay(request.home, request.profile)
    },
  }
}

/**
 * The running Host's local device approval and consents, for the update channel's `devices.*`, `permission.reload` and
 * `mcp.*` operations.
 * @param booted - the booted profile.
 * @returns `devices` when the profile loads `@delo/home-auth`, and `consents` when the booted profile offers them.
 */
function withDevices(booted: BootedProfile): { readonly devices?: LocalDeviceApproval, readonly consents?: LocalConsents } {
  const devices = booted.devices?.()
  const consents = booted.consents?.()
  return { ...devices === undefined ? {} : { devices }, ...consents === undefined ? {} : { consents } }
}

/**
 * The running Host's reach operations, for the update channel's `reach.status` and `reach.apply`: an apply reads the
 * profile's own `delo-reach` row, which `delorun reach on|off` wrote, when it arrives.
 * @param booted - the booted profile.
 * @param request - the home and profile.
 * @returns `reach` when the profile loads `@delo/reach`, otherwise nothing.
 */
function withReach(booted: BootedProfile, request: Pick<StartRequest, 'home' | 'profile'>): { readonly reach?: LocalReach } {
  const reach = booted.reach?.(() => reachRowsOf(readReachRow(request.home, request.profile)))
  return reach === undefined ? {} : { reach }
}

/**
 * `delorun start` without `--foreground`: start the home process detached from the terminal and wait for it to report
 * `running`, then say that it keeps running, where the studio is and how to watch and stop it.
 * @param home - the prepared Delo home.
 * @param profile - the CLI profile.
 * @param output - where the command writes.
 * @param open - whether this command opens the studio in the browser once the home process runs.
 * @param opener - how the studio is opened; this computer's by default.
 * @returns {@link EXIT.ok} when the home process runs, {@link EXIT.failed} when it exited or did not report `running`
 *   within 120 seconds.
 * @throws {CliError} when the home has no CLI profile.
 */
export async function startDetached(home: string, profile: string, output: CommandOutput, open = false, opener: StudioOpener = computerOpener(process.env)): Promise<CommandResult> {
  if (!hasCliProfile(home, profile)) throw new CliError(EXIT.failed, `delorun: the CLI profile ${profile} is not set up in ${home}; run: delorun setup`)
  const running = await answeringStatus(home, profile)
  if (running !== undefined) {
    output.stdout(`Delo is already running for the profile ${profile} (process ${String(running.pid)}, ${running.state}).\n`)
    await announceStudio(home, profile, open, output, opener)
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
      const notice = await startNoticeLine(home, profile, process.env)
      output.stdout([
        `Delo is running in the background for the profile ${profile} (process ${String(status.pid)})${status.studio === undefined ? '' : ` at ${status.studio}`}; it keeps running after this terminal closes.`,
        'See it with delorun status, follow its log with delorun logs --follow, and stop it with delorun stop.',
        ...notice === undefined ? [] : [notice],
        '',
      ].join('\n'))
      await announceStudio(home, profile, open, output, opener)
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
  return `Delo runs in this terminal; closing the terminal stops it. To keep it running after the terminal closes, start it with delorun start --background${flag}, or run delorun setup background${flag} to make that the default.\n`
}

/** `delorun start [--foreground | --background] [--open] [--profile <name>]`. */
export const startCommand: CliCommand = {
  name: 'start',
  summary: 'Start the home process: --background detaches it from the terminal, --foreground keeps it in this terminal; without either, setup\'s answer chooses',
  async run(args, context) {
    const values = parseOptions('start', args, { foreground: { type: 'boolean', default: false }, background: { type: 'boolean', default: false }, open: { type: 'boolean', default: false }, profile: { type: 'string' } })
    const { home, profile } = await prepareHome(context, values.profile)
    const choice = startChoice('start', { foreground: values.foreground === true, background: values.background === true }, profileDirectory(home.path, profile))
    if (choice.detached) return startDetached(home.path, profile, context, values.open === true)
    const result = await startForeground({ home: home.path, profile, open: values.open === true, output: context, env: context.env })
    if (result === undefined && !choice.explicit) context.stdout(foregroundHint(profile))
    return result
  },
}
