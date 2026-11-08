/**
 * The release-log check state of each installed release (contract C18, `Check states`): `verified`, `unchecked` or
 * `failed`, with the refusal when it failed, the time of the last attempt and the verified checkpoint the attempt
 * reached. `delorun verify`, `delorun status` and the studio's Verification panel show the state with the release's
 * version, and a start records it, so a restart reads what the last check found instead of starting blank.
 *
 * @module @delo/release-verify/state
 */
import type { ReleaseLogCheck, ReleaseLogCheckState, ReleaseLogFailure } from '@delo/contract-release-log'
import type { SemanticVersion } from '@delo/contract-release-manifest'
import { z } from 'zod'
import { contractFailureOf, RELEASE_LOG_REFUSALS, refuse, type ReleaseLogRefusal } from './errors.ts'
import { parseStrictJson } from './json.ts'

/** The `schema` value of the check state record. */
export const RELEASE_LOG_STATE_SCHEMA = 'delo.release-log-state/1'

/** The size limit of the check state record: one entry per installed release, a few hundred bytes each. */
export const RELEASE_LOG_STATE_SIZE_LIMIT = 32 * 1024

/** One release's recorded state: the contract's record, with the finer refusal this client made. */
export interface RecordedCheck extends ReleaseLogCheck {
  /** Present when the state is `failed`: which check refused. */
  readonly refusal?: ReleaseLogRefusal
  /** Present when the state is `failed`: what the check saw. */
  readonly detail?: string
}

/**
 * A record under assembly: the same fields as {@link RecordedCheck}, with the optional ones set only when a check found
 * them, because `exactOptionalPropertyTypes` distinguishes an absent field from one holding `undefined`.
 */
interface DraftRecord {
  release: SemanticVersion
  state: ReleaseLogCheckState
  lastAttempt: number
  failure?: ReleaseLogFailure
  refusal?: ReleaseLogRefusal
  detail?: string
}

const REFUSALS: ReadonlySet<string> = new Set(RELEASE_LOG_REFUSALS)

const RefusalSchema = z.string().refine((value): value is ReleaseLogRefusal => REFUSALS.has(value), 'not a refusal this client makes')

const RecordedSchema = z.strictObject({
  release: z.string().min(1),
  state: z.enum(['verified', 'unchecked', 'failed']),
  failure: z.string().optional(),
  refusal: RefusalSchema.optional(),
  detail: z.string().optional(),
  lastAttempt: z.number().int().min(0),
})

const StateSchema = z.strictObject({
  schema: z.literal(RELEASE_LOG_STATE_SCHEMA),
  releases: z.record(z.string().min(1), RecordedSchema),
})

/**
 * Read the check state record.
 * @param bytes - the file's bytes.
 * @returns one entry per release.
 * @throws ReleaseLogRefusalError `check-state-invalid` when the record is above {@link RELEASE_LOG_STATE_SIZE_LIMIT}, is
 * not strict JSON or does not match the record's schema. An unreadable record is refused as a whole, so a caller reads
 * no state at all rather than a state it cannot trust, and the next check runs as the first one.
 */
export function readCheckState(bytes: Uint8Array): Map<string, RecordedCheck> {
  const parsed = StateSchema.safeParse(parseStrictJson(bytes, RELEASE_LOG_STATE_SIZE_LIMIT, 'check-state-invalid', 'check-state-invalid'))
  if (!parsed.success) throw refuse('check-state-invalid', `the release-log state record does not match its schema: ${z.prettifyError(parsed.error).replaceAll('\n', '; ')}`)
  const state = new Map<string, RecordedCheck>()
  for (const [release, entry] of Object.entries(parsed.data.releases)) {
    const record: DraftRecord = { release: entry.release as SemanticVersion, state: entry.state as ReleaseLogCheckState, lastAttempt: entry.lastAttempt }
    if (entry.failure !== undefined) record.failure = entry.failure as ReleaseLogFailure
    if (entry.refusal !== undefined) record.refusal = entry.refusal
    if (entry.detail !== undefined) record.detail = entry.detail
    state.set(release, record)
  }
  return state
}

/**
 * Write the check state record, with the releases in version order.
 * @param state - one entry per release.
 * @returns the file's text, ending with a newline.
 */
export function serializeCheckState(state: ReadonlyMap<string, RecordedCheck>): string {
  const releases: Record<string, RecordedCheck> = {}
  for (const version of [...state.keys()].sort()) releases[version] = state.get(version)!
  return `${JSON.stringify({ schema: RELEASE_LOG_STATE_SCHEMA, releases }, null, 2)}\n`
}

/**
 * The record of one attempt.
 * @param release - the release's version.
 * @param state - what the attempt found.
 * @param lastAttempt - Unix seconds of the attempt.
 * @param refusal - the refusal, when the attempt failed.
 * @param detail - what the check saw, when the attempt failed.
 * @returns the record, carrying the contract's failure class when the refusal has one.
 */
export function recorded(release: string, state: ReleaseLogCheckState, lastAttempt: number, refusal?: ReleaseLogRefusal, detail?: string): RecordedCheck {
  const failure = refusal === undefined ? undefined : contractFailureOf(refusal)
  const record: DraftRecord = { release: release as SemanticVersion, state, lastAttempt }
  if (failure !== undefined) record.failure = failure
  if (refusal !== undefined) record.refusal = refusal
  if (detail !== undefined) record.detail = detail
  return record
}
