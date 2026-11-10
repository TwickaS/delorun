/**
 * What a person does with Changes: list and show what waits for review, and apply, discard or undo a change, turn one
 * plugin off or on, change the protection setting, and start and end a work session. `delorun changes` calls these now and the studio's Changes
 * section later, so both decide the same way.
 *
 * Every action that changes something takes an {@link AtComputer} proof and refuses, before it reads or writes
 * anything, a proof that {@link attestTerminal} did not issue. Each runs under upstream's
 * profile write lock, `withFileLock(join(profileDir, 'package.json'), …)`, and every action that changes the
 * profile's files records one profile history version whose subject names the change id, so upstream's undo and
 * restore see it like any other change. Discarding changes no file the profile runs and records no version; the
 * protection setting lives in the home, not the profile, and records none either.
 *
 * An action that changes what the Host runs then calls the injected {@link ReloadHost}, which makes a running Host
 * load what the profile's files now name. When that reload fails, the action goes back: the approved record, the
 * active directory and the active record, or the bundle list, return to what they held, a second history version
 * records the way back, the change is pending again with the failure, and the Host is reloaded once more.
 *
 * @module @delo/changes/actions
 */
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProfileHistory } from '@deepseek-ai/dsh-plugin-manager/history'
import { PROTECTED_FILE_MODE } from '@delo/contract-home-layout'
import { DELO_BUNDLE } from '@delo/profile-safety'
import { locked, recordVersion, timeOf } from './action-support.ts'
import { holdContent, namesDirectory, PROFILE_LOCK_WAIT_MS } from './enforce.ts'
import { ChangesError } from './errors.ts'
import { changeId } from './ids.ts'
import { isJsonObject, LINK_SECTIONS, readLinks, readProfileManifest, type JsonObject } from './link.ts'
import { activeDirectory, CHANGES_ENTRIES, profileChangesDirectory, versionsDirectory } from './paths.ts'
import { pluginChange } from './pending.ts'
import {
  approvedOf,
  findEntry,
  readActiveRecord,
  readApproved,
  readChangeLog,
  readProtection,
  readWorkSession,
  requirePresence,
  setProtection,
  withEntry,
  writeActiveRecord,
  writeApproved,
  writeChangeLog,
  type AtComputer,
} from './records.ts'
import {
  PROTECTION_LEVELS,
  type ActiveContent,
  type ActiveRecord,
  type ApprovedPlugin,
  type ApprovedRecord,
  type ChangeEntry,
  type ChangeId,
  type ChangeLog,
  type ContentVersion,
  type LeftOut,
  type PluginChange,
  type ProtectionLevel,
  type WorkSessionRecord,
} from './types.ts'
import { isPluginRequest } from './install-actions.ts'
import { leftOutOf } from './left-out.ts'
import { beginWork, endWork, type WorkDone, type WorkStarted } from './work.ts'

/** The profile an action works on. */
export interface ChangesContext {
  /** The Delo home. */
  readonly home: string
  /** The profile's name. */
  readonly profile: string
  /** The profile's directory. */
  readonly profileDir: string
  /** The clock for the records' times; `() => new Date()` by default. */
  readonly now?: () => Date
  /** How long to wait for the profile write lock; {@link PROFILE_LOCK_WAIT_MS} by default. */
  readonly lockWaitMs?: number
  /** An open profile history, when the caller already has one; the profile's own by default. */
  readonly history?: Pick<ProfileHistory, 'record'>
}

/** What a running Host answers when asked to load what the profile's files name. */
export type ReloadOutcome = { readonly ok: true } | { readonly ok: false, readonly error: string }

/**
 * Make the running Host load what the profile's files now name: `changes.reload` on the update channel when Delo
 * runs. It carries nothing and changes no file.
 * @returns the Host's answer, or undefined when Delo is not running for the profile, so the next start loads the files.
 */
export type ReloadHost = () => Promise<ReloadOutcome | undefined>

/** What an action that changes what the Host runs is given. */
export interface ReloadOptions {
  /** Reloads the running Host. */
  readonly reload: ReloadHost
}

/** How the running Host took an action. */
export type ReloadReport =
  /** Delo is not running for the profile; the next start loads the change. */
  | { readonly kind: 'not-running' }
  /** The running Host loaded the change. */
  | { readonly kind: 'reloaded' }
  /**
   * The running Host failed to load the change, so the action went back: the change is pending again with the failure.
   * `again` is the Host's answer to the reload after going back; `historyVersion` the version that records going back.
   */
  | { readonly kind: 'went-back', readonly failure: string, readonly historyVersion?: string, readonly again?: ReloadOutcome }

/** What an action that changes what the Host runs did. */
export interface ActionResult {
  /** The change's log entry as it now stands. */
  readonly entry: ChangeEntry
  /** The profile history version the action recorded. */
  readonly historyVersion?: string
  /** How the running Host took it. */
  readonly reload: ReloadReport
}

/** A change waiting for review, with the failure of its last apply when it failed to load. */
export type ListedChange = PluginChange & { readonly lastFailure?: LeftOut }

