/**
 * Changes that load without review while protection is off (contract C21, "The protection setting"). Off is the
 * default: a start approves what each linked plugin's folder holds ([enforce](./enforce.ts)), the running Host reloads
 * a linked plugin when its folder changes ({@link loadUnreviewed}), and a start applies the edits of the harness's
 * writable copy ([harness](./harness.ts)). Each is still a logged change, applied and decided `unreviewed`, so the
 * person lists, shows and undoes it as any other.
 *
 * Content the person declined loads no more: when the newest decided change of a plugin's content was undone or
 * discarded and the folder still holds what that change brought, the plugin keeps its approved content, and that
 * content waits for review as under protection on, until the folder holds something else.
 *
 * Nothing here needs a proof of presence. Each writer reads the protection setting again under the profile write lock
 * and does nothing when protection is on, so turning it on takes effect at the next decision without a restart.
 *
 * @module @delorun/changes/unreviewed
 */
import { join, resolve } from 'node:path'
import { locked, recordVersion, timeOf } from './action-support.ts'
import type { ChangesContext, ReloadHost, ReloadOutcome } from './actions.ts'
import { holdContent, namesDirectory, storeFolderContent } from './enforce.ts'
import { changeId } from './ids.ts'
import { isPluginRequest } from './install-actions.ts'
import { leftOutOf, newestDecided } from './left-out.ts'
import { readLinks } from './link.ts'
import { activeDirectory, CHANGES_ENTRIES, profileChangesDirectory } from './paths.ts'
import { approvedOf, findEntry, readActiveRecord, readApproved, readChangeLog, readProtection, readWorkSession, withEntry, withoutDecision, writeActiveRecord, writeApproved, writeChangeLog } from './records.ts'
import type { ActiveRecord, ApprovedRecord, ChangeEntry, ChangeId, ChangeLog, ContentVersion, LeftOut } from './types.ts'
import { referenceRelease } from './tree.ts'

/** A plugin's folder content that loaded without review. */
export interface UnreviewedLoad {
  readonly id: ChangeId
  readonly plugin: string
  readonly kind: 'plugin-edit' | 'plugin-install'
}

/** What one look at a linked plugin's folder did while protection is off. */
export type UnreviewedSync =
  /** Protection is on, so nothing loads without review. */
  | { readonly kind: 'protected', readonly plugin: string }
  /** Nothing to load: the folder holds the approved content, content the person declined, content that failed to load already, or content a failed start left out. */
  | { readonly kind: 'unchanged', readonly plugin: string }
  /** The plugin is not linked to its active directory, a work session is open on it, or its folder is gone. */
  | { readonly kind: 'skipped', readonly plugin: string }
  /** The folder could not be read as one content version. */
  | { readonly kind: 'unreadable', readonly plugin: string, readonly detail: string }
  /** The running Host loaded the folder's content, now approved and logged. */
  | { readonly kind: 'loaded', readonly plugin: string, readonly entry: ChangeEntry }
  /** Delorun is not running for the profile; the content is approved and logged and loads at the next start. */
  | { readonly kind: 'not-running', readonly plugin: string, readonly entry: ChangeEntry }
  /**
   * The running Host failed to load it, so the approved content, the active directory and the records went back; the
   * change is pending with the failure, and is not tried again until the folder changes. `again` is the Host's answer
   * to the reload after going back.
   */
  | { readonly kind: 'went-back', readonly plugin: string, readonly entry: ChangeEntry, readonly failure: string, readonly again?: ReloadOutcome }

/** The kinds of a change of a plugin's content. */
const CONTENT_KINDS: ReadonlySet<ChangeEntry['kind']> = new Set(['plugin-edit', 'plugin-install'])

/**
 * Whether the person declined a plugin's folder content: the newest decided change of the plugin's content was undone
 * or discarded, and it brought exactly this content.
 * @param log - the change log.
 * @param plugin - the package name.
 * @param version - the folder's content.
 * @returns whether it was declined.
 */
export function declinedByPerson(log: ChangeLog, plugin: string, version: ContentVersion): boolean {
  const newest = newestDecided(log.entries, entry => entry.subject.plugin === plugin && CONTENT_KINDS.has(entry.kind) && !isPluginRequest(entry))
  return newest !== undefined && (newest.state === 'undone' || newest.state === 'discarded') && newest.to === version
}

/**
 * The applied change that records folder content loaded without review.
 * @param log - the change log, whose entry with the same id gives its creation time.
 * @param change - the plugin, its folder, the approved content before and the folder's content.
 * @param at - when, ISO 8601.
 * @returns the entry, applied and decided `unreviewed`.
 */
