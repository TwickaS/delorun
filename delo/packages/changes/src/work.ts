/**
 * Work sessions (contract C21, "Work sessions"): while the person works on one approved plugin, its folder's content
 * loads live, for at most {@link WORK_SESSION_MAX_MINUTES} minutes. Modules load from the plugin's active directory,
 * never from its folder, so Delo watches the folder itself and copies each settled change into the active directory
 * before the running Host reloads, rather than turning on upstream's source watching (`hmr.root`), which would watch
 * files that are not loaded.
 *
 * Every load stores the folder's content, makes the active directory hold it (replacing only the files that differ,
 * so hot reload replaces only the changed modules) and asks the running Host to reload. A load that fails goes back:
 * the active directory holds the content that last loaded, or the approved content when nothing loaded yet, the Host
 * reloads once more, the failed content is noted in the session record and `run/<profile>/changes-work.json` names the
 * error; the session stays open. Nothing loads once the session's end time has passed.
 *
 * Only the person approves what the session loaded: `done` shows the folder's content as a version digest with its
 * files and diff against the approved content, and approves exactly that digest, refusing with `CHANGED_SINCE_REVIEW`
 * when the folder holds anything else by then. A session that ends without the person (Delo stopping, a start after a
 * crash, or its end time) approves nothing: the approved content stays the version the session started from, the
 * active directory holds it again, and the folder's content is the ordinary pending change against it.
 *
 * Opening and ending a session from a request needs a proof of presence ([actions](./actions.ts)); ending it without
 * the person is the separate entry `@delo/changes/stop` ([stop](./stop.ts)). Every load and every end of a session runs
 * under upstream's profile write lock.
 *
 * @module @delo/changes/work
 */
import { unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { locked, recordVersion, timeOf } from './action-support.ts'
import type { ChangesContext, ReloadHost, ReloadOutcome } from './actions.ts'
import { holdContent, namesDirectory } from './enforce.ts'
import { ChangesError } from './errors.ts'
import { changeId } from './ids.ts'
import { readLinks } from './link.ts'
import { activeDirectory, CHANGES_ENTRIES, profileChangesDirectory } from './paths.ts'
import { pluginChange } from './pending.ts'
import {
  approvedOf,
  noteFailed,
  noteLoaded,
  openWorkSession,
  readActiveRecord,
  readApproved,
  readChangeLog,
  readWorkSession,
  withEntry,
  writeActiveRecord,
  writeApproved,
  writeChangeLog,
  type AtComputer,
} from './records.ts'
import { storeFolder } from './store.ts'
import type { ActiveContent, ChangeEntry, ContentVersion, DecidedFrom, PluginChange, WorkSessionRecord } from './types.ts'
import { removeWorkFailure, writeWorkFailure } from './work-record.ts'

/**
 * The longest a work session lasts, in minutes: eight hours. Everything the folder holds loads without review while a
 * session lasts, so no request opens a longer one.
 */
export const WORK_SESSION_MAX_MINUTES = 480

/** How many hexadecimal digits of a content version the person reads. */
const SHORT_VERSION_LENGTH = 7

/** How one load of folder content in a work session went. */
export type WorkLoad =
  /** The running Host loaded it. */
  | { readonly kind: 'loaded', readonly plugin: string, readonly version: ContentVersion }
  /**
   * The running Host failed to load it, so the active directory holds `back` again: the content that last loaded, or
   * the approved content. `again` is the Host's answer to the reload after going back.
   */
  | { readonly kind: 'went-back', readonly plugin: string, readonly version: ContentVersion, readonly back: ContentVersion, readonly failure: string, readonly again?: ReloadOutcome }
  /** Delo is not running for the profile; the active directory holds it for the next start. */
  | { readonly kind: 'not-running', readonly plugin: string, readonly version: ContentVersion }

/** What one look at the open work session's folder did. */
export type WorkSync =
  /** No work session is open. */
  | { readonly kind: 'none' }
  /** The folder holds what the active directory holds, or content that failed to load already. */
  | { readonly kind: 'unchanged', readonly plugin: string }
  /** The folder is gone; the active directory keeps what it holds. */
  | { readonly kind: 'folder-gone', readonly plugin: string }
  /** The session's end time has passed, so nothing loads; the session waits to be ended without the person. */
  | { readonly kind: 'expired', readonly plugin: string, readonly endsAt: string }
  | WorkLoad

/** What starting a work session did. */
export interface WorkStarted {
  /** The open session's record. */
  readonly session: WorkSessionRecord
  /** How the folder's content loaded. */
  readonly load: Exclude<WorkLoad, { readonly kind: 'not-running' }>
}

/** How a work session ended: the person at `done`, Delo stopping or a start after a crash, or its end time. */
export type WorkEnding = 'done' | 'stopped' | 'expired'

/** What ending a work session did. */
export interface WorkFinished {
  readonly kind: 'ended'
  readonly plugin: string
  /** The plugin's folder. */
  readonly source: string
  /** The approved content when the session began. */
  readonly from: ContentVersion
  /** How it ended. */
  readonly ended: WorkEnding
  /** The approved content now: the version `done` showed, or {@link WorkFinished.from} when it ended without the person. */
  readonly approved: ContentVersion
  /** The folder's content `done` showed; absent when the folder is gone and when the session ended without the person. */
  readonly folder?: ContentVersion
  /** The applied `plugin-edit` change; absent when the approved content did not change. */
  readonly entry?: ChangeEntry
  /** The load of the version `done` approved, when the active directory did not hold it yet. */
  readonly load?: WorkLoad
  /** The running Host's answer after the session ended at its end time and the active directory held `from` again. */
  readonly reload?: ReloadOutcome
}

/** `done` approved nothing: the version it showed failed to load, so Delo went back and the session stays open. */
export interface WorkNotApproved {
  readonly kind: 'went-back'
  readonly plugin: string
  /** The failed load. */
  readonly load: Extract<WorkLoad, { readonly kind: 'went-back' }>
}

/** What `done` did. */
export type WorkDone = WorkFinished | WorkNotApproved

/** What `done` shows before the person approves. */
export interface WorkReview {
  /** The open session. */
  readonly session: WorkSessionRecord
  /** The folder's content, stored; absent when the folder is gone. */
  readonly folder?: ContentVersion
  /** The folder's content against the approved content `from`; absent when they are the same or the folder is gone. */
  readonly change?: PluginChange
  /** Whether the folder's content is the content whose reload failed in the session. */
  readonly failedToLoad: boolean
}

/** A load and the session record after it. */
interface Loaded {
  readonly load: WorkLoad
  readonly session: WorkSessionRecord
}

/**
 * The short form of a content version that `done`, the history subject and the session's end lines show.
 * @param version - a content version.
 * @returns its first 7 hexadecimal digits.
 */
export function shortVersion(version: ContentVersion): string {
  return version.slice(0, SHORT_VERSION_LENGTH)
}

/**
 * Whether a work session's end time has passed by the context's clock, after which nothing loads and the session ends
 * without the person.
 * @param ctx - the context's clock; the system clock when absent.
 * @param session - an open session.
 * @returns whether its end time has passed.
 */
export function workSessionExpired(ctx: Pick<ChangesContext, 'now'>, session: Pick<WorkSessionRecord, 'endsAt'>): boolean {
  return Date.parse(session.endsAt) <= (ctx.now ?? (() => new Date()))().getTime()
}

/**
 * @param ctx - the profile.
 * @returns the work-session record's path.
 */
function sessionPath(ctx: ChangesContext): string {
  return join(profileChangesDirectory(ctx.home, ctx.profile), CHANGES_ENTRIES.workSession)
}

/**
 * @param ctx - the profile.
 * @returns the scan cache a store of a folder uses.
 */
function scanCache(ctx: ChangesContext): string {
  return join(profileChangesDirectory(ctx.home, ctx.profile), CHANGES_ENTRIES.scanCache)
}

/**
 * Make a plugin's active directory hold one content and record it in `active.json`.
 * @param ctx - the profile.
 * @param plugin - the package name.
 * @param content - what the directory holds.
 */
async function hold(ctx: ChangesContext, plugin: string, content: ActiveContent): Promise<void> {
  await holdContent(ctx.home, activeDirectory(ctx.home, ctx.profile, plugin), content.version)
  const record = await readActiveRecord(ctx.home, ctx.profile)
  await writeActiveRecord(ctx.home, ctx.profile, { ...record, plugins: { ...record.plugins, [plugin]: content } })
}

/**
 * @param ctx - the profile.
 * @param plugin - the package name.
 * @returns the content `active.json` records for the plugin's active directory.
 */
async function activeVersion(ctx: ChangesContext, plugin: string): Promise<ContentVersion | undefined> {
  const { plugins } = await readActiveRecord(ctx.home, ctx.profile)
  return Object.hasOwn(plugins, plugin) ? plugins[plugin]!.version : undefined
}

/**
 * Load folder content in the open session: the active directory holds it and the Host reloads; a failed reload goes
 * back to the content that last loaded, or the approved content.
 * @param ctx - the profile.
 * @param session - the open session.
 * @param version - the folder's content, stored.
 * @param reload - reloads the running Host.
 * @returns the load and the session record after it.
 */
async function loadVersion(ctx: ChangesContext, session: WorkSessionRecord, version: ContentVersion, reload: ReloadHost): Promise<Loaded> {
  const { plugin } = session
  await hold(ctx, plugin, { version, kind: 'work-session' })
  const outcome = await reload()
  if (outcome === undefined) return { load: { kind: 'not-running', plugin, version }, session }
  if (outcome.ok) {
    const loaded = await noteLoaded(ctx.home, ctx.profile, version)
    await removeWorkFailure(ctx.home, ctx.profile)
    return { load: { kind: 'loaded', plugin, version }, session: loaded }
  }
  const back = session.lastLoaded ?? session.from
  await hold(ctx, plugin, { version: back, kind: back === session.from ? 'approved' : 'work-session' })
  const failed = await noteFailed(ctx.home, ctx.profile, version)
  await writeWorkFailure(ctx.home, ctx.profile, { plugin, at: timeOf(ctx), error: outcome.error })
  const again = await reload()
  return { load: { kind: 'went-back', plugin, version, back, failure: outcome.error, ...again === undefined ? {} : { again } }, session: failed }
}

/**
 * @param ctx - the profile.
 * @param session - the open session.
 * @returns the folder's content, stored; undefined when the folder is gone.
 */
async function folderVersion(ctx: ChangesContext, session: WorkSessionRecord): Promise<ContentVersion | undefined> {
  if (!await namesDirectory(session.source)) return undefined
  return (await storeFolder(ctx.home, session.source, { scanCache: scanCache(ctx) })).version
}

/**
 * Load the open work session's folder when it holds content new to the session: neither what the active directory
 * holds nor content that failed to load. The Host calls it for each settled change of the folder or of the session
 * record; it opens no session, so it needs no proof of presence. Once the session's end time has passed it loads
 * nothing.
 * @param ctx - the profile.
 * @param reload - reloads the running Host.
 * @returns what it did.
 * @throws {ChangesError} when a record of Changes is not one Delo wrote or the folder changed while it was read.
 */
export async function loadWorkSession(ctx: ChangesContext, reload: ReloadHost): Promise<WorkSync> {
  return locked(ctx, async () => {
    const session = await readWorkSession(ctx.home, ctx.profile)
    if (session === undefined) return { kind: 'none' }
    if (workSessionExpired(ctx, session)) return { kind: 'expired', plugin: session.plugin, endsAt: session.endsAt }
    const folder = await folderVersion(ctx, session)
    if (folder === undefined) return { kind: 'folder-gone', plugin: session.plugin }
    if (folder === session.lastFailed || folder === await activeVersion(ctx, session.plugin)) return { kind: 'unchanged', plugin: session.plugin }
    return (await loadVersion(ctx, session, folder, reload)).load
  })
}

/**
 * Open a work session on an approved plugin and load its folder's content. The caller checked the proof.
 * @param ctx - the profile.
 * @param plugin - the package name.
 * @param presence - the proof, recorded as where the session started.
 * @param reload - reloads the running Host.
 * @param minutes - how long the session lasts, from 1 to {@link WORK_SESSION_MAX_MINUTES}.
 * @returns the session and how its folder loaded.
 * @throws {ChangesError} `NOT_ALLOWED` for a length outside that range, before anything is read; `NOT_LINKED` for a
 *   plugin the profile does not load from its active directory with approved content, or whose folder is gone;
 *   `WORK_SESSION_OPEN`; `NOT_ALLOWED` when Delo is not running for the profile, after closing the session again.
 */
export async function beginWork(ctx: ChangesContext, plugin: string, presence: AtComputer, reload: ReloadHost, minutes: number): Promise<WorkStarted> {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > WORK_SESSION_MAX_MINUTES) {
    throw new ChangesError('NOT_ALLOWED', plugin, `A work session lasts from 1 to ${String(WORK_SESSION_MAX_MINUTES)} minutes, so ${String(minutes)} minutes is not allowed.`)
  }
  return locked(ctx, async () => {
    const approval = approvedOf(await readApproved(ctx.profileDir), plugin)
    const directory = activeDirectory(ctx.home, ctx.profile, plugin)
    const linked = (await readLinks(ctx.profileDir)).some(link => link.name === plugin && resolve(link.target) === resolve(directory))
    if (approval === undefined || !linked) throw new ChangesError('NOT_LINKED', plugin, `${plugin} is not a plugin of the profile ${ctx.profile} that you approved from a folder. See them: delorun changes list`)
    if (!await namesDirectory(approval.source)) throw new ChangesError('NOT_LINKED', plugin, `The folder of ${plugin}, ${approval.source}, is gone, so there is nothing to work on.`)
    const { version } = await storeFolder(ctx.home, approval.source, { scanCache: scanCache(ctx) })
    const activeBefore = await readActiveRecord(ctx.home, ctx.profile)
    const opened = await openWorkSession(ctx.home, ctx.profile, { plugin, source: approval.source, from: approval.version, minutes }, presence)
    await removeWorkFailure(ctx.home, ctx.profile)
    const { load, session } = await loadVersion(ctx, opened, version, reload)
    if (load.kind !== 'not-running') return { session, load }
    await holdContent(ctx.home, directory, Object.hasOwn(activeBefore.plugins, plugin) ? activeBefore.plugins[plugin]!.version : undefined)
    await writeActiveRecord(ctx.home, ctx.profile, activeBefore)
    await unlink(sessionPath(ctx))
    throw new ChangesError('NOT_ALLOWED', plugin, `Delo is not running for the profile ${ctx.profile}, so nothing would load live. Start it with delorun start, then run delorun changes work ${plugin}.`)
  })
}