/** A plugin whose folder is gone, so nothing is computed for it; its approved content still loads. */
export interface MissingFolder {
  readonly plugin: string
  readonly source: string
}

/** What `list` shows. */
export interface ChangesListing {
  readonly protection: ProtectionLevel
  /** Changes waiting for review, in the profile's dependency order. */
  readonly pending: readonly ListedChange[]
  /** The agent's plugin installs, updates and removals waiting for review, oldest first ([install actions](./install-actions.ts)). */
  readonly requests: readonly ChangeEntry[]
  /** The changes a failed start left out that stay out, at most one per plugin, newest in the log first ([left out](./left-out.ts)). */
  readonly leftOut: readonly ChangeEntry[]
  /** Every other logged change, newest first: decided ones, and a plugin turned off or on that failed to load. */
  readonly entries: readonly ChangeEntry[]
  /** Plugins whose folder no longer exists. */
  readonly missing: readonly MissingFolder[]
  /** The plugin whose folder loads live, while a work session is open. */
  readonly workSession?: { readonly plugin: string, readonly startedAt: string, readonly endsAt: string }
}

/** What `show` shows: a change waiting for review, or a logged one. */
export type ShownChange =
  | { readonly kind: 'pending', readonly change: ListedChange }
  | { readonly kind: 'logged', readonly entry: ChangeEntry }

/** What changing the protection setting did. */
export interface ProtectionChange {
  readonly before: ProtectionLevel
  readonly level: ProtectionLevel
  /** The `guard-weakening` entry, when the level is weaker than before. */
  readonly entry?: ChangeEntry
}

/** The kinds whose pending changes are computed from a folder rather than read from the log. */
const FOLDER_KINDS: ReadonlySet<ChangeEntry['kind']> = new Set(['plugin-edit', 'plugin-install'])

/** One plugin under Changes: linked to its active directory, with the folder it comes from. */
interface Managed {
  readonly plugin: string
  readonly source: string
  readonly approval?: ApprovedPlugin
}

/** The records an action reads under the lock. */
interface State {
  readonly approved: ApprovedRecord
  readonly log: ChangeLog
  readonly workSession: WorkSessionRecord | undefined
  readonly managed: readonly Managed[]
  /** The changes the folders hold now, discarded ones included. */
  readonly changes: readonly PluginChange[]
  readonly missing: readonly MissingFolder[]
}

/** Where a change id was found. */
type Located =
  | { readonly kind: 'current', readonly change: PluginChange }
  | { readonly kind: 'logged', readonly entry: ChangeEntry }

/**
 * The plugins under Changes: each `link:` dependency that names its active directory, with the folder its approval
 * names, or for a plugin with none, the folder its newest install entry names. A plugin whose folder no record names is
 * left out.
 * @param ctx - the profile.
 * @param approved - the approved record.
 * @param log - the change log.
 * @returns the plugins, in the manifest's order.
 */
async function managedPlugins(ctx: ChangesContext, approved: ApprovedRecord, log: ChangeLog): Promise<Managed[]> {
  const managed: Managed[] = []
  for (const link of await readLinks(ctx.profileDir)) {
    if (resolve(link.target) !== resolve(activeDirectory(ctx.home, ctx.profile, link.name))) continue
    const approval = approvedOf(approved, link.name)
    const source = approval?.source ?? log.entries.findLast(entry => entry.kind === 'plugin-install' && entry.subject.plugin === link.name && entry.subject.source !== undefined)?.subject.source
    if (source !== undefined) managed.push({ plugin: link.name, source, ...approval === undefined ? {} : { approval } })
  }
  return managed
}

/**
 * Read the records and compute what each plugin's folder holds against its approved content.
 * @param ctx - the profile.
 * @returns the state.
 */
async function readState(ctx: ChangesContext): Promise<State> {
  const approved = await readApproved(ctx.profileDir)
  const log = await readChangeLog(ctx.home, ctx.profile)
  const workSession = await readWorkSession(ctx.home, ctx.profile)
  const managed = await managedPlugins(ctx, approved, log)
  const scanCache = join(profileChangesDirectory(ctx.home, ctx.profile), CHANGES_ENTRIES.scanCache)
  const changes: PluginChange[] = []
  const missing: MissingFolder[] = []
  for (const { plugin, source, approval } of managed) {
    if (!await namesDirectory(source)) {
      missing.push({ plugin, source })
      continue
    }
    const change = await pluginChange(ctx.home, { plugin, source, ...approval === undefined ? {} : { approved: approval.version }, scanCache })
    if (change !== undefined) changes.push(change)
  }
  return { approved, log, workSession, managed, changes, missing }
}

/**
 * @param log - the change log.
 * @param id - a change id.
 * @returns whether the person discarded the change with the id.
 */
function isDiscarded(log: ChangeLog, id: ChangeId): boolean {
  return findEntry(log, id)?.state === 'discarded'
}

/**
 * @param entry - a log entry.
 * @returns whether it is a pending change of a folder, which the listing computes from the folder instead.
 */
function isFolderPending(entry: ChangeEntry): boolean {
  return entry.state === 'pending' && FOLDER_KINDS.has(entry.kind) && !isPluginRequest(entry)
}

