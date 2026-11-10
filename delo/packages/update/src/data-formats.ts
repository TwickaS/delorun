/**
 * Whether two releases read each other's chat data (contract C3, "Data formats"). Each runtime closure carries a
 * signed `data-formats.json` with the digest of upstream's persistence-schema inventory and the versions of Delo's
 * own records under the home; the manifests carry each release's `dsh` version. Upstream's inventory covers the
 * Session header, envelope and events but no storage unit under `storages/`, so a different `dsh` version counts as
 * a difference on its own. Any difference, or a file that cannot be read, is one `data` item; Delo does not judge
 * the direction, and nothing here refuses a rollback.
 *
 * @module @delo/update/data-formats
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DATA_FORMATS_FILE,
  DATA_FORMATS_SCHEMA,
  SESSION_DATA_DIRECTORIES,
  type DataCopySize,
  type DataFormatDifference,
  type DataFormats,
  type ReportItem,
} from '@delo/contract-update-report'
import type { SemanticVersion, Sha256Hex } from '@delo/contract-release-manifest'
import { z } from 'zod'
import deloRecords from './data-records.json' with { type: 'json' }

/**
 * The versioned records Delo's own packages keep under the home and a previous release reads, by record name, at the
 * version this release writes, as `data-records.json` beside this module lists them. A record whose writer changes its
 * version changes that file in the same commit, so the next update names the data change and the release tool refuses
 * to sign the change as a patch release; `delo/apps/cli/tests/update-records.spec.ts` checks each entry against what
 * its owner writes. The records:
 *
 * - `update-record`: `run/<profile>/update.json`, the update record (C19, C3).
 * - `store-layout`: `runtimes/store.json` (C1).
 * - `profile-safety`: `profiles/<profile>/delo-safety.json` (C3).
 * - `safe-mode`: `run/<profile>/safe-mode.json` (C3).
 * - `update-report`: `profiles/<profile>/delo-update-report.json` (C3).
 * - `session-data-copy`: `data-copies/<version>/copy.json` (C3).
 * - `data-restore-journal`: `data-copies/restore.json` (C3).
 * - `storage:delo_workspaces`: the `delo_workspaces` storage domain under `storages/`, its `defineDomain` version
 *   (`@delo/plugin-workspaces`).
 * - `storage:delo_chat_states`: the `delo_chat_states` storage domain under `storages/`, its `defineDomain` version
 *   (`@delo/plugin-chat-states`).
 * - `trash-item`: `trash/items/<id>/item.json`, a trash item's record, at `TRASH_ITEM_SCHEMA_VERSION` (`@delo/trash`).
 */
export const DELO_RECORDS: Readonly<Record<string, number>> = Object.freeze({ ...deloRecords })

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u)
const dataFormatsSchema = z.strictObject({
  schema: z.literal(DATA_FORMATS_SCHEMA),
  persistence: sha256,
  deloRecords: z.record(z.string().min(1), z.number().int().nonnegative()),
})

/**
 * The `data-formats.json` of a release built from a checkout.
 * @param persistenceSchema - the bytes of upstream's `docs/persistence-schema.json` at the built commit.
 * @returns the record the release build writes into the runtime closure.
 */
export function dataFormatsOf(persistenceSchema: Uint8Array): DataFormats {
  return {
    schema: DATA_FORMATS_SCHEMA,
    persistence: createHash('sha256').update(persistenceSchema).digest('hex') as Sha256Hex,
    deloRecords: { ...DELO_RECORDS },
  }
}

/**
 * The text of a `data-formats.json`, one JSON object and a newline.
 * @param formats - the record.
 * @returns its text.
 */
export function dataFormatsText(formats: DataFormats): string {
  return `${JSON.stringify(formats, undefined, 2)}\n`
}

/**
 * Parse a `data-formats.json`.
 * @param text - the file's text.
 * @returns the record.
 * @throws {Error} when the text is not JSON or not a `delo.data-formats/1` record.
 */
export function parseDataFormats(text: string): DataFormats {
  const parsed = dataFormatsSchema.safeParse(JSON.parse(text))
  if (!parsed.success) throw new Error(`not a ${DATA_FORMATS_SCHEMA} record: ${parsed.error.issues.map(issue => issue.message).join('; ')}`)
  // The schema checked the digest's form; the brand is the contract's type.
  return { ...parsed.data, persistence: parsed.data.persistence as Sha256Hex }
}

