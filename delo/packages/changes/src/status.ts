/**
 * What `delorun verify` and `delorun doctor` report about Changes for one profile: the protection setting, the approved
 * plugins, the pending changes, the plugins running content the person did not approve, the work session, the
 * invariants that do not hold ([invariants](./invariants.ts)), the record of the last start
 * ([boot record](./boot-record.ts)) and of the last failed reload in a work session ([work record](./work-record.ts)).
 *
 * Nothing is written: a folder is scanned without the scan cache and nothing is copied into the store, so a pending
 * change carries its id only when the store already holds the folder's content (a start stored it); otherwise
 * `delorun changes list` stores it and shows the id. A record that cannot be read becomes a broken invariant, except
 * the boot record, which only `doctor` reads.
 *
 * @module @delo/changes/status
 */
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { managedPlugins, readBootRecord, type BootRecord } from './boot-record.ts'
import { namesDirectory } from './enforce.ts'
import { isChangesError } from './errors.ts'
import { changeId } from './ids.ts'
import { checkChangesInvariants, type InvariantRequest } from './invariants.ts'
import { leftOutNow, type LeftOutFact } from './left-out.ts'
import { versionsDirectory } from './paths.ts'
import { approvedOf, readActiveRecord, readApproved, readChangeLog, readProtection, readWorkSession, unshownAtUpgrade } from './records.ts'
import { compareCodeUnits, scanFolder, versionOf } from './tree.ts'
import { readWorkFailure, type WorkFailureRecord } from './work-record.ts'
import {
  ACTIVE_RECORD_SCHEMA,
  APPROVED_RECORD_SCHEMA,
  CHANGE_LOG_SCHEMA,
  type ActiveContent,
  type ChangeEntry,
  type ChangeId,
  type ContentVersion,
  type ProtectionLevel,
} from './types.ts'

/** The profile whose Changes are reported, and the harness's own links. */
export type ChangesStatusRequest = InvariantRequest

/** One approved plugin. */
export interface ApprovedStatus {
  readonly plugin: string
  /** The folder it is linked from. */
  readonly source: string
  /** When it was approved, ISO 8601. */
  readonly approvedAt: string
  /** Whether the first start under Changes approved it as it was. */
  readonly approvedAtUpgrade: boolean
}

/** A plugin's folder that differs from its approved content. */
export interface PendingStatus {
  /** The change's id; absent when the store does not hold the folder's content yet. */
  readonly id?: ChangeId
  readonly plugin: string
  /** The folder. */
  readonly source: string
  readonly kind: 'plugin-edit' | 'plugin-install'
}

/** The newest applied change of a plugin. */
export interface AppliedStatus {
  readonly id: ChangeId
  /** Its one line in the person's words. */
  readonly summary: string
  /** When it was applied, ISO 8601. */
  readonly at: string
}

/** One plugin under Changes, for `doctor`'s line per plugin. */
export interface PluginStatus {
  readonly plugin: string
  /** The folder it is linked from. */
  readonly source: string
  /** Its approved content; absent for a plugin waiting for review as an install. */
  readonly approved?: ContentVersion
  /** What its active directory holds; absent when it holds nothing. */
  readonly active?: ActiveContent
  /** The newest applied change of it. */
  readonly lastApplied?: AppliedStatus
}

/** What both commands report. */
export interface ChangesStatus {
  /** The protection setting; absent when its record cannot be read, which {@link ChangesStatus.invariants} names. */
  readonly protection?: ProtectionLevel
  /** The approved plugins, by name. */
  readonly approved: readonly ApprovedStatus[]
  /** How many changes in the log are applied. */
  readonly appliedCount: number
  /** The plugins whose folder differs from their approved content, by name. */
  readonly pending: readonly PendingStatus[]
  /** The plugins whose active content is of kind `unapproved` (under `warn` or `off`), by name. */
  readonly unapproved: readonly { readonly plugin: string }[]
  /** The open work session. */
  readonly workSession?: { readonly plugin: string, readonly source: string, readonly startedAt: string }
  /** One line per invariant that does not hold, and per record or folder that cannot be read. */
  readonly invariants: readonly string[]
  /** The plugins the first start under Changes approved as they were and no terminal has shown yet, oldest first. */
  readonly unshownAtUpgrade: readonly { readonly plugin: string, readonly source: string }[]
  /** Every plugin under Changes, by name. */
  readonly plugins: readonly PluginStatus[]
  /** The changes a failed start left out whose content stays out ({@link leftOutFacts}). */
  readonly leftOut: readonly LeftOutFact[]
  /** The record of the last start, when one was written. */
  readonly boot?: BootRecord
  /** Why the record of the last start cannot be read, when it cannot. */
  readonly bootUnreadable?: string
  /** The last failed reload in a work session, while its record is kept. */
  readonly workFailure?: WorkFailureRecord
  /** Why the record of the last failed reload in a work session cannot be read, when it cannot. */
  readonly workFailureUnreadable?: string
}

