/**
 * The runtime store as the home process drives it: the `RuntimeStore` seam of contract C19
 * (`delorun/packages/home-process/src/seams.ts`) over C1's {@link RuntimeStore}. {@link HomeRuntimeStore.prepare} runs
 * the update's `checking`, `installing` and `reporting` phases, {@link HomeRuntimeStore.reportRollback} reports the
 * rollback's target, and {@link HomeRuntimeStore.homeCommand} builds the command that starts a home process from an
 * installed runtime. The release channel's opener and the report builder are options, because the launcher owns the download
 * (C1, "The npm launcher and the install script") and C3's report is `delorun/packages/update`'s.
 *
 * @module @delorun/runtime-store/seam
 */
import { join } from 'node:path'
import semver from 'semver'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import type { RootMetadata } from '@delorun/contract-release-manifest'
import { isStoreError, RuntimeStoreError } from './errors.ts'
import { launchFiles } from './launch.ts'
import { isInstalled, type RuntimePointers } from './pointer.ts'
import type { TrustedRootSource } from './release.ts'
import type { FilledRelease, RetentionResult, RuntimeStore } from './store.ts'

/** The phases of an update's prepare, as the home process reports them. */
export type PreparePhase = 'checking' | 'installing' | 'reporting'

/**
 * How a home process is started: `successor` starts one in `standby`, which reads the handover from the pipe it
 * inherits on file descriptor 3; `start` starts one as `delorun start --foreground` does.
 */
export type HomeCommandMode = 'successor' | 'start'

/** A release the channel resolved, with the root it verified the release's metadata with. */
export interface ChannelRelease {
  /** The version to install. */
  readonly version: RuntimeVersion
  /** The root the channel verified the release's metadata with. */
  readonly root: RootMetadata
}

/**
 * The release channel an update fetches through: the launcher's download. C1's install requires the client
 * verification of C2, steps 1 to 5, before anything lands in the store, and the store repeats the signature and
 * file checks itself, so the channel's checks and the store's agree.
 */
export interface RuntimeChannel {
  /**
   * The release to install: `target`, or the newest release on the person's channel when it is `undefined`.
   * @param target - the requested version, or `undefined`.
   * @returns the release and the root it verified with.
   * @throws when the channel cannot name a release, such as an unknown target or no network.
   */
  resolve(target: RuntimeVersion | undefined): Promise<ChannelRelease>
  /**
   * Download `release`, run C2's client verification steps 1 to 5, and extract the archive into `directory` with
   * C1's path checks. Runs under `store.lock`, because the store calls it from its install.
   * @param release - the release {@link RuntimeChannel.resolve} returned.
   * @param directory - a new, empty `staging/<16 hex>/` directory at mode 0700.
   * @returns the release files to keep beside the installation, and the identities of the files written.
   * @throws when the download or a check fails.
   */
  fill(release: ChannelRelease, directory: string): Promise<FilledRelease>
}

/**
 * The release channel of an update: a {@link RuntimeChannel} that also records each release the store installed, so
 * the install leaves C18's release-log check record as the launcher's does. `@delorun/install`'s `LauncherChannel`
 * implements it.
 */
export interface UpdateReleaseChannel extends RuntimeChannel {
  /**
   * Record the release-log check state of a release the store installed; called after the store's install returned,
   * so a release the store refused leaves no record.
   * @param release - the release {@link RuntimeChannel.resolve} returned and the store installed.
   * @returns when the record is written.
   * @throws when the record cannot be written; the installed runtime stays.
   */
  recordInstalled(release: ChannelRelease): Promise<void>
}

/**
 * One step of an install as the update reports it: `@delorun/install`'s `InstallerProgress`, which this package cannot
 * import because that package imports this one. The home process carries it to `delorun update` as it is, and the CLI
 * checks its `step` before it draws it.
 */
export type UpdateInstallEvent = Readonly<Record<string, unknown>> & { readonly step: string }

/**
 * Opens the release channel for one prepare, whose resolve, fill and record run on the one channel it returns.
 * @param report - told of each step of the release's install, for the person to see.
 * @returns the channel.
 * @throws when the channel cannot be opened, such as a home that stores no verified release root.
 */
export type OpenUpdateChannel = (report: (event: UpdateInstallEvent) => void) => Promise<UpdateReleaseChannel>

/** What C3's health check holds a target to, as the report predicts it. */
export interface ReportedHealth {
  /** H3: the plugins the report names as disabled at boot. */
  readonly disabledPlugins: readonly string[]
  /** H3, H4: the rows the report names, by id or name. */
  readonly namedRows: readonly string[]
  /** H3, H4: the rows a bundle patch of the target disables, by id only. */
  readonly bundleRows?: readonly string[]
  /** H5: the bundle list the report predicts. */
  readonly bundles?: readonly string[]
}

