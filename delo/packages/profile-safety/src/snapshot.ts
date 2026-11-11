/**
 * The extended profile history: the version an update writes before it changes anything, and the version an undo, a
 * restore or a rollback brings back. Delo's history holds upstream's five files plus the Delo axis's exemption file, its
 * own safety record, a copy of the home patch and the update report, so a version brings back the profile the person
 * had — bundle order included — rather than the subset upstream's plugin management writes.
 *
 * Everything here reads or writes the profile's history through upstream's git-backed `ProfileHistory`, with the file
 * list replaced by {@link PROFILE_SAFETY_FILES}; no file outside the profile and the home patch is touched.
 *
 * @module @delo/profile-safety/snapshot
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parse, stringify } from 'yaml'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  HistoryUnavailableError,
  ProfileHistory,
  writeProfileVersion,
  type ProfileChangedBy,
  type ProfileVersionId,
  type VersionAdmission,
} from '@deepseek-ai/dsh-plugin-manager/history'
import type { VersionAxis } from '@delo/contract-plugin-versions'
import { EXEMPTION_FILES } from '@delo/contract-plugin-versions'
import type { RestoreChanges } from '@delo/contract-update-report'
import type { SemanticVersion } from '@delo/contract-release-manifest'
import { isProfileSafetyError, ProfileSafetyError } from './errors.ts'
import {
  DELO_STATE_FILES,
  HOME_PATCH_COPY_FILENAME,
  HOME_PATCH_FILENAME,
  PROFILE_MANIFEST_FILENAME,
  PROFILE_PATCH_FILENAME,
  PROFILE_SAFETY_FILES,
  PROFILE_WORKSPACE_FILENAME,
  SAFETY_RECORD_FILENAME,
  UPDATE_REPORT_FILENAME,
} from './files.ts'
import { readSafetyRecord, withDisabled, writeSafetyRecord, type DisabledPlugin } from './record.ts'

const runFile = promisify(execFile)

/** How long one git run of the history may take. */
export const HISTORY_TIMEOUT_MS = 30_000

/** How long a profile change waits for upstream's profile writer lock: the plugin manager's own default wait. */
export const PROFILE_LOCK_WAIT_MS = 120_000

/**
 * Run one change to a profile's files under upstream's profile writer lock, the `package.json` lock the Host's plugin
 * manager holds while it installs, edits, records or restores, so a Delo snapshot, restore or rollback never interleaves
 * with one. The lock is not reentrant: the operation must not take it again.
 * @param profileDir - the profile directory.
 * @param code - the refusal's code when the lock cannot be taken.
 * @param operation - the change, run while holding the lock.
 * @param waitMs - how long to wait for another holder; {@link PROFILE_LOCK_WAIT_MS} by default.
 * @returns the operation's result; the lock releases on both outcomes.
 * @throws {ProfileSafetyError} `code` when the lock cannot be taken in time, before the operation changes anything;
 *   the operation's own error otherwise.
 */
export async function withProfileLock<T>(profileDir: string, code: 'SNAPSHOT_FAILED' | 'RESTORE_REFUSED' | 'RECOVER_REFUSED', operation: () => Promise<T>, waitMs: number = PROFILE_LOCK_WAIT_MS): Promise<T> {
  let started = false
  try {
    return await withFileLock(join(profileDir, PROFILE_MANIFEST_FILENAME), () => {
      started = true
      return operation()
    }, { waitMs })
  } catch (error) {
    if (started) throw error
    const detail = `the profile's writer lock could not be taken, so another process may be changing this profile; nothing was changed. Wait for it to finish, then run the command again: ${error instanceof Error ? error.message : String(error)}`
    throw new ProfileSafetyError(code, profileDir, detail, code === 'SNAPSHOT_FAILED' ? ['skip-update'] : [], [], { cause: error })
  }
}

/** What {@link openHistory} needs. */
export interface HistoryOptions {
  /** The profile directory, the history's work tree. */
  readonly profileDir: string
  /** The git executable, resolved through `PATH`; `git` by default. */
  readonly git?: string
  /** The bound on one git run; {@link HISTORY_TIMEOUT_MS} by default. */
  readonly timeoutMs?: number
  /**
   * Decides before each version is saved whether it may be, such as the one `secretFieldAdmission` builds; a refused
   * snapshot is `SNAPSHOT_FAILED` with the reason. Without one every version is saved.
   */
  readonly admit?: VersionAdmission
}

