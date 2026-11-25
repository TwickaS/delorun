/**
 * What a start of a profile runs from the plugins the person links from folders. Before the profile boots, every
 * `link:` dependency names the plugin's active directory under `changes/`, never its folder, and the active directory
 * holds exactly one content version:
 *
 * 1. during a work session for the plugin that has not passed its end time, the folder's current content (a start ends a
 *    session past its end time without the person first, approving nothing, as the Host's watcher does);
 * 2. otherwise, while a change a failed start left out stays out, the content from before that change, or nothing for an
 *    install or a plugin turned on ([left out](./left-out.ts)); under protection `off` only while the folder still holds
 *    what the change brought;
 * 3. otherwise, under protection `on`, the approved version, or nothing at all for a plugin with no approved version
 *    (upstream then skips its bundle as unresolvable, so nothing from the folder loads);
 * 4. under `off`, the folder's current content, which becomes the approved version and is logged as an applied change
 *    decided `unreviewed` ([unreviewed](./unreviewed.ts)), unless the person declined exactly that content, which keeps
 *    the approved version.
 *
 * A link into the runtime store `runtimes/`, as Delorun's own bundles carried by an installed release are linked, is left
 * alone: the store's start check covers it, and an update replaces it. A link to the directory the running installation
 * itself carries for the package name is left alone too, because a source checkout runs the whole harness, upstream
 * packages included, from the checkout, so copying Delorun's bundles would not stop edits to the code the Host runs.
 * `file:` specs and registry plugins are left alone as well. Every other `link:` dependency is a linked plugin, whether
 * or not its target exists or is a directory: one whose folder is missing, or names a file, is moved to its empty
 * active directory and waits for review as a `plugin-install` from that folder, so a folder created there later loads
 * nothing before the person reviews it. The first start under Changes of a profile the home held when Changes first ran (`migratesAtUpgrade`) approves every linked plugin as it is, so
 * nobody's working harness changes what it runs; a plugin linked from a folder at any later start waits for review. Every
 * profile write happens under upstream's profile write lock, and a start that changed the profile's files records one
 * profile history version.
 *
 * @module @delorun/changes/enforce
 */
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { DELORUN_HOME_ENTRIES, PRIVATE_DIR_MODE } from '@delorun/contract-home-layout'
import { openHistory } from '@delorun/profile-safety'
import { collectStore } from './collect.ts'
import { ChangesError, isChangesError } from './errors.ts'
import { changeId } from './ids.ts'
import { checkLoadedContent } from './invariants.ts'
import { leftOutContent, leftOutFact, leftOutWords, leftOutOf, type LeftOutFact } from './left-out.ts'
import { pointLinkAt, readLinks } from './link.ts'
import { activeDirectory, CHANGES_ENTRIES, profileChangesDirectory } from './paths.ts'
import { PROFILE_LOCK_WAIT_MS, withProfileWriteLock } from './profile-lock.ts'
import { approvedOf, findEntry, migratesAtUpgrade, readActiveRecord, readApproved, readChangeLog, readProtection, readWorkSession, withEntry, writeActiveRecord, writeApproved, writeChangeLog } from './records.ts'
import { holdsVersion, materialize, readVersion, storeEmptyVersion, storeFolder } from './store.ts'
import { referenceRelease, versionOf, type ScanMemo } from './tree.ts'
import { ACTIVE_RECORD_SCHEMA, type ActiveContent, type ApprovedRecord, type ChangeEntry, type ChangeId, type ChangeLog, type ContentVersion, type ProtectionLevel } from './types.ts'
import { inPackStore, supersededByUpdate, type UpdateBaseline } from './update-baseline.ts'
import { approvedWith, declinedByPerson, unreviewedEntry, unreviewedWords, type UnreviewedLoad } from './unreviewed.ts'
import { endWorkWithoutPerson, workFinishedLine, workSessionExpired, type WorkFinished } from './work.ts'

export { PROFILE_LOCK_WAIT_MS, withProfileWriteLock, type ProfileWriteLockOptions } from './profile-lock.ts'

/** The profile a start is about to boot. */
export interface EnforceRequest {
  /** The Delorun home. */
  readonly home: string
  /** The profile's name. */
  readonly profile: string
  /** The profile's directory. */
  readonly profileDir: string
  /** The clock for the records' times; `() => new Date()` by default. */
  readonly now?: () => Date
  /** How long to wait for the profile write lock; {@link PROFILE_LOCK_WAIT_MS} by default. */
  readonly lockWaitMs?: number
  /**
   * Whether a `link:` dependency names a package of the harness itself: the directory the running installation
   * resolves for that package name, as a source checkout's setup links Delorun's bundles. Such a link is left alone, like
   * a link into `runtimes/`. None is the harness's when absent.
   * @param name - the package name.
   * @param target - the folder the link names, absolute.
   * @returns true for the harness's own package.
   */
  readonly harnessLink?: (name: string, target: string) => boolean
  /**
   * The installed release this process runs from (`DELORUN_VERSION`). A start re-points an active directory's links into
   * the runtime store to this release's installed packages, and the load check holds them to it, so a Host still running
   * after an update switched `runtimes/current` loads its own release's packages and a start of the new release loads
   * the new one's. When absent, as from a source checkout, both use the release `runtimes/current` names.
   */
  readonly runningRelease?: string
  /**
   * Set only by the start of an update's successor, which verified both releases' packs files itself
   * ({@link UpdateBaseline}): a pack's approved content that differs from its folder only by the release's own files is
   * replaced by the folder's, as an applied change decided `update`. A start without it never replaces approved content.
   */
  readonly updateBaseline?: UpdateBaseline
  /**
   * The digests this boot's earlier scans of active directories read. The pass uses it only where it decides whether to
   * rewrite a directory, never in a check that decides what loads, and drops what it writes. An update's successor passes
   * one for its first boot; every other caller leaves it out and reads every file.
   */
  readonly scanMemo?: ScanMemo
}