/** C3's update report, with what the health check holds the target to and whether the data differs. */
export interface UpdateReport {
  /** The report, returned to the caller as it is. */
  readonly report: unknown
  /** What the health check holds the target to. */
  readonly health: ReportedHealth
  /** Whether the report names a data change (C3, "Data formats"). */
  readonly dataDiffers: boolean
}

/**
 * The update report builder of contract C3, `delorun/packages/update`. It reads the profile and the installed target
 * and imports no plugin code.
 */
export interface UpdateReporter {
  /**
   * Compute the report against an installed, verified version, installing nothing.
   * @param version - the installed target.
   * @param purpose - `update` for {@link HomeRuntimeStore.prepare}, `rollback` for {@link HomeRuntimeStore.reportRollback}.
   * @returns the report.
   */
  build(version: RuntimeVersion, purpose: 'update' | 'rollback'): Promise<UpdateReport>
}

/** What a {@link HomeRuntimeStore} needs. */
export interface HomeRuntimeStoreOptions {
  /** The C1 runtime store of this home. */
  readonly store: RuntimeStore
  /** The CLI profile whose home process this store serves. */
  readonly profile: string
  /** Opens the release channel of one prepare; `@delorun/install`'s `LauncherChannel` in a real run. */
  readonly openChannel: OpenUpdateChannel
  /** The report builder, which `delorun/packages/update` provides. */
  readonly report: UpdateReporter
  /**
   * The anchored root every start check of this store's prepare and rollback report verifies with. A release the
   * channel resolves and the store installs is verified with the root the channel walked to, which the opener anchors.
   */
  readonly root: TrustedRootSource
  /**
   * The interval of the start check's full hash in days, as `resolveFullCheckDays` resolves it from the launcher's
   * variable: the prepare's checks and the check before a home process starts are start checks, which hash every file
   * when it is due.
   */
  readonly fullCheckDays: number
  /**
   * Contract C18's release-log start check of a version before a home process starts from it, as the launcher runs it
   * before a start; none by default.
   * @param version - the installed version.
   * @param root - the anchored root its start check verified it under.
   * @throws when the check stops the start.
   */
  readonly preLaunch?: (version: RuntimeVersion, root: RootMetadata) => Promise<void>
  /**
   * Installs the target's version of every plugin pack this home added, before `current` moves; none by default.
   * @param from - the version `current` names.
   * @param to - the installed target.
   * @throws when a pack cannot be fetched, verified or installed; the update fails and `current` stays.
   */
  readonly carryPacks?: (from: RuntimeVersion, to: RuntimeVersion) => Promise<unknown>
}

/** A version ready to switch to: the installed, verified target with its update report. */
export interface PreparedRuntime {
  /** The target version, installed and verified. */
  readonly version: RuntimeVersion
  /** C3's update report, returned to the caller as it is. */
  readonly report: unknown
  /** What the health check holds the target to. */
  readonly health: ReportedHealth
  /** Whether the report names a data change. */
  readonly dataDiffers: boolean
}

/** The command that starts a home process from a version's runtime. */
export interface HomeCommand {
  /** The executable. */
  readonly command: string
  /** Its arguments; never a token, which travels on the handover pipe. */
  readonly args: readonly string[]
  /** The working directory. */
  readonly cwd: string
}

/** The arguments of `delorun start --foreground` for one profile, after the CLI entry file. */
function startArguments(profile: string): readonly string[] {
  return ['start', '--foreground', '--profile', profile]
}

/**
 * The home process's runtime store: C1's store with the update's prepare and rollback reports and the home
 * process's start command. Switching stays C1's: {@link HomeRuntimeStore.switchTo} writes `previous` and then
 * `current` by atomic rename under `store.lock`, and nothing in an update switches `current` before the
 * handshake's waiting phase has seen no running chat.
 */
export class HomeRuntimeStore {
  /** The store, the profile, the channel and the report builder. */
  private readonly options: HomeRuntimeStoreOptions

  /**
   * @param options - the store, the profile, the channel and the report builder.
   */
  constructor(options: HomeRuntimeStoreOptions) {
    this.options = options
  }

  /** The C1 store this serves, for the launch plan, the start check and retention. */
  get store(): RuntimeStore {
    return this.options.store
  }

  /**
   * Read `current` and `previous`.
   * @returns the pointers; `previous` is absent unless it names an installed version.
   * @throws {RuntimeStoreError} `NO_ACTIVE_RUNTIME` when `current` is missing, malformed or names no installed version.
   */
  async pointers(): Promise<RuntimePointers> {
    return this.options.store.pointers()
  }