/**
 * Why the git the profile history runs cannot start, checked before an update so the person learns it before
 * anything is fetched or written: an update's snapshot and a rollback both need it.
 * @param options - the git command and its timeout, as {@link openHistory} takes them.
 * @returns `undefined` when `git --version` exits 0; otherwise the reason, naming the command.
 */
export async function historyGitProblem(options: Pick<HistoryOptions, 'git' | 'timeoutMs'>): Promise<string | undefined> {
  const git = options.git ?? 'git'
  try {
    await runFile(git, ['--version'], { timeout: options.timeoutMs ?? HISTORY_TIMEOUT_MS })
    return undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return `no ${git} command is on PATH`
    return `${git} --version failed: ${error instanceof Error ? error.message.split('\n')[0]! : String(error)}`
  }
}

/**
 * Open a profile's history over {@link PROFILE_SAFETY_FILES}.
 * @param options - the profile directory and, optionally, the git command, its timeout and the version admission.
 * @returns the history to record snapshots and read versions with.
 */
export function openHistory(options: HistoryOptions): ProfileHistory {
  return new ProfileHistory(options.profileDir, PROFILE_SAFETY_FILES, options.git ?? 'git', options.timeoutMs ?? HISTORY_TIMEOUT_MS, options.admit)
}

/** What {@link recordSnapshot} needs. */
export interface SnapshotRequest extends HistoryOptions {
  /** The Harness home, whose `cordis.patch.yml` the profile's history holds a copy of. */
  readonly homeDir: string
  /** The change's summary, which is the version's subject. */
  readonly summary: string
  /** Who made the change, which is the version's `Changed-by` trailer. */
  readonly changedBy: ProfileChangedBy
  /** The update report the snapshot holds, as contract C3 requires of an update's snapshot. */
  readonly report?: unknown
  /** An open history, when the caller already has one. */
  readonly history?: ProfileHistory
}

/**
 * Write the history version an update takes before it changes the profile: the profile's own files, Delo's record, a
 * copy of the home patch and the update report.
 * @param request - the profile, home, summary and report.
 * @returns the version's id; the latest version when nothing differs from it, because that version already holds this
 *   profile.
 * @throws {ProfileSafetyError} `SNAPSHOT_FAILED` when the history cannot be written, so no update may proceed.
 */
export async function recordSnapshot(request: SnapshotRequest): Promise<ProfileVersionId> {
  const history = request.history ?? openHistory(request)
  try {
    await mirrorHomePatch(request.profileDir, request.homeDir)
    if (request.report !== undefined) {
      await writeFileAtomic(join(request.profileDir, UPDATE_REPORT_FILENAME), JSON.stringify(request.report, undefined, 2) + '\n', { mode: 0o600, dirMode: 0o700 })
    }
    const recorded = await history.record(request.summary, request.changedBy)
    if (recorded !== undefined) return recorded
    const [latest] = await history.list(1)
    if (latest === undefined) {
      throw new ProfileSafetyError('SNAPSHOT_FAILED', request.profileDir, 'the profile history holds no version to roll back to.', ['repair-profile'], [{ kind: 'configuration', name: SAFETY_RECORD_FILENAME }])
    }
    return latest.id
  } catch (error) {
    if (isProfileSafetyError(error)) throw error
    if (error instanceof HistoryUnavailableError) {
      throw new ProfileSafetyError('SNAPSHOT_FAILED', request.profileDir, `the snapshot before the update could not be written: ${error.message}`, ['repair-profile', 'skip-update'], [], { cause: error })
    }
    throw new ProfileSafetyError('SNAPSHOT_FAILED', request.profileDir, `the snapshot before the update could not be written: ${String(error)}`, ['repair-profile', 'skip-update'], [], { cause: error })
  }
}

/** A plugin version a revocation list has revoked, which a restore brings back disabled with its reason. */
export interface RevokedPlugin {
  /** The package name. */
  readonly name: string
  /** The version the revocation is about. */
  readonly version: string
  /** The revocation's reason code. */
  readonly reason: string
  /** The revocation's message. */
  readonly message: string
}

/** What {@link planRestore} needs. */
export interface RestoreRequest extends HistoryOptions {
  /** The Harness home, which holds the patch layer the version brings back. */
  readonly homeDir: string
  /** The version to bring back. */
  readonly version: ProfileVersionId
  /** The plugin versions the current revocation list revokes. */
  readonly revoked?: readonly RevokedPlugin[]
  /** An open history, when the caller already has one. */
  readonly history?: ProfileHistory
}

