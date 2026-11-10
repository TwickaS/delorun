/**
 * The home process's update support for the CLI home (contracts C3 and C19): C1's runtime store with the release
 * channel and C3's report, the profile history through `@delo/profile-safety`, and the session-data copies and the
 * one rollback function of `@delo/update`. `delorun start` passes it to the home process when it runs from the
 * runtime store, and `delorun recover rollback` uses the same rollback with no home process running.
 *
 * @module @delo/cli/update/support
 */
import { join } from 'node:path'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import type { UpdateJournal } from '@delo/contract-home-process'
import { HomeProcessError, type ProfileSnapshots, type RollbackSteps, type SessionDataCopies, type UpdateSupport } from '@delo/home-process'
import { readSafetyRecord, recordSnapshot, rollbackToSnapshot, withUpdate, writeSafetyRecord } from '@delo/profile-safety'
import type { ProfileVersionId } from '@deepseek-ai/dsh-plugin-manager/history'
import { assertSoleDataUser, DataInUseError } from '../home-exclusion.ts'
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
}

/**
 * The profile history an update saves and a rollback restores: C3's snapshot named for the update, with the report,
 * and Delo's record of the update in `delo-safety.json`.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 * @param now - the clock.
 * @returns the snapshots, whose `restore` brings back the version the update record names.
 */
export function profileSnapshots(home: string, profile: string, now: () => Date): ProfileSnapshots & { restore(record: Pick<UpdateJournal, 'from' | 'to' | 'snapshot'>): Promise<void> } {
  const profileDir = join(home, 'profiles', profile)
  return {
    async save(from, to, report) {
      const snapshot = await recordSnapshot({ profileDir, homeDir: home, summary: `Before update to Delo ${to}`, changedBy: { kind: 'person' }, report })
      await writeSafetyRecord(profileDir, withUpdate(readSafetyRecord(profileDir), { from, to, at: now().toISOString(), state: 'applying', snapshot }))
      return snapshot
    },
    async restore(record) {
      const update = readSafetyRecord(profileDir).update
      const version = record.snapshot ?? (update?.from === record.from && update.to === record.to ? update.snapshot : undefined)
      await rollbackToSnapshot({ profileDir, homeDir: home, ...version === undefined ? {} : { version: version as ProfileVersionId } })
      await writeSafetyRecord(profileDir, withUpdate(readSafetyRecord(profileDir), { from: record.from, to: record.to, at: now().toISOString(), state: 'rolled-back', ...version === undefined ? {} : { snapshot: version } }))
    },
  }
}

/**
 * Run C3's one rollback function over the home's copies and the profile history: refuse while another process uses
 * the chat data, check that the version rolled back to is installed and passes its start check before anything
 * changes, then the caller's `rolling-back` mark, the data, the profile and the caller's runtime switch.
 * @param options - the home, the profile, the store and the clock.
 * @param record - the update record.
 * @param steps - whether only the profile goes back, the caller's runtime switch and its `rolling-back` mark.
 * @returns what the rollback did.
 * @throws {DataSafetyError} `ROLLBACK_NEEDS_DATA_COPY` when the table refuses; {@link DataInUseError} while another
 *   process uses the chat data; the store's error when the version rolled back to is unusable; nothing has changed then.
 */
export async function rollbackRecordedUpdate(options: Pick<UpdateSupportOptions, 'home' | 'profile' | 'store' | 'root' | 'now'>, record: UpdateJournal, steps: RollbackSteps): Promise<RollbackResult> {
  const snapshots = profileSnapshots(options.home, options.profile, options.now)
  if (!steps.profileOnly) assertSoleDataUser(options.home)
  return rollbackUpdate({
    home: options.home, record, profileOnly: steps.profileOnly, now: options.now(),
    preflight: async () => { await options.store.checkRuntime(record.from, await options.root()) },
    markRollingBack: steps.markRollingBack,
    restoreProfile: () => snapshots.restore(record),
    switchRuntime: steps.switchRuntime,
  })
}

/**
 * The session-data copies of the home, with every refusal turned into C19's error codes.
 * @param options - the home, the profile, the store and the clock.
 * @returns the copies.
 */
export function sessionDataCopies(options: Pick<UpdateSupportOptions, 'home' | 'profile' | 'store' | 'root' | 'now'>): SessionDataCopies {
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
        await rollbackRecordedUpdate(options, record, steps)
      } catch (error) {
        throw refusal(error)
      }
    },
  }
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
 * a person reads: a prepare whose release, installed runtime or stored root fails its check is `VERIFY_FAILED`, and a
 * version to roll back to that is not installed, fails its start check or cannot be checked is
 * `ROLLBACK_TARGET_UNUSABLE`. Any other failure reaches the handshake unchanged. A prepare, and the report of a rollback
 * that switches the runtime, refuse with `CHATS_RUNNING` while another process uses the chat data, another profile's
 * home process included, before anything is downloaded or changed: `current` and the chat data are the whole home's.
 */
class CliHomeRuntimeStore extends HomeRuntimeStore {
  /**
   * @param options - the store's options.
   * @param dataHome - the resolved Delo home whose data users are checked.
   */
  constructor(options: ConstructorParameters<typeof HomeRuntimeStore>[0], private readonly dataHome: string) {
    super(options)
  }

  /** @inheritdoc */
  override async prepare(...args: Parameters<HomeRuntimeStore['prepare']>): ReturnType<HomeRuntimeStore['prepare']> {
    soleDataUser(this.dataHome)
    try {
      return await super.prepare(...args)
    } catch (error) {
      if (isStoreError(error, 'ROOT_NOT_ANCHORED', 'INSTALL_VERIFY_FAILED', 'RUNTIME_CHANGED')) throw new HomeProcessError('VERIFY_FAILED', error.message)
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
 * @returns the support.
 */
export function homeUpdateSupport(options: UpdateSupportOptions): UpdateSupport {
  const store = new CliHomeRuntimeStore({
    store: options.store,
    profile: options.profile,
    openChannel: options.openChannel,
    root: options.root,
    ...options.preLaunch === undefined ? {} : { preLaunch: options.preLaunch },
    report: { build: version => buildFromSources('cli-home', options.sources, version) },
  }, options.home)
  return { store, snapshots: profileSnapshots(options.home, options.profile, options.now), copies: sessionDataCopies(options) }
}