/**
 * Whether an id names a change of a plugin's folder that is no longer its current content: the folder changed after
 * the change was shown. Every folder content a scan saw is a version in the store, so each is tried.
 * @param ctx - the profile.
 * @param state - the records.
 * @param id - the id.
 * @returns whether it does.
 */
async function isStale(ctx: ChangesContext, state: State, id: ChangeId): Promise<boolean> {
  if (state.managed.length === 0) return false
  const versions = (await readdir(versionsDirectory(ctx.home))).map(name => brandString<ContentVersion>(name.replace(/\.json$/, '')))
  return state.managed.some(({ plugin, source, approval }) => versions.some(version => changeId(approval === undefined ? 'plugin-install' : 'plugin-edit', { plugin, source }, approval?.version, version) === id))
}

/**
 * Find a change by its id: a change a folder holds now, or a logged change.
 * @param ctx - the profile.
 * @param state - the records.
 * @param id - the id.
 * @returns where it was found.
 * @throws {ChangesError} `CHANGED_SINCE_REVIEW` when the id names content a folder no longer holds; `UNKNOWN_CHANGE`
 *   when no change has the id.
 */
async function locate(ctx: ChangesContext, state: State, id: ChangeId): Promise<Located> {
  const change = state.changes.find(candidate => candidate.id === id)
  if (change !== undefined) return { kind: 'current', change }
  const entry = findEntry(state.log, id)
  if (entry !== undefined && !isFolderPending(entry)) return { kind: 'logged', entry }
  if (entry !== undefined || await isStale(ctx, state, id)) {
    throw new ChangesError('CHANGED_SINCE_REVIEW', id, `The folder of change ${id} changed after it was shown, so ${id} no longer names what it holds. See the change it holds now: delorun changes list`)
  }
  throw new ChangesError('UNKNOWN_CHANGE', id, `No change has the id ${id}. See the changes: delorun changes list`)
}

/**
 * @param state - the records.
 * @param plugin - a package name.
 * @throws {ChangesError} `NOT_ALLOWED` while a work session is open on the plugin.
 */
function refuseInWorkSession(state: State, plugin: string): void {
  if (state.workSession?.plugin === plugin) throw new ChangesError('NOT_ALLOWED', plugin, `Delo is working on ${plugin}, so its folder loads live; end that first with delorun changes done ${plugin}.`)
}

/**
 * @param change - a change of a plugin's folder.
 * @returns its one line in the person's words.
 */
function summaryOf(change: PluginChange): string {
  return change.kind === 'plugin-install' ? `${change.plugin} from ${change.source}` : `${change.plugin}: changes in ${change.source}`
}

/**
 * @param entry - a log entry.
 * @returns it without the decision's fields and the failure, as a pending change records it.
 */
function undecided(entry: ChangeEntry): ChangeEntry {
  const { decidedAt: _decidedAt, decidedFrom: _decidedFrom, historyVersion: _historyVersion, lastFailure: _lastFailure, ...rest } = entry
  return rest
}

/**
 * @param entry - a log entry.
 * @returns it without the failure of an earlier attempt.
 */
function withoutFailure(entry: ChangeEntry): ChangeEntry {
  const { lastFailure: _lastFailure, ...rest } = entry
  return rest
}

/**
 * @param record - the active record.
 * @param plugin - a package name.
 * @param content - what its active directory holds; undefined when it holds nothing.
 * @returns the record with the plugin's content set or removed.
 */
function withActive(record: ActiveRecord, plugin: string, content: ActiveContent | undefined): ActiveRecord {
  const { [plugin]: _previous, ...others } = record.plugins
  return { ...record, plugins: content === undefined ? others : { ...others, [plugin]: content } }
}

/**
 * @param record - the approved record.
 * @param plugin - a package name.
 * @param approval - its approval; undefined to remove it.
 * @returns the record with the plugin's approval set or removed.
 */
function withApproval(record: ApprovedRecord, plugin: string, approval: ApprovedPlugin | undefined): ApprovedRecord {
  const { [plugin]: _previous, ...others } = record.plugins
  return { ...record, plugins: approval === undefined ? others : { ...others, [plugin]: approval } }
}

/** One action's writes, how to go back from them, and its log entries. */
interface Plan {
  readonly id: ChangeId
  /** The subject of the history version the action records. */
  readonly summary: string
  /** The subject of the history version that records going back. */
  readonly wentBack: string
  /** Writes the profile's files and the home's records. */
  readonly write: () => Promise<void>
  /** Puts them back as they were. */
  readonly revert: () => Promise<void>
  /**
   * @param historyVersion - the version the action recorded.
   * @returns the entry once the action is done.
   */
  readonly done: (historyVersion: { readonly historyVersion?: string }) => ChangeEntry
  /**
   * @param failure - why the Host failed to load the change.
   * @returns the entry once the action went back.
   */
  readonly failed: (failure: LeftOut) => ChangeEntry
}

/**
 * Carry out a plan under the lock the caller holds: write, record the history version and the log entry, reload, and
 * go back when the reload failed.
 * @param ctx - the profile.
 * @param log - the change log before the action.
 * @param reload - reloads the running Host.
 * @param plan - the action.
 * @returns what the action did.
 */