/** A plugin the first start under Changes approved as it was. */
export interface ApprovedAtUpgrade {
  readonly plugin: string
  /** Its folder. */
  readonly source: string
}

/** A pack whose approved content an update replaced with the release's own files. */
export interface ReplacedByUpdate {
  readonly id: ChangeId
  readonly plugin: string
  /** The release the update installed. */
  readonly to: string
}

/** A change waiting for review whose content this start does not load. */
export interface PendingAtStart {
  readonly id: ChangeId
  readonly plugin: string
  readonly kind: 'plugin-edit' | 'plugin-install'
}

/** What a start tells the person about the plugins it loads from folders. */
export interface StartChanges {
  readonly protection: ProtectionLevel
  /** Plugins approved at the upgrade that no terminal has shown yet; `markShownAtUpgrade` records it once one did. */
  readonly approvedAtUpgrade: readonly ApprovedAtUpgrade[]
  /** The changes this start leaves out: under `on`, each folder that differs from its approved content; under `off`, content the person declined. */
  readonly pending: readonly PendingAtStart[]
  /** Under `off`, the folder content this start approved without review. */
  readonly unreviewed: readonly UnreviewedLoad[]
  /** The packs whose approved content this start replaced with the update's release files, logged as applied changes. */
  readonly replacedByUpdate?: readonly ReplacedByUpdate[]
  /** The plugin whose folder loads live, when a work session is open for a plugin of the profile. */
  readonly workSession?: { readonly plugin: string }
  /** The work session this start ended without the person because its end time had passed. */
  readonly workEnded?: WorkFinished
  /** The profile history version this start recorded, when it changed the profile's files. */
  readonly historyVersion?: string
  /** The changes a failed start left out whose content stays out ([left out](./left-out.ts)). */
  readonly leftOut?: readonly LeftOutFact[]
  /**
   * Plugins whose folder could not be read as one content version, or whose approved content the store no longer
   * holds: each loads its approved content, or nothing.
   */
  readonly failed?: readonly PluginFailure[]
  /**
   * Under `off`, plugins too large to copy with their installed packages, which load those packages from where they
   * are installed; `underHome` when one of them is below the person's home folder, where a confined command can write.
   */
  readonly linkedDependencies?: readonly { readonly plugin: string, readonly underHome: boolean }[]
}

/** A plugin whose content a start or reload could not read, and why. */
export interface PluginFailure {
  readonly plugin: string
  /** What the person reads. */
  readonly detail: string
}

/** The content version of an empty directory: what the active directory of a plugin with nothing to load holds. */
export const EMPTY_CONTENT_VERSION: ContentVersion = versionOf([])

/** One linked plugin whose spec names its active directory, as the start decides its content. */
interface ManagedPlugin {
  readonly plugin: string
  /** Its folder; undefined when neither the approved record nor a pending install names one. */
  readonly source: string | undefined
}

/**
 * Bring the profile's linked plugins under Changes and make each active directory hold the content this start loads,
 * then check that what the profile names is what Changes keeps ({@link checkLoadedContent}) and collect the store
 * ([collect](./collect.ts)). Takes the profile write lock itself. A folder that cannot be read as one content version
 * (it changes while it is read, it passes a content limit, or the filesystem refuses it) leaves the plugin's approved
 * content loading, or nothing for a plugin with none, and is reported in {@link StartChanges.failed}; so does approved
 * content the store no longer holds.
 * @param request - the home, the profile, its directory, the clock and the lock wait.
 * @returns what the start prints ({@link startNotice}).
 * @throws {ChangesError} when a record of Changes or the profile's manifest is not one Delorun wrote, or `LOAD_REFUSED`
 *   when what the profile names afterwards is not what Changes keeps.
 * @throws {HistoryUnavailableError} when the profile changed and its history cannot record the change, so the start
 *   must not go on.
 */
export async function enforceApprovedContent(request: EnforceRequest): Promise<StartChanges> {
  const { home, profileDir } = request
  const at = (request.now ?? (() => new Date()))().toISOString()
  return withProfileWriteLock(profileDir, async () => {
    const changes = await bringUnderChanges(request, at, 'start')
    await refuseUnkept(request)
    try {
      await collectStore({ home, profileDirectory: (name) => join(dirname(profileDir), name) })
    } catch (error) {
      // A filesystem error removing a store file: collection only frees space and changes nothing that loads, so the
      // files stay for the next start.
      void error
    }
    return changes
  }, { waitMs: request.lockWaitMs ?? PROFILE_LOCK_WAIT_MS })
}

/** How long the check before a reload waits for the profile write lock before it only verifies. */
export const RELOAD_LOCK_WAIT_MS = 2_000

