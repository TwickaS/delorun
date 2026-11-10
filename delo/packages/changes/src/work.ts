/**
 * Work sessions (contract C21, "Work sessions"): while the person works on one approved plugin, its folder's content
 * loads live. Modules load from the plugin's active directory, never from its folder, so Delo watches the folder itself
 * and copies each settled change into the active directory before the running Host reloads, rather than turning on
 * upstream's source watching (`hmr.root`), which would watch files that are not loaded.
 *
 * Every load stores the folder's content, makes the active directory hold it (replacing only the files that differ,
 * so hot reload replaces only the changed modules) and asks the running Host to reload. A load that fails goes back:
 * the active directory holds the content that last loaded, or the approved content when nothing loaded yet, the Host
 * reloads once more, the failed content is noted in the session record and `run/<profile>/changes-work.json` names the
 * error; the session stays open. Ending a session makes the folder's content the approved version, or the content that
 * last loaded when the folder's content failed to load or the folder is gone, and records the whole difference since
 * the session began as one applied `plugin-edit` change and one profile history version.
 *
 * Opening and ending a session from a request needs a proof of presence ([actions](./actions.ts)); Delo stopping ends
 * the session without one ([stop](./stop.ts)). Every load and every end of a session runs under upstream's profile
 * write lock.
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
import type { ActiveContent, ChangeEntry, ContentVersion, DecidedFrom, WorkSessionRecord } from './types.ts'
import { removeWorkFailure, writeWorkFailure } from './work-record.ts'

/** How many hexadecimal digits of a content version a history subject shows. */
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
  | WorkLoad

/** What starting a work session did. */
export interface WorkStarted {
  /** The open session's record. */
  readonly session: WorkSessionRecord
  /** How the folder's content loaded. */
  readonly load: Exclude<WorkLoad, { readonly kind: 'not-running' }>
}

/** What ending a work session did. */
export interface WorkFinished {
  readonly plugin: string
  /** The plugin's folder. */
  readonly source: string
  /** The approved content when the session began. */
  readonly from: ContentVersion
  /** The approved content now. */
  readonly approved: ContentVersion
  /** The folder's content when the session ended; absent when the folder is gone. */
  readonly folder?: ContentVersion
  /** Why the approved content is the content that last loaded rather than the folder's. */
  readonly kept?: 'failed-to-load' | 'folder-gone'
  /** The applied `plugin-edit` change; absent when the approved content did not change. */
  readonly entry?: ChangeEntry
  /** The last load before the session ended, when the folder held content not loaded yet. */
  readonly load?: WorkLoad
}

