/**
 * The update record `run/<profile>/update.json` (contract C19, "Interrupted updates"; contract C3, "Rollback"):
 * written at mode 0600 and synced at the start of each phase from `snapshot` on, and again with `targetStarted`
 * before the target's process is spawned. It is read at the next start to finish an interrupted update. The
 * successor marks it `committed` so a later rollback reads it; a rollback rewrites it with phase `rolling-back`
 * before its first step, and it goes only once the runtime rolled back to has passed its health check. An update
 * that ends before the switch removes it.
 *
 * While an update runs, the previous update's committed record waits in the stash `run/<profile>/update.previous.json`:
 * it returns when the update ends without committing and goes when the update commits.
 *
 * @module @delo/home-process/journal
 */
import { constants } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RUN_ENTRIES, RUNTIME_VERSION_PATTERN, type RuntimeVersion } from '@delo/contract-home-layout'
import type { UpdateHealth, UpdateJournal, UpdatePhase } from '@delo/contract-home-process'
import { readProtectedFile, runDirectory, writeProtectedFile } from '@delo/home'
import { z } from 'zod'

/** The stash's file name in `run/<profile>/`. */
const STASH_FILE = 'update.previous.json'

const version = z.string().regex(new RegExp(RUNTIME_VERSION_PATTERN))
const journalSchema = z.strictObject({
  v: z.literal(1),
  from: version,
  to: version,
  previous: version.optional(),
  phase: z.enum(['checking', 'installing', 'reporting', 'snapshot', 'waiting', 'switching', 'health-check', 'committed', 'rolling-back']),
  startedAt: z.string().datetime(),
  dataDiffers: z.boolean(),
  copy: z.boolean(),
  targetStarted: z.boolean(),
  snapshot: z.string().min(1).optional(),
  refused: z.literal(true).optional(),
  health: z.strictObject({
    disabledPlugins: z.array(z.string()),
    namedRows: z.array(z.string()),
    bundles: z.array(z.string()).optional(),
  }).optional(),
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

/**
 * The stash beside a journal, where the previous update's committed record waits while an update runs.
 * @param journal - the journal path.
 * @returns `<home>/run/<profile>/update.previous.json`.
 */
export function stashPath(journal: string): string {
  return join(dirname(journal), STASH_FILE)
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
  /** The profile history version the `snapshot` phase saved. */
  readonly snapshot?: string | undefined
  /** Present when C3's table refused the automatic rollback. */
  readonly refused?: true | undefined
  /** What the health check holds the target to; `bundles` may be present as `undefined`. */
  readonly health?: (Omit<UpdateHealth, 'bundles'> & { readonly bundles?: readonly string[] | undefined }) | undefined
}

/**
 * The record an update writes in a phase.
 * @param update - the update's versions, the pointer `previous` held before it, its start time, its data facts, and
 *   its snapshot, refusal and health expectations when it has them.
 * @param phase - the phase.
 * @returns the record.
 */
export function journalRecord(update: JournalledUpdate, phase: UpdatePhase): UpdateJournal {
  const health = update.health
  return {
    v: 1, from: update.from, to: update.to, ...update.previous === undefined ? {} : { previous: update.previous }, phase, startedAt: update.startedAt,
    dataDiffers: update.dataDiffers, copy: update.copy, targetStarted: update.targetStarted,
    ...update.snapshot === undefined ? {} : { snapshot: update.snapshot },
    ...update.refused === true ? { refused: true } : {},
    ...health === undefined
      ? {}
      : { health: { disabledPlugins: [...health.disabledPlugins], namedRows: [...health.namedRows], ...health.bundles === undefined ? {} : { bundles: [...health.bundles] } } },
  }
}

/**
 * The fields of a read record as an update to write again.
 * @param record - the record.
 * @returns the update, every field kept.
 */
export function journalledUpdate(record: UpdateJournal): JournalledUpdate {
  return { ...record, previous: record.previous }
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
  const data = parsed.data
  return journalRecord({
    ...data, from: brandString<RuntimeVersion>(data.from), to: brandString<RuntimeVersion>(data.to),
    previous: data.previous === undefined ? undefined : brandString<RuntimeVersion>(data.previous),
  }, data.phase)
}

/**
 * Rewrite the record with a new phase, keeping every other field.
 * @param path - the journal path.
 * @param phase - the phase.
 * @returns when the record is synced, or at once when no record exists.
 */
export async function markJournal(path: string, phase: UpdatePhase): Promise<void> {
  const record = await readJournal(path)
  if (record === undefined) return
  await writeJournal(path, journalledUpdate(record), phase)
}

/**
 * Mark the update a record names as committed, keeping every other field: the successor does this once it runs.
 * @param path - the journal path.
 * @returns when the record says `committed`, or at once when no record exists.
 */
export async function markCommitted(path: string): Promise<void> {
  await markJournal(path, 'committed')
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

/**
 * Flush a directory so a rename in it survives a power loss; Windows has no directory flush.
 * @param directory - the directory.
 */
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(directory, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Whether the stash exists.
 * @param journal - the journal path.
 * @returns true when `update.previous.json` exists beside it.
 */
export async function hasStash(journal: string): Promise<boolean> {
  try {
    await lstat(stashPath(journal))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Before an update writes its first record: move a committed record to the stash by one rename, flushed, so the
 * previous update's way back survives an update that ends without committing.
 * @param journal - the journal path.
 * @returns whether a record was stashed.
 * @throws {Error} for a record that is not a journal record.
 */
export async function stashCommitted(journal: string): Promise<boolean> {
  const record = await readJournal(journal)
  if (record?.phase !== 'committed') return false
  await rename(journal, stashPath(journal))
  await syncDirectory(dirname(journal))
  return true
}

/**
 * An update ended without committing: its record goes, and the stashed record, when one exists, takes its place by
 * one rename, flushed.
 * @param journal - the journal path.
 */
export async function endUpdateRecord(journal: string): Promise<void> {
  try {
    await rename(stashPath(journal), journal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await removeJournal(journal)
    return
  }
  await syncDirectory(dirname(journal))
}

/**
 * An update committed: the stashed record goes.
 * @param journal - the journal path.
 */
export async function removeStash(journal: string): Promise<void> {
  await removeJournal(stashPath(journal))
}
