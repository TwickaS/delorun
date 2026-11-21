/**
 * The outcome record `run/<profile>/update-result.json` (contract C19, "The outcome record"): how the last update or
 * rollback ended, written by the home process at every end so a page that lost its connection to the switch, and the
 * Host that runs afterwards, can say what happened. The next update or rollback removes it when it starts, and the
 * person's dismissal removes it. A record that is missing or unreadable reads as none: the outcome record never
 * decides anything, it only reports.
 *
 * @module @delorun/home-process/update-result
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RUN_ENTRIES, RUNTIME_VERSION_PATTERN, type RuntimeVersion } from '@delorun/contract-home-layout'
import type { HomeProcessErrorCode, UpdateOutcome } from '@delorun/contract-home-process'
import { readProtectedFile, runDirectory, writeProtectedFile } from '@delorun/home'
import { z } from 'zod'

/** Contents of `update-result.json`. */
export interface UpdateResultRecord {
  /** Record version. */
  readonly v: 1
  /** Whether an update or the person's rollback ended. */
  readonly kind: 'update' | 'rollback'
  /** How it ended. */
  readonly outcome: UpdateOutcome
  /** The version that ran before. */
  readonly from: RuntimeVersion
  /** The version the attempt moved to. */
  readonly to: RuntimeVersion
  /** The refusal or failure code, for an outcome other than `committed`. */
  readonly reason?: HomeProcessErrorCode
  /** The first health criterion the target failed, such as `H2-host-ready`. */
  readonly criterion?: string
  /** RFC 3339 UTC time it ended. */
  readonly at: string
  /**
   * Plain-words sentences on the protected-row changes the new release's own bundles brought, which the update's health
   * check accepted because the running release's report could not name them; added by the successor after it took over.
   */
  readonly rowChanges?: readonly string[]
}

const version = z.string().regex(new RegExp(RUNTIME_VERSION_PATTERN))
const resultSchema = z.strictObject({
  v: z.literal(1),
  kind: z.enum(['update', 'rollback']),
  outcome: z.enum(['committed', 'rolled-back', 'aborted', 'failed']),
  from: version,
  to: version,
  reason: z.string().min(1).max(64).optional(),
  criterion: z.string().min(1).max(64).optional(),
  at: z.string().datetime(),
  rowChanges: z.array(z.string().max(600)).max(32).optional(),
})

/**
 * @param home - the resolved Delorun home.
 * @param profile - the CLI profile.
 * @returns `<home>/run/<profile>/update-result.json`.
 */
export function updateResultPath(home: string, profile: string): string {
  return join(runDirectory(home, profile), RUN_ENTRIES.updateResult)
}

/**
 * Write the record, mode 0600, replacing an earlier one.
 * @param path - {@link updateResultPath}.
 * @param record - the record.
 */
export async function writeUpdateResult(path: string, record: UpdateResultRecord): Promise<void> {
  await writeProtectedFile(path, `${JSON.stringify(record)}\n`)
}

/**
 * Read the record through C1's protected-file check.
 * @param path - {@link updateResultPath}.
 * @returns the record, or `undefined` when none exists or the file is not one this module wrote.
 */
export async function readUpdateResult(path: string): Promise<UpdateResultRecord | undefined> {
  let bytes: Buffer
  try {
    bytes = await readProtectedFile(path)
  } catch (_unreadable) {
    // Absent is the normal case; a laxer, linked or foreign file is not trusted either, and the record only reports.
    return undefined
  }
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch (_notJson) {
    // Not a record this module wrote: it reads as none.
    return undefined
  }
  const parsed = resultSchema.safeParse(value)
  if (!parsed.success) return undefined
  const data = parsed.data
  return {
    v: 1, kind: data.kind, outcome: data.outcome, from: brandString<RuntimeVersion>(data.from), to: brandString<RuntimeVersion>(data.to), at: data.at,
    ...data.reason === undefined ? {} : { reason: data.reason as HomeProcessErrorCode },
    ...data.criterion === undefined ? {} : { criterion: data.criterion },
    ...data.rowChanges === undefined ? {} : { rowChanges: data.rowChanges },
  }
}

/**
 * Remove the record; none is not an error.
 * @param path - {@link updateResultPath}.
 */
export async function removeUpdateResult(path: string): Promise<void> {
  await rm(path, { force: true })
}