/** What bringing a version back would change, before anything is written. */
export interface RestorePlan {
  /** The version. */
  readonly version: ProfileVersionId
  /** The plugins, build decisions and exemptions that change, in contract C3's shape for the approval prompt. */
  readonly changes: RestoreChanges
  /** The bundle list's membership changes: `selected` puts a bundle back, the absence removes it. */
  readonly bundles: readonly { readonly name: string, readonly selected: boolean }[]
  /** Whether the version's profile patch differs from the profile's now. */
  readonly patchChanged: boolean
  /** The files whose text could not be read on either side, so no change from them is listed. */
  readonly unreadable: readonly string[]
  /** The revoked plugin versions the restore brings back disabled, with the reason each shows. */
  readonly disabled: readonly DisabledPlugin[]
  /** Every profile file the restore writes, relative to the profile directory. */
  readonly writes: readonly string[]
  /** Whether the version holds a home patch that differs from the home's, so the restore writes it. */
  readonly homePatchWritten: boolean
  /** Whether restoring the version reinstalls dependencies, because its lockfile differs. */
  readonly lockfileChanged: boolean
}

/**
 * Work out what bringing a history version back would change, writing nothing.
 * @param request - the profile, home, version and revoked plugin versions.
 * @returns the plan the approval prompt lists.
 * @throws {ProfileSafetyError} `RESTORE_REFUSED` when the version cannot be brought back as the person asked; nothing
 *   has been written when it throws.
 */
export async function planRestore(request: RestoreRequest): Promise<RestorePlan> {
  const history = request.history ?? openHistory(request)
  const current = currentFiles(request.profileDir)
  const restored = await restoredFiles(history, request.version, request.profileDir, current)
  const adjusted = adjustForRevoked(restored, request.revoked ?? [], request.profileDir)
  return {
    version: request.version,
    changes: restoreChanges(current, adjusted.files),
    bundles: bundleChanges(current.get(PROFILE_MANIFEST_FILENAME), adjusted.files.get(PROFILE_MANIFEST_FILENAME)),
    patchChanged: current.get(PROFILE_PATCH_FILENAME) !== adjusted.files.get(PROFILE_PATCH_FILENAME),
    unreadable: unreadableFiles(current, adjusted.files),
    disabled: adjusted.disabled,
    writes: writesFor(current, adjusted.files),
    homePatchWritten: adjusted.files.get(HOME_PATCH_COPY_FILENAME) !== readHomePatch(request.homeDir),
    lockfileChanged: current.get('pnpm-lock.yaml') !== adjusted.files.get('pnpm-lock.yaml'),
  }
}

/**
 * Bring a version back: the plan's files, the home patch, and the record of the versions kept disabled.
 * @param plan - the plan {@link planRestore} returned.
 * @param request - the profile, home and version it was planned for.
 * @returns a promise that resolves when every file is in place.
 * @throws {ProfileSafetyError} `RESTORE_REFUSED` when a file cannot be written; the profile is then partly restored,
 *   and the caller reports it as a failed restore rather than as a refusal.
 */
export async function applyRestore(plan: RestorePlan, request: RestoreRequest): Promise<void> {
  const history = request.history ?? openHistory(request)
  const restored = await restoredFiles(history, request.version, request.profileDir, currentFiles(request.profileDir))
  const adjusted = adjustForRevoked(restored, request.revoked ?? [], request.profileDir)
  try {
    // Only the files the plan listed are written, so a plan the person approved is the set of changes they get.
    const approved = new Set(plan.writes)
    const profileFiles = new Map([...adjusted.files].filter(([name]) => name === HOME_PATCH_COPY_FILENAME || approved.has(name)))
    profileFiles.delete(HOME_PATCH_COPY_FILENAME)
    await writeProfileVersion(request.profileDir, profileFiles)
    const homePatch = plan.homePatchWritten ? adjusted.files.get(HOME_PATCH_COPY_FILENAME) : undefined
    if (homePatch !== undefined) await writeFileAtomic(join(request.homeDir, HOME_PATCH_FILENAME), homePatch, { mode: 0o600, dirMode: 0o700 })
    if (adjusted.disabled.length > 0) {
      const record = readSafetyRecord(request.profileDir)
      await writeSafetyRecord(request.profileDir, adjusted.disabled.reduce((acc, disabled) => withDisabled(acc, disabled), record))
    }
  } catch (error) {
    throw new ProfileSafetyError('RESTORE_REFUSED', request.profileDir, `restoring ${request.version} failed: ${String(error)}`, ['restore', 'repair-profile'], [], { cause: error })
  }
}