/**
 * @param ctx - the profile.
 * @param plugin - the package name.
 * @returns the open session on the plugin.
 * @throws {ChangesError} `NO_WORK_SESSION` when no work session on the plugin is open.
 */
async function sessionOn(ctx: ChangesContext, plugin: string): Promise<WorkSessionRecord> {
  const session = await readWorkSession(ctx.home, ctx.profile)
  if (session?.plugin !== plugin) throw new ChangesError('NO_WORK_SESSION', plugin, `No work session on ${plugin} is open in the profile ${ctx.profile}.`)
  return session
}

/**
 * What `done` shows: the folder's content, stored, and its difference from the approved content the session started
 * from. Reading stores the folder's content; nothing the profile runs changes, so it needs no proof of presence.
 * @param ctx - the profile.
 * @param plugin - the package name.
 * @returns the session, the folder's content and the change.
 * @throws {ChangesError} `NO_WORK_SESSION` when no work session on the plugin is open; when a record of Changes is not
 *   one Delo wrote or the folder changed while it was read.
 */
export async function reviewWork(ctx: ChangesContext, plugin: string): Promise<WorkReview> {
  return locked(ctx, async () => {
    const session = await sessionOn(ctx, plugin)
    if (!await namesDirectory(session.source)) return { session, failedToLoad: false }
    const change = await pluginChange(ctx.home, { plugin, source: session.source, approved: session.from, scanCache: scanCache(ctx) })
    const folder = change?.to ?? session.from
    return { session, folder, ...change === undefined ? {} : { change }, failedToLoad: folder === session.lastFailed }
  })
}

