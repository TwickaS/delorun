/**
 * A start that fails right after a change starts again without that change (contract C21, "When a start fails").
 *
 * The change a failed start may leave out is the newest decision that changed what the profile runs (an `applied`,
 * `undone` or `left-out-at-start` entry, by `decidedAt`, then by its place in the log), when that decision applied a
 * `plugin-edit`, `plugin-install`, `plugin-update` or `plugin-on` the person made (not an approval at upgrade) to a
 * plugin the profile links to its active directory, whose active directory holds approved content; for a change of
 * content, that content is the change's `to` and the approved version. Any other failed start fails as before, and so
 * does a start after a left-out change, so a run of failures never leaves out more than one change.
 *
 * {@link leaveOutNewestChange} writes only the change log, under the profile write lock: the entry becomes
 * `left-out-at-start` with the failure. It never writes the profile's files. From then on every start makes the plugin's
 * active directory hold the content from before the change, or nothing for an install or a plugin turned on
 * ([enforce](./enforce.ts)), and names the change, until the person applies it again or undoes it ([actions](./actions.ts)).
 * Leaving a change out needs no proof of presence: it only takes back what a person applied, and only a start calls it.
 *
 * @module @delo/changes/left-out
 */
import { resolve } from 'node:path'
import { locked, timeOf } from './action-support.ts'
import type { ChangesContext } from './actions.ts'
import { readLinks } from './link.ts'
import { activeDirectory } from './paths.ts'
import { approvedOf, readActiveRecord, readApproved, readChangeLog, withEntry, writeChangeLog } from './records.ts'
import type { ActiveContent, ActiveRecord, ApprovedRecord, ChangeEntry, ChangeKind, ChangeLog, ChangeState } from './types.ts'

/** The most a left-out change's failure keeps, in bytes of UTF-8. */
export const FAILURE_LIMIT_BYTES = 2048

/** The most of a failure the start's words show, in characters. */
export const FAILURE_SHOWN_CHARACTERS = 200

/** The kinds a failed start may leave out. */
export const LEAVABLE_KINDS: ReadonlySet<ChangeKind> = new Set<ChangeKind>(['plugin-edit', 'plugin-install', 'plugin-update', 'plugin-on'])

/** The states of a decision that changed what the profile runs. */
const RUNNING_DECISIONS: ReadonlySet<ChangeState> = new Set<ChangeState>(['applied', 'undone', 'left-out-at-start'])

/** A change left out at start whose content stays out, as the start, `doctor` and the studio name it. */
export interface LeftOutFact {
  readonly id: ChangeEntry['id']
  readonly plugin: string
  readonly kind: ChangeKind
  /** When the start left it out, ISO 8601. */
  readonly at: string
  /** What the start failed with. */
  readonly failure: string
}

/** The records that decide which change a failed start leaves out. */
export interface LeavableRecords {
  readonly log: ChangeLog
  readonly approved: ApprovedRecord
  readonly active: ActiveRecord
  /** The plugins the profile links to their active directories. */
  readonly linked: ReadonlySet<string>
}

/**
 * @param entries - log entries.
 * @param include - which entries count.
 * @returns the counted entry decided last, the later one in the log on a tie; undefined when none counts.
 */
function newestDecided(entries: readonly ChangeEntry[], include: (entry: ChangeEntry) => boolean): ChangeEntry | undefined {
  let newest: ChangeEntry | undefined
  let newestAt = Number.NEGATIVE_INFINITY
  for (const entry of entries) {
    if (entry.decidedAt === undefined || !include(entry)) continue
    const at = Date.parse(entry.decidedAt)
    if (at >= newestAt) {
      newest = entry
      newestAt = at
    }
  }
  return newest
}

/**
 * @param plugins - an active record's plugins.
 * @param plugin - a package name.
 * @returns what the plugin's active directory holds, or undefined.
 */
