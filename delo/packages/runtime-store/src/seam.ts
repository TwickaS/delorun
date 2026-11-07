/**
 * The runtime store as the home process drives it: the `RuntimeStore` seam of contract C19
 * (`delo/packages/home-process/src/seams.ts`) over C1's {@link RuntimeStore}. {@link HomeRuntimeStore.prepare} runs
 * the update's `checking`, `installing` and `reporting` phases, {@link HomeRuntimeStore.reportRollback} reports the
 * rollback's target, and {@link HomeRuntimeStore.homeCommand} builds the command that starts a home process from an
 * installed runtime. The release channel and the report builder are options, because the launcher owns the download
 * (C1, "The npm launcher and the install script") and C3's report is `delo/packages/update`'s.
 *
 * @module @delo/runtime-store/seam
 */
import { join } from 'node:path'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import type { RootMetadata } from '@delo/contract-release-manifest'
import { isStoreError, RuntimeStoreError } from './errors.ts'
import { launchFiles } from './launch.ts'
import { isInstalled, type RuntimePointers } from './pointer.ts'
import { readStoredRoot, type ReleaseFileBytes } from './release.ts'
import type { RuntimeStore } from './store.ts'

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
   * @returns the release files to keep beside the installation.
   * @throws when the download or a check fails.
   */
  fill(release: ChannelRelease, directory: string): Promise<ReleaseFileBytes>
}

/** C3's update report, with the plugin ids the health check holds the target to. */
export interface UpdateReport {
  /** The report, returned to the caller as it is. */
  readonly report: unknown
  /** The plugin ids the report names as disabled at boot; the health check refuses any other. */
  readonly disabledPlugins: readonly string[]
}

/**
 * The update report builder of contract C3, `delo/packages/update`. It reads the profile and the installed target
 * and imports no plugin code.
 */
export interface UpdateReporter {
  /**
   * Compute the report against an installed, verified version, installing nothing.
   * @param version - the installed target.
   * @returns the report.
   */
  build(version: RuntimeVersion): Promise<UpdateReport>
}

/** What a {@link HomeRuntimeStore} needs. */
export interface HomeRuntimeStoreOptions {
  /** The C1 runtime store of this home. */
  readonly store: RuntimeStore
  /** The CLI profile whose home process this store serves. */
  readonly profile: string
  /** The release channel, which the launcher provides. */
  readonly channel: RuntimeChannel
  /** The report builder, which `delo/packages/update` provides. */
  readonly report: UpdateReporter
}

/** A version ready to switch to: the installed, verified target with its update report. */
export interface PreparedRuntime {
  /** The target version, installed and verified. */
  readonly version: RuntimeVersion
  /** C3's update report, returned to the caller as it is. */
  readonly report: unknown
  /** The plugin ids the report names as disabled at boot. */
  readonly disabledPlugins: readonly string[]
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
  /**
   * @param options - the store, the profile, the channel and the report builder.
   */
  constructor(private readonly options: HomeRuntimeStoreOptions) {}

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
   * The update's `checking`, `installing` and `reporting` phases: resolve `target`, or the newest release on the
   * person's channel, and install it unless it is installed and its files match its manifest. An installed copy
   * that fails the start check is installed again, and an install never switches `current`.
   * @param target - the version, or `undefined` for the newest release.
   * @param phase - called as each phase starts; `installing` is skipped when nothing installs.
   * @returns the prepared version.
   * @throws {RuntimeStoreError} `INSTALL_VERIFY_FAILED` when a check of the fetched release fails; `NO_ACTIVE_RUNTIME`
   *   when the store has no usable runtime; `STORE_BUSY` while another install, switch or removal holds the lock.
   */
  async prepare(target: RuntimeVersion | undefined, phase: (phase: PreparePhase) => void): Promise<PreparedRuntime> {
    phase('checking')
    let version: RuntimeVersion
    if (target !== undefined && await this.intact(target)) {
      version = target
    } else {
      const resolved = await this.options.channel.resolve(target)
      if (!await this.intact(resolved.version)) {
        phase('installing')
        await this.options.store.install({
          version: resolved.version,
          root: resolved.root,
          fill: directory => this.options.channel.fill(resolved, directory),
        })
      }
      version = resolved.version
    }
    phase('reporting')
    const report = await this.options.report.build(version)
    return { version, report: report.report, disabledPlugins: report.disabledPlugins }
  }

  /**
   * The `reporting` phase of a rollback: the report against an installed version, installing nothing. The version
   * must pass the start check, because the report describes the runtime the rollback would start.
   * @param target - the version `previous` names.
   * @returns the prepared version.
   * @throws {RuntimeStoreError} `NOT_INSTALLED` when the version is not installed; `RUNTIME_CHANGED` when its files
   *   or stored release files fail the start check.
   */
  async reportRollback(target: RuntimeVersion): Promise<PreparedRuntime> {
    if (!await isInstalled(this.options.store.paths, target)) {
      throw new RuntimeStoreError('NOT_INSTALLED', this.options.store.paths.version(target), `runtime ${target} is not installed in ${this.options.store.paths.root}`)
    }
    await this.options.store.checkRuntime(target, await readStoredRoot(this.options.store.paths.home))
    const report = await this.options.report.build(target)
    return { version: target, report: report.report, disabledPlugins: report.disabledPlugins }
  }

  /**
   * The command that starts a home process from a version's runtime: launch protocol 1's own Node executable and
   * `delorun start --foreground`, so the started process is the home process itself and the home lock's process id
   * names it. Both modes run the same command, because the successor is told by the handover pipe it inherits as
   * file descriptor 3 and never by a command-line field (C19); the CLI wiring that boots a successor reads that
   * pipe. The home and profile reach the process through its inherited `DELO_HOME` and `DELO_PROFILE`.
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
   * Whether an installed version is whole: it passes the start check against the stored root.
   * @param version - the version.
   * @returns true when it is installed and intact.
   * @throws {RuntimeStoreError} when the store cannot read the version's stored release files for a reason other
   *   than a failed check.
   */
  private async intact(version: RuntimeVersion): Promise<boolean> {
    const paths = this.options.store.paths
    if (!await isInstalled(paths, version)) return false
    try {
      await this.options.store.checkRuntime(version, await readStoredRoot(paths.home))
      return true
    } catch (error) {
      if (isStoreError(error, 'RUNTIME_CHANGED')) return false
      throw error
    }
  }
}
