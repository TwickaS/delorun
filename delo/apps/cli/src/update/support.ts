/**
 * The home process's update support for the CLI home (contracts C3 and C19): C1's runtime store with the release
 * channel and C3's report, the profile history through `@delo/profile-safety`, and the session-data copies and the
 * one rollback function of `@delo/update`, and the person's approved harness files carried across the switch
 * ([harness carry](./harness-carry.ts)). `delorun start` passes it to the home process when it runs from the
 * runtime store, and `delorun recover rollback` uses the same rollback with no home process running.
 *
 * @module @delo/cli/update/support
 */
import { join } from 'node:path'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import type { UpdateJournal } from '@delo/contract-home-process'
import { HomeProcessError, type ProfileSnapshots, type RollbackSteps, type SessionDataCopies, type UpdateSupport } from '@delo/home-process'
import { historyGitProblem, readSafetyRecord, recordSnapshot, rollbackToSnapshot, withProfileLock, withUpdate, writeSafetyRecord } from '@delo/profile-safety'
import type { ProfileVersionId } from '@deepseek-ai/dsh-plugin-manager/history'
import { assertSoleDataUser, DataInUseError } from '../home-exclusion.ts'
import { describeFailure, renderRefusal } from '@delo/home'
import { isInstallError } from '@delo/install'
import { CLI_DESCRIBERS, cliRedactor } from '../refusals.ts'
import { storeHarnessCarry } from './harness-carry.ts'
import { isChangesError } from '@delo/changes'
import { HomeRuntimeStore, isStoreError, type HomeRuntimeStoreOptions, type OpenUpdateChannel, type RuntimeStore, type TrustedRootSource } from '@delo/runtime-store'
import { assertCopyFits, buildFromSources, discardCopy, keepOnlyCopy, isDataSafetyError, planDataCopy, readDataFormats, rollbackUpdate, saveDataCopy, type ReportSources, type RollbackResult } from '@delo/update'

/** What {@link homeUpdateSupport} needs. */
export interface UpdateSupportOptions {
  /** The resolved Delo home. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
  /** C1's runtime store. */
  readonly store: RuntimeStore
  /** The stored root, anchored on the launcher's roots ([trusted root](./trusted-root.ts)). */
  readonly root: TrustedRootSource
  /**
   * Contract C18's release-log start check before a home process starts from an installed version
   * ([release check](./release-check.ts)); none when absent.
   */
  readonly preLaunch?: HomeRuntimeStoreOptions['preLaunch']
  /** Opens the release channel of one prepare. */
  readonly openChannel: OpenUpdateChannel
  /** The report's sources. */
  readonly sources: ReportSources
  /** The clock; `() => new Date()` in a real run. */
  readonly now: () => Date
  /** How long an update's snapshot and a rollback wait for the profile's writer lock; `PROFILE_LOCK_WAIT_MS` by default. */
  readonly profileLockWaitMs?: number
}

/**
 * The profile history an update saves and a rollback restores: C3's snapshot named for the update, with the report,
 * and Delo's record of the update in `delo-safety.json`. `save` holds upstream's profile writer lock while it writes;
 * `restore` runs inside {@link rollbackRecordedUpdate}, which holds that lock across the whole rollback.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 * @param now - the clock.
 * @param lockWaitMs - how long `save` waits for the profile's writer lock; `PROFILE_LOCK_WAIT_MS` by default.
 * @returns the snapshots, whose `restore` brings back the version the update record names; the caller holds the lock.
 */
export function profileSnapshots(home: string, profile: string, now: () => Date, lockWaitMs?: number): ProfileSnapshots & { restore(record: Pick<UpdateJournal, 'from' | 'to' | 'snapshot'>): Promise<void> } {
  const profileDir = join(home, 'profiles', profile)
  return {
    save: (from, to, report) => withProfileLock(profileDir, 'SNAPSHOT_FAILED', async () => {
      const snapshot = await recordSnapshot({ profileDir, homeDir: home, summary: `Before update to Delo ${to}`, changedBy: { kind: 'person' }, report })
      await writeSafetyRecord(profileDir, withUpdate(readSafetyRecord(profileDir), { from, to, at: now().toISOString(), state: 'applying', snapshot }))
      return snapshot
    }, lockWaitMs),
    restore: async (record) => {
      const update = readSafetyRecord(profileDir).update
      const version = record.snapshot ?? (update?.from === record.from && update.to === record.to ? update.snapshot : undefined)
      await rollbackToSnapshot({ profileDir, homeDir: home, ...version === undefined ? {} : { version: version as ProfileVersionId } })
      await writeSafetyRecord(profileDir, withUpdate(readSafetyRecord(profileDir), { from: record.from, to: record.to, at: now().toISOString(), state: 'rolled-back', ...version === undefined ? {} : { snapshot: version } }))
    },
  }
}