function activeOf(plugins: ActiveRecord['plugins'], plugin: string): ActiveContent | undefined {
  return Object.hasOwn(plugins, plugin) ? plugins[plugin] : undefined
}

/**
 * The change a failed start leaves out, from records already read. Nothing is written.
 * @param records - the change log, the approved and active records, and the plugins linked to their active directories.
 * @returns the applied entry, or undefined when the failed start leaves nothing out.
 */
export function leavableIn(records: LeavableRecords): ChangeEntry | undefined {
  const entry = newestDecided(records.log.entries, candidate => RUNNING_DECISIONS.has(candidate.state))
  if (entry?.state !== 'applied' || !LEAVABLE_KINDS.has(entry.kind) || entry.decidedFrom === 'upgrade') return undefined
  const plugin = entry.subject.plugin
  if (plugin === undefined || !records.linked.has(plugin)) return undefined
  const active = activeOf(records.active.plugins, plugin)
  if (active?.kind !== 'approved') return undefined
  if (entry.kind === 'plugin-on') return entry
  return entry.to !== undefined && active.version === entry.to && approvedOf(records.approved, plugin)?.version === entry.to ? entry : undefined
}

/**
 * The change a failed start of the profile leaves out. Nothing is written.
 * @param ctx - the profile.
 * @returns the applied entry, or undefined when the failed start leaves nothing out.
 * @throws {ChangesError} `RECORD_UNREADABLE` when a record of Changes or the profile's manifest is not one Delo wrote.
 */
export async function newestLeavableChange(ctx: Pick<ChangesContext, 'home' | 'profile' | 'profileDir'>): Promise<ChangeEntry | undefined> {
  const linked = new Set((await readLinks(ctx.profileDir)).filter(link => resolve(link.target) === resolve(activeDirectory(ctx.home, ctx.profile, link.name))).map(link => link.name))
  return leavableIn({ log: await readChangeLog(ctx.home, ctx.profile), approved: await readApproved(ctx.profileDir), active: await readActiveRecord(ctx.home, ctx.profile), linked })
}

/**
 * @param failure - an error's message.
 * @returns it cut to at most {@link FAILURE_LIMIT_BYTES} bytes of UTF-8, at a character's end.
 */
export function boundedFailure(failure: string): string {
  let bytes = 0
  let kept = ''
  for (const character of failure) {
    bytes += Buffer.byteLength(character)
    if (bytes > FAILURE_LIMIT_BYTES) break
    kept += character
  }
  return kept
}

/**
 * Leave the newest change out after a failed start: under the profile write lock, its entry becomes
 * `left-out-at-start` with the failure, decided from `start`. Only the change log is written; the next start makes the
 * plugin's active directory hold what it held before the change.
 * @param ctx - the profile, the clock and the lock wait.
 * @param failure - the failed start's error message, without a stack; kept to {@link FAILURE_LIMIT_BYTES}.
 * @returns the entry as it now stands, or undefined when the failed start leaves nothing out.
 * @throws {ChangesError} `RECORD_UNREADABLE` when a record of Changes or the profile's manifest is not one Delo wrote.
 */
export async function leaveOutNewestChange(ctx: ChangesContext, failure: string): Promise<ChangeEntry | undefined> {
  return locked(ctx, async () => {
    const entry = await newestLeavableChange(ctx)
    if (entry === undefined) return undefined
    const at = timeOf(ctx)
    const { lastFailure: _lastFailure, ...applied } = entry
    const left: ChangeEntry = { ...applied, state: 'left-out-at-start', decidedAt: at, decidedFrom: 'start', leftOut: { at, failure: boundedFailure(failure) } }
    await writeChangeLog(ctx.home, ctx.profile, withEntry(await readChangeLog(ctx.home, ctx.profile), left))
    return left
  })
}

/**
 * The change left out of a plugin that stays out: its newest `left-out-at-start` entry, when the change turned the
 * plugin on, or the plugin's approved version is still the change's `to`.
 * @param log - the change log.
 * @param approved - the approved record.
 * @param plugin - a package name.
 * @returns the entry, or undefined when nothing of the plugin is left out.
 */