export function unreviewedEntry(log: ChangeLog, change: { readonly plugin: string, readonly source: string, readonly from?: ContentVersion, readonly to: ContentVersion }, at: string): ChangeEntry & Pick<UnreviewedLoad, 'kind'> {
  const subject = { plugin: change.plugin, source: change.source }
  const kind: UnreviewedLoad['kind'] = change.from === undefined ? 'plugin-install' : 'plugin-edit'
  const id = changeId(kind, subject, change.from, change.to)
  return {
    id,
    kind,
    state: 'applied',
    subject,
    ...change.from === undefined ? {} : { from: change.from },
    to: change.to,
    summary: kind === 'plugin-install' ? `Loaded without review: ${change.plugin} from ${change.source}` : `Loaded without review: ${change.plugin}: changes in ${change.source}`,
    createdAt: findEntry(log, id)?.createdAt ?? at,
    decidedAt: at,
    decidedFrom: 'unreviewed',
  }
}

/**
 * The words a start or a reload says about content that loaded without review.
 * @param load - the change.
 * @returns the line, without a trailing newline.
 */
export function unreviewedWords(load: UnreviewedLoad): string {
  return load.kind === 'plugin-install'
    ? `${load.plugin} loaded without review, because protection is off: delorun changes show ${load.id}`
    : `${load.plugin} loaded changes without review, because protection is off: delorun changes show ${load.id}`
}

/**
 * @param record - the approved record.
 * @param plugin - a package name.
 * @param source - its folder.
 * @param version - the content to approve.
 * @param at - when, ISO 8601.
 * @returns the record with the plugin approved at that content.
 */
export function approvedWith(record: ApprovedRecord, plugin: string, source: string, version: ContentVersion, at: string): ApprovedRecord {
  return { ...record, plugins: { ...record.plugins, [plugin]: { source, version, approvedAt: at } } }
}

/**
 * @param record - the active record.
 * @param plugin - a package name.
 * @param version - what its active directory holds.
 * @returns the record with the plugin's content approved at that version.
 */
function activeWith(record: ActiveRecord, plugin: string, version: ContentVersion): ActiveRecord {
  return { ...record, plugins: { ...record.plugins, [plugin]: { version, kind: 'approved' } } }
}

/** A linked plugin's folder, which the running Host watches while protection is off. */
export interface WatchedFolder {
  readonly plugin: string
  /** Its folder, absolute. */
  readonly source: string
}

/**
 * The folders whose content loads without review: with protection off, each plugin the profile links to its active
 * directory, with the folder its approval names, or for a plugin with none, the folder its newest install names.
 * @param ctx - the profile.
 * @returns the folders; none with protection on.
 * @throws {ChangesError} when a record of Changes or the profile's manifest is not one Delorun wrote.
 */
export async function unreviewedFolders(ctx: Pick<ChangesContext, 'home' | 'profile' | 'profileDir'>): Promise<WatchedFolder[]> {
  if (await readProtection(ctx.home) === 'on') return []
  const approved = await readApproved(ctx.profileDir)
  const sources = new Map<string, string>()
  for (const entry of (await readChangeLog(ctx.home, ctx.profile)).entries) {
    if (entry.kind === 'plugin-install' && entry.subject.plugin !== undefined && entry.subject.source !== undefined) sources.set(entry.subject.plugin, entry.subject.source)
  }
  for (const [plugin, approval] of Object.entries(approved.plugins)) sources.set(plugin, approval.source)
  return (await readLinks(ctx.profileDir)).flatMap((link): WatchedFolder[] => {
    const source = sources.get(link.name)
    return source !== undefined && resolve(link.target) === resolve(activeDirectory(ctx.home, ctx.profile, link.name)) ? [{ plugin: link.name, source }] : []
  })
}

/** What the records say about loading a plugin's folder: its folder and the records the decision reads, or why nothing loads. */
type LoadTarget =
  | { readonly kind: 'load', readonly source: string, readonly directory: string, readonly approved: ApprovedRecord, readonly log: ChangeLog }
  | Extract<UnreviewedSync, { readonly kind: 'protected' | 'skipped' }>

/**
 * Read what decides whether a plugin's folder loads without review.
 * @param ctx - the profile.
 * @param plugin - the package name.
 * @returns the folder with the approved record and the change log, or `protected` or `skipped`.
 * @throws {ChangesError} when a record of Changes or the profile's manifest is not one Delorun wrote.
 */
async function loadTarget(ctx: ChangesContext, plugin: string): Promise<LoadTarget> {
  if (await readProtection(ctx.home) === 'on') return { kind: 'protected', plugin }
  const directory = activeDirectory(ctx.home, ctx.profile, plugin)
  const linked = (await readLinks(ctx.profileDir)).some(link => link.name === plugin && resolve(link.target) === resolve(directory))
  const approved = await readApproved(ctx.profileDir)
  const log = await readChangeLog(ctx.home, ctx.profile)
  const source = approvedOf(approved, plugin)?.source ?? log.entries.findLast(entry => entry.kind === 'plugin-install' && entry.subject.plugin === plugin && entry.subject.source !== undefined)?.subject.source
  if (!linked || source === undefined || (await readWorkSession(ctx.home, ctx.profile))?.plugin === plugin || !await namesDirectory(source)) return { kind: 'skipped', plugin }
  return { kind: 'load', source, directory, approved, log }
}