  /**
   * Switch from the running version to an installed one: write `previous` with `from` and then `current` with `to`,
   * each by C1's atomic rename under `store.lock`.
   * @param from - the version `current` names now.
   * @param to - the installed target.
   * @throws {RuntimeStoreError} `POINTER_CHANGED` when `current` does not name `from`; `NOT_INSTALLED` when `to` is
   *   not installed; `NO_ACTIVE_RUNTIME`, `STORE_BUSY` or `POINTER_REPLACE_FAILED`.
   */
  async switchTo(from: RuntimeVersion, to: RuntimeVersion): Promise<void> {
    return this.options.store.switchTo(from, to)
  }

  /**
   * Restore both pointers to the values read before an update: `previous` first (removed when it was absent), then
   * `current`, each by C1's atomic rename under `store.lock`.
   * @param before - the pointers read before the update.
   * @throws {RuntimeStoreError} `NOT_INSTALLED` when a version named is no longer installed; `STORE_BUSY` or
   *   `POINTER_REPLACE_FAILED`.
   */
  async restore(before: RuntimePointers): Promise<void> {
    return this.options.store.restore(before)
  }

  /**
   * The check before a home process is started from an installed version, an update's or a rollback's successor or the
   * start after an interrupted update, as the launcher checks a version before it starts it: contract C2's start check
   * of every file under the anchored root, by its recorded identity or its hash, then the options' `preLaunch`,
   * contract C18's release-log start check.
   * @param version - the installed version.
   * @throws {RuntimeStoreError} `RUNTIME_CHANGED` when a file or the stored release files do not verify;
   *   `ROOT_NOT_ANCHORED` when the root cannot be anchored; whatever `preLaunch` throws when the release-log check
   *   stops the start.
   */
  async checkLaunch(version: RuntimeVersion): Promise<void> {
    const root = await this.options.root()
    await this.options.store.startCheckRuntime(version, root, this.options.fullCheckDays)
    await this.options.preLaunch?.(version, root)
  }

  /**
   * Keep the versions the pointers name and remove every other installation, as a committed update leaves the store.
   * @returns what was removed, and what could not be and is retried by the next run.
   */
  async retain(): Promise<RetentionResult> {
    return this.options.store.retain()
  }

  /**
   * The update's `checking`, `installing` and `reporting` phases: resolve `target`, or the newest release on the
   * person's channel, and install it unless it is installed and its files match its manifest. An installed copy
   * that fails the start check is installed again, and an install never switches `current`. The phases share one
   * file check per runtime ({@link RuntimeStore.shareChecks}): the channel opener's start check of the running runtime,
   * the install's hash of each file it writes or the start check of an installed target, and the report readers'
   * checks of both.
   * @param target - the version, or `undefined` for the newest release.
   * @param phase - called as each phase starts; `installing` is skipped when nothing installs.
   * @param steps - told of each step of the release's install; nothing is reported when the target is installed and
   *   intact.
   * @returns the prepared version.
   * @throws {RuntimeStoreError} `INSTALL_VERIFY_FAILED` when a check of the fetched release fails; `TARGET_LOWER` when
   *   the target, or the newest release on the channel, is lower than the version `current` names, before anything
   *   installs; `NO_ACTIVE_RUNTIME` when the store has no usable runtime; `STORE_BUSY` while another install, switch or
   *   removal holds the lock.
   */
  async prepare(target: RuntimeVersion | undefined, phase: (phase: PreparePhase) => void, steps: (event: UpdateInstallEvent) => void): Promise<PreparedRuntime> {
    return this.options.store.shareChecks(() => this.prepareShared(target, phase, steps))
  }

  /**
   * {@link prepare}'s phases, inside its shared checks.
   * @param target - the version, or `undefined` for the newest release.
   * @param phase - called as each phase starts.
   * @param steps - told of each step of the release's install.
   * @returns the prepared version.
   */
  private async prepareShared(target: RuntimeVersion | undefined, phase: (phase: PreparePhase) => void, steps: (event: UpdateInstallEvent) => void): Promise<PreparedRuntime> {
    phase('checking')
    const { current } = await this.options.store.pointers()
    let version: RuntimeVersion
    if (target !== undefined && await this.intact(target)) {
      this.refuseLower(target, current)
      version = target
    } else {
      const channel = await this.options.openChannel(steps)
      const resolved = await channel.resolve(target)
      this.refuseLower(resolved.version, current)
      if (!await this.intact(resolved.version)) {
        phase('installing')
        await this.options.store.install({
          version: resolved.version,
          root: resolved.root,
          fill: async (directory) => {
            const files = await channel.fill(resolved, directory)
            steps({ step: 'installing', version: resolved.version })
            return files
          },
        })
        await channel.recordInstalled(resolved)
        steps({ step: 'installed', version: resolved.version })
      }
      version = resolved.version
    }
    if (this.options.carryPacks !== undefined) {
      try {
        await this.options.carryPacks(current, version)
      } catch (error) {
        throw new RuntimeStoreError('INSTALL_VERIFY_FAILED', this.options.store.paths.packs, `the plugin packs of release ${version} could not be prepared, so the update stopped before it switched: ${(error as Error).message}`, [], { cause: error })
      }
    }
    phase('reporting')
    const report = await this.options.report.build(version, 'update')
    return { version, report: report.report, health: report.health, dataDiffers: report.dataDiffers }
  }

