/**
 * Contract C1's runtime store under `~/.delo/runtimes/`: reading `current` and `previous`, switching and restoring
 * them by atomic rename under `store.lock`, installing a verified closure from a
 * staging directory, retention, and the start check of contract C2 that every launch of the CLI runtime runs.
 *
 * @module @delo/runtime-store/store
 */
import { mkdir, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { PRIVATE_DIR_MODE, STORE_ENTRIES, STORE_LAYOUT, STORE_LOCK_WAIT_MS, type RuntimeVersion } from '@delo/contract-home-layout'
import type { RootMetadata, RuntimePlatform } from '@delo/contract-release-manifest'
import type { VerificationMode } from '@delo/contract-verification-checks'
import type { DeloLogger } from '@delo/logs'
import { isStoreError, RuntimeStoreError, type RuntimeRemedy } from './errors.ts'
import { createStagingDirectory, moveOutAndRemove, removeTree, sealInstallation, setInstalledModes, writeStoreFile } from './files.ts'
import { launchCommand, readStoreLayout, requireLayout, requireProtocol, SUPPORTED, type LauncherSupport, type LaunchCommand } from './launch.ts'
import { withStoreLock } from './lock.ts'
import { parseRuntimeVersion, releaseFileVersion, StorePaths } from './paths.ts'
import { isInstalled, readPointerFile, readPointers, syncDirectory, writePointers, type RuntimePointers } from './pointer.ts'
import { readStoredRelease, verifyRelease, type ReleaseFileBytes, type VerifiedRelease } from './release.ts'
import { checkTree, describeProblems } from './tree.ts'

/** A temporary file the store writes before a rename: `<name>.tmp-<16 hex>`. */
const TEMPORARY = /\.tmp-[0-9a-f]{16}$/u

/** What a {@link RuntimeStore} needs. */
export interface RuntimeStoreOptions {
  /** The resolved Delo home, which exists. */
  readonly home: string
  /** The platform whose runtime closures this machine installs. */
  readonly platform: RuntimePlatform
  /** Where retention reports removals it could not finish. */
  readonly logger: DeloLogger
}

/** What {@link RuntimeStore.install} needs. */
export interface InstallRequest {
  /** The version to install. */
  readonly version: RuntimeVersion
  /** The root the caller verified the release's metadata with. */
  readonly root: RootMetadata
  /**
   * Fill the staging directory: download the release, run C2's client verification steps 1 to 5 (root and
   * timestamp walk, the manifest's signature and freshness, the release-log bundle and online check, the archive's
   * and file list's digests), and extract the archive into `directory` with C1's path checks.
   * @param directory - a new, empty `staging/<16 hex>/` directory at mode 0700.
   * @returns the release files to keep beside the installation.
   */
  readonly fill: (directory: string) => Promise<ReleaseFileBytes>
}

/** A runtime that passed the start check. */
export interface VerifiedRuntime extends VerifiedRelease {
  /** Its version. */
  readonly version: RuntimeVersion
}

/** What {@link RuntimeStore.prepareLaunch} needs. */
export interface LaunchRequest {
  /** The store layouts and launch protocols the launcher supports. */
  readonly launcher: LauncherSupport
  /** The trusted root. */
  readonly root: RootMetadata
  /** The person's verification mode, which a refusal names; the start check runs in every mode. */
  readonly mode: VerificationMode
  /** The CLI profile. */
  readonly profile: string
  /** The arguments for `delorun`. */
  readonly args: readonly string[]
}

/** A verified launch of `current`. */
export interface LaunchPlan extends LaunchCommand {
  /** The version `current` names, which the command starts. */
  readonly version: RuntimeVersion
}

/** What one retention run removed and what it left for the next. */
export interface RetentionResult {
  /** The entries removed, as paths. */
  readonly removed: readonly string[]
  /** The entries whose removal failed; the next run retries them. */
  readonly failed: readonly string[]
}

/** C1's runtime store of one home. */
export class RuntimeStore {
  /** The store's paths. */
  readonly paths: StorePaths

  /** The home, the platform and the logger. */
  private readonly options: RuntimeStoreOptions

  /**
   * @param options - the home, the platform and the logger.
   */
  constructor(options: RuntimeStoreOptions) {
    this.options = options
    this.paths = new StorePaths(options.home, options.platform)
  }

  /**
   * Read `current` and `previous`.
   * @returns the pointers; `previous` is absent unless it names an installed version.
   * @throws {RuntimeStoreError} `NO_ACTIVE_RUNTIME` when `current` is missing, malformed or names no installed version.
   */
  async pointers(): Promise<RuntimePointers> {
    return readPointers(this.paths)
  }

  /**
   * Switch from the running version to an installed one: under `store.lock`, write `previous` with `from` and then
   * `current` with `to`, each by C1's atomic rename, so a process killed between the writes leaves `current` naming
   * `from`. Nothing is removed; retention runs once the caller has committed the switch.
   * @param from - the version `current` names now.
   * @param to - the installed target.
   * @throws {RuntimeStoreError} `POINTER_CHANGED` when `current` does not name `from`; `NOT_INSTALLED` when `to` is not
   *   installed; `NO_ACTIVE_RUNTIME`, `STORE_BUSY` or `POINTER_REPLACE_FAILED`.
   */
  async switchTo(from: RuntimeVersion, to: RuntimeVersion): Promise<void> {
    await this.locked(async () => {
      const { current } = await readPointers(this.paths)
      if (current !== from) throw new RuntimeStoreError('POINTER_CHANGED', this.paths.pointer(STORE_ENTRIES.current), `current names ${current}, not ${from}; the switch to ${to} was not made`)
      await this.requireInstalled(to)
      await writePointers(this.paths, { current: to, previous: from })
    })
  }

  /**
   * Restore both pointers to the values read before an update: `previous` first (removed when it was absent), then
   * `current`, each by C1's atomic rename, under `store.lock`.
   * @param before - the pointers read before the update.
   * @throws {RuntimeStoreError} `NOT_INSTALLED` when a version named is no longer installed; `STORE_BUSY` or
   *   `POINTER_REPLACE_FAILED`.
   */
  async restore(before: RuntimePointers): Promise<void> {
    await this.locked(async () => {
      await this.requireInstalled(before.current)
      if (before.previous !== undefined) await this.requireInstalled(before.previous)
      await writePointers(this.paths, before)
    })
  }

  /**
   * Run the start check on an installed version: verify its stored manifest and file list with the root, then check
   * every regular file under its directory against the list. A missing, changed or extra file fails it.
   * @param version - the installed version.
   * @param root - the trusted root.
   * @returns the verified runtime.
   * @throws {RuntimeStoreError} `RUNTIME_CHANGED`, naming the files that differ and offering reinstall and, when
   *   another installed version is kept as `previous`, rollback.
   */
  async checkRuntime(version: RuntimeVersion, root: RootMetadata): Promise<VerifiedRuntime> {
    return this.checkFiles(version, await this.storedRelease(version, root))
  }

  /**
   * Prepare the launch of `current`, writing nothing: check the store's layout, read `current`, verify its manifest
   * and launch protocol, run the start check, and build launch protocol 1's command. The check runs in every
   * verification mode, and a launcher never switches `current`, whether it is newer or older than the active runtime.
   * @param request - the launcher's support, the root, the mode, the profile and the arguments.
   * @returns the command that starts `current`.
   * @throws {RuntimeStoreError} `RUNTIME_INCOMPATIBLE`, `NO_ACTIVE_RUNTIME` or `RUNTIME_CHANGED`, each naming the
   *   verification mode.
   */
  async prepareLaunch(request: LaunchRequest): Promise<LaunchPlan> {
    try {
      requireLayout(this.paths, await readStoreLayout(this.paths), request.launcher)
      const { current } = await readPointers(this.paths)
      const release = await this.storedRelease(current, request.root)
      requireProtocol(this.paths, current, release.manifest, release.files, request.launcher)
      await this.checkFiles(current, release)
      return { version: current, ...launchCommand(this.paths, current, request.profile, request.args) }
    } catch (error) {
      if (!isStoreError(error)) throw error
      const detail = `${error.detail} (verification mode ${request.mode}; this check stops the start in every mode)`
      throw new RuntimeStoreError(error.code, error.path, detail, error.remedies, { cause: error.cause })
    }
  }

  /**
   * The command that starts an installed runtime by launch protocol 1, without checking it; run
   * {@link checkRuntime} first.
   * @param version - the installed version.
   * @param profile - the CLI profile.
   * @param args - the arguments for `delorun`.
   * @returns the command.
   */
  launchCommand(version: RuntimeVersion, profile: string, args: readonly string[]): LaunchCommand {
    return launchCommand(this.paths, version, profile, args)
  }

  /**
   * Install a verified runtime closure under `store.lock`. The caller fills a new staging directory after C2's client
   * verification steps 1 to 5; the store then verifies the release files' signatures with the root and every staged
   * file against the file list, writes the release files beside the installation, and renames the staging directory
   * to `runtimes/<version>/` last, so no version reads as installed before every check passes. An installed copy of
   * the same version is moved out just before. A failed install removes its staging directory and leaves every
   * pointer and installation as it was. When `store.json` is absent or unreadable it is written, and when `current`
   * is absent or malformed it is set to the installed version: C1's first install.
   * @param request - the version, the root and the fill step.
   * @returns the installed, verified runtime.
   * @throws {RuntimeStoreError} `INSTALL_VERIFY_FAILED` when a signature or file check fails; `RUNTIME_INCOMPATIBLE`
   *   when the store has a layout this package does not write; `STORE_BUSY`.
   */
  async install(request: InstallRequest): Promise<VerifiedRuntime> {
    return this.locked(async () => {
      const layout = await readStoreLayout(this.paths).catch((error: unknown) => {
        if (isStoreError(error, 'NO_ACTIVE_RUNTIME')) return undefined
        throw error
      })
      if (layout !== undefined) requireLayout(this.paths, layout, SUPPORTED)
      const staging = await createStagingDirectory(this.paths.staging)
      try {
        const bytes = await request.fill(staging)
        let release: VerifiedRelease
        let problems
        try {
          release = verifyRelease(this.paths, request.root, request.version, bytes)
          // Seal the staged tree before it is hashed: the digest a person's machine installs must be the digest of
          // bytes nobody could change, so no writable window may sit between the hash and the mode that closes it.
          await setInstalledModes(staging, release.files)
          problems = await checkTree(staging, release.files)
        } catch (error) {
          throw new RuntimeStoreError('INSTALL_VERIFY_FAILED', staging, `release ${request.version} does not verify: ${(error as Error).message}`, [], { cause: error })
        }
        if (problems.length > 0) throw new RuntimeStoreError('INSTALL_VERIFY_FAILED', staging, `the staged runtime ${request.version} differs from its signed file list: ${describeProblems(problems)}`)
        const files = this.paths.releaseFiles(request.version)
        await writeStoreFile(files.manifest, bytes.manifest)
        await writeStoreFile(files.files, bytes.files)
        await writeStoreFile(files.bundle, bytes.bundle)
        if (layout === undefined) await writeStoreFile(this.paths.layout, Buffer.from(`${JSON.stringify({ layout: STORE_LAYOUT })}\n`))
        await syncDirectory(this.paths.root)
        const installation = this.paths.version(request.version)
        if (await isInstalled(this.paths, request.version)) await moveOutAndRemove(installation, this.paths.staging)
        await rename(staging, installation)
        await sealInstallation(installation)
        await syncDirectory(this.paths.root)
        const current = await readPointerFile(this.paths.pointer(STORE_ENTRIES.current))
        if (current === undefined || current === 'malformed') await writePointers(this.paths, { current: request.version })
        return { version: request.version, ...release }
      } catch (error) {
        await removeTree(staging)
        throw error
      }
    })
  }

  /**
   * C1's retention, run after a switch commits and at each start: under `store.lock`, keep the versions `current`
   * and `previous` name with their release files, and remove every other installation with its release files, every
   * directory under `staging/`, and the temporary files of interrupted writes. Other entries are left alone. A
   * removal that fails is logged and left for the next run.
   * @returns what was removed and what failed.
   * @throws {RuntimeStoreError} `NO_ACTIVE_RUNTIME` when `current` cannot be read, before anything is removed;
   *   `STORE_BUSY`.
   */
  async retain(): Promise<RetentionResult> {
    return this.locked(async () => {
      const { current, previous } = await readPointers(this.paths)
      const kept = new Set<string>(previous === undefined ? [current] : [current, previous])
      const removed: string[] = []
      const failed: string[] = []
      const attempt = async (path: string, remove: () => Promise<unknown>): Promise<void> => {
        try {
          await remove()
          removed.push(path)
        } catch (error) {
          failed.push(path)
          this.options.logger.warn('the runtime store could not remove an entry; the next retention retries it', { err: error, data: { path } })
        }
      }
      for (const entry of await readdir(this.paths.root, { withFileTypes: true })) {
        const path = join(this.paths.root, entry.name)
        if (entry.isDirectory()) {
          const version = parseRuntimeVersion(entry.name)
          if (version !== undefined && !kept.has(version)) await attempt(path, () => moveOutAndRemove(path, this.paths.staging))
        } else if (entry.isFile()) {
          const owner = releaseFileVersion(entry.name)
          if (TEMPORARY.test(entry.name) || (owner !== undefined && !kept.has(owner))) await attempt(path, () => removeTree(path))
        }
      }
      await syncDirectory(this.paths.root)
      const staged = await readdir(this.paths.staging).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      })
      for (const name of staged) await attempt(join(this.paths.staging, name), () => removeTree(join(this.paths.staging, name)))
      return { removed, failed }
    })
  }

  /**
   * Read and verify a version's stored release files.
   * @param version - the installed version.
   * @param root - the trusted root.
   * @returns the verified manifest and file list.
   * @throws {RuntimeStoreError} `RUNTIME_CHANGED` when a file is missing or does not verify.
   */
  private async storedRelease(version: RuntimeVersion, root: RootMetadata): Promise<VerifiedRelease> {
    try {
      return await readStoredRelease(this.paths, root, version)
    } catch (error) {
      throw new RuntimeStoreError('RUNTIME_CHANGED', this.paths.version(version), `runtime ${version}'s stored manifest or file list does not verify: ${(error as Error).message}`, await this.remediesFor(version), { cause: error })
    }
  }

  /**
   * Check an installation's files against its verified file list.
   * @param version - the installed version.
   * @param release - its verified release files.
   * @returns the verified runtime.
   * @throws {RuntimeStoreError} `RUNTIME_CHANGED` naming the files that differ.
   */
  private async checkFiles(version: RuntimeVersion, release: VerifiedRelease): Promise<VerifiedRuntime> {
    const directory = this.paths.version(version)
    let problems
    try {
      problems = await checkTree(directory, release.files)
    } catch (error) {
      throw new RuntimeStoreError('RUNTIME_CHANGED', directory, `runtime ${version} cannot be checked: ${(error as Error).message}`, await this.remediesFor(version), { cause: error })
    }
    if (problems.length > 0) throw new RuntimeStoreError('RUNTIME_CHANGED', directory, `runtime ${version} differs from its signed file list: ${describeProblems(problems)}`, await this.remediesFor(version))
    return { version, ...release }
  }

  /**
   * Refuse a version that is not installed.
   * @param version - the version.
   * @throws {RuntimeStoreError} `NOT_INSTALLED`.
   */
  private async requireInstalled(version: RuntimeVersion): Promise<void> {
    if (!await isInstalled(this.paths, version)) throw new RuntimeStoreError('NOT_INSTALLED', this.paths.version(version), `runtime ${version} is not installed in ${this.paths.root}`)
  }

  /**
   * What the launcher offers when a version fails the start check: reinstall, and rollback when `previous` names
   * another installed version.
   * @param version - the version that failed.
   * @returns the remedies.
   */
  private async remediesFor(version: RuntimeVersion): Promise<RuntimeRemedy[]> {
    const previous = await readPointerFile(this.paths.pointer(STORE_ENTRIES.previous))
    const rollback = previous !== undefined && previous !== 'malformed' && previous !== version && await isInstalled(this.paths, previous)
    return rollback ? ['reinstall', 'rollback'] : ['reinstall']
  }

  /**
   * Run work under `store.lock`, waiting C1's 30 seconds; `runtimes/` is created at mode 0700 when absent.
   * @param work - the work.
   * @returns its result.
   */
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(this.paths.root, { mode: PRIVATE_DIR_MODE }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
    return withStoreLock(this.paths.lock, STORE_LOCK_WAIT_MS, work)
  }
}