/**
 * Close the session with one approved version: the active directory holds it as approved, a version other than `from`
 * is recorded as one applied `plugin-edit` change from `from` and one profile history version, and the session record
 * and the record of its last failed reload are removed.
 * @param ctx - the profile.
 * @param session - the open session.
 * @param decidedFrom - where the person approved it.
 * @param approved - the version to approve.
 * @param shown - what `done` showed and the load before approving.
 * @returns what was done.
 */
async function approveAndClose(ctx: ChangesContext, session: WorkSessionRecord, decidedFrom: DecidedFrom, approved: ContentVersion, shown: Pick<WorkFinished, 'folder' | 'load'>): Promise<WorkFinished> {
  const { plugin, source, from } = session
  await hold(ctx, plugin, { version: approved, kind: 'approved' })
  let entry: ChangeEntry | undefined
  if (approved !== from) {
    const at = timeOf(ctx)
    const record = await readApproved(ctx.profileDir)
    await writeApproved(ctx.profileDir, { ...record, plugins: { ...record.plugins, [plugin]: { source, version: approved, approvedAt: at } } })
    const summary = `Work on ${plugin}: ${shortVersion(from)} → ${shortVersion(approved)}`
    const subject = { plugin, source }
    entry = { id: changeId('plugin-edit', subject, from, approved), kind: 'plugin-edit', state: 'applied', subject, from, to: approved, summary, createdAt: session.startedAt, decidedAt: at, decidedFrom, ...await recordVersion(ctx, summary) }
    await writeChangeLog(ctx.home, ctx.profile, withEntry(await readChangeLog(ctx.home, ctx.profile), entry))
  }
  await unlink(sessionPath(ctx))
  await removeWorkFailure(ctx.home, ctx.profile)
  return { kind: 'ended', plugin, source, from, ended: 'done', approved, ...shown, ...entry === undefined ? {} : { entry } }
}