/**
 * Leave a profile exactly as the person had it after an update fails: the history version the update took, or the
 * latest version when the caller has no id.
 * @param request - the profile, home, version (or the latest) and the revoked plugin versions.
 * @returns the plan that was applied.
 * @throws {ProfileSafetyError} `RECOVER_REFUSED` when the history holds no version to go back to.
 */
export async function rollbackToSnapshot(request: Omit<RestoreRequest, 'version'> & { readonly version?: ProfileVersionId }): Promise<RestorePlan> {
  const history = request.history ?? openHistory(request)
  const version = request.version ?? (await latestVersion(history))
  if (version === undefined) {
    throw new ProfileSafetyError('RECOVER_REFUSED', request.profileDir, 'the profile history holds no version to roll back to.', ['restore'], [])
  }
  const plan = await planRestore({ ...request, version, history })
  await applyRestore(plan, { ...request, version, history })
  return plan
}

/**
 * The profile's latest history version.
 * @param history - the open history.
 * @returns the version's id, or undefined before the first version.
 */
export async function latestVersion(history: ProfileHistory): Promise<ProfileVersionId | undefined> {
  const [latest] = await history.list(1)
  return latest?.id
}

/**
 * A version's files to restore: for each Delo state file ({@link DELO_STATE_FILES}) that the version does not hold
 * and that no version up to it ever held, because the history did not track it yet, the profile's current copy, so a
 * restore never removes Delo's state for that reason alone. A state file that a version up to this one held and this
 * one does not was removed, and the restore removes it again.
 * @param history - the open history.
 * @param version - the version.
 * @param profileDir - the profile directory, for a refusal.
 * @param current - the profile's files now.
 * @returns the files to restore.
 * @throws {ProfileSafetyError} `RESTORE_REFUSED` when the version cannot be read.
 */
async function restoredFiles(history: ProfileHistory, version: ProfileVersionId, profileDir: string, current: ReadonlyMap<string, string | undefined>): Promise<Map<string, string | undefined>> {
  try {
    const files = await history.filesAt(version)
    for (const name of DELO_STATE_FILES) {
      if (files.get(name) === undefined && !(await history.trackedBy(version, name))) files.set(name, current.get(name))
    }
    return files
  } catch (error) {
    throw new ProfileSafetyError('RESTORE_REFUSED', profileDir, `profile version ${version} cannot be read: ${String(error)}`, ['repair-profile'], [], { cause: error })
  }
}

/**
 * The profile's tracked files as they are on disk now, by name relative to the profile directory.
 * @param profileDir - the profile directory.
 * @returns each tracked file's text, or undefined when the profile has none.
 */
export function currentFiles(profileDir: string): Map<string, string | undefined> {
  const files = new Map<string, string | undefined>()
  for (const name of PROFILE_SAFETY_FILES) {
    const path = join(profileDir, name)
    files.set(name, existsSync(path) ? readFileSync(path, 'utf8') : undefined)
  }
  return files
}

