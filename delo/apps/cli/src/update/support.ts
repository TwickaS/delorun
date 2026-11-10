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
import { assertSoleDataUser, DataInUseError } from './data-users.ts'
import { HomeRuntimeStore, isStoreError, readStoredRoot, type RuntimeChannel, type RuntimeStore } from '@delo/runtime-store'
import { assertCopyFits, buildFromSources, discardCopy, keepOnlyCopy, isDataSafetyError, planDataCopy, readDataFormats, recoverDataCopies, rollbackUpdate, saveDataCopy, type ReportSources, type RollbackResult } from '@delo/update'

/** What {@link homeUpdateSupport} needs. */
export interface UpdateSupportOptions {
  /** The resolved Delo home. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
  /** C1's runtime store. */
  readonly store: RuntimeStore
  /** The release channel. */
  readonly channel: RuntimeChannel
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
export async function rollbackRecordedUpdate(options: Pick<UpdateSupportOptions, 'home' | 'profile' | 'store' | 'now'>, record: UpdateJournal, steps: RollbackSteps): Promise<RollbackResult> {
  const snapshots = profileSnapshots(options.home, options.profile, options.now)
  if (!steps.profileOnly) assertSoleDataUser(options.home)
  return rollbackUpdate({
    home: options.home, record, profileOnly: steps.profileOnly, now: options.now(),
    preflight: async () => { await options.store.checkRuntime(record.from, await readStoredRoot(options.home)) },
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
export function sessionDataCopies(options: Pick<UpdateSupportOptions, 'home' | 'profile' | 'store' | 'now'>): SessionDataCopies {
  const { home, store } = options
  const refusal = (error: unknown): unknown => {
    if (isDataSafetyError(error, 'DATA_COPY_NO_SPACE')) return new HomeProcessError('DATA_COPY_NO_SPACE', error.detail)
    if (isDataSafetyError(error, 'ROLLBACK_NEEDS_DATA_COPY')) return new HomeProcessError('ROLLBACK_NEEDS_DATA_COPY', error.detail)
    if (error instanceof DataInUseError) return new HomeProcessError('CHATS_RUNNING', error.detail)
    if (isStoreError(error)) return new HomeProcessError('ROLLBACK_TARGET_UNUSABLE', error.message)
    return error
  }
  return {
    async recover() {
      await recoverDataCopies(home)
    },
    async plan() {
      try {
        assertSoleDataUser(home)
        assertCopyFits(await planDataCopy(home))
      } catch (error) {
        throw refusal(error)
      }
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
 * The home process's update support over the store, the channel and the report's sources.
 * @param options - the home, the profile, the store, the channel, the sources and the clock.
 * @returns the support.
 */
export function homeUpdateSupport(options: UpdateSupportOptions): UpdateSupport {
  const store = new HomeRuntimeStore({
    store: options.store,
    profile: options.profile,
    channel: options.channel,
    report: { build: version => buildFromSources('cli-home', options.sources, version) },
  })
  return { store, snapshots: profileSnapshots(options.home, options.profile, options.now), copies: sessionDataCopies(options) }
}
