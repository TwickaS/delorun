/**
 * Contract C1's runtime store under `~/.delo/runtimes/`: reading `current` and `previous`, switching and restoring
 * them by atomic rename under `store.lock`, installing a verified closure from a
 * staging directory, retention, and the start check of contract C2 that every launch of the CLI runtime runs: the
 * comparison of each file's identity with the installation's identity record where change times are trusted, and the
 * hash of every file at install, on request, when due and wherever the record cannot vouch ([identity](./identity.ts)).
 *
 * @module @delo/runtime-store/store
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { lstatSync } from 'node:fs'
import { mkdir, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { PRIVATE_DIR_MODE, PROTECTED_FILE_MODE, STORE_ENTRIES, STORE_LAYOUT, STORE_LOCK_WAIT_MS, type RuntimeVersion } from '@delo/contract-home-layout'
import type { RootMetadata, RuntimePlatform } from '@delo/contract-release-manifest'
import type { VerificationMode } from '@delo/contract-verification-checks'
import type { DeloLogger } from '@delo/logs'
import { isStoreError, RuntimeStoreError, type RuntimeRemedy } from './errors.ts'
import { createStagingDirectory, moveOutAndRemove, removeTree, sealInstallation, setInstalledModes, STORE_FILE_MODE, writeStoreFile } from './files.ts'
import { changeTimeOf, fullCheckDue, nowNs, RACY_WINDOW_NS, readIdentityRecord, recordBound, recordText, trustedFileSystem, type RecordBinding } from './identity.ts'
import { launchCommand, readStoreLayout, requireLayout, requireProtocol, SUPPORTED, type LauncherSupport, type LaunchCommand } from './launch.ts'
import { withStoreLock } from './lock.ts'
import { identityRecordVersion, parseRuntimeVersion, releaseFileVersion, StorePaths } from './paths.ts'
import { isInstalled, readPointerFile, readPointers, syncDirectory, writePointers, type RuntimePointers } from './pointer.ts'
import { readStoredRelease, verifyRelease, type ReleaseFileBytes, type VerifiedRelease } from './release.ts'
import type { StartCheckSummary } from './start-record.ts'
import { describeProblems, examineTree, type RecordedIdentities, type TreeExamination } from './tree.ts'

/** A temporary file the store writes before a rename: `<name>.tmp-<16 hex>`. */
const TEMPORARY = /\.tmp-[0-9a-f]{16}$/u

const NS_PER_MS = 1_000_000n

/**
 * The environment variable that sets the interval of the start check's full hash ({@link resolveFullCheckDays}): the
 * launcher reads no settings file, so this is where a person sets it, and a home process reads the same variable for
 * the start checks of an update.
 */
export const FULL_CHECK_DAYS_ENV = 'DELO_RUNTIME_FULL_CHECK_DAYS'

/** The interval of the start's full hash when the person sets none, in days. */
const FULL_CHECK_DAYS = 7

/** The longest interval of the start's full hash a person may set, in days. */
const FULL_CHECK_DAYS_MAX = 30

/**
 * Resolve the interval of the start's full hash from the person's setting: whole days from 0 to 30, where 0 hashes
 * every file at every start, and 7 when nothing is set.
 * @param text - the setting's text, or `undefined` when it is not set.
 * @returns the interval in days.
 * @throws {Error} when the text is not a whole number of days from 0 to 30.
 */
export function resolveFullCheckDays(text: string | undefined): number {
  if (text === undefined || text.trim() === '') return FULL_CHECK_DAYS
  const days = /^[0-9]{1,2}$/u.test(text.trim()) ? Number(text.trim()) : Number.NaN
  if (!(days <= FULL_CHECK_DAYS_MAX)) throw new Error(`the interval of the runtime's full check is ${JSON.stringify(text)}, and it must be a whole number of days from 0 to ${String(FULL_CHECK_DAYS_MAX)}`)
  return days
}

/** What a {@link RuntimeStore} needs. */
export interface RuntimeStoreOptions {
  /** The resolved Delo home, which exists. */
  readonly home: string
  /** The platform whose runtime closures this machine installs. */
  readonly platform: RuntimePlatform
  /** Where retention reports removals it could not finish. */
  readonly logger: DeloLogger
}