/**
 * Load a linked plugin's folder content in the running Host while protection is off: when the folder holds content new
 * to the plugin, it becomes the approved content, the active directory holds it, one profile history version and an
 * applied change decided `unreviewed` record it, and the Host reloads. A failed reload goes back: the approved record,
 * the active directory and `active.json` hold what they held, a second history version records it, and the change is
 * pending with `lastFailure`, which keeps the same content from being tried again. The Host's watcher calls it for each
 * settled change of the folder.
 *
 * The folder is read into the store before the profile write lock is taken, because reading a large folder takes
 * seconds and every plugin install and Changes action waits for that lock. Under the lock the records are read again
 * and decide alone: a change another writer made after the read, such as protection turned on or the same content
 * approved by an install, is what the load acts on. When the records name another folder by then, the new folder is
 * read, again outside the lock. What loads is the content read, copied from the store; an edit of the folder after the
 * read is the watcher's next load.
 * @param ctx - the profile.
 * @param plugin - the package name.
 * @param reload - reloads the running Host.
 * @returns what it did.
 * @throws {ChangesError} when a record of Changes or the profile's manifest is not one Delorun wrote.
 */
export async function loadUnreviewed(ctx: ChangesContext, plugin: string, reload: ReloadHost): Promise<UnreviewedSync> {
  const scanCache = join(profileChangesDirectory(ctx.home, ctx.profile), CHANGES_ENTRIES.scanCache)
  let read = await loadTarget(ctx, plugin)
  for (;;) {
    if (read.kind !== 'load') return read
    const { source } = read
    const content = await storeFolderContent(ctx.home, source, scanCache, 'off')
    if (content.kind === 'unreadable') return { kind: 'unreadable', plugin, detail: content.detail }
    const decided = await locked(ctx, async (): Promise<UnreviewedSync | LoadTarget> => {
      const target = await loadTarget(ctx, plugin)
      if (target.kind !== 'load' || target.source !== source) return target
      return commitUnreviewed(ctx, plugin, reload, target, content.version)
    })
    if (decided.kind !== 'load') return decided
    read = decided
  }
}

/**
 * Decide and commit one read of a plugin's folder; the caller holds the profile write lock.
 * @param ctx - the profile.
 * @param plugin - the package name.
 * @param reload - reloads the running Host.
 * @param target - the records, read under the lock.
 * @param version - the folder's content, already in the store.
 * @returns what it did.
 */
async function commitUnreviewed(ctx: ChangesContext, plugin: string, reload: ReloadHost, target: Extract<LoadTarget, { readonly kind: 'load' }>, version: ContentVersion): Promise<UnreviewedSync> {
  const { source, directory, approved, log } = target
  const approval = approvedOf(approved, plugin)
  const left = leftOutOf(log, approved, plugin)
  const at = timeOf(ctx)
  const entry = unreviewedEntry(log, { plugin, source, ...approval === undefined ? {} : { from: approval.version }, to: version }, at)
  const tried = findEntry(log, entry.id)
  if (version === approval?.version || declinedByPerson(log, plugin, version) || (left !== undefined && (left.kind === 'plugin-on' || left.to === version)) || (tried?.state === 'pending' && tried.lastFailure !== undefined)) {
    return { kind: 'unchanged', plugin }
  }
  const activeBefore = await readActiveRecord(ctx.home, ctx.profile)
  const activeVersion = Object.hasOwn(activeBefore.plugins, plugin) ? activeBefore.plugins[plugin]!.version : undefined
  await writeApproved(ctx.profileDir, approvedWith(approved, plugin, source, version, at))
  await holdContent(ctx.home, directory, version, await referenceRelease(ctx.home, ctx.runningRelease))
  await writeActiveRecord(ctx.home, ctx.profile, activeWith(activeBefore, plugin, version))
  const applied: ChangeEntry = { ...entry, ...await recordVersion(ctx, entry.summary) }
  await writeChangeLog(ctx.home, ctx.profile, withEntry(log, applied))
  const outcome = await reload()
  if (outcome === undefined) return { kind: 'not-running', plugin, entry: applied }
  if (outcome.ok) return { kind: 'loaded', plugin, entry: applied }
  await writeApproved(ctx.profileDir, approved)
  await holdContent(ctx.home, directory, activeVersion, await referenceRelease(ctx.home, ctx.runningRelease))
  await writeActiveRecord(ctx.home, ctx.profile, activeBefore)
  await recordVersion(ctx, `Went back: ${entry.summary} failed to load`)
  const lastFailure: LeftOut = { at: timeOf(ctx), failure: outcome.error }
  const { historyVersion: _historyVersion, ...undecided } = withoutDecision(applied)
  const failed: ChangeEntry = { ...undecided, state: 'pending', lastFailure }
  await writeChangeLog(ctx.home, ctx.profile, withEntry(log, failed))
  const again = await reload()
  return { kind: 'went-back', plugin, entry: failed, failure: outcome.error, ...again === undefined ? {} : { again } }
}
