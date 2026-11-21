/**
 * The prepared update the Host holds and what the page may see of it (contract C3, "Applying an update"): the home
 * process's report id and the report stay in Host memory, the page gets an opaque handle, and the tick keys the page
 * must return are derived from the same rule the terminal's `--yes` uses ({@link confirmationNeeds}).
 *
 * @module @delorun/plugin-update/report-view
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { REPORT_LIFETIME_MS } from '@delorun/contract-home-process'
import { UPDATE_REPORT_SCHEMA, type UpdateKind, type UpdateReport } from '@delorun/contract-update-report'
import { confirmationNeeds } from '@delorun/update'
import semver from 'semver'
import type { PreparedUpdateView, UpdateConfirmView } from './wire.ts'

/** The tick key of an item of the report. */
export const itemTick = (index: number): string => `item:${String(index)}`

/** The tick key of a release the release channel could not confirm is current. */
export const FRESHNESS_TICK = 'freshness'

/** The tick key of a release whose log check did not complete. */
export const LOG_TICK = 'log'

/** The tick key of declining the copy of chat data that changes format. */
export const NO_COPY_TICK = 'data-no-copy'

/** A prepared update as the Host holds it. */
export interface HeldUpdate {
  /** The opaque handle the page applies with. */
  readonly handle: string
  /** The home process's report id; never leaves the Host. */
  readonly reportId: string
  /** The report. */
  readonly report: UpdateReport
  /** When the home process drops the report, in milliseconds since the epoch. */
  readonly expiresAt: number
  /** What the page must tick, and whether the report can be confirmed. */
  readonly confirm: UpdateConfirmView
}

/**
 * @param value - the report line of `update.prepare`'s answer.
 * @returns whether it is a report of the format this Host reads.
 */
export function isUpdateReport(value: unknown): value is UpdateReport {
  return typeof value === 'object' && value !== null && (value as { schema?: unknown }).schema === UPDATE_REPORT_SCHEMA && Array.isArray((value as { items?: unknown }).items)
}

/**
 * What the page must tick before `apply` accepts the report.
 * @param report - the report.
 * @returns the tick keys, whether the report can be confirmed at all, and the data item's index.
 */
export function confirmOf(report: UpdateReport): UpdateConfirmView {
  const needs = confirmationNeeds(report)
  const ticks = [...needs.items.map(itemTick), ...needs.freshness ? [FRESHNESS_TICK] : [], ...needs.log && report.release.log === 'unchecked' ? [LOG_TICK] : []]
  const dataItem = report.items.findIndex(item => item.kind === 'data')
  const conflicted = report.items.some(item => item.reason === 'harness-change-conflicts')
  const blocked = conflicted ? 'harness-conflict' : report.release.log === 'failed' ? 'log-failed' : undefined
  return { ticks, ...blocked === undefined ? {} : { blocked }, ...dataItem === -1 ? {} : { dataItem } }
}

/**
 * Hold a prepared update.
 * @param reportId - the home process's report id.
 * @param report - the report.
 * @param now - the time, in milliseconds since the epoch.
 * @returns the held update with a fresh handle.
 */
export function hold(reportId: string, report: UpdateReport, now: number): HeldUpdate {
  return { handle: randomBytes(16).toString('hex'), reportId, report, expiresAt: now + REPORT_LIFETIME_MS, confirm: confirmOf(report) }
}

/**
 * @param held - the update the Host holds, if any.
 * @param handle - what the page sent.
 * @param now - the time, in milliseconds since the epoch.
 * @returns whether the handle names the held, unexpired update.
 */
export function holds(held: HeldUpdate | undefined, handle: unknown, now: number): held is HeldUpdate {
  if (held === undefined || typeof handle !== 'string' || held.expiresAt <= now) return false
  const a = Buffer.from(held.handle)
  const b = Buffer.from(handle)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The tick keys an apply still lacks.
 * @param held - the held update.
 * @param acknowledged - the keys the page sent.
 * @param dataCopy - whether the page chose the copy of chat data.
 * @returns the missing keys, in the order the page asks for them.
 */
export function missingTicks(held: HeldUpdate, acknowledged: readonly string[], dataCopy: boolean): readonly string[] {
  const given = new Set(acknowledged)
  const needed = [...held.confirm.ticks, ...!dataCopy && held.confirm.dataItem !== undefined ? [NO_COPY_TICK] : []]
  return needed.filter(key => !given.has(key))
}

/**
 * How far a release moves.
 * @param from - the running Delorun version.
 * @param to - the target's.
 * @returns `major`, `minor` or `patch`; a pre-release counts as the step it leads to.
 */
export function kindOf(from: string, to: string): UpdateKind {
  const step = semver.diff(from, to)
  if (step === 'major' || step === 'premajor') return 'major'
  if (step === 'minor' || step === 'preminor') return 'minor'
  return 'patch'
}

/**
 * The page's view of a held update.
 * @param held - the held update.
 * @param running - the running Delorun version.
 * @param releaseNote - the release's one-line summary, when the check verified one.
 * @param runningChats - the chats running now.
 * @returns the view, without the report id.
 */
export function viewOf(held: HeldUpdate, running: string, releaseNote: string | undefined, runningChats: number): PreparedUpdateView {
  return {
    handle: held.handle, expiresAt: held.expiresAt, report: held.report, kind: kindOf(running, held.report.to.delorun), confirm: held.confirm, runningChats,
    ...releaseNote === undefined ? {} : { releaseNote },
  }
}