/** The files a fill step wrote, each hashed from the bytes it wrote, so the store need not read them again. */
export interface StagedFiles {
  /** The SHA-256 of the signed file list whose lengths and digests every written file matched. */
  readonly fileList: string
  /**
   * Each written file's identity by its list path, from `fstat` after its last write, as `identityOf` gives it. The
   * file was created at its installed mode, so sealing the tree leaves the identity unchanged.
   */
  readonly identities: ReadonlyMap<string, string>
}

/** What a fill step returns: the release files to keep, and the identities of the files it wrote when it reports them. */
export interface FilledRelease extends ReleaseFileBytes {
  /** The staged files' identities; without them the store hashes every staged file. */
  readonly staged?: StagedFiles
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
   * @returns the release files to keep beside the installation, and the identities of the files written.
   */
  readonly fill: (directory: string) => Promise<FilledRelease>
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
  /** The interval of the start check's full hash in days, as {@link resolveFullCheckDays} resolves it. */
  readonly fullCheckDays: number
  /** The CLI profile. */
  readonly profile: string
  /** The arguments for `delorun`. */
  readonly args: readonly string[]
}

/** A verified launch of `current`. */
export interface LaunchPlan extends LaunchCommand {
  /** The version `current` names, which the command starts. */
  readonly version: RuntimeVersion
  /** What its start check did. */
  readonly check: StartCheckSummary
}

/** What one retention run removed and what it left for the next. */
export interface RetentionResult {
  /** The entries removed, as paths. */
  readonly removed: readonly string[]
  /** The entries whose removal failed; the next run retries them. */
  readonly failed: readonly string[]
}

/**
 * Wait until every staged identity is settled and return the capture time: the clock reading, from the same clock the
 * capture records, at which every reported change time lies at least {@link RACY_WINDOW_NS} behind. The clock is read
 * again after each wait, because a timer can fire before the clock it was set against has moved that far, and the
 * wait ends at most {@link RACY_WINDOW_NS} after it began; a change time later than that, such as one written under a
 * clock since set back, stays unsettled, and the start hashes its file.
 * @param staged - the identities a fill reported, or `null` where it reported none.
 * @returns the capture time in nanoseconds.
 */
async function settle(staged: readonly (string | null)[]): Promise<bigint> {
  let newest = 0n
  for (const identity of staged) if (identity !== null && changeTimeOf(identity) > newest) newest = changeTimeOf(identity)
  const ready = newest + RACY_WINDOW_NS
  let now = nowNs()
  const deadline = now + RACY_WINDOW_NS
  while (now < ready && now < deadline) {
    const until = ready < deadline ? ready : deadline
    await sleep(Number((until - now) / NS_PER_MS) + 1)
    now = nowNs()
  }
  return now
}

/** C1's runtime store of one home. */
export class RuntimeStore {
  /** The store's paths. */
  readonly paths: StorePaths

  /** The home, the platform and the logger. */
  private readonly options: RuntimeStoreOptions
  /**
   * The file checks of the current {@link shareChecks} scope, by version and file list digest, each with whether it
   * hashed every file: a full check or an install, which a later start check or full check shares, or a start check,
   * which only a later start check shares.
   */
  private readonly shared = new AsyncLocalStorage<Map<string, { readonly full: boolean, readonly check: Promise<StartCheckSummary> }>>()

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
   * Run the full check on an installed version: verify its stored manifest and file list with the root, then hash
   * every regular file under its directory against the list, whatever the identity record says. A missing, changed or
   * extra file fails it. A pass rewrites the record, where change times are trusted, only when no usable record exists
   * or an identity differs from it, so a check of an intact runtime writes nothing. Inside a {@link shareChecks} scope,
   * the file check of a version runs once and every later call shares its result.
   * @param version - the installed version.
   * @param root - the trusted root.
   * @returns the verified runtime.
   * @throws {RuntimeStoreError} `RUNTIME_CHANGED`, naming the files that differ and offering reinstall and, when
   *   another installed version is kept as `previous`, rollback.
   */
  async checkRuntime(version: RuntimeVersion, root: RootMetadata): Promise<VerifiedRuntime> {
    const release = await this.storedRelease(version, root)
    await this.sharedCheck(version, release, true, () => this.fullCheck(version, release, 'changed'))
    return { version, ...release }
  }