async function carryOut(ctx: ChangesContext, log: ChangeLog, reload: ReloadHost, plan: Plan): Promise<ActionResult> {
  await plan.write()
  const recorded = await recordVersion(ctx, plan.summary)
  const entry = plan.done(recorded)
  await writeChangeLog(ctx.home, ctx.profile, withEntry(log, entry))
  const outcome = await reload()
  if (outcome === undefined) return { entry, ...recorded, reload: { kind: 'not-running' } }
  if (outcome.ok) return { entry, ...recorded, reload: { kind: 'reloaded' } }
  await plan.revert()
  const back = await recordVersion(ctx, plan.wentBack)
  const failed = plan.failed({ at: timeOf(ctx), failure: outcome.error })
  await writeChangeLog(ctx.home, ctx.profile, withEntry(log, failed))
  const again = await reload()
  return { entry: failed, ...recorded, reload: { kind: 'went-back', failure: outcome.error, ...back, ...again === undefined ? {} : { again } } }
}

/**
 * Make a plugin's active directory, the approved record and the active record hold a content version, and go back.
 * @param ctx - the profile.
 * @param state - the records.
 * @param plugin - the package name.
 * @param approval - the plugin's new approval; undefined to remove it, which leaves its active directory empty.
 * @returns the writes and the way back.
 */
async function contentSteps(ctx: ChangesContext, state: State, plugin: string, approval: ApprovedPlugin | undefined): Promise<Pick<Plan, 'write' | 'revert'>> {
  const activeBefore = await readActiveRecord(ctx.home, ctx.profile)
  const directory = activeDirectory(ctx.home, ctx.profile, plugin)
  const before = Object.hasOwn(activeBefore.plugins, plugin) ? activeBefore.plugins[plugin] : undefined
  return {
    write: async () => {
      await holdContent(ctx.home, directory, approval?.version)
      await writeApproved(ctx.profileDir, withApproval(state.approved, plugin, approval))
      await writeActiveRecord(ctx.home, ctx.profile, withActive(activeBefore, plugin, approval === undefined ? undefined : { version: approval.version, kind: 'approved' }))
    },
    revert: async () => {
      await holdContent(ctx.home, directory, before?.version)
      await writeApproved(ctx.profileDir, state.approved)
      await writeActiveRecord(ctx.home, ctx.profile, activeBefore)
    },
  }
}

/**
 * The changes waiting for review, the logged changes, the plugins whose folder is gone, the protection setting and the
 * work session. Reading stores each folder's content, so a later apply finds it; nothing the profile runs changes.
 * @param ctx - the profile.
 * @returns the listing.
 * @throws {ChangesError} when a record of Changes or the profile's manifest is not one Delo wrote, or a folder changed
 *   while it was read.
 */
export async function listChanges(ctx: ChangesContext): Promise<ChangesListing> {
  const protection = await readProtection(ctx.home)
  const state = await readState(ctx)
  const pending = state.changes
    .filter(change => !isDiscarded(state.log, change.id))
    .map((change): ListedChange => {
      const failure = findEntry(state.log, change.id)?.lastFailure
      return failure === undefined ? change : { ...change, lastFailure: failure }
    })
  const requests = state.log.entries.filter(entry => entry.state === 'pending' && isPluginRequest(entry))
  const leftOut = state.log.entries.filter(entry => entry.state === 'left-out-at-start' && leftOutOf(state.log, state.approved, entry.subject.plugin!) === entry).reverse()
  const entries = state.log.entries
    .map((entry, index) => ({ entry, index, at: Date.parse(entry.decidedAt ?? entry.createdAt) }))
    .filter(({ entry }) => !isFolderPending(entry) && !requests.includes(entry) && !leftOut.includes(entry))
    .sort((left, right) => right.at - left.at || right.index - left.index)
    .map(({ entry }) => entry)
  const session = state.workSession
  return {
    protection,
    pending,
    requests,
    leftOut,
    entries,
    missing: state.missing,
    ...session === undefined ? {} : { workSession: { plugin: session.plugin, startedAt: session.startedAt, endsAt: session.endsAt } },
  }
}

/**
 * One change: waiting for review, with its files, diff and risk summary, or logged.
 * @param ctx - the profile.
 * @param id - the change id.
 * @returns the change.
 * @throws {ChangesError} `CHANGED_SINCE_REVIEW` when the folder no longer holds what the id names; `UNKNOWN_CHANGE`
 *   when no change has the id.
 */
export async function showChange(ctx: ChangesContext, id: ChangeId): Promise<ShownChange> {
  const state = await readState(ctx)
  const located = await locate(ctx, state, id)
  if (located.kind === 'logged') return located
  const entry = findEntry(state.log, id)
  if (entry?.state === 'discarded') return { kind: 'logged', entry }
  return { kind: 'pending', change: entry?.lastFailure === undefined ? located.change : { ...located.change, lastFailure: entry.lastFailure } }
}