/**
 * End the work session on a plugin at the person's word: approve exactly the folder's content `done` showed, or keep
 * `from` when the folder was gone. When the active directory does not hold that version yet and Delo runs, it loads
 * first; a failed load approves nothing and leaves the session open. The caller checked the proof.
 * @param ctx - the profile.
 * @param plugin - the package name.
 * @param decidedFrom - where the person approved it.
 * @param reload - reloads the running Host.
 * @param approve - the folder's content `done` showed ({@link WorkReview.folder}); undefined when the folder was gone.
 * @returns what was done.
 * @throws {ChangesError} `NO_WORK_SESSION` when no work session on the plugin is open; `CHANGED_SINCE_REVIEW`, approving
 *   nothing and leaving the session open, when the folder holds anything other than `approve`.
 */
export async function endWork(ctx: ChangesContext, plugin: string, decidedFrom: DecidedFrom, reload: ReloadHost, approve: ContentVersion | undefined): Promise<WorkDone> {
  return locked(ctx, async () => {
    const session = await sessionOn(ctx, plugin)
    const folder = await folderVersion(ctx, session)
    if (folder !== approve) {
      throw new ChangesError('CHANGED_SINCE_REVIEW', plugin, `The folder of ${plugin} changed after it was shown, so nothing was approved and your work session stays open. Run delorun changes done ${plugin} again to see what it holds now.`)
    }
    const target = folder ?? session.from
    if (target === await activeVersion(ctx, plugin)) return approveAndClose(ctx, session, decidedFrom, target, folder === undefined ? {} : { folder })
    const { load } = await loadVersion(ctx, session, target, reload)
    if (load.kind === 'went-back') return { kind: 'went-back', plugin, load }
    return approveAndClose(ctx, session, decidedFrom, target, { ...folder === undefined ? {} : { folder }, load })
  })
}

/**
 * End the open work session without the person: the approved content stays the version the session started from, the
 * active directory holds it again, and the folder's content waits for review as the ordinary pending change. Nothing
 * is approved, so nothing is logged and no profile history version is recorded; the folder is not read. The caller
 * holds the profile's lock.
 * @param ctx - the profile.
 * @param session - the open session.
 * @param ended - why it ends.
 * @param reload - reloads the running Host when the session ends while Delo runs; undefined when Delo stops or starts.
 * @returns what was done.
 */
export async function endWorkWithoutPerson(ctx: ChangesContext, session: WorkSessionRecord, ended: Exclude<WorkEnding, 'done'>, reload: ReloadHost | undefined): Promise<WorkFinished> {
  const { plugin, source, from } = session
  await hold(ctx, plugin, { version: from, kind: 'approved' })
  await unlink(sessionPath(ctx))
  await removeWorkFailure(ctx.home, ctx.profile)
  const outcome = reload === undefined ? undefined : await reload()
  return { kind: 'ended', plugin, source, from, ended, approved: from, ...outcome === undefined ? {} : { reload: outcome } }
}

/**
 * The line that says what ending a work session approved, in the person's words.
 * @param finished - what ending it did.
 * @returns the line, without a trailing newline.
 */
export function workFinishedLine(finished: WorkFinished): string {
  const { plugin, from } = finished
  if (finished.ended !== 'done') return `Nothing was approved: ${plugin} keeps the version it had when the session started (${shortVersion(from)}), and what its folder holds waits for your review: delorun changes list`
  if (finished.entry !== undefined) return `Version ${shortVersion(finished.approved)} is now the approved version of ${plugin} (${finished.entry.id}).`
  return finished.folder === undefined ? `The folder of ${plugin} is gone; ${plugin} keeps its approved version (${shortVersion(from)}).` : `${plugin} keeps its approved version (${shortVersion(from)}); its folder holds no change.`
}