/** The open work session, as `delorun status` and the studio's badge show it. */
export interface WorkSessionFact {
  /** The plugin whose folder loads live. */
  readonly plugin: string
  /** Its folder. */
  readonly source: string
  /** When the session started, ISO 8601. */
  readonly startedAt: string
  /** When it ends without the person, ISO 8601. */
  readonly endsAt: string
  /** The last reload of the folder's content that failed, while Delo runs the content that last loaded instead. */
  readonly lastError?: { readonly at: string, readonly error: string }
}

/**
 * @param error - a thrown value.
 * @returns its words for the person.
 */
function detailOf(error: unknown): string {
  return isChangesError(error) ? error.detail : String(error)
}

/**
 * Run one read; a failure gives the fallback, and its words to `onFailure`.
 * @param read - the read.
 * @param fallback - what a failed read gives.
 * @param onFailure - receives the failure's words.
 * @returns what the read returned, or the fallback.
 */
async function orElse<T>(read: () => Promise<T>, fallback: T, onFailure: (detail: string) => void = () => {}): Promise<T> {
  try {
    return await read()
  } catch (error) {
    onFailure(detailOf(error))
    return fallback
  }
}

/**
 * @param path - a path.
 * @returns whether something is there that this process can reach.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (_absent) {
    // Missing or not reachable: the store does not hold it for this reader.
    return false
  }
}

/**
 * @param entries - the change log's entries.
 * @param plugin - a package name.
 * @returns the plugin's applied change with the latest decision, or undefined.
 */
function lastAppliedOf(entries: readonly ChangeEntry[], plugin: string): AppliedStatus | undefined {
  let last: AppliedStatus | undefined
  for (const entry of entries) {
    if (entry.state !== 'applied' || entry.subject.plugin !== plugin) continue
    const at = entry.decidedAt ?? entry.createdAt
    if (last === undefined || at >= last.at) last = { id: entry.id, summary: entry.summary, at }
  }
  return last
}

/**
 * Report Changes for one profile. Nothing is written.
 * @param request - the home, the profile, its directory and the harness's own links.
 * @returns the report.
 */