  /**
   * Refuse an update's target lower than the version `current` names, before anything installs: an update never goes
   * back, so a channel or a request that names a lower release cannot reach a runtime the person moved past, and
   * `delorun recover rollback` stays the only way back.
   * @param target - the update's target.
   * @param current - the version `current` names.
   * @throws {RuntimeStoreError} `TARGET_LOWER` when `target` is lower than `current`, or either is not a semantic
   *   version, so the two cannot be ordered.
   */
  private refuseLower(target: RuntimeVersion, current: RuntimeVersion): void {
    if (semver.valid(target) === null || semver.valid(current) === null) {
      throw new RuntimeStoreError('TARGET_LOWER', this.options.store.paths.version(target), `the update's target ${target} and ${current}, the version this home runs, cannot be ordered as semantic versions, so the update cannot show it does not go to a lower version; nothing was installed`)
    }
    if (!semver.lt(target, current)) return
    throw new RuntimeStoreError('TARGET_LOWER', this.options.store.paths.version(target), `the update's target ${target} is lower than ${current}, the version this home runs; an update never goes to a lower version, and nothing was installed`, ['rollback'])
  }

  /**
   * The `reporting` phase of a rollback: the report against an installed version, installing nothing. The version
   * must pass the full check, because the report describes the runtime the rollback would start; the report's readers
   * share that check ({@link RuntimeStore.shareChecks}).
   * @param target - the version `previous` names.
   * @returns the prepared version.
   * @throws {RuntimeStoreError} `NOT_INSTALLED` when the version is not installed; `RUNTIME_CHANGED` when its files
   *   or stored release files fail the start check.
   */
  async reportRollback(target: RuntimeVersion): Promise<PreparedRuntime> {
    if (!await isInstalled(this.options.store.paths, target)) {
      throw new RuntimeStoreError('NOT_INSTALLED', this.options.store.paths.version(target), `runtime ${target} is not installed in ${this.options.store.paths.root}`)
    }
    return this.options.store.shareChecks(async () => {
      await this.options.store.checkRuntime(target, await this.options.root())
      const report = await this.options.report.build(target, 'rollback')
      return { version: target, report: report.report, health: report.health, dataDiffers: report.dataDiffers }
    })
  }

  /**
   * The command that starts a home process from a version's runtime: launch protocol 1's own Node executable and
   * `delorun start --foreground`, so the started process is the home process itself and the home lock's process id
   * names it. Both modes run the same command, because the successor is told by the handover pipe it inherits as
   * file descriptor 3 and never by a command-line field (C19); the CLI wiring that boots a successor reads that
   * pipe. The home and profile reach the process through its inherited `DELORUN_HOME` and `DELORUN_PROFILE`.
   * @param version - the installed version.
   * @param _mode - a successor, which inherits the handover pipe, or a fresh start; the pipe tells the process
   *   which it is, so both modes run the same command.
   * @returns the command.
   */
  homeCommand(version: RuntimeVersion, _mode: HomeCommandMode): HomeCommand {
    const directory = this.options.store.paths.version(version)
    const files = launchFiles(this.options.store.paths.platform)
    return {
      command: join(directory, ...files.node.split('/')),
      args: [join(directory, ...files.entry.split('/')), ...startArguments(this.options.profile)],
      cwd: this.options.store.paths.home,
    }
  }

  /**
   * Whether an installed version is whole: it passes the start check against the stored root, as a launch of it would.
   * @param version - the version.
   * @returns true when it is installed and intact.
   * @throws {RuntimeStoreError} when the store cannot read the version's stored release files for a reason other
   *   than a failed check.
   */
  private async intact(version: RuntimeVersion): Promise<boolean> {
    const paths = this.options.store.paths
    if (!await isInstalled(paths, version)) return false
    try {
      await this.options.store.startCheckRuntime(version, await this.options.root(), this.options.fullCheckDays)
      return true
    } catch (error) {
      if (isStoreError(error, 'RUNTIME_CHANGED')) return false
      throw error
    }
  }
}