/** A load and the session record after it. */
interface Loaded {
  readonly load: WorkLoad
  readonly session: WorkSessionRecord
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
function scanCache(ctx: ChangesContext): { readonly scanCache: string } {
  return { scanCache: join(profileChangesDirectory(ctx.home, ctx.profile), CHANGES_ENTRIES.scanCache) }
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
  return (await storeFolder(ctx.home, session.source, scanCache(ctx))).version
}

/**
 * @param ctx - the profile.
 * @param session - the open session.
 * @param folder - the folder's content.
 * @returns whether it is new to the session: neither what the active directory holds nor content that failed to load.
 */
async function isNew(ctx: ChangesContext, session: WorkSessionRecord, folder: ContentVersion): Promise<boolean> {
  const { plugins } = await readActiveRecord(ctx.home, ctx.profile)
  const content = Object.hasOwn(plugins, session.plugin) ? plugins[session.plugin] : undefined
  return folder !== session.lastFailed && content?.version !== folder
}

/**
 * Load the open work session's folder when it holds content new to the session. The Host calls it for each settled
 * change of the folder or of the session record; it opens no session, so it needs no proof of presence.
 * @param ctx - the profile.
 * @param reload - reloads the running Host.
 * @returns what it did.
 * @throws {ChangesError} when a record of Changes is not one Delo wrote or the folder changed while it was read.
 */
export async function loadWorkSession(ctx: ChangesContext, reload: ReloadHost): Promise<WorkSync> {
  return locked(ctx, async () => {
    const session = await readWorkSession(ctx.home, ctx.profile)
    if (session === undefined) return { kind: 'none' }
    const folder = await folderVersion(ctx, session)
    if (folder === undefined) return { kind: 'folder-gone', plugin: session.plugin }
    if (!await isNew(ctx, session, folder)) return { kind: 'unchanged', plugin: session.plugin }
    return (await loadVersion(ctx, session, folder, reload)).load
  })
}

/**
 * Open a work session on an approved plugin and load its folder's content. The caller checked the proof.
 * @param ctx - the profile.
 * @param plugin - the package name.
 * @param presence - the proof, recorded as where the session started.
 * @param reload - reloads the running Host.
 * @returns the session and how its folder loaded.
 * @throws {ChangesError} `NOT_LINKED` for a plugin the profile does not load from its active directory with approved
 *   content, or whose folder is gone; `WORK_SESSION_OPEN`; `NOT_ALLOWED` when Delo is not running for the profile, after
 *   closing the session again.
 */
export async function beginWork(ctx: ChangesContext, plugin: string, presence: AtComputer, reload: ReloadHost): Promise<WorkStarted> {
  return locked(ctx, async () => {
    const approval = approvedOf(await readApproved(ctx.profileDir), plugin)
    const directory = activeDirectory(ctx.home, ctx.profile, plugin)
    const linked = (await readLinks(ctx.profileDir)).some(link => link.name === plugin && resolve(link.target) === resolve(directory))
    if (approval === undefined || !linked) throw new ChangesError('NOT_LINKED', plugin, `${plugin} is not a plugin of the profile ${ctx.profile} that you approved from a folder. See them: delorun changes list`)
    if (!await namesDirectory(approval.source)) throw new ChangesError('NOT_LINKED', plugin, `The folder of ${plugin}, ${approval.source}, is gone, so there is nothing to work on.`)
    const { version } = await storeFolder(ctx.home, approval.source, scanCache(ctx))
    const activeBefore = await readActiveRecord(ctx.home, ctx.profile)
    const opened = await openWorkSession(ctx.home, ctx.profile, { plugin, source: approval.source, from: approval.version }, presence)
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
 * @param version - a content version.
 * @returns its first digits, as a history subject shows it.
 */
function short(version: ContentVersion): string {
  return version.slice(0, SHORT_VERSION_LENGTH)
}

/**
 * End the open work session: load the folder's content once more when the Host runs and it is new, approve the
 * folder's content or, when it failed to load or the folder is gone, the content that last loaded, record the whole
 * difference since the session began as one applied change and one profile history version, and close the session.
 * The caller holds the profile's lock and checked the proof, or ends the session because Delo stops.
 * @param ctx - the profile.
 * @param session - the open session.
 * @param decidedFrom - where the change is recorded as decided.
 * @param reload - reloads the running Host; undefined when Delo stops, so nothing loads.
 * @returns what was done.
 */
export async function endWork(ctx: ChangesContext, session: WorkSessionRecord, decidedFrom: DecidedFrom, reload: ReloadHost | undefined): Promise<WorkFinished> {
  const { plugin, source, from } = session
  const folder = await folderVersion(ctx, session)
  let current = session
  let load: WorkLoad | undefined
  if (reload !== undefined && folder !== undefined && await isNew(ctx, session, folder)) ({ load, session: current } = await loadVersion(ctx, session, folder, reload))
  const approved = folder !== undefined && folder !== current.lastFailed ? folder : current.lastLoaded ?? from
  const kept = approved === folder ? undefined : folder === undefined ? 'folder-gone' : 'failed-to-load'
  await hold(ctx, plugin, { version: approved, kind: 'approved' })
  let entry: ChangeEntry | undefined
  if (approved !== from) {
    const at = timeOf(ctx)
    const record = await readApproved(ctx.profileDir)
    await writeApproved(ctx.profileDir, { ...record, plugins: { ...record.plugins, [plugin]: { source, version: approved, approvedAt: at } } })
    const summary = `Work on ${plugin}: ${short(from)} → ${short(approved)}`
    const subject = { plugin, source }
    entry = { id: changeId('plugin-edit', subject, from, approved), kind: 'plugin-edit', state: 'applied', subject, from, to: approved, summary, createdAt: session.startedAt, decidedAt: at, decidedFrom, ...await recordVersion(ctx, summary) }
    await writeChangeLog(ctx.home, ctx.profile, withEntry(await readChangeLog(ctx.home, ctx.profile), entry))
  }
  await unlink(sessionPath(ctx))
  if (kept !== 'failed-to-load') await removeWorkFailure(ctx.home, ctx.profile)
  return { plugin, source, from, approved, ...folder === undefined ? {} : { folder }, ...kept === undefined ? {} : { kept }, ...entry === undefined ? {} : { entry }, ...load === undefined ? {} : { load } }
}

/**
 * The line that says how a work session ended, in the person's words.
 * @param finished - what ending it did.
 * @returns the line, without a trailing newline.
 */
export function workFinishedLine(finished: WorkFinished): string {
  const { plugin } = finished
  if (finished.kept === 'failed-to-load') return `The newest content of ${plugin}'s folder failed to load, so the content that last loaded is now the approved version of ${plugin}.`
  if (finished.kept === 'folder-gone') return `The folder of ${plugin} is gone, so the content that last loaded is now the approved version of ${plugin}.`
  return finished.entry === undefined ? `${plugin} runs its approved version; its folder holds no change.` : `The folder's content is now the approved version of ${plugin} (${finished.entry.id}).`
}