/**
 * Refuse with C19's `GIT_UNAVAILABLE` when the git the profile history runs cannot start: an update's snapshot and
 * every rollback need it, so an update or a rollback checks it before anything is fetched or changed and never stops
 * half-way for a missing git.
 * @throws {HomeProcessError} `GIT_UNAVAILABLE`, naming the command and why it cannot run.
 */
export async function assertHistoryGit(): Promise<void> {
  const problem = await historyGitProblem({})
  if (problem !== undefined) throw new HomeProcessError('GIT_UNAVAILABLE', `Delo saves and restores the profile's history with git, and git cannot run here: ${problem}; nothing was fetched or changed`)
}

/**
 * Run C3's one rollback function over the home's copies and the profile history: refuse when git cannot run or while
 * another process uses the chat data, take upstream's profile writer lock, check that the version rolled back to is
 * installed and passes its start check before anything changes, then the caller's `rolling-back` mark, the data, the
 * profile and the caller's runtime switch. The lock is held from before the mark until the switch, so no
 * plugin-manager change lands in the middle of the table and a lock that cannot be taken refuses before anything
 * changed.
 * @param options - the home, the profile, the store, the clock and the lock's wait.
 * @param record - the update record.
 * @param steps - whether only the profile goes back, the caller's runtime switch and its `rolling-back` mark.
 * @returns what the rollback did.
 * @throws {HomeProcessError} `GIT_UNAVAILABLE` when git cannot run; {@link DataSafetyError} `ROLLBACK_NEEDS_DATA_COPY`
 *   when the table refuses; {@link DataInUseError} while another process uses the chat data; `ProfileSafetyError`
 *   `RECOVER_REFUSED` when the profile's writer lock is not released in time; the store's error when the version rolled
 *   back to is unusable; nothing has changed then.
 */
export async function rollbackRecordedUpdate(options: Pick<UpdateSupportOptions, 'home' | 'profile' | 'store' | 'root' | 'now' | 'profileLockWaitMs'>, record: UpdateJournal, steps: RollbackSteps): Promise<RollbackResult> {
  await assertHistoryGit()
  const snapshots = profileSnapshots(options.home, options.profile, options.now)
  if (!steps.profileOnly) assertSoleDataUser(options.home)
  return withProfileLock(join(options.home, 'profiles', options.profile), 'RECOVER_REFUSED', () => rollbackUpdate({
    home: options.home, record, profileOnly: steps.profileOnly, now: options.now(),
    preflight: async () => { await options.store.checkRuntime(record.from, await options.root()) },
    markRollingBack: steps.markRollingBack,
    restoreProfile: () => snapshots.restore(record),
    switchRuntime: steps.switchRuntime,
  }), options.profileLockWaitMs)
}

/**
 * The session-data copies of the home, with every refusal turned into C19's error codes.
 * @param options - the home, the profile, the store and the clock.
 * @returns the copies.
 */
export function sessionDataCopies(options: Pick<UpdateSupportOptions, 'home' | 'profile' | 'store' | 'root' | 'now' | 'profileLockWaitMs'>): SessionDataCopies {
  const { home, store } = options
  const refusal = (error: unknown): unknown => {
    if (isDataSafetyError(error, 'DATA_COPY_NO_SPACE')) return new HomeProcessError('DATA_COPY_NO_SPACE', error.detail)
    if (isDataSafetyError(error, 'ROLLBACK_NEEDS_DATA_COPY')) return new HomeProcessError('ROLLBACK_NEEDS_DATA_COPY', error.detail)
    if (error instanceof DataInUseError) return new HomeProcessError('CHATS_RUNNING', error.detail)
    if (isStoreError(error)) return new HomeProcessError('ROLLBACK_TARGET_UNUSABLE', error.message)
    return error
  }
  return {
    async plan(copy: boolean) {
      try {
        assertSoleDataUser(home)
        if (copy) assertCopyFits(await planDataCopy(home))
      } catch (error) {
        throw refusal(error)
      }
    },
    async confirmSoleUser() {
      soleDataUser(home)
      return Promise.resolve()
    },
    async save(from: RuntimeVersion, to: RuntimeVersion) {
      const formats = { from: await readDataFormats(store.paths.version(from)), to: await readDataFormats(store.paths.version(to)) }
      try {
        assertSoleDataUser(home)
        await saveDataCopy({ home, from, to, formats, now: options.now() })
      } catch (error) {
        throw refusal(error)
      }
    },
    async discard(to: RuntimeVersion) {
      await discardCopy(home, to)
    },
    async commit(to: RuntimeVersion) {
      await keepOnlyCopy(home, to)
    },
    async rollback(record, steps) {
      try {
        return (await rollbackRecordedUpdate(options, record, steps)).lines
      } catch (error) {
        throw refusal(error)
      }
    },
  }
}

