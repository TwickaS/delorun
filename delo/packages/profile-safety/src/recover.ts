/**
 * `delorun recover`: what the person runs when an update failed, when a plugin broke the start, or when they want a
 * profile from before an update back. It reads the profile's record and history, and either reports where the profile
 * stands or carries out one of the three ways back the contract C3 offers: roll back to the snapshot an update took,
 * restore any history version, or start in safe mode and end it again. Every action reports what it did in the
 * person's words, and every refusal happens before a file changes.
 *
 * @module @delo/profile-safety/recover
 */
import type { ProfileChangedBy, ProfileVersionId, VersionAdmission } from '@deepseek-ai/dsh-plugin-manager/history'
import { ProfileSafetyError } from './errors.ts'
import { readInventory } from './inventory.ts'
import { readSafetyRecord, type LastUpdate } from './record.ts'
import { enterSafeMode, exitSafeMode, readSafeMode, startInSafeMode, type SafeModeMarker } from './safe-mode.ts'
import {
  applyRestore,
  latestVersion,
  openHistory,
  planRestore,
  recordSnapshot,
  rollbackToSnapshot,
  withProfileLock,
  type RestorePlan,
  type RevokedPlugin,
} from './snapshot.ts'

/** What `delorun recover` was asked to do. */
export type RecoverAction =
  /** Report where the profile stands; the default. */
  | { readonly kind: 'status' }
  /** Go back to the snapshot an update took, or to the version named. */
  | { readonly kind: 'rollback', readonly version?: ProfileVersionId }
  /**
   * Bring back the version named. With `saveFirst`, the current profile is saved as a version with that summary
   * before anything is written, under the same writer lock, so the restore can itself be undone by restoring that version.
   */
  | { readonly kind: 'restore', readonly version: ProfileVersionId, readonly saveFirst?: string }
  /** Start in safe mode: third-party bundles and their rows are left out until it ends. */
  | { readonly kind: 'safe-mode', readonly reason: string }
  /** End safe mode. */
  | { readonly kind: 'exit-safe-mode' }

/** What {@link recover} needs. */
export interface RecoverRequest {
  /** The profile directory. */
  readonly profileDir: string
  /** The Harness home, which holds the home patch and the run directory. */
  readonly homeDir: string
  /** The profile's name, as its directory is named. */
  readonly profile: string
  /** What to do. */
  readonly action: RecoverAction
  /** The bundles the installation itself ships, which safe mode keeps loading. */
  readonly installationBundles?: readonly string[]
  /** The plugin versions the current revocation list revokes. */
  readonly revoked?: readonly RevokedPlugin[]
  /** Decides before each version is saved whether it may be, as `openHistory` takes it; every version is saved without one. */
  readonly admit?: VersionAdmission
  /** Who asked, for the history's trailer; the person by default. */
  readonly changedBy?: ProfileChangedBy
  /** The current time, for the marker's start time; now by default. */
  readonly now?: Date
  /** How long a rollback or restore waits for the profile's writer lock; `PROFILE_LOCK_WAIT_MS` by default. */
  readonly lockWaitMs?: number
}

/** A history version as `delorun recover` lists it. */
export interface RecoverVersion {
  /** The version's id. */
  readonly id: ProfileVersionId
  /** When it was written, milliseconds since the epoch. */
  readonly at: number
  /** The change's summary. */
  readonly summary: string
}

/** What `delorun recover` found or did. */
export interface RecoverReport {
  /** The action that ran. */
  readonly action: RecoverAction['kind']
  /** The last update the profile's record holds, when it holds one. */
  readonly lastUpdate?: LastUpdate
  /** Whether the home is in safe mode, and since when. */
  readonly safeMode?: SafeModeMarker
  /** The recent history versions, newest first. */
  readonly versions: readonly RecoverVersion[]
  /** What a restore or rollback would change, and changed. */
  readonly plan?: RestorePlan
  /** The version a restore with `saveFirst` saved before it wrote anything; absent when the profile already matched the latest version. */
  readonly saved?: ProfileVersionId
  /** The third-party bundles a safe-mode start leaves out. */
  readonly skipped?: readonly string[]
  /** What the person reads, one line each. */
  readonly lines: readonly string[]
}

