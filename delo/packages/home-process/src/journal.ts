/**
 * The update journal `run/<profile>/update.json` (contract C19, "Interrupted updates"): written at mode 0600 at the
 * start of each phase from `snapshot` on, read at the next start to finish an interrupted update, and removed when
 * the update ends.
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
  phase: z.enum(['checking', 'installing', 'reporting', 'snapshot', 'waiting', 'switching', 'health-check', 'committed']),
  startedAt: z.string().datetime(),
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
 * Write the journal for an update entering a phase.
 * @param path - the journal path.
 * @param update - the update's versions and start time.
 * @param update.from - the version that ran before the update.
 * @param update.to - the target version.
 * @param update.startedAt - RFC 3339 UTC time the update started.
 * @param phase - the phase that starts now.
 */
export async function writeJournal(path: string, update: { readonly from: RuntimeVersion, readonly to: RuntimeVersion, readonly startedAt: string }, phase: UpdatePhase): Promise<void> {
  const record: UpdateJournal = { v: 1, from: update.from, to: update.to, phase, startedAt: update.startedAt }
  await writeProtectedFile(path, `${JSON.stringify(record)}\n`)
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