/**
 * Apply a change: the plugin's approved content becomes exactly what the change showed, its active directory holds it,
 * one history version records it, and the running Host reloads; a failed reload goes back. A plugin turned off or on
 * that failed to load is turned off or on again, and a change a failed start left out loads again.
 * @param ctx - the profile.
 * @param id - the change id the person reviewed.
 * @param presence - proof that the person is at their computer.
 * @param options - the Host's reload.
 * @returns what was done.
 * @throws {ChangesError} `NOT_AT_COMPUTER` for a proof the attest functions did not issue; `CHANGED_SINCE_REVIEW` when
 *   the folder no longer holds what the id names; `UNKNOWN_CHANGE`; `NOT_ALLOWED` for a change already decided or a
 *   plugin in a work session.
 */
export async function applyChange(ctx: ChangesContext, id: ChangeId, presence: AtComputer, options: ReloadOptions): Promise<ActionResult> {
  requirePresence(presence, id)
  return locked(ctx, async () => {
    const state = await readState(ctx)
    const located = await locate(ctx, state, id)
    if (located.kind === 'logged') {
      const { entry } = located
      if (isPluginRequest(entry)) throw new ChangesError('NOT_ALLOWED', id, `Change ${id} installs, updates or removes a plugin the agent asked for; applyInstallChange applies it.`)
      if (entry.state === 'pending') return switchBundle(ctx, state, entry.subject.plugin!, entry.kind === 'plugin-on', presence, options.reload)
      if (entry.state === 'left-out-at-start') return applyLeftOut(ctx, state, entry, presence, options.reload)
      throw new ChangesError('NOT_ALLOWED', id, `Change ${id} is ${entry.state}, so it cannot be applied.`)
    }
    const { change } = located
    refuseInWorkSession(state, change.plugin)
    const at = timeOf(ctx)
    const existing = findEntry(state.log, id)
    const summary = summaryOf(change)
    const pendingEntry: ChangeEntry = {
      id,
      kind: change.kind,
      state: 'pending',
      subject: { plugin: change.plugin, source: change.source },
      ...change.from === undefined ? {} : { from: change.from },
      to: change.to,
      summary,
      createdAt: existing?.createdAt ?? at,
    }
    const steps = await contentSteps(ctx, state, change.plugin, { source: change.source, version: change.to, approvedAt: at })
    return carryOut(ctx, state.log, options.reload, {
      id,
      summary: `Applied ${id}: ${summary}`,
      wentBack: `Went back: ${id} failed to load`,
      ...steps,
      done: recorded => ({ ...pendingEntry, state: 'applied', decidedAt: at, decidedFrom: presence.kind, ...recorded }),
      failed: lastFailure => ({ ...pendingEntry, lastFailure }),
    })
  })
}

/**
 * Discard a change: it never loads, and it is hidden from the changes waiting for review while the folder holds that
 * content. The person's folder is never written.
 * @param ctx - the profile.
 * @param id - the change id.
 * @param presence - proof that the person is at their computer.
 * @returns the discarded entry.
 * @throws {ChangesError} `NOT_AT_COMPUTER` for a proof the attest functions did not issue; `CHANGED_SINCE_REVIEW`;
 *   `UNKNOWN_CHANGE`; `NOT_ALLOWED` for a change that is not pending.
 */
export async function discardChange(ctx: ChangesContext, id: ChangeId, presence: AtComputer): Promise<ChangeEntry> {
  requirePresence(presence, id)
  return locked(ctx, async () => {
    const state = await readState(ctx)
    const located = await locate(ctx, state, id)
    const at = timeOf(ctx)
    let base: ChangeEntry
    if (located.kind === 'logged') {
      if (located.entry.state !== 'pending') throw new ChangesError('NOT_ALLOWED', id, `Change ${id} is ${located.entry.state}, so it cannot be discarded.`)
      base = undecided(located.entry)
    } else {
      const { change } = located
      if (isDiscarded(state.log, id)) throw new ChangesError('NOT_ALLOWED', id, `Change ${id} is discarded already.`)
      base = {
        id,
        kind: change.kind,
        state: 'pending',
        subject: { plugin: change.plugin, source: change.source },
        ...change.from === undefined ? {} : { from: change.from },
        to: change.to,
        summary: summaryOf(change),
        createdAt: findEntry(state.log, id)?.createdAt ?? at,
      }
    }
    const entry: ChangeEntry = { ...base, state: 'discarded', decidedAt: at, decidedFrom: presence.kind }
    await writeChangeLog(ctx.home, ctx.profile, withEntry(state.log, entry))
    return entry
  })
}

/**
 * Undo an applied change, or one a failed start left out: a plugin's approved content goes back to what it was before
 * the change, or the plugin has none after undoing its install, and a plugin turned off is turned on again and the
 * other way round. One history version records it and the running Host reloads; a failed reload goes back and the
 * change stays as it was.
 * @param ctx - the profile.
 * @param id - the change id.
 * @param presence - proof that the person is at their computer.
 * @param options - the Host's reload.
 * @returns what was done.
 * @throws {ChangesError} `NOT_AT_COMPUTER` for a proof the attest functions did not issue; `UNKNOWN_CHANGE` when the
 *   log has no change with the id; `NOT_ALLOWED` for a change that is neither applied nor left out, a later change of the same plugin, a
 *   kind undone another way, or a plugin in a work session.
 */