/** The home patch's text, or undefined when the home has none. */
function readHomePatch(homeDir: string): string | undefined {
  const path = join(homeDir, HOME_PATCH_FILENAME)
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

async function mirrorHomePatch(profileDir: string, homeDir: string): Promise<void> {
  const homePatch = join(homeDir, HOME_PATCH_FILENAME)
  if (!existsSync(homePatch)) return
  await writeFileAtomic(join(profileDir, HOME_PATCH_COPY_FILENAME), readFileSync(homePatch, 'utf8'), { mode: 0o600, dirMode: 0o700 })
}

/** What a restore writes: every tracked file whose text differs from the profile's now. */
function writesFor(current: ReadonlyMap<string, string | undefined>, restored: ReadonlyMap<string, string | undefined>): string[] {
  return [...restored.keys()].filter(name => current.get(name) !== restored.get(name))
}

/**
 * A version's files with the revoked plugin versions kept disabled: a revoked bundle leaves the bundle list, and a
 * revoked plugin's rows are disabled in the profile patch. Nothing is written.
 * @param files - the version's files.
 * @param revoked - the revoked plugin versions.
 * @param profileDir - the profile directory, for the refusal's path.
 * @returns the files to write and the disabled plugins to record.
 * @throws {ProfileSafetyError} `RESTORE_REFUSED` when a revoked plugin's row has no id, because the restore would have
 *   no way to disable exactly that row.
 */
function adjustForRevoked(
  files: ReadonlyMap<string, string | undefined>, revoked: readonly RevokedPlugin[], profileDir: string,
): { files: Map<string, string | undefined>, disabled: DisabledPlugin[] } {
  const adjusted = new Map(files)
  const disabled: DisabledPlugin[] = revoked.map(plugin => ({
    name: plugin.name,
    version: plugin.version,
    reason: plugin.reason,
    message: plugin.message,
  }))
  if (disabled.length === 0) return { files: adjusted, disabled }
  const names = new Set(disabled.map(plugin => plugin.name))

  const manifestText = adjusted.get(PROFILE_MANIFEST_FILENAME)
  const manifest = parsedJson(manifestText)
  if (manifest !== undefined) {
    const dsh = recordOf(recordOf(manifest)['dsh'])
    const profile = recordOf(dsh['profile'])
    const bundles = profile['bundles']
    if (Array.isArray(bundles)) {
      const kept = bundles.filter(name => typeof name !== 'string' || !names.has(name))
      if (kept.length !== bundles.length) {
        profile['bundles'] = kept
        dsh['profile'] = profile
        const next = { ...manifest, dsh: { ...dsh, profile } }
        adjusted.set(PROFILE_MANIFEST_FILENAME, JSON.stringify(next, undefined, 2) + '\n')
      }
    }
  }

  const patchText = adjusted.get(PROFILE_PATCH_FILENAME)
  if (patchText !== undefined) {
    const parsed: unknown = tryParseYaml(patchText)
    if (Array.isArray(parsed)) {
      const disables = disablingEntries(parsed, names, profileDir)
      if (disables.length > 0) adjusted.set(PROFILE_PATCH_FILENAME, dumpPatch([...parsed, ...disables]))
    }
  }
  return { files: adjusted, disabled }
}

/** One disabling patch entry per row a revoked plugin loads. */
function disablingEntries(parsed: readonly unknown[], names: ReadonlySet<string>, profileDir: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = []
  for (const entry of parsed) {
    if (!isRecord(entry) || !Array.isArray(entry['insert'])) continue
    for (const row of entry['insert']) {
      if (!isRecord(row) || typeof row['name'] !== 'string' || !names.has(row['name'])) continue
      const id = row['id']
      if (typeof id !== 'string') {
        throw new ProfileSafetyError(
          'RESTORE_REFUSED',
          profileDir,
          `the row ${row['name']} in ${PROFILE_PATCH_FILENAME} has no id, so a restore cannot disable exactly it; give the row an id and restore again.`,
          ['repair-profile'],
          [{ kind: 'row', name: row['name'], layer: 'profile-patch' }],
        )
      }
      entries.push({ id, disabled: true })
    }
  }
  return entries
}

function dumpPatch(entries: readonly unknown[]): string {
  // A patch file Delo rewrites keeps its meaning: it is a YAML list of mappings, which upstream's loader reads.
  return stringify(entries, { lineWidth: 0 })
}

/** The plugins, build decisions and exemptions that differ, in contract C3's shape. */
function restoreChanges(current: ReadonlyMap<string, string | undefined>, restored: ReadonlyMap<string, string | undefined>): RestoreChanges {
  const plugins: { name: string, from?: SemanticVersion, to?: SemanticVersion }[] = []
  const now = dependenciesOf(current.get(PROFILE_MANIFEST_FILENAME))
  const then = dependenciesOf(restored.get(PROFILE_MANIFEST_FILENAME))
  for (const [name, to] of Object.entries(then)) {
    const from = now[name]
    if (from === undefined) plugins.push({ name, to: versionText(to) })
    else if (from !== to) plugins.push({ name, from: versionText(from), to: versionText(to) })
  }
  for (const [name, from] of Object.entries(now)) {
    if (!Object.hasOwn(then, name)) plugins.push({ name, from: versionText(from) })
  }
  plugins.sort((left, right) => (left.name < right.name ? -1 : 1))

  const builds: { key: string, from?: boolean | 'pending', to?: boolean | 'pending' }[] = []
  const decisionsNow = buildDecisions(current.get(PROFILE_WORKSPACE_FILENAME))
  const decisionsThen = buildDecisions(restored.get(PROFILE_WORKSPACE_FILENAME))
  for (const key of [...new Set([...Object.keys(decisionsNow), ...Object.keys(decisionsThen)])].sort()) {
    const from = decisionsNow[key]
    const to = decisionsThen[key]
    if (from === to) continue
    builds.push({ key, ...from === undefined ? {} : { from }, ...to === undefined ? {} : { to } })
  }

  const exemptions: { axis: VersionAxis, key: string, version: SemanticVersion, change: 'added' | 'removed' }[] = []
  for (const axis of ['dsh', 'delo'] as const) {
    const name = EXEMPTION_FILES[axis]
    const grantsNow = grants(restored.get(name))
    const grantsBefore = grants(current.get(name))
    for (const [identity, grant] of grantsNow) {
      if (!grantsBefore.has(identity)) exemptions.push({ axis, key: grant.key, version: grant.version, change: 'added' })
    }
    for (const [identity, grant] of grantsBefore) {
      if (!grantsNow.has(identity)) exemptions.push({ axis, key: grant.key, version: grant.version, change: 'removed' })
    }
  }
  return { plugins, builds, exemptions }
}

function bundleChanges(nowText: string | undefined, thenText: string | undefined): { name: string, selected: boolean }[] {
  const now = new Set(bundlesOf(nowText))
  const then = new Set(bundlesOf(thenText))
  return [...new Set([...now, ...then])].sort()
    .filter(name => now.has(name) !== then.has(name))
    .map(name => ({ name, selected: then.has(name) }))
}

function unreadableFiles(current: ReadonlyMap<string, string | undefined>, restored: ReadonlyMap<string, string | undefined>): string[] {
  const unreadable: string[] = []
  const check = (name: string, read: (text: string | undefined) => unknown): void => {
    const now = read(current.get(name))
    const then = read(restored.get(name))
    if (now === undefined || then === undefined) unreadable.push(name)
  }
  check(PROFILE_MANIFEST_FILENAME, parsedJson)
  check(PROFILE_WORKSPACE_FILENAME, parsedYaml)
  check(EXEMPTION_FILES.dsh, parsedJson)
  check(EXEMPTION_FILES.delo, parsedJson)
  return unreadable
}

function bundlesOf(text: string | undefined): string[] {
  const manifest = parsedJson(text)
  if (manifest === undefined) return []
  const bundles = recordOf(recordOf(recordOf(manifest)['dsh'])['profile'])['bundles']
  return Array.isArray(bundles) ? bundles.filter((name): name is string => typeof name === 'string') : []
}

function dependenciesOf(text: string | undefined): Record<string, string> {
  const manifest = parsedJson(text)
  if (manifest === undefined) return {}
  return Object.fromEntries(Object.entries(recordOf(recordOf(manifest)['dependencies']))
    .flatMap(([name, spec]) => typeof spec === 'string' ? [[name, spec]] : []))
}

function buildDecisions(text: string | undefined): Record<string, boolean | 'pending'> {
  const workspace = parsedYaml(text)
  return Object.fromEntries(Object.entries(recordOf(recordOf(workspace)['allowBuilds'])).flatMap(([name, value]): Array<[string, boolean | 'pending']> =>
    value === true ? [[name, true]]
      : value === false ? [[name, false]]
        : value === 'set this to true or false' ? [[name, 'pending']] : []))
}

/** Each grant an exemption file holds, keyed by its package and runtime versions. */
function grants(text: string | undefined): Map<string, { readonly key: string, readonly version: SemanticVersion }> {
  const parsed = parsedJson(text)
  if (parsed === undefined) return new Map()
  const grants = new Map<string, { readonly key: string, readonly version: SemanticVersion }>()
  for (const [packageVersion, versions] of Object.entries(recordOf(parsed))) {
    for (const runtime of Array.isArray(versions) ? versions : []) {
      if (typeof runtime === 'string') grants.set(`${packageVersion}\u0000${runtime}`, { key: packageVersion, version: versionText(runtime) })
    }
  }
  return grants
}

/** A spec or version as contract C3's prompt carries it: a local `file:` spec appears where a version would. */
function versionText(text: string): SemanticVersion {
  return brandString<SemanticVersion>(text)
}

function parsedJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch (_error) {
    return undefined
  }
}

function parsedYaml(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined
  return recordOf(tryParseYaml(text))
}

function tryParseYaml(text: string): unknown {
  try {
    return parse(text)
  } catch (_error) {
    return undefined
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