  /**
   * Run contract C2's start check on an installed version, as the launcher runs it before it starts the version:
   * verify its stored manifest and file list with the root, list the installation, and compare each file's identity
   * with the installation's record, hashing every file the record cannot vouch for, and every file when the record is
   * missing or unbound, the full hash is due, or change times are not trusted here. It writes nothing but that record,
   * after a passing hash. Inside a {@link shareChecks} scope it shares a full check, an install or a start check of the
   * version already made there.
   * @param version - the installed version.
   * @param root - the trusted root.
   * @param fullCheckDays - the interval of the full hash in days, as {@link resolveFullCheckDays} resolves it.
   * @returns the verified runtime.
   * @throws {RuntimeStoreError} `RUNTIME_CHANGED`, naming the files that differ and offering reinstall and, when
   *   another installed version is kept as `previous`, rollback.
   */
  async startCheckRuntime(version: RuntimeVersion, root: RootMetadata, fullCheckDays: number): Promise<VerifiedRuntime> {
    const release = await this.storedRelease(version, root)
    await this.sharedCheck(version, release, false, () => this.startCheck(version, release, fullCheckDays))
    return { version, ...release }
  }

  /**
   * Run work in which every {@link checkRuntime} and {@link startCheckRuntime} of a version, and an install's
   * verification of it, share one file check: an update's prepare, whose channel opener, install and report readers
   * each check the runtimes they read. A start check shares any earlier check of the version; a full check shares only
   * a full check or an install. The result is shared only within the work's own calls; a later scope checks again.
   * @param work - the work.
   * @returns its result.
   */
  async shareChecks<T>(work: () => Promise<T>): Promise<T> {
    return this.shared.run(new Map(), work)
  }