/**
 * Read the `data-formats.json` at the root of an installed runtime. The store's start check has verified the file
 * against the signed file list when it is listed; a release built before the file existed has none.
 * @param runtimeDirectory - `runtimes/<version>/`.
 * @returns the record, or `undefined` when the file is missing or unreadable, which C3 reports as `data-format-unknown`.
 */
export async function readDataFormats(runtimeDirectory: string): Promise<DataFormats | undefined> {
  try {
    return parseDataFormats(await readFile(join(runtimeDirectory, DATA_FORMATS_FILE), 'utf8'))
  } catch (_unreadable) {
    // Missing or malformed: the comparison states it as `data-format-unknown`, never as equal.
    return undefined
  }
}

/** One release's data facts: its `dsh` version from the verified manifest, and its `data-formats.json`. */
export interface ReleaseDataFacts {
  /** The release's DSH version. */
  readonly dsh: SemanticVersion
  /** Its `data-formats.json`, or `undefined` when missing or unreadable. */
  readonly formats: DataFormats | undefined
}

/** Both releases' data facts and the size of the copy an update would take. */
export interface DataFacts {
  /** The running release. */
  readonly from: ReleaseDataFacts
  /** The target release. */
  readonly to: ReleaseDataFacts
  /** The copy's size and the free space. */
  readonly copy: DataCopySize
}

/** What the comparison found. */
export type DataComparison =
  /** The two releases read each other's data. */
  | { readonly kind: 'same' }
  /** The data facts differ. */
  | { readonly kind: 'changed', readonly differs: readonly DataFormatDifference[] }
  /** A release's `data-formats.json` cannot be read. */
  | { readonly kind: 'unknown', readonly unreadable: readonly ('from' | 'to')[] }

/**
 * Whether two string-to-number tables hold the same entries.
 * @param left - one table.
 * @param right - the other.
 * @returns true when both hold the same names with the same numbers.
 */
function sameRecords(left: Readonly<Record<string, number>>, right: Readonly<Record<string, number>>): boolean {
  const names = Object.keys(left)
  return names.length === Object.keys(right).length && names.every(name => Object.hasOwn(right, name) && right[name] === left[name])
}

/**
 * Compare two releases' data facts.
 * @param from - the running release.
 * @param to - the target release.
 * @returns `same`, `changed` with what differs, or `unknown` naming the unreadable side.
 */
export function compareDataFacts(from: ReleaseDataFacts, to: ReleaseDataFacts): DataComparison {
  const unreadable = (['from', 'to'] as const).filter(side => (side === 'from' ? from : to).formats === undefined)
  if (unreadable.length > 0 || from.formats === undefined || to.formats === undefined) return { kind: 'unknown', unreadable }
  const differs: DataFormatDifference[] = []
  if (from.dsh !== to.dsh) differs.push('dsh')
  if (from.formats.persistence !== to.formats.persistence) differs.push('persistence')
  if (!sameRecords(from.formats.deloRecords, to.formats.deloRecords)) differs.push('delo-records')
  return differs.length === 0 ? { kind: 'same' } : { kind: 'changed', differs }
}

/**
 * The `data` item a report holds: none when the releases read each other's data.
 * @param facts - both releases' data facts and the copy's size.
 * @returns zero or one item.
 */
export function dataItems(facts: DataFacts): readonly ReportItem[] {
  const comparison = compareDataFacts(facts.from, facts.to)
  const subject = { directories: SESSION_DATA_DIRECTORIES }
  const actions = ['copy-session-data', 'continue-without-copy'] as const
  switch (comparison.kind) {
    case 'same':
      return []
    case 'changed':
      return [{ kind: 'data', subject, reason: 'data-format-changed', effect: 'changed', verification: 'verified', detail: { differs: comparison.differs, copy: facts.copy }, actions }]
    case 'unknown':
      return [{ kind: 'data', subject, reason: 'data-format-unknown', effect: 'changed', verification: 'unverified', detail: { unreadable: comparison.unreadable, copy: facts.copy }, actions }]
  }
}