export async function undoChange(ctx: ChangesContext, id: ChangeId, presence: AtComputer, options: ReloadOptions): Promise<ActionResult> {
  requirePresence(presence, id)
  return locked(ctx, async () => {
    const state = await readState(ctx)
    const entry = findEntry(state.log, id)
    if (entry === undefined) throw new ChangesError('UNKNOWN_CHANGE', id, `No applied change has the id ${id}. See the changes: delorun changes list`)
    if (entry.state !== 'applied' && entry.state !== 'left-out-at-start') throw new ChangesError('NOT_ALLOWED', id, `Change ${id} is ${entry.state}, so there is nothing to undo.`)
    switch (entry.kind) {
      case 'plugin-off':
      case 'plugin-on':
        return switchBundle(ctx, state, entry.subject.plugin!, entry.kind === 'plugin-off', presence, options.reload, entry)
      case 'plugin-edit':
      case 'plugin-install':
        if (!isPluginRequest(entry)) return undoContent(ctx, state, entry, presence, options.reload)
        throw new ChangesError('NOT_ALLOWED', id, `Change ${id} cannot be undone here: ${entry.summary}. Restore the profile version before it with delorun recover.`)
      case 'plugin-update':
      case 'plugin-remove':
      case 'harness-edit':
      case 'guard-weakening':
        throw new ChangesError('NOT_ALLOWED', id, `Change ${id} cannot be undone here: ${entry.summary}.`)
    }
  })
}

/**
 * Apply a change a failed start left out again ([left out](./left-out.ts)): the plugin's active directory holds its
 * approved content again, which for a change of content is the change's `to`, the change is applied, and the running
 * Host reloads; a failed reload goes back and the change stays left out with the failure.
 * @param ctx - the profile.
 * @param state - the records.
 * @param entry - the left-out entry.
 * @param presence - the proof.
 * @param reload - reloads the running Host.
 * @returns what was done.
 * @throws {ChangesError} `NOT_ALLOWED` when the plugin's approved content is no longer what the change applied, or a
 *   work session is open on it.
 */
async function applyLeftOut(ctx: ChangesContext, state: State, entry: ChangeEntry, presence: AtComputer, reload: ReloadHost): Promise<ActionResult> {
  const plugin = entry.subject.plugin!
  refuseInWorkSession(state, plugin)
  const approval = approvedOf(state.approved, plugin)
  if (entry.kind !== 'plugin-on' && approval?.version !== entry.to) {
    throw new ChangesError('NOT_ALLOWED', entry.id, `${plugin} no longer has what change ${entry.id} applied, so there is nothing to apply again. See the changes: delorun changes list`)
  }
  const at = timeOf(ctx)
  const steps = await contentSteps(ctx, state, plugin, approval)
  const { leftOut: _leftOut, lastFailure: _lastFailure, ...applied } = entry
  return carryOut(ctx, state.log, reload, {
    id: entry.id,
    summary: `Applied ${entry.id} again: ${entry.summary}`,
    wentBack: `Went back: ${entry.id} failed to load again`,
    ...steps,
    done: recorded => ({ ...applied, state: 'applied', decidedAt: at, decidedFrom: presence.kind, ...recorded }),
    failed: lastFailure => ({ ...entry, lastFailure }),
  })
}

/**
 * Undo an applied change of a plugin's content.
 * @param ctx - the profile.
 * @param state - the records.
 * @param entry - the applied entry.
 * @param presence - the proof.
 * @param reload - reloads the running Host.
 * @returns what was done.
 * @throws {ChangesError} `NOT_ALLOWED` when the plugin's approved content is no longer what the change applied, or a
 *   work session is open on it.
 */
async function undoContent(ctx: ChangesContext, state: State, entry: ChangeEntry, presence: AtComputer, reload: ReloadHost): Promise<ActionResult> {
  const plugin = entry.subject.plugin!
  refuseInWorkSession(state, plugin)
  const approval = approvedOf(state.approved, plugin)
  if (approval === undefined || approval.version !== entry.to) {
    throw new ChangesError('NOT_ALLOWED', entry.id, `${plugin} no longer runs what change ${entry.id} applied; undo the later change first.`)
  }
  const at = timeOf(ctx)
  const steps = await contentSteps(ctx, state, plugin, entry.from === undefined ? undefined : { source: approval.source, version: entry.from, approvedAt: at })
  return carryOut(ctx, state.log, reload, {
    id: entry.id,
    summary: `Undid ${entry.id}: ${entry.summary}`,
    wentBack: `Went back: undoing ${entry.id} failed to load`,
    ...steps,
    done: () => ({ ...withoutFailure(entry), state: 'undone', decidedAt: at, decidedFrom: presence.kind }),
    failed: lastFailure => ({ ...entry, lastFailure }),
  })
}