  /**
   * Prepare the launch of `current`: check the store's layout, read `current`, verify its manifest and launch protocol,
   * run the start check, and build launch protocol 1's command. The start check lists the installation and compares
   * each file's identity with the installation's record and hashes every file the record cannot vouch for; it hashes
   * every file when the record is missing or unbound, the full hash is due, or change times are not trusted here. The
   * record carries no key, so a rewritten record hides a changed file from this check; the launcher gives
   * `delorun verify` an interval of 0, which hashes every file whatever the record says. It writes nothing but that
   * record, after a passing hash. It runs in every verification mode, and a launcher never
   * switches `current`, whether it is newer or older than the active runtime.
   * @param request - the launcher's support, the root, the mode, the profile and the arguments.
   * @returns the command that starts `current`, with what its start check did.
   * @throws {RuntimeStoreError} `RUNTIME_INCOMPATIBLE`, `NO_ACTIVE_RUNTIME` or `RUNTIME_CHANGED`, each naming the
   *   verification mode.
   */
  async prepareLaunch(request: LaunchRequest): Promise<LaunchPlan> {
    try {
      requireLayout(this.paths, await readStoreLayout(this.paths), request.launcher)
      const { current } = await readPointers(this.paths)
      const release = await this.storedRelease(current, request.root)
      requireProtocol(this.paths, current, release.manifest, release.files, request.launcher)
      const check = await this.startCheck(current, release, request.fullCheckDays)
      return { version: current, check, ...launchCommand(this.paths, current, request.profile, request.args) }
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
   * to `runtimes/<version>/` last, so no version reads as installed before every check passes. A staged file the fill
   * reports with an identity its `lstat` still shows, against the same file list, is not read again, where change
   * times are trusted; every other file is hashed. The identity record is then written under the lock. An installed copy of
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
        let examined: TreeExamination
        let fileSystem: number | undefined
        let capturedAt: bigint
        try {
          release = verifyRelease(this.paths, request.root, request.version, bytes)
          fileSystem = await trustedFileSystem(staging)
          // Seal the staged tree before it is checked: the digest a person's machine installs must be the digest of
          // bytes nobody could change, so no writable window may sit between the check and the mode that closes it.
          await setInstalledModes(staging, release.files)
          const staged = fileSystem === undefined ? undefined : this.stagedIdentities(release, bytes.staged)
          capturedAt = staged === undefined ? nowNs() : await settle(staged)
          examined = await examineTree(staging, release.files, staged === undefined ? undefined : { identities: staged, capturedAt })
        } catch (error) {
          throw new RuntimeStoreError('INSTALL_VERIFY_FAILED', staging, `release ${request.version} does not verify: ${(error as Error).message}`, [], { cause: error })
        }
        if (examined.problems.length > 0) throw new RuntimeStoreError('INSTALL_VERIFY_FAILED', staging, `the staged runtime ${request.version} differs from its signed file list: ${describeProblems(examined.problems)}`)
        const files = this.paths.releaseFiles(request.version)
        await writeStoreFile(files.manifest, bytes.manifest, STORE_FILE_MODE)
        await writeStoreFile(files.files, bytes.files, STORE_FILE_MODE)
        await writeStoreFile(files.bundle, bytes.bundle, STORE_FILE_MODE)
        if (layout === undefined) await writeStoreFile(this.paths.layout, Buffer.from(`${JSON.stringify({ layout: STORE_LAYOUT })}\n`), STORE_FILE_MODE)
        await syncDirectory(this.paths.root)
        const installation = this.paths.version(request.version)
        if (await isInstalled(this.paths, request.version)) await moveOutAndRemove(installation, this.paths.staging)
        await rename(staging, installation)
        await sealInstallation(installation)
        await syncDirectory(this.paths.root)
        if (fileSystem !== undefined) await this.writeRecord(request.version, release, { identities: examined.identities, capturedAt }, Number(capturedAt / NS_PER_MS), fileSystem)
        // Every file was hashed from the bytes it was written from, as a full check would hash it.
        this.shared.getStore()?.set(`${request.version}\n${this.listDigest(release)}`, { full: true, check: Promise.resolve({ full: true, hashed: release.files.files.length, files: release.files.files.length, fullCheckAt: Number(capturedAt / NS_PER_MS) }) })
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
   * and `previous` name with their release files and identity records, and remove every other installation with its
   * release files and identity record, every directory under `staging/`, and the temporary files of interrupted writes. Other entries are left alone. A
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
      const records = await readdir(this.paths.identityRecords).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      })
      for (const name of records) {
        const owner = identityRecordVersion(name)
        if (owner !== undefined && (!kept.has(owner) || TEMPORARY.test(name))) await attempt(join(this.paths.identityRecords, name), () => removeTree(join(this.paths.identityRecords, name)))
      }
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
   * Run a file check of a version once per {@link shareChecks} scope: outside a scope it always runs; inside one it
   * joins an earlier check of the same version and file list that hashed every file, or, for a start check, any earlier
   * check.
   * @param version - the installed version.
   * @param release - its verified release files.
   * @param full - whether the caller needs every file hashed.
   * @param run - the check.
   * @returns what the check, its own or a shared one, did, once it has passed.
   * @throws whatever the check throws.
   */
  private async sharedCheck(version: RuntimeVersion, release: VerifiedRelease, full: boolean, run: () => Promise<StartCheckSummary>): Promise<StartCheckSummary> {
    const scope = this.shared.getStore()
    if (scope === undefined) return run()
    const key = `${version}\n${this.listDigest(release)}`
    const earlier = scope.get(key)
    if (earlier !== undefined && (earlier.full || !full)) return earlier.check
    const check = run()
    scope.set(key, { full, check })
    return check
  }