/**
 * The check the running Host makes before every recomposition of the profile (upstream's hot reload calls it through
 * `@delorun/plugin-changes`): a `link:` dependency that names a folder, as upstream's restore, undo and
 * `delorun plugin add link:<folder>` write, is moved to the plugin's active directory as a start moves it, without
 * approving anything (a reload never migrates); the active directory of a plugin moved now is made to hold what a start
 * would load. Then every link and active directory is checked against what Changes keeps ({@link checkLoadedContent}),
 * and a mismatch refuses the reload. Active directories of plugins already under Changes are never rewritten here: one
 * that differs refuses the reload.
 *
 * The profile write lock decides what may be written. When this process holds it, upstream's plugin management is
 * changing the profile and called the reload inside its lock, so the check writes without taking it. When no process
 * holds it, the check takes it for at most {@link RELOAD_LOCK_WAIT_MS}. When another process holds it, such as
 * `delorun changes`, which waits for the reload's answer under it, or a `pnpm` run, the check writes nothing and only
 * verifies, so a link to a folder refuses the reload until the holder is done.
 * @param request - the home, the profile, its directory, the clock and the harness's own links.
 * @returns what was moved, as a start reports it; no plugin is named as approved at upgrade.
 * @throws {ChangesError} `LOAD_REFUSED` when a link or an active directory is not what Changes keeps, and the failures
 *   of a start's writes.
 */
export async function prepareReload(request: EnforceRequest): Promise<StartChanges> {
  const at = (request.now ?? (() => new Date()))().toISOString()
  const pass = async (): Promise<StartChanges> => {
    const changes = await bringUnderChanges(request, at, 'reload')
    await refuseUnkept(request)
    return changes
  }
  const holder = await profileLockHolder(request.profileDir)
  if (holder === 'this-process') return pass()
  if (holder === 'none') {
    const signal = AbortSignal.timeout(request.lockWaitMs ?? RELOAD_LOCK_WAIT_MS)
    let started = false
    try {
      return await withFileLock(join(request.profileDir, 'package.json'), () => {
        started = true
        return pass()
      }, { signal, waitMs: Number.MAX_SAFE_INTEGER })
    } catch (error) {
      if (started || !signal.aborted) throw error
      // Another process took the lock first and holds it: verify only, as below.
    }
  }
  await refuseUnkept(request)
  return { protection: await readProtection(request.home), approvedAtUpgrade: [], pending: [], unreviewed: [] }
}

/**
 * Re-point each active directory's links into the runtime store to the running release's installed packages, without
 * deciding or approving anything: every directory is made to hold the version `active.json` already records for it, as
 * a start does in its last step. An update's successor needs this because it takes over without a start's pre-start
 * steps, and a pack copy written under the previous release names that release's packages, which the load check of the
 * new release refuses. A directory that already holds its version is left as it is; a plugin with no record is left
 * alone, and the load check still refuses a stray directory.
 * @param request - the home, the profile, its directory and the running release.
 * @returns the plugins whose active directory was rewritten, in record order.
 * @throws {ChangesError} `STORE_CORRUPT` or `RUNTIME_CHANGED` when the store cannot give a recorded version, and a
 *   record that cannot be read; the load check then refuses the start as it would have.
 */
export async function repointActiveCopies(request: EnforceRequest): Promise<readonly string[]> {
  const { home, profile, profileDir } = request
  const release = await referenceRelease(home, request.runningRelease)
  /** The plugins whose active copy does not hold the version the record names. */
  const stale = async (): Promise<[string, ActiveContent][]> => {
    const behind: [string, ActiveContent][] = []
    for (const [plugin, content] of Object.entries((await readActiveRecord(home, profile)).plugins)) {
      if (content.version !== undefined && !await holdsVersion(home, activeDirectory(home, profile, plugin), content.version, release, request.scanMemo)) behind.push([plugin, content])
    }
    return behind
  }
  // A normal restart finds every copy holding its version and takes no lock, so it never waits for a profile writer.
  if ((await stale()).length === 0) return []
  return withProfileWriteLock(profileDir, async () => {
    const rewritten: string[] = []
    for (const [plugin, content] of await stale()) {
      await holdContent(home, activeDirectory(home, profile, plugin), content.version, release, request.scanMemo)
      rewritten.push(plugin)
    }
    return rewritten
  }, { waitMs: request.lockWaitMs ?? PROFILE_LOCK_WAIT_MS })
}

/**
 * Make each active copy that loads approved content hold what the profile's approved record names now, for a Host
 * that boots again after a failed switch. A failed health check rolls the profile's files back, approved record
 * included, but not `active.json`, which still names what the failed release's start decided; with protection on, the
 * load check refuses that, so the previous release could not resume. This never reads a folder and never approves
 * anything: each such plugin is set to its approved version, or to nothing when it has none, and
 * {@link repointActiveCopies} then fills the directories. A copy for a work session or left out of a failed start is
 * not touched.
 * @param request - the home, the profile and its directory.
 * @returns the plugins whose record was changed, in record order.
 * @throws {ChangesError} when a record cannot be read or written.
 */
export async function followApprovedContent(request: EnforceRequest): Promise<readonly string[]> {
  const { home, profile, profileDir } = request
  /** The records that name approved content other than the approved record's version, with the version to hold instead. */
  const stale = async (): Promise<readonly (readonly [string, ContentVersion | undefined])[]> => {
    const approved = await readApproved(profileDir)
    return Object.entries((await readActiveRecord(home, profile)).plugins)
      .filter(([plugin, content]) => content.kind === 'approved' && content.version !== approvedOf(approved, plugin)?.version)
      .map(([plugin]) => [plugin, approvedOf(approved, plugin)?.version] as const)
  }
  // A boot after a failed switch whose records agree takes no lock, as a restart of the same release does.
  if ((await stale()).length === 0) return []
  return withProfileWriteLock(profileDir, async () => {
    const behind = await stale()
    const plugins: Record<string, ActiveContent> = { ...(await readActiveRecord(home, profile)).plugins }
    for (const [plugin, version] of behind) {
      if (version === undefined) delete plugins[plugin]
      else plugins[plugin] = { version, kind: 'approved' }
    }
    if (behind.length > 0) await writeActiveRecord(home, profile, { schema: ACTIVE_RECORD_SCHEMA, plugins })
    return behind.map(([plugin]) => plugin)
  }, { waitMs: request.lockWaitMs ?? PROFILE_LOCK_WAIT_MS })
}