/**
 * Turn one plugin off: its package name leaves the profile manifest's `dsh.profile.bundles`, as upstream's plugin
 * manager writes it, keeping the others' order. One history version records it and the running Host reloads; a failed
 * reload goes back.
 * @param ctx - the profile.
 * @param plugin - the package name.
 * @param presence - proof that the person is at their computer.
 * @param options - the Host's reload.
 * @returns what was done.
 * @throws {ChangesError} `NOT_AT_COMPUTER` for a proof the attest functions did not issue; `NOT_ALLOWED` for Delo's own
 *   bundle or a plugin that is not turned on in the profile; `RECORD_UNREADABLE` for a manifest Delo cannot read.
 */
export async function turnOff(ctx: ChangesContext, plugin: string, presence: AtComputer, options: ReloadOptions): Promise<ActionResult> {
  requirePresence(presence, plugin)
  return locked(ctx, async () => switchBundle(ctx, await readState(ctx), plugin, false, presence, options.reload))
}

/**
 * Turn one plugin on again: its package name is appended to the profile manifest's `dsh.profile.bundles`, where
 * upstream's plugin manager appends it. One history version records it and the running Host reloads; a failed reload
 * goes back.
 * @param ctx - the profile.
 * @param plugin - the package name.
 * @param presence - proof that the person is at their computer.
 * @param options - the Host's reload.
 * @returns what was done.
 * @throws {ChangesError} `NOT_AT_COMPUTER` for a proof the attest functions did not issue; `NOT_ALLOWED` for Delo's own
 *   bundle, a plugin that is not a dependency of the profile, or one turned on already; `RECORD_UNREADABLE` for a
 *   manifest Delo cannot read.
 */
export async function turnOn(ctx: ChangesContext, plugin: string, presence: AtComputer, options: ReloadOptions): Promise<ActionResult> {
  requirePresence(presence, plugin)
  return locked(ctx, async () => switchBundle(ctx, await readState(ctx), plugin, true, presence, options.reload))
}

/**
 * @param manifest - the profile's manifest.
 * @param path - its path, for the refusal.
 * @returns `dsh.profile.bundles`; empty when absent.
 * @throws {ChangesError} `RECORD_UNREADABLE` when it is not a list of package names.
 */
function bundlesOf(manifest: JsonObject, path: string): readonly string[] {
  const profile = isJsonObject(manifest.dsh) ? manifest.dsh.profile : undefined
  const bundles = isJsonObject(profile) ? profile.bundles : undefined
  if (bundles === undefined) return []
  if (!Array.isArray(bundles) || !bundles.every(name => typeof name === 'string')) throw new ChangesError('RECORD_UNREADABLE', path, `The profile's dsh.profile.bundles in ${path} is not a list of package names.`)
  return bundles
}

/**
 * Write the profile manifest's bundle list, keeping every other field.
 * @param profileDir - the profile's directory.
 * @param bundles - the list.
 */
async function writeBundles(profileDir: string, bundles: readonly string[]): Promise<void> {
  const manifest = await readProfileManifest(profileDir)
  const dsh = isJsonObject(manifest.dsh) ? manifest.dsh : {}
  const profile = isJsonObject(dsh.profile) ? dsh.profile : {}
  await writeFileAtomic(join(profileDir, 'package.json'), `${JSON.stringify({ ...manifest, dsh: { ...dsh, profile: { ...profile, bundles } } }, undefined, 2)}\n`, { mode: PROTECTED_FILE_MODE })
}

/**
 * Turn a plugin off or on under the lock the caller holds, as a new change or as the undo of an applied one.
 * @param ctx - the profile.
 * @param state - the records.
 * @param plugin - the package name.
 * @param enabled - whether to turn it on.
 * @param presence - the proof.
 * @param reload - reloads the running Host.
 * @param undoing - the applied entry this undoes, when it is an undo.
 * @returns what was done.
 * @throws {ChangesError} `NOT_ALLOWED` for Delo's own bundle, a plugin not in the profile, or one already in that state.
 */
async function switchBundle(ctx: ChangesContext, state: State, plugin: string, enabled: boolean, presence: AtComputer, reload: ReloadHost, undoing?: ChangeEntry): Promise<ActionResult> {
  if (plugin === DELO_BUNDLE) throw new ChangesError('NOT_ALLOWED', plugin, `${DELO_BUNDLE} is Delo's own bundle and stays on; to start without other plugins, use delorun recover safe-mode.`)
  const path = join(ctx.profileDir, 'package.json')
  const manifest = await readProfileManifest(ctx.profileDir)
  const bundles = bundlesOf(manifest, path)
  if (enabled) {
    if (!LINK_SECTIONS.some(section => isJsonObject(manifest[section]) && Object.hasOwn(manifest[section], plugin))) throw new ChangesError('NOT_ALLOWED', plugin, `${plugin} is not a plugin of the profile ${ctx.profile}.`)
    if (bundles.includes(plugin)) throw new ChangesError('NOT_ALLOWED', plugin, `${plugin} is on already.`)
  } else if (!bundles.includes(plugin)) {
    throw new ChangesError('NOT_ALLOWED', plugin, `${plugin} is not turned on in the profile ${ctx.profile}.`)
  }
  const next = enabled ? [...bundles, plugin] : bundles.filter(name => name !== plugin)
  const at = timeOf(ctx)
  const kind = enabled ? 'plugin-on' : 'plugin-off'
  const id = undoing?.id ?? changeId(kind, { plugin }, undefined, undefined)
  const summary = `${enabled ? 'Turned on' : 'Turned off'} ${plugin}`
  const pendingEntry: ChangeEntry = { id, kind, state: 'pending', subject: { plugin }, summary, createdAt: at }
  return carryOut(ctx, state.log, reload, {
    id,
    summary: undoing === undefined ? `${summary} (${id})` : `Undid ${id}: ${undoing.summary}`,
    wentBack: `Went back: ${id} failed to load`,
    write: () => writeBundles(ctx.profileDir, next),
    revert: () => writeBundles(ctx.profileDir, bundles),
    done: recorded => undoing === undefined
      ? { ...pendingEntry, state: 'applied', decidedAt: at, decidedFrom: presence.kind, ...recorded }
      : { ...withoutFailure(undoing), state: 'undone', decidedAt: at, decidedFrom: presence.kind },
    failed: lastFailure => undoing === undefined ? { ...pendingEntry, lastFailure } : { ...undoing, lastFailure },
  })
}