/**
 * Run one `delorun recover` action.
 * @param request - the profile, the home and the action.
 * @returns what it found or did, and the lines the command prints.
 * @throws {ProfileSafetyError} `RECOVER_REFUSED` when the action cannot run, such as a rollback on a profile with no
 *   history, and `RESTORE_REFUSED` when a version cannot be brought back; nothing has changed when it throws.
 */
export async function recover(request: RecoverRequest): Promise<RecoverReport> {
  const history = openHistory({ profileDir: request.profileDir, ...request.admit === undefined ? {} : { admit: request.admit } })
  const record = readSafetyRecord(request.profileDir)
  const safeMode = readSafeMode(request.homeDir, request.profile)
  const versions = (await history.list(10)).map(version => ({ id: version.id, at: version.at, summary: version.summary }))
  const lastUpdate = record.update
  switch (request.action.kind) {
    case 'status':
      return { action: 'status', ...lastUpdate === undefined ? {} : { lastUpdate }, ...safeMode === undefined ? {} : { safeMode }, versions, lines: statusLines(lastUpdate, safeMode, versions, record.ejected.map(entry => entry.name), record.disabled) }
    case 'rollback': {
      const { version } = request.action
      const plan = await withProfileLock(request.profileDir, 'RECOVER_REFUSED', () => rollbackToSnapshot({
        profileDir: request.profileDir,
        homeDir: request.homeDir,
        ...version === undefined ? {} : { version },
        ...request.revoked === undefined ? {} : { revoked: request.revoked },
        history,
      }), request.lockWaitMs)
      return { action: 'rollback', ...lastUpdate === undefined ? {} : { lastUpdate }, versions, plan, lines: planLines('Rolled back', plan) }
    }
    case 'restore': {
      const restore = {
        profileDir: request.profileDir,
        homeDir: request.homeDir,
        version: request.action.version,
        ...request.revoked === undefined ? {} : { revoked: request.revoked },
        history,
      }
      const { saveFirst } = request.action
      let saved: ProfileVersionId | undefined
      const planned = await withProfileLock(request.profileDir, 'RESTORE_REFUSED', async () => {
        if (saveFirst !== undefined) {
          const latest = (await history.list(1))[0]?.id
          const id = await recordSnapshot({ profileDir: request.profileDir, homeDir: request.homeDir, summary: saveFirst, changedBy: request.changedBy ?? { kind: 'person' }, history })
          if (id !== latest) saved = id
        }
        const plan = await planRestore(restore)
        await applyRestore(plan, restore)
        return plan
      }, request.lockWaitMs)
      return { action: 'restore', versions, plan: planned, ...saved === undefined ? {} : { saved }, lines: planLines(`Restored ${request.action.version}`, planned) }
    }
    case 'safe-mode': {
      const { installationBundles } = request
      if (installationBundles === undefined) {
        throw new ProfileSafetyError('RECOVER_REFUSED', request.profileDir, 'safe mode needs the installation\'s own bundle list, which this caller did not pass.', ['repair-profile'], [])
      }
      const plan = startInSafeMode({ inventory: readInventory({ profileDir: request.profileDir, homeDir: request.homeDir }), installationBundles })
      const marker = await enterSafeMode({ homeDir: request.homeDir, profile: request.profile, reason: request.action.reason, skipped: plan.skipped, ...request.now === undefined ? {} : { now: request.now } })
      return {
        action: 'safe-mode',
        safeMode: marker,
        skipped: plan.skipped,
        versions,
        lines: [
          `Safe mode is on since ${marker.since}.`,
          ...plan.skipped.length === 0
            ? ['This profile selects no third-party bundles, so the next start loads all of it.']
            : [`The next start leaves out ${plan.skipped.join(', ')}; their rows and your settings stay in the profile.`],
          'Start Delorun again, then run `delorun recover exit-safe-mode` when it works.',
        ],
      }
    }
    case 'exit-safe-mode': {
      const removed = await exitSafeMode({ homeDir: request.homeDir, profile: request.profile })
      return {
        action: 'exit-safe-mode',
        versions,
        lines: [removed ? 'Safe mode is off; the next start loads the whole profile again.' : 'Safe mode was not on, so nothing changed.'],
      }
    }
  }
}