/** What the approved record and `active.json` name for a profile at one moment ({@link recordsOf}). */
export interface DecisionRecords {
  /** The profile's approved record. */
  readonly approved: ApprovedRecord
  /** `active.json`'s plugins. */
  readonly active: Readonly<Record<string, ActiveContent>>
}

/**
 * Read the two records a start decides, for {@link revertDecisions}.
 * @param request - the home, the profile and its directory.
 * @returns the approved record and the active record's plugins now.
 * @throws {ChangesError} when a record cannot be read.
 */
export async function recordsOf(request: Pick<EnforceRequest, 'home' | 'profile' | 'profileDir'>): Promise<DecisionRecords> {
  return { approved: await readApproved(request.profileDir), active: (await readActiveRecord(request.home, request.profile)).plugins }
}

/**
 * Undo what one start decided in the approved record and `active.json`, for an update's successor whose health check
 * failed: the release it left may predate {@link followApprovedContent}, and with protection on it refuses to resume
 * when `active.json` names a version the restored approved record does not. Only a plugin whose entry still equals
 * `after` goes back to its `before` entry (or loses it when it had none), so an entry changed since, by a person or
 * another writer, is kept; each active directory of an entry put back holds that entry's content again, or nothing. The
 * change log and the history are not touched.
 * @param request - the home, the profile and its directory.
 * @param before - the records before the start.
 * @param after - the records the start left.
 * @returns the plugins whose approved entry or active entry was put back, in record order.
 * @throws {ChangesError} when a record cannot be read or written.
 */
export async function revertDecisions(request: Pick<EnforceRequest, 'home' | 'profile' | 'profileDir' | 'lockWaitMs'>, before: DecisionRecords, after: DecisionRecords): Promise<readonly string[]> {
  const { home, profile, profileDir } = request
  const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)
  /** The names whose entry differs between `before` and `after`. */
  const changed = <T>(from: Readonly<Record<string, T>>, to: Readonly<Record<string, T>>): string[] => [...new Set([...Object.keys(from), ...Object.keys(to)])].filter(name => !same(from[name], to[name]))
  if (changed(before.approved.plugins, after.approved.plugins).length === 0 && changed(before.active, after.active).length === 0) return []
  return withProfileWriteLock(profileDir, async () => {
    const now = await recordsOf(request)
    const touched = new Set<string>()
    /** `now` with each changed entry that still equals `after`'s put back to `before`'s. */
    const reverted = <T>(was: Readonly<Record<string, T>>, left: Readonly<Record<string, T>>, still: Readonly<Record<string, T>>): Record<string, T> => {
      const entries: Record<string, T> = { ...still }
      for (const name of changed(was, left)) {
        if (!same(still[name], left[name])) continue
        if (was[name] === undefined) delete entries[name]
        else entries[name] = was[name]
        touched.add(name)
      }
      return entries
    }
    const approvedPlugins = reverted(before.approved.plugins, after.approved.plugins, now.approved.plugins)
    const activePlugins = reverted(before.active, after.active, now.active)
    if (!same(approvedPlugins, now.approved.plugins)) await writeApproved(profileDir, { ...now.approved, plugins: approvedPlugins })
    if (!same(activePlugins, now.active)) await writeActiveRecord(home, profile, { schema: ACTIVE_RECORD_SCHEMA, plugins: activePlugins })
    // An entry the start added is gone from the record, and one it moved names another version: the directory must hold what the record says, or the predecessor's invariant refuses it.
    for (const name of changed(now.active, activePlugins)) await holdContent(home, activeDirectory(home, profile, name), activePlugins[name]?.version)
    return [...touched]
  }, { waitMs: request.lockWaitMs ?? PROFILE_LOCK_WAIT_MS })
}

/**
 * Who holds the profile write lock, from the process id upstream's lock file records.
 * @param profileDir - the profile directory.
 * @returns `none` without a lock file, `this-process` when it names this process, and `other` otherwise.
 */