  /**
   * Hash every file of an installation against its verified file list, and rewrite its identity record from the
   * identities the pass read under, where change times are trusted: always, for the start's scheduled pass, whose time
   * the record must move; or only when the record is missing, unbound or names another identity, for a check on
   * request.
   * @param version - the installed version.
   * @param release - its verified release files.
   * @param write - `always`, or `changed` to leave a record that already holds every identity the pass read.
   * @returns what the pass did: every file hashed.
   * @throws {RuntimeStoreError} `RUNTIME_CHANGED` naming the files that differ.
   */
  private async fullCheck(version: RuntimeVersion, release: VerifiedRelease, write: 'always' | 'changed'): Promise<StartCheckSummary> {
    const directory = this.paths.version(version)
    const fileSystem = await trustedFileSystem(directory)
    const capturedAt = nowNs()
    const examined = await this.examine(version, release)
    const summary: StartCheckSummary = { full: true, hashed: examined.hashed, files: release.files.files.length, fullCheckAt: Number(capturedAt / NS_PER_MS) }
    if (fileSystem === undefined) return summary
    if (write === 'changed') {
      const record = await readIdentityRecord(this.paths.identityRecord(version))
      const unchanged = record !== undefined && recordBound(record, await this.binding(version, release, fileSystem)) && record.files.every((identity, index) => identity === examined.identities[index])
      if (unchanged) return summary
    }
    await this.refreshRecord(version, release, { identities: examined.identities, capturedAt }, Number(capturedAt / NS_PER_MS), fileSystem)
    return summary
  }

  /**
   * What an installation's record must be bound to.
   * @param version - the installed version.
   * @param release - its verified release files.
   * @param fileSystem - the installation's trusted file system.
   * @returns the binding.
   * @throws {RuntimeStoreError} `RUNTIME_CHANGED` when the installation's directory cannot be read.
   */
  private async binding(version: RuntimeVersion, release: VerifiedRelease, fileSystem: number): Promise<RecordBinding> {
    const directory = this.paths.version(version)
    let stats
    try {
      stats = lstatSync(directory, { bigint: true })
    } catch (error) {
      throw new RuntimeStoreError('RUNTIME_CHANGED', directory, `runtime ${version} cannot be checked: ${(error as Error).message}`, await this.remediesFor(version), { cause: error })
    }
    return { version, platform: this.paths.platform, fileList: this.listDigest(release), manifest: release.manifestSha256, rootInode: String(stats.ino), fileSystem, length: release.files.files.length }
  }

  /**
   * The start check of an installation. Where change times are trusted and the installation's record is bound to this
   * release, installation and file system, and its full hash is not due, compare each file's identity with the record
   * and hash the files it cannot vouch for, rewriting the record when any was hashed and all match; otherwise
   * {@link fullCheck}. The record is unauthenticated, so a rewritten record hides a changed file from this check.
   * @param version - the installed version.
   * @param release - its verified release files.
   * @param fullCheckDays - the interval of the full hash in days.
   * @returns what the check did.
   * @throws {RuntimeStoreError} `RUNTIME_CHANGED` naming the files that differ.
   */
  private async startCheck(version: RuntimeVersion, release: VerifiedRelease, fullCheckDays: number): Promise<StartCheckSummary> {
    const directory = this.paths.version(version)
    const fileSystem = await trustedFileSystem(directory)
    if (fileSystem === undefined) return this.fullCheck(version, release, 'always')
    const record = await readIdentityRecord(this.paths.identityRecord(version))
    if (record === undefined || !recordBound(record, await this.binding(version, release, fileSystem)) || fullCheckDue(record, Date.now(), fullCheckDays)) return this.fullCheck(version, release, 'always')
    const capturedAt = nowNs()
    const examined = await this.examine(version, release, { identities: record.files, capturedAt: BigInt(record.capturedAt) * NS_PER_MS })
    if (examined.hashed > 0) await this.refreshRecord(version, release, { identities: examined.identities, capturedAt }, record.fullCheckAt, fileSystem)
    return { full: examined.hashed === release.files.files.length, hashed: examined.hashed, files: release.files.files.length, fullCheckAt: record.fullCheckAt }
  }