function statusLines(
  lastUpdate: LastUpdate | undefined, safeMode: SafeModeMarker | undefined, versions: readonly RecoverVersion[],
  ejected: readonly string[], disabled: readonly { readonly name: string, readonly message: string }[],
): string[] {
  return [
    lastUpdate === undefined
      ? 'This profile has not been through a Delorun update yet.'
      : `The last update, from Delorun ${lastUpdate.from} to Delorun ${lastUpdate.to}, ${updateOutcome(lastUpdate)}.`,
    ...lastUpdate?.snapshot === undefined ? [] : [`Its snapshot is profile version ${lastUpdate.snapshot}.`],
    safeMode === undefined ? 'Safe mode is off.' : `Safe mode is on since ${safeMode.since}: ${safeMode.reason}.`,
    versionLine(versions),
    ...ejected.length === 0 ? [] : [`Ejected from this profile: ${ejected.join(', ')}.`],
    ...disabled.length === 0 ? [] : [`Kept disabled by a restore: ${disabled.map(entry => `${entry.name} (${entry.message})`).join(', ')}.`],
    'Run `delorun recover rollback` to go back, `delorun recover restore <version>` for another version, or `delorun recover safe-mode` to start without third-party plugins.',
  ]
}

/**
 * How the last update stands, in the person's words: committed, rolled back, still applying (an update that has not
 * committed, or one stopped before it did), or the state it ended in with its reason.
 * @param update - the profile's record of the update.
 * @returns the clause after the update's versions.
 */
function updateOutcome(update: LastUpdate): string {
  switch (update.state) {
    case 'committed': return 'committed'
    case 'rolled-back': return 'was rolled back'
    case 'applying': return 'has not committed: it is applying, or it stopped before it committed'
    default: return `ended ${update.state}${update.failure === undefined ? '' : `: ${update.failure}`}`
  }
}

/**
 * The line that lists the profile's recent versions.
 * @param versions - the versions, newest first.
 * @returns the line the person reads.
 */
function versionLine(versions: readonly RecoverVersion[]): string {
  const [newest] = versions
  if (newest === undefined) return 'The profile history holds no version yet.'
  const count = versions.length === 1 ? 'One profile version is' : `${String(versions.length)} profile versions are`
  return `${count} available, the newest written ${new Date(newest.at).toISOString()}.`
}

function planLines(lead: string, plan: RestorePlan): string[] {
  const plugins = plan.changes.plugins.map(plugin => `${plugin.name} ${plugin.from ?? 'not installed'} to ${plugin.to ?? 'removed'}`)
  const builds = plan.changes.builds.map(build => `${build.key}'s build script ${decision(build.from)} to ${decision(build.to)}`)
  const exemptions = plan.changes.exemptions.map(exemption => `${exemption.key} on the ${exemption.axis} axis ${exemption.change}`)
  return [
    `${lead}: ${plan.writes.length === 0 ? 'no profile files change' : `these profile files change: ${plan.writes.join(', ')}`}${plan.homePatchWritten ? ', and so does the home patch' : ''}.`,
    ...plugins.length === 0 ? [] : [`Plugins: ${plugins.join('; ')}.`],
    ...builds.length === 0 ? [] : [`Builds: ${builds.join('; ')}.`],
    ...exemptions.length === 0 ? [] : [`Exemptions: ${exemptions.join('; ')}.`],
    ...plan.bundles.length === 0 ? [] : [`Bundles: ${plan.bundles.map(bundle => `${bundle.name} ${bundle.selected ? 'comes back' : 'leaves'}`).join('; ')}.`],
    ...plan.disabled.length === 0 ? [] : [`Kept disabled: ${plan.disabled.map(plugin => `${plugin.name} (${plugin.message})`).join('; ')}.`],
    'Your rows and settings are unchanged by this.',
  ]
}

function decision(value: boolean | 'pending' | undefined): string {
  return value === undefined ? 'unset' : value === 'pending' ? 'undecided' : value ? 'allowed' : 'denied'
}

/**
 * The version `delorun recover rollback --profile-only` would go back to without an update record.
 * @param profileDir - the profile directory.
 * @returns the latest version's id, or undefined before the first version.
 */
export async function recoverTarget(profileDir: string): Promise<ProfileVersionId | undefined> {
  return latestVersion(openHistory({ profileDir }))
}