async function profileLockHolder(profileDir: string): Promise<'none' | 'this-process' | 'other'> {
  let text: string
  try {
    text = await readFile(join(profileDir, 'package.json.lock'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'none'
    throw error
  }
  return text.trim() === String(process.pid) ? 'this-process' : 'other'
}

/**
 * Refuse a profile whose links or active directories are not what Changes keeps.
 * @param request - the home, the profile, its directory and the harness's own links.
 * @throws {ChangesError} `LOAD_REFUSED` naming every one that is not.
 */
async function refuseUnkept(request: EnforceRequest): Promise<void> {
  const broken = await checkLoadedContent(request)
  if (broken.length === 0) return
  throw new ChangesError('LOAD_REFUSED', request.profile, `Delorun did not load the profile ${request.profile}, because what it would load is not what you approved: ${broken.join(' ')}`)
}

/**
 * @param error - what storing a folder threw.
 * @returns what the person reads about it.
 */
function failureDetail(error: unknown): string {
  return isChangesError(error) ? error.detail : String(error)
}

/** A folder stored at this pass, or why it could not be. */
export type FolderContent =
  | { readonly kind: 'stored', readonly version: ContentVersion, readonly linkedDependencies?: { readonly underHome: boolean } }
  | { readonly kind: 'unreadable', readonly detail: string }

/**
 * Store a plugin folder's content, as the protection level allows it: under `off` a folder too large to copy with its
 * installed packages is stored with those packages kept as links to where they are installed.
 * @param home - the Delorun home.
 * @param source - the folder.
 * @param scanCache - the scan cache file.
 * @param protection - the protection level.
 * @returns the stored version, or why the folder could not be read: it changed while it was read, it passes a content
 *   limit, or the filesystem or the store refused it. Such a folder never stops a start or a reload.
 */
export async function storeFolderContent(home: string, source: string, scanCache: string, protection: ProtectionLevel): Promise<FolderContent> {
  try {
    return { kind: 'stored', version: (await storeFolder(home, source, { scanCache })).version }
  } catch (error) {
    if (protection === 'on' || !isChangesError(error) || error.code !== 'CONTENT_TOO_LARGE') return { kind: 'unreadable', detail: failureDetail(error) }
  }
  try {
    const { manifest, version } = await storeFolder(home, source, { scanCache, dependencies: 'link' })
    const outside = manifest.entries.flatMap((entry) => entry.type === 'link' && entry.outside && entry.runtime !== true ? [entry.target] : [])
    const osHome = homedir()
    return { kind: 'stored', version, linkedDependencies: { underHome: outside.some((target) => isInside(osHome, target)) } }
  } catch (error) {
    return { kind: 'unreadable', detail: failureDetail(error) }
  }
}

/**
 * One pass over the profile's links under the profile write lock, which the caller holds. A start brings every linked
 * plugin under Changes, decides each active directory's content and records a history version; a reload only moves
 * links that name a folder, decides the content of the plugins it moved, and approves nothing.
 * @param request - the home, the profile, its directory and the harness's own links.
 * @param at - the time of the records, ISO 8601.
 * @param pass - `start` or `reload`.
 * @returns what the pass reports.
 */
async function bringUnderChanges(request: EnforceRequest, at: string, pass: 'start' | 'reload'): Promise<StartChanges> {
  const { home, profile, profileDir } = request
  const protection = await readProtection(home)
  const recordedSession = await readWorkSession(home, profile)
  // A session past its end loads nothing from the folder. A start ends it without the person, as the watcher does at
  // the end time, before anything is loaded; a reload leaves ending it to the watcher.
  const expired = recordedSession !== undefined && workSessionExpired(request, recordedSession)
  const workEnded = expired && pass === 'start' ? await endWorkWithoutPerson(request, recordedSession, 'expired', undefined) : undefined
  const workSession = expired ? undefined : recordedSession
  const scanCache = join(profileChangesDirectory(home, profile), CHANGES_ENTRIES.scanCache)
  const firstLog = await readChangeLog(home, profile)
  const migrating = pass === 'start' && await migratesAtUpgrade(home, profile, profileDir, firstLog, at)
  let log = firstLog
  let approved = await readApproved(profileDir)
  const managed: ManagedPlugin[] = []
  const moved: { readonly plugin: string, readonly source: string }[] = []
  const upgraded: string[] = []
  const awaiting: string[] = []
  const unreviewed: UnreviewedLoad[] = []
  const replaced: ReplacedByUpdate[] = []
  const failed: PluginFailure[] = []
  const stored = new Map<string, FolderContent>()
  let approvalsChanged = false
  for (const link of await readLinks(profileDir)) {
    const active = activeDirectory(home, profile, link.name)
    if (resolve(link.target) === resolve(active)) {
      if (pass === 'start') managed.push({ plugin: link.name, source: approvedOf(approved, link.name)?.source ?? installSource(log, link.name, protection) })
      continue
    }
    if (isHarnessLink(request, link.name, link.target)) continue
    // A missing folder, or a file where the folder was, is still brought under Changes: left alone, its link would load
    // whatever is created there before the next start.
    const content: FolderContent = await namesDirectory(link.target)
      ? await storeFolderContent(home, link.target, scanCache, protection)
      : { kind: 'unreadable', detail: `${link.target} is not a folder` }
    stored.set(link.name, content)
    const subject = { plugin: link.name, source: link.target }
    // A folder that cannot be read waits for review with no content, so the next start reads it again.
    const version = content.kind === 'stored' ? content.version : EMPTY_CONTENT_VERSION
    const approval = approvedOf(approved, link.name)
    if (migrating && content.kind === 'stored') {
      approved = withApproval(approved, link.name, { source: link.target, version, approvedAt: at, approvedAtUpgrade: true })
      approvalsChanged = true
      log = withNewEntry(log, {
        id: changeId('plugin-install', subject, undefined, version),
        kind: 'plugin-install',
        state: 'applied',
        subject,
        to: version,
        summary: `Approved at upgrade: ${link.name} from ${link.target}`,
        createdAt: at,
        decidedAt: at,
        decidedFrom: 'upgrade',
      })
      upgraded.push(link.name)
    } else if (protection === 'off' && content.kind === 'stored' && approval?.version !== version && !declinedByPerson(log, link.name, version)) {
      // Under `off` a new link loads its folder's content, logged as a change nobody reviewed.
      const entry = unreviewedEntry(log, { ...subject, ...approval === undefined ? {} : { from: approval.version }, to: version }, at)
      approved = approvedWith(approved, link.name, link.target, version, at)
      approvalsChanged = true
      log = withEntry(log, entry)
      unreviewed.push({ id: entry.id, plugin: link.name, kind: entry.kind })
    } else if (approval?.source !== link.target) {
      // A link back to the approved plugin's own folder, as an undo past the upgrade brings back, is moved silently.
      if (content.kind === 'unreadable') await storeEmptyVersion(home)
      log = withNewEntry(log, {
        id: changeId('plugin-install', subject, undefined, version),
        kind: 'plugin-install',
        state: 'pending',
        subject,
        to: version,
        summary: `${link.name} from ${link.target} waits for your review`,
        createdAt: at,
      })
      awaiting.push(link.name)
    }
    moved.push({ plugin: link.name, source: link.target })
    managed.push({ plugin: link.name, source: link.target })
  }

  // Under `off`, the folder content of each plugin already under Changes becomes its approved content before anything
  // is written, so the records name it before the active directories hold it.
  const decided = new Map<string, ActiveContent | undefined>()
  const pending: PendingAtStart[] = []
  const linkedDependencies: { readonly plugin: string, readonly underHome: boolean }[] = []
  const leftOut: LeftOutFact[] = []
  for (const { plugin, source } of managed) {
    const approvedVersion = approvedOf(approved, plugin)?.version
    // A folder that is gone leaves the approved content, and nothing to review.
    const content = source === undefined || !await namesDirectory(source) ? undefined : stored.get(plugin) ?? await storeFolderContent(home, source, scanCache, protection)
    if (content?.kind === 'unreadable') failed.push({ plugin, detail: content.detail })
    const folder = content?.kind === 'stored' ? { source: source!, version: content.version } : undefined
    const left = leftOutOf(log, approved, plugin)
    if (workSession?.plugin === plugin && folder !== undefined) {
      decided.set(plugin, { version: folder.version, kind: 'work-session' })
    } else if (left !== undefined && (protection === 'on' || folder === undefined || left.kind === 'plugin-on' || left.to === folder.version)) {
      decided.set(plugin, leftOutContent(left))
      leftOut.push(leftOutFact(left))
    } else if (pass === 'start' && request.updateBaseline !== undefined && folder !== undefined && approvedVersion !== undefined && folder.version !== approvedVersion
      && inPackStore(home, folder.source) && !declinedByPerson(log, plugin, folder.version)
      && await replacesApproved(request.updateBaseline, home, plugin, approvedVersion, folder.version)) {
      const entry = replacedEntry(log, { plugin, source: folder.source, from: approvedVersion, to: folder.version }, request.updateBaseline.to, at)
      approved = approvedWith(approved, plugin, folder.source, folder.version, at)
      approvalsChanged = true
      log = withEntry(log, entry)
      replaced.push({ id: entry.id, plugin, to: request.updateBaseline.to })
      decided.set(plugin, { version: folder.version, kind: 'approved' })
    } else if (protection === 'on' || folder === undefined || folder.version === approvedVersion || declinedByPerson(log, plugin, folder.version)) {
      decided.set(plugin, approvedVersion === undefined ? undefined : { version: approvedVersion, kind: 'approved' })
      if (folder !== undefined && folder.version !== approvedVersion) {
        const kind = approvedVersion === undefined ? 'plugin-install' : 'plugin-edit'
        pending.push({ id: changeId(kind, { plugin, source: folder.source }, approvedVersion, folder.version), plugin, kind })
      }
    } else {
      const entry = unreviewedEntry(log, { plugin, source: folder.source, ...approvedVersion === undefined ? {} : { from: approvedVersion }, to: folder.version }, at)
      approved = approvedWith(approved, plugin, folder.source, folder.version, at)
      approvalsChanged = true
      log = withEntry(log, entry)
      unreviewed.push({ id: entry.id, plugin, kind: entry.kind })
      decided.set(plugin, { version: folder.version, kind: 'approved' })
    }
    if (protection === 'off' && content?.kind === 'stored' && content.linkedDependencies !== undefined && decided.get(plugin)?.version === content.version) {
      linkedDependencies.push({ plugin, underHome: content.linkedDependencies.underHome })
    }
  }

  // The log names every new source before the profile's specs stop naming it; `migratedAt` is set only at the end,
  // so a start interrupted in between migrates the remaining links at the next start.
  if (log !== firstLog) await writeChangeLog(home, profile, log)
  if (approvalsChanged) await writeApproved(profileDir, approved)
  for (const { plugin } of moved) await pointLinkAt(profileDir, plugin, activeDirectory(home, profile, plugin))

  const activeBefore = await readActiveRecord(home, profile)
  const release = await referenceRelease(home, request.runningRelease)
  // A reload decides only the plugins it moved; every other active directory keeps what the record says it holds.
  const activePlugins: Record<string, ActiveContent> = pass === 'start' ? {} : { ...activeBefore.plugins }
  for (const { plugin } of managed) {
    let active = decided.get(plugin)
    try {
      await holdContent(home, activeDirectory(home, profile, plugin), active?.version, release, request.scanMemo)
    } catch (error) {
      if (!isChangesError(error) || (error.code !== 'STORE_CORRUPT' && error.code !== 'RUNTIME_CHANGED')) throw error
      // Content the store no longer holds, such as a version a restored history version names after collection
      // removed it, or a link to a package the release carries while the home runs no installed release: the plugin
      // loads nothing until the person applies a change again.
      failed.push({ plugin, detail: error.detail })
      await holdContent(home, activeDirectory(home, profile, plugin), undefined, release, request.scanMemo)
      active = undefined
    }
    if (active === undefined) delete activePlugins[plugin]
    else activePlugins[plugin] = active
  }
  if (JSON.stringify(activePlugins) !== JSON.stringify(activeBefore.plugins)) {
    await writeActiveRecord(home, profile, { schema: ACTIVE_RECORD_SCHEMA, plugins: activePlugins })
  }

  let historyVersion: string | undefined
  if (pass === 'start') {
    // An approval at upgrade without a history version, which an earlier start could not record, is recorded now.
    const unrecorded = log.entries.flatMap(entry => entry.decidedFrom === 'upgrade' && entry.historyVersion === undefined && entry.subject.plugin !== undefined ? [entry.subject.plugin] : [])
    const summary = historySummary(unrecorded, awaiting, unreviewed.map(({ plugin }) => plugin), moved.map(({ plugin }) => plugin), replaced.map(({ plugin }) => plugin), request.updateBaseline?.to)
    historyVersion = summary === undefined ? undefined : await openHistory({ profileDir }).record(summary, { kind: 'person' })
  }

  const loadedNow = new Set([...unreviewed, ...replaced].map(({ id }) => id))
  const shown: ApprovedAtUpgrade[] = []
  const entries = log.entries.map((entry): ChangeEntry => {
    let next = entry
    if (historyVersion !== undefined && entry.historyVersion === undefined && (entry.decidedFrom === 'upgrade' || (entry.state === 'applied' && loadedNow.has(entry.id)))) {
      next = { ...next, historyVersion }
    }
    if (pass === 'start' && entry.decidedFrom === 'upgrade' && entry.state === 'applied' && entry.shownAt === undefined && entry.subject.plugin !== undefined && entry.subject.source !== undefined) {
      shown.push({ plugin: entry.subject.plugin, source: entry.subject.source })
    }
    return next
  })
  const finalLog: ChangeLog = { ...log, ...migrating ? { migratedAt: at } : {}, entries }
  if (JSON.stringify(finalLog) !== JSON.stringify(firstLog)) await writeChangeLog(home, profile, finalLog)

  const session = pass === 'start' && workSession !== undefined && managed.some(({ plugin }) => plugin === workSession.plugin) ? { plugin: workSession.plugin } : undefined
  return {
    protection,
    approvedAtUpgrade: shown,
    pending,
    unreviewed,
    ...replaced.length === 0 ? {} : { replacedByUpdate: replaced },
    ...session === undefined ? {} : { workSession: session },
    ...workEnded === undefined ? {} : { workEnded },
    ...historyVersion === undefined ? {} : { historyVersion },
    ...failed.length === 0 ? {} : { failed },
    ...linkedDependencies.length === 0 ? {} : { linkedDependencies },
    ...leftOut.length === 0 ? {} : { leftOut },
  }
}

/**
 * The lines a start prints about the plugins it loads from folders, in the person's words.
 * @param changes - what {@link enforceApprovedContent} returned.
 * @returns the lines, each ending in a newline; empty when there is nothing to say.
 */
export function startNotice(changes: StartChanges): string {
  const lines: string[] = []
  if (changes.workEnded !== undefined) lines.push(`Your work session on ${changes.workEnded.plugin} ended at its time limit. ${workFinishedLine(changes.workEnded)}`)
  for (const fact of changes.leftOut ?? []) lines.push(leftOutWords(fact))
  for (const { plugin, source } of changes.approvedAtUpgrade) {
    lines.push(`Delorun now runs the approved copy of ${plugin}, linked from ${source}. Edits in that folder wait for your review: delorun changes list.`)
  }
  if (changes.workSession !== undefined) {
    lines.push(`Working on ${changes.workSession.plugin}: edits in its folder load live until delorun changes done ${changes.workSession.plugin}.`)
  }
  for (const { id, plugin, kind } of changes.pending) {
    lines.push(kind === 'plugin-install'
      ? `${plugin} is not loaded until you review it: delorun changes show ${id}`
      : `${plugin} has changes waiting for your review and loads without them: delorun changes show ${id}`)
  }
  for (const { id, plugin, to } of changes.replacedByUpdate ?? []) lines.push(`${plugin} now holds the files of the update to ${to}, which Delorun checked against the signed release: delorun changes show ${id}`)
  for (const load of changes.unreviewed) lines.push(unreviewedWords(load))
  for (const { plugin, underHome } of changes.linkedDependencies ?? []) {
    lines.push(`${plugin} is too large to copy with its installed packages, so it loads them from where they are installed${underHome ? ', inside your home folder, where commands the agent runs can change them' : ''}.`)
  }
  for (const { plugin, detail } of changes.failed ?? []) {
    lines.push(`${plugin} runs the content you approved, or nothing if you approved none, because Delorun could not read its folder: ${detail}`)
  }
  return lines.map(line => `${line}\n`).join('')
}

/**
 * The folder of a plugin without approved content, from its install entries: under `on` the newest pending install's,
 * whose folder waits for review; under `off` the newest install's in any state, so a folder whose install was undone
 * or discarded loads again once it holds anything else.
 * @param log - the change log.
 * @param plugin - the package name.
 * @param protection - the protection level.
 * @returns the folder, or undefined.
 */
function installSource(log: ChangeLog, plugin: string, protection: ProtectionLevel): string | undefined {
  return log.entries.findLast(entry => entry.kind === 'plugin-install' && (protection === 'off' || entry.state === 'pending') && entry.subject.plugin === plugin && entry.subject.source !== undefined)?.subject.source
}

/**
 * @param log - the change log.
 * @param entry - an entry this start records.
 * @returns the log with the entry appended; the log as it is when it already has an entry with the id, which an
 *   earlier start recorded for the same folder content.
 */
function withNewEntry(log: ChangeLog, entry: ChangeEntry): ChangeLog {
  return findEntry(log, entry.id) === undefined ? withEntry(log, entry) : log
}

/**
 * @param record - the approved record.
 * @param plugin - a package name.
 * @param approval - its approval.
 * @returns the record with the plugin approved.
 */
function withApproval(record: ApprovedRecord, plugin: string, approval: ApprovedRecord['plugins'][string]): ApprovedRecord {
  return { ...record, plugins: { ...record.plugins, [plugin]: approval } }
}

/**
 * Make an active directory hold one version, or nothing. A directory that already holds it is left as it is; anything
 * else in it, such as a file changed or added since, is replaced.
 * @param home - the Delorun home.
 * @param directory - the active directory.
 * @param version - the version; undefined for an empty directory.
 * @param release - the release whose installed packages its `runtime` links name; `runtimes/current` when omitted.
 * @param memo - the digests this boot's earlier scans read, which the first check of the directory uses; none reads every file. What this writes is dropped from it.
 */
export async function holdContent(home: string, directory: string, version: ContentVersion | undefined, release?: string, memo?: ScanMemo): Promise<void> {
  if (await holdsVersion(home, directory, version ?? EMPTY_CONTENT_VERSION, release, memo)) return
  memo?.forget(directory)
  if (version !== undefined) {
    await materialize(home, version, directory, undefined, release)
    return
  }
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE })
}