/**
 * The detail of a prepare's `VERIFY_FAILED` or `CHANNEL_UNREACHABLE` line: the refusal `delorun` prints for the same
 * failure, from the one refusal format with its remedies and through the same redactor, so `delorun update` explains
 * it as the launcher does.
 * @param error - the failure.
 * @param profile - the CLI profile, which a remedy's command names.
 * @returns the text, without its trailing newline.
 */
export function prepareRefusal(error: unknown, profile: string): string {
  return renderRefusal(describeFailure(error, CLI_DESCRIBERS, { profile }), cliRedactor()).trimEnd()
}

/**
 * Refuse with C19's `CHATS_RUNNING` while another process uses the chat data.
 * @param home - the resolved Delo home.
 * @throws {HomeProcessError} `CHATS_RUNNING` naming the processes.
 */
function soleDataUser(home: string): void {
  try {
    assertSoleDataUser(home)
  } catch (error) {
    throw error instanceof DataInUseError ? new HomeProcessError('CHATS_RUNNING', error.detail) : error
  }
}

/**
 * C1's store as the home process drives it, with C19's codes for the store refusals the handshake answers with a line
 * a person reads: a prepare whose download did not finish is `CHANNEL_UNREACHABLE`, and one whose release the channel
 * refuses, or whose installed runtime, stored root or a target file the report reads fails its check, is
 * `VERIFY_FAILED`, each with the refusal `delorun` prints for the same failure as its detail ({@link prepareRefusal}); a
 * version to roll back to that is not
 * installed, fails its start check or cannot be checked is `ROLLBACK_TARGET_UNUSABLE`. Any other failure reaches the
 * handshake unchanged. A prepare, and the report of a rollback that switches the runtime, refuse with `CHATS_RUNNING`
 * while another process uses the chat data, another profile's home process included, and a prepare refuses with
 * `GIT_UNAVAILABLE` when git cannot run, before anything is downloaded or changed: `current` and the chat data are the
 * whole home's.
 */
class CliHomeRuntimeStore extends HomeRuntimeStore {
  /** The CLI profile, which a refusal's remedies name. */
  private readonly profile: string
  /** The resolved Delo home whose data users are checked. */
  private readonly dataHome: string

  /**
   * @param options - the store's options.
   * @param dataHome - the resolved Delo home whose data users are checked.
   */
  constructor(options: ConstructorParameters<typeof HomeRuntimeStore>[0], dataHome: string) {
    super(options)
    this.profile = options.profile
    this.dataHome = dataHome
  }

  /** @inheritdoc */
  override async prepare(...args: Parameters<HomeRuntimeStore['prepare']>): ReturnType<HomeRuntimeStore['prepare']> {
    soleDataUser(this.dataHome)
    await assertHistoryGit()
    try {
      return await super.prepare(...args)
    } catch (error) {
      // A download that did not finish is the network's or the disk's, not a release that failed a check.
      if (isInstallError(error, 'DOWNLOAD_FAILED') && !error.oversize) throw new HomeProcessError('CHANNEL_UNREACHABLE', prepareRefusal(error, this.profile))
      if (isInstallError(error) || isStoreError(error, 'ROOT_NOT_ANCHORED', 'INSTALL_VERIFY_FAILED', 'RUNTIME_CHANGED') || (isChangesError(error) && error.code === 'RUNTIME_CHANGED')) throw new HomeProcessError('VERIFY_FAILED', prepareRefusal(error, this.profile))
      throw error
    }
  }

  /** @inheritdoc */
  override async reportRollback(...args: Parameters<HomeRuntimeStore['reportRollback']>): ReturnType<HomeRuntimeStore['reportRollback']> {
    soleDataUser(this.dataHome)
    try {
      return await super.reportRollback(...args)
    } catch (error) {
      if (isStoreError(error)) throw new HomeProcessError('ROLLBACK_TARGET_UNUSABLE', error.message)
      throw error
    }
  }
}

/**
 * The home process's update support over the store, the channel and the report's sources.
 * @param options - the home, the profile, the store, the anchored root, the channel's opener, the sources and the clock.
 * @returns the support, whose harness carry reads both runtimes through the store's start check.
 */
export function homeUpdateSupport(options: UpdateSupportOptions): UpdateSupport {
  const store = new CliHomeRuntimeStore({
    store: options.store,
    profile: options.profile,
    openChannel: options.openChannel,
    root: options.root,
    ...options.preLaunch === undefined ? {} : { preLaunch: options.preLaunch },
    report: { build: async (version, purpose) => buildFromSources('cli-home', options.sources, version, purpose) },
  }, options.home)
  return {
    store,
    snapshots: profileSnapshots(options.home, options.profile, options.now, options.profileLockWaitMs),
    copies: sessionDataCopies(options),
    harness: storeHarnessCarry(options),
  }
}