  /**
   * Compare an installation with its verified file list.
   * @param version - the installed version.
   * @param release - its verified release files.
   * @param recorded - the record's identities, when the start check may skip files they vouch for.
   * @returns what the comparison found.
   * @throws {RuntimeStoreError} `RUNTIME_CHANGED` naming the files that differ, or when the installation cannot be read.
   */
  private async examine(version: RuntimeVersion, release: VerifiedRelease, recorded?: RecordedIdentities): Promise<TreeExamination> {
    const directory = this.paths.version(version)
    let examined
    try {
      examined = await examineTree(directory, release.files, recorded)
    } catch (error) {
      throw new RuntimeStoreError('RUNTIME_CHANGED', directory, `runtime ${version} cannot be checked: ${(error as Error).message}`, await this.remediesFor(version), { cause: error })
    }
    if (examined.problems.length > 0) throw new RuntimeStoreError('RUNTIME_CHANGED', directory, `runtime ${version} differs from its signed file list: ${describeProblems(examined.problems)}`, await this.remediesFor(version))
    return examined
  }

  /**
   * Rewrite an installation's identity record under `store.lock` without waiting for it: while an install, a switch or
   * a removal holds the lock, the record stays as it is and the next start hashes again what this pass hashed.
   * @param version - the installed version.
   * @param release - its verified release files.
   * @param recorded - the identities a passing check read the files under, and their capture time.
   * @param fullCheckAt - when the last pass that hashed every file started, in milliseconds since the epoch.
   * @param fileSystem - the installation's trusted file system.
   */
  private async refreshRecord(version: RuntimeVersion, release: VerifiedRelease, recorded: RecordedIdentities, fullCheckAt: number, fileSystem: number): Promise<void> {
    try {
      await withStoreLock(this.paths.lock, 0, () => this.writeRecord(version, release, recorded, fullCheckAt, fileSystem))
    } catch (error) {
      if (isStoreError(error, 'STORE_BUSY')) {
        this.options.logger.info('the runtime store left its runtime check unrecorded while another operation held store.lock', { err: error })
      } else {
        this.options.logger.warn('the runtime store could not take store.lock to record its runtime check; the next start checks every file again', { err: error, data: { lock: this.paths.lock } })
      }
    }
  }

  /**
   * Write an installation's identity record, under `store.lock`, which the caller holds. A record that cannot be
   * written is logged and left; the next start then hashes every file.
   * @param version - the installed version.
   * @param release - its verified release files.
   * @param recorded - the identities a passing check read the files under, and their capture time.
   * @param fullCheckAt - when the last pass that hashed every file started, in milliseconds since the epoch.
   * @param fileSystem - the installation's trusted file system.
   */
  private async writeRecord(version: RuntimeVersion, release: VerifiedRelease, recorded: RecordedIdentities, fullCheckAt: number, fileSystem: number): Promise<void> {
    const path = this.paths.identityRecord(version)
    try {
      await mkdir(this.paths.identityRecords, { mode: PRIVATE_DIR_MODE }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      })
      const record = {
        version: String(version),
        platform: this.paths.platform,
        fileList: this.listDigest(release),
        manifest: release.manifestSha256,
        rootInode: String(lstatSync(this.paths.version(version), { bigint: true }).ino),
        fileSystem,
        capturedAt: Number(recorded.capturedAt / NS_PER_MS),
        fullCheckAt,
        files: recorded.identities,
      }
      await writeStoreFile(path, Buffer.from(recordText(record)), PROTECTED_FILE_MODE)
    } catch (error) {
      this.options.logger.warn('the runtime store could not record its runtime check; the next start checks every file again', { err: error, data: { path } })
    }
  }

  /**
   * The identities a fill reported, in the order of the verified file list, when it checked the files against that
   * list.
   * @param release - the verified release files.
   * @param staged - what the fill reported.
   * @returns one identity or `null` per list entry, or `undefined` when the fill reported none for this list.
   */
  private stagedIdentities(release: VerifiedRelease, staged: StagedFiles | undefined): (string | null)[] | undefined {
    if (staged === undefined || staged.fileList !== this.listDigest(release)) return undefined
    return release.files.files.map(file => staged.identities.get(file.path) ?? null)
  }

  /**
   * The SHA-256 of a verified file list, as its verified manifest gives it.
   * @param release - the verified release files.
   * @returns the digest.
   */
  private listDigest(release: VerifiedRelease): string {
    // A verified release's file list is this platform's, which its manifest lists (`verifyFileList`).
    return release.manifest.runtime[this.paths.platform]!.files.sha256
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