/**
 * @param home - the Delorun home.
 * @param target - a link's folder, absolute.
 * @returns whether it lies inside the runtime store, whose own start check covers it.
 */
export function isInRuntimeStore(home: string, target: string): boolean {
  return isInside(join(home, DELORUN_HOME_ENTRIES.runtimes), target)
}

/**
 * @param outer - a directory.
 * @param inner - a path.
 * @returns whether `inner` is below `outer`.
 */
function isInside(outer: string, inner: string): boolean {
  const path = relative(outer, inner)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/**
 * @param request - the home and the harness's own links.
 * @param name - a linked package's name.
 * @param target - the folder its link names, absolute.
 * @returns whether the link is the harness's rather than a plugin's: into the runtime store, or to the directory the
 *   running installation carries for the name.
 */
export function isHarnessLink(request: Pick<EnforceRequest, 'home' | 'harnessLink'>, name: string, target: string): boolean {
  return isInRuntimeStore(request.home, target) || request.harnessLink?.(name, target) === true
}

/**
 * @param path - a path.
 * @returns whether it names a directory, following links; false when nothing is there.
 * @throws the filesystem error other than a missing path, such as `EACCES`.
 */
export async function namesDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // A missing target, or a file where a directory is expected on the way, names no folder to load.
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}

/**
 * Whether an update replaces a pack's approved content with its folder's ({@link supersededByUpdate}). Approved content
 * the store no longer holds is not replaced: the start reports it as it does without an update.
 * @param baseline - what the successor verified.
 * @param home - the Delorun home.
 * @param plugin - the package name.
 * @param approved - the approved content.
 * @param folder - the folder's content.
 * @returns whether the difference is only the release's own files.
 */
