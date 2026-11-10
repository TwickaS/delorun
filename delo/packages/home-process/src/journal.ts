/**
 * The update record `run/<profile>/update.json` (contract C19, "Interrupted updates"; contract C3, "Rollback"):
 * written at mode 0600 and synced at the start of each phase from `snapshot` on, and again with `targetStarted`
 * before the target's process is spawned. It is read at the next start to finish an interrupted update, kept with
 * phase `committed` after the update commits so a later rollback reads it, and removed when a rollback completes or
 * an update ends before the switch.
 *
 * @module @delo/home-process/journal
 */
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { RUN_ENTRIES, RUNTIME_VERSION_PATTERN, type RuntimeVersion } from '@delo/contract-home-layout'
import type { UpdateJournal, UpdatePhase } from '@delo/contract-home-process'
import { readProtectedFile, runDirectory, writeProtectedFile } from '@delo/home'
import { z } from 'zod'

const version = z.string().regex(new RegExp(RUNTIME_VERSION_PATTERN))
const journalSchema = z.strictObject({
  v: z.literal(1),
  from: version,
  to: version,
  previous: version.optional(),
  phase: z.enum(['checking', 'installing', 'reporting', 'snapshot', 'waiting', 'switching', 'health-check', 'committed']),
  startedAt: z.string().datetime(),
  dataDiffers: z.boolean(),
  copy: z.boolean(),
  targetStarted: z.boolean(),
})

/**
 * The journal path of a profile.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 * @returns `<home>/run/<profile>/update.json`.
 */
export function journalPath(home: string, profile: string): string {
  return join(runDirectory(home, profile), RUN_ENTRIES.updateJournal)
}

/** An update as its journal records it. */
export interface JournalledUpdate {
  /** The version that ran before the update. */
  readonly from: RuntimeVersion
  /** The target version. */
  readonly to: RuntimeVersion
  /** The version the `previous` pointer named before the update, or `undefined` when none existed. */
  readonly previous: RuntimeVersion | undefined
  /** RFC 3339 UTC time the update started. */
  readonly startedAt: string
  /** Whether the two releases' chat data differs. */
  readonly dataDiffers: boolean
  /** Whether the update takes a session-data copy. */
  readonly copy: boolean
  /** Whether the target's process was spawned. */
  readonly targetStarted: boolean
}

/**
 * The record an update writes in a phase.
 * @param update - the update's versions, the pointer `previous` held before it, its start time and its data facts.
 * @param phase - the phase.
 * @returns the record.
 */
export function journalRecord(update: JournalledUpdate, phase: UpdatePhase): UpdateJournal {
  return {
    v: 1, from: update.from, to: update.to, ...update.previous === undefined ? {} : { previous: update.previous }, phase, startedAt: update.startedAt,
    dataDiffers: update.dataDiffers, copy: update.copy, targetStarted: update.targetStarted,
  }
}

/**
 * Write the journal for an update entering a phase.
 * @param path - the journal path.
 * @param update - the update's versions, the pointer `previous` held before it, and its start time.
 * @param phase - the phase that starts now.
 */
export async function writeJournal(path: string, update: JournalledUpdate, phase: UpdatePhase): Promise<void> {
  await writeProtectedFile(path, `${JSON.stringify(journalRecord(update, phase))}\n`)
}

/**
 * Read the journal through C1's protected-file check.
 * @param path - the journal path.
 * @returns the journal, or `undefined` when none exists.
 * @throws {HomeLayoutError} for a laxer, linked or foreign file.
 * @throws {Error} naming the path when the file is not a journal record.
 */
export async function readJournal(path: string): Promise<UpdateJournal | undefined> {
  let bytes: Buffer
  try {
    bytes = await readProtectedFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(`${path} is not an update journal; remove it once no delorun process runs for this profile`, { cause: error })
  }
  const parsed = journalSchema.safeParse(value)
  if (!parsed.success) throw new Error(`${path} is not an update journal; remove it once no delorun process runs for this profile`)
  // The schema checked the versions' form; the brands are the contract's own types.
  return parsed.data as UpdateJournal
}

/**
 * Mark the update a record names as committed, keeping every other field: the successor does this once it runs.
 * @param path - the journal path.
 * @returns when the record says `committed`, or at once when no record exists.
 */
export async function markCommitted(path: string): Promise<void> {
  const record = await readJournal(path)
  if (record === undefined) return
  await writeJournal(path, { ...record, previous: record.previous }, 'committed')
}

/**
 * Remove the journal.
 * @param path - the journal path.
 */
export async function removeJournal(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