/**
 * Change the protection setting. Only a terminal proof changes it. A weaker level than
 * before is logged in the profile's change log as an applied `guard-weakening` change. The setting is read at the next
 * start.
 * @param ctx - the profile whose log records a weakening.
 * @param level - the new level.
 * @param presence - proof from `attestTerminal`.
 * @returns the level before and after, and the logged entry when the level is weaker.
 * @throws {ChangesError} `NOT_AT_COMPUTER` for a proof {@link attestTerminal} did not issue.
 */
export async function changeProtection(ctx: ChangesContext, level: ProtectionLevel, presence: AtComputer): Promise<ProtectionChange> {
  const before = await readProtection(ctx.home)
  const record = await setProtection(ctx.home, level, presence)
  if (PROTECTION_LEVELS.indexOf(level) <= PROTECTION_LEVELS.indexOf(before)) return { before, level }
  const entry: ChangeEntry = {
    id: changeId('guard-weakening', { setting: 'protection' }, undefined, undefined),
    kind: 'guard-weakening',
    state: 'applied',
    subject: { setting: 'protection' },
    summary: `Protection lowered from ${before} to ${level}`,
    createdAt: record.setAt,
    decidedAt: record.setAt,
    decidedFrom: 'terminal',
  }
  await locked(ctx, async () => {
    await writeChangeLog(ctx.home, ctx.profile, withEntry(await readChangeLog(ctx.home, ctx.profile), entry))
  })
  return { before, level, entry }
}

/**
 * Start a work session on an approved plugin: its folder's content loads live in the running Host until the session
 * ends, at the latest after `minutes` ([work sessions](./work.ts)). The folder's content loads at once; when that
 * fails, the plugin runs its approved content again, the failure is reported and the session stays open.
 * @param ctx - the profile.
 * @param plugin - the package name.
 * @param presence - proof that the person is at their computer, recorded as where the session started.
 * @param options - the Host's reload, and how many minutes the session lasts, from 1 to `WORK_SESSION_MAX_MINUTES`.
 * @returns the session and how the folder's content loaded.
 * @throws {ChangesError} `NOT_AT_COMPUTER` for a proof the attest functions did not issue; `NOT_ALLOWED` for a length
 *   outside that range; `NOT_LINKED` for a plugin the profile does not load from its active directory with approved
 *   content, or whose folder is gone; `WORK_SESSION_OPEN` when the profile has a work session already; `NOT_ALLOWED`
 *   when Delo is not running for the profile, which leaves no session open.
 */
export async function startWork(ctx: ChangesContext, plugin: string, presence: AtComputer, options: ReloadOptions & { readonly minutes: number }): Promise<WorkStarted> {
  requirePresence(presence, plugin)
  return beginWork(ctx, plugin, presence, options.reload, options.minutes)
}

/**
 * End the work session on a plugin at the person's word: exactly the folder's content `done` showed becomes the
 * approved version, as one applied change from the version the session started from and one profile history version.
 * When the running Host does not run that version yet, it loads first, and a failed load approves nothing and leaves
 * the session open.
 * @param ctx - the profile.
 * @param plugin - the package name.
 * @param presence - proof that the person is at their computer.
 * @param options - the Host's reload, and the folder's content the person was shown (`WorkReview.folder` of
 *   `reviewWork`), undefined when the folder was gone, which keeps the approved version.
 * @returns what was done, or the failed load.
 * @throws {ChangesError} `NOT_AT_COMPUTER` for a proof the attest functions did not issue; `NO_WORK_SESSION` when no
 *   work session on the plugin is open; `CHANGED_SINCE_REVIEW` when the folder holds anything other than what was
 *   shown, which approves nothing and leaves the session open.
 */
export async function finishWork(ctx: ChangesContext, plugin: string, presence: AtComputer, options: ReloadOptions & { readonly approve: ContentVersion | undefined }): Promise<WorkDone> {
  requirePresence(presence, plugin)
  return endWork(ctx, plugin, presence.kind, options.reload, options.approve)
}