async function replacesApproved(baseline: UpdateBaseline, home: string, plugin: string, approved: ContentVersion, folder: ContentVersion): Promise<boolean> {
  try {
    return await supersededByUpdate(home, baseline, { plugin, before: await readVersion(home, approved), after: await readVersion(home, folder) })
  } catch (error) {
    // A version the store cannot give is a content problem the rest of the start reports; nothing is replaced for it.
    if (isChangesError(error) && error.code === 'STORE_CORRUPT') return false
    throw error
  }
}

/**
 * The applied change that records a pack's approved content replaced by the update's release files.
 * @param log - the change log, whose entry with the same id gives its creation time.
 * @param change - the plugin, its folder, the approved content before and the folder's content.
 * @param to - the release the update installed.
 * @param at - when, ISO 8601.
 * @returns the entry, applied and decided `update`.
 */
function replacedEntry(log: ChangeLog, change: { readonly plugin: string, readonly source: string, readonly from: ContentVersion, readonly to: ContentVersion }, to: string, at: string): ChangeEntry {
  const subject = { plugin: change.plugin, source: change.source }
  const id = changeId('plugin-edit', subject, change.from, change.to)
  return {
    id,
    kind: 'plugin-edit',
    state: 'applied',
    subject,
    from: change.from,
    to: change.to,
    summary: `Replaced by the update to ${to}: ${change.plugin}`,
    createdAt: findEntry(log, id)?.createdAt ?? at,
    decidedAt: at,
    decidedFrom: 'update',
  }
}