export function leftOutOf(log: ChangeLog, approved: ApprovedRecord, plugin: string): ChangeEntry | undefined {
  return newestDecided(log.entries, entry => entry.state === 'left-out-at-start' && entry.subject.plugin === plugin
    && (entry.kind === 'plugin-on' || (entry.to !== undefined && approvedOf(approved, plugin)?.version === entry.to)))
}

/**
 * @param entry - a change left out at start.
 * @returns what the plugin's active directory holds while it stays out: the content from before the change, or nothing
 *   for an install or a plugin turned on.
 */
export function leftOutContent(entry: ChangeEntry): ActiveContent {
  return entry.kind !== 'plugin-on' && entry.from !== undefined ? { version: entry.from, kind: 'left-out' } : { kind: 'left-out' }
}

/**
 * @param entry - a change left out at start.
 * @returns the fact the start, `doctor` and the studio name.
 */
export function leftOutFact(entry: ChangeEntry): LeftOutFact {
  return { id: entry.id, plugin: entry.subject.plugin ?? '', kind: entry.kind, at: entry.leftOut?.at ?? entry.decidedAt ?? entry.createdAt, failure: entry.leftOut?.failure ?? '' }
}

/**
 * The changes left out whose content stays out now: for each plugin whose active directory holds `left-out` content,
 * the newest change left out of it that holds that content.
 * @param log - the change log.
 * @param active - the active record.
 * @returns the facts, by plugin in the record's order.
 */
export function leftOutNow(log: ChangeLog, active: ActiveRecord): LeftOutFact[] {
  return Object.entries(active.plugins).flatMap(([plugin, content]) => {
    if (content.kind !== 'left-out') return []
    const entry = newestDecided(log.entries, candidate => candidate.state === 'left-out-at-start' && candidate.subject.plugin === plugin && leftOutContent(candidate).version === content.version)
    return entry === undefined ? [] : [leftOutFact(entry)]
  })
}

/**
 * The change the newest failed start left out, whether or not it stays out.
 * @param home - the Delo home.
 * @param profile - the profile's name.
 * @returns the fact, or undefined when no start left a change out.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the change log is not one Delo wrote.
 */
export async function lastLeftOut(home: string, profile: string): Promise<LeftOutFact | undefined> {
  const entry = newestDecided((await readChangeLog(home, profile)).entries, candidate => candidate.state === 'left-out-at-start' && candidate.decidedFrom === 'start')
  return entry === undefined ? undefined : leftOutFact(entry)
}

/**
 * @param failure - a failure message.
 * @returns it as one line without a final full stop, cut at {@link FAILURE_SHOWN_CHARACTERS} characters.
 */
function shownFailure(failure: string): string {
  const line = failure.replace(/\s*\n\s*/gu, ' ').trim().replace(/\.+$/u, '')
  return line.length <= FAILURE_SHOWN_CHARACTERS ? line : `${line.slice(0, FAILURE_SHOWN_CHARACTERS)}…`
}

/**
 * The words that name a change a failed start left out: what failed, that Delo starts without it, and how to apply or
 * undo it, on three lines. The caller escapes them for the terminal.
 * @param fact - the change.
 * @returns the lines, joined by line breaks, without a final one.
 */
export function leftOutWords(fact: Pick<LeftOutFact, 'id' | 'plugin' | 'failure'>): string {
  return [
    `Delo did not start with your latest change to ${fact.plugin} (${fact.id}): ${shownFailure(fact.failure)}.`,
    'It starts without it now; your files are unchanged.',
    `To try it again: delorun changes apply ${fact.id}. To undo it: delorun changes undo ${fact.id}.`,
  ].join('\n')
}

/** The words of a start that failed again after it left a change out. */
export const SECOND_FAILURE_LINE = 'Delo did not start again. Start without third-party plugins: delorun recover safe-mode, then delorun start.'