export async function changesStatus(request: ChangesStatusRequest): Promise<ChangesStatus> {
  const { home, profile, profileDir } = request
  const invariants = [...await checkChangesInvariants(request)]
  const protection = await orElse<ProtectionLevel | undefined>(() => readProtection(home), undefined)
  const approved = await orElse(() => readApproved(profileDir), { schema: APPROVED_RECORD_SCHEMA, plugins: {} })
  const active = await orElse(() => readActiveRecord(home, profile), { schema: ACTIVE_RECORD_SCHEMA, plugins: {} })
  const workSession = await orElse(() => readWorkSession(home, profile), undefined)
  // The invariants name a change log that cannot be read.
  const log = await orElse(() => readChangeLog(home, profile), { schema: CHANGE_LOG_SCHEMA, entries: [] })
  let bootUnreadable: string | undefined
  const boot = await orElse(() => readBootRecord(home, profile), undefined, detail => { bootUnreadable = detail })
  let workFailureUnreadable: string | undefined
  const workFailure = await orElse(() => readWorkFailure(home, profile), undefined, detail => { workFailureUnreadable = detail })

  const pending: PendingStatus[] = []
  const plugins: PluginStatus[] = []
  for (const { plugin, source } of managedPlugins(approved, log)) {
    const approvedVersion = approvedOf(approved, plugin)?.version
    const content = Object.hasOwn(active.plugins, plugin) ? active.plugins[plugin] : undefined
    const lastApplied = lastAppliedOf(log.entries, plugin)
    plugins.push({
      plugin,
      source,
      ...approvedVersion === undefined ? {} : { approved: approvedVersion },
      ...content === undefined ? {} : { active: content },
      ...lastApplied === undefined ? {} : { lastApplied },
    })
    const folder = await orElse(async () => await namesDirectory(source) ? versionOf((await scanFolder(source, { home })).entries) : undefined, undefined, detail => invariants.push(`The folder of ${plugin} cannot be read: ${detail}`))
    if (folder === undefined || folder === approvedVersion) continue
    const kind = approvedVersion === undefined ? 'plugin-install' : 'plugin-edit'
    const stored = await exists(join(versionsDirectory(home), `${folder}.json`))
    pending.push({ ...stored ? { id: changeId(kind, { plugin, source }, approvedVersion, folder) } : {}, plugin, source, kind })
  }

  return {
    ...protection === undefined ? {} : { protection },
    approved: Object.entries(approved.plugins)
      .map(([plugin, approval]): ApprovedStatus => ({ plugin, source: approval.source, approvedAt: approval.approvedAt, approvedAtUpgrade: approval.approvedAtUpgrade === true }))
      .sort((a, b) => compareCodeUnits(a.plugin, b.plugin)),
    appliedCount: log.entries.filter(entry => entry.state === 'applied').length,
    pending,
    unapproved: plugins.filter(entry => entry.active?.kind === 'unapproved').map(({ plugin }) => ({ plugin })),
    ...workSession === undefined ? {} : { workSession: { plugin: workSession.plugin, source: workSession.source, startedAt: workSession.startedAt } },
    invariants,
    unshownAtUpgrade: log.entries.flatMap(entry => unshownAtUpgrade(entry) && entry.subject.plugin !== undefined && entry.subject.source !== undefined ? [{ plugin: entry.subject.plugin, source: entry.subject.source }] : []),
    plugins,
    leftOut: leftOutNow(log, active),
    ...boot === undefined ? {} : { boot },
    ...bootUnreadable === undefined ? {} : { bootUnreadable },
    ...workFailure === undefined ? {} : { workFailure },
    ...workFailureUnreadable === undefined ? {} : { workFailureUnreadable },
  }
}

/**
 * The open work session for `delorun status` and the studio's badge, with its end time and the last failed reload of its plugin while one is recorded.
 * Nothing is written.
 * @param home - the Delo home.
 * @param profile - the profile's name.
 * @returns the session, or undefined when none is open.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the work-session record or the record of the last failed reload is not
 *   one Delo wrote.
 */
export async function workSessionFact(home: string, profile: string): Promise<WorkSessionFact | undefined> {
  const session = await readWorkSession(home, profile)
  if (session === undefined) return undefined
  const failure = await readWorkFailure(home, profile)
  const { plugin, source, startedAt, endsAt } = session
  return { plugin, source, startedAt, endsAt, ...failure?.plugin === plugin ? { lastError: { at: failure.at, error: failure.error } } : {} }
}

/**
 * The changes a failed start left out whose content stays out, for the studio and `delorun status`: for each plugin
 * whose active directory holds `left-out` content, the change that left it out ([left out](./left-out.ts)). Nothing is
 * written.
 * @param home - the Delo home.
 * @param profile - the profile's name.
 * @returns the facts; empty when nothing is left out.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the change log or the active record is not one Delo wrote.
 */
export async function leftOutFacts(home: string, profile: string): Promise<LeftOutFact[]> {
  return leftOutNow(await readChangeLog(home, profile), await readActiveRecord(home, profile))
}

/**
 * How many changes the person has not approved are present: each pending change, and each plugin running unapproved
 * content that no pending change already names.
 * @param status - the report.
 * @returns the count.
 */
export function notApprovedCount(status: Pick<ChangesStatus, 'pending' | 'unapproved'>): number {
  return status.pending.length + status.unapproved.filter(({ plugin }) => !status.pending.some(change => change.plugin === plugin)).length
}