/**
 * The subject of the profile history version a start records.
 * @param upgraded - the plugins approved at the upgrade whose approval no history version holds yet.
 * @param awaiting - the plugins added since, which wait for review.
 * @param unreviewed - the plugins whose folder content this start approved without review.
 * @param moved - every plugin whose spec this start moved to its active directory.
 * @param replaced - the packs whose approved content the update replaced.
 * @param to - the release the update installed.
 * @returns the summary, or undefined when the start changed none of the profile's files.
 */
function historySummary(upgraded: readonly string[], awaiting: readonly string[], unreviewed: readonly string[], moved: readonly string[], replaced: readonly string[], to: string | undefined): string | undefined {
  if (moved.length === 0 && upgraded.length === 0 && unreviewed.length === 0 && replaced.length === 0) return undefined
  const parts: string[] = []
  if (upgraded.length > 0) parts.push(`approved at upgrade ${upgraded.join(', ')}`)
  if (awaiting.length > 0) parts.push(`${awaiting.join(', ')} ${awaiting.length === 1 ? 'waits' : 'wait'} for your review`)
  if (unreviewed.length > 0) parts.push(`loaded without review ${unreviewed.join(', ')}`)
  if (replaced.length > 0) parts.push(`replaced by the update to ${to ?? 'the new release'} ${replaced.join(', ')}`)
  const relinked = moved.filter(plugin => !upgraded.includes(plugin) && !awaiting.includes(plugin) && !unreviewed.includes(plugin) && !replaced.includes(plugin))
  if (relinked.length > 0) parts.push(`${relinked.join(', ')} linked to Delorun's copy again`)
  return `Changes: ${parts.join('; ')}`
}
