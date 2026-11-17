/**
 * The review entries a setup import created, kept so that going back to the version saved before the import takes
 * them away too: the plugin's folder is no longer linked then, and a pending review of its code would otherwise wait
 * for a decision about code that no longer runs.
 *
 * @module @delorun/changes/setup-transfer/import-reviews
 */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { PROTECTED_FILE_MODE } from '@delorun/contract-home-layout'
import { locked, timeOf } from '../action-support.ts'
import type { ChangesContext } from '../actions.ts'
import { changesDirectory } from '../paths.ts'
import { findEntry, readChangeLog, withEntry, writeChangeLog } from '../records.ts'
import type { ChangeId } from '../types.ts'

/** One import: the version saved before it and the review changes it created. */
interface ImportReviews {
  readonly version: string
  readonly changes: readonly string[]
}

/**
 * @param ctx - the profile.
 * @returns the path of the profile's record of import reviews.
 */
function recordPath(ctx: ChangesContext): string {
  return join(changesDirectory(ctx.home), 'setup-imports', `${ctx.profile}.json`)
}

/**
 * @param ctx - the profile.
 * @returns the recorded imports; empty when none was recorded or the file is not a list of them.
 */
async function readRecord(ctx: ChangesContext): Promise<readonly ImportReviews[]> {
  let text: string
  try {
    text = await readFile(recordPath(ctx), 'utf8')
  } catch (error: unknown) {
    // ENOENT: no import has recorded reviews yet.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A record that is not JSON names no import; the reviews stay for the person to decide.
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((item): item is ImportReviews => typeof item === 'object' && item !== null && typeof (item as ImportReviews).version === 'string' && Array.isArray((item as ImportReviews).changes))
}

/**
 * Remember the review changes an import created.
 * @param ctx - the profile.
 * @param version - the history version saved before the import.
 * @param changes - the review changes the import created.
 */
export async function recordImportReviews(ctx: ChangesContext, version: string, changes: readonly ChangeId[]): Promise<void> {
  if (changes.length === 0) return
  const kept = (await readRecord(ctx)).filter(item => item.version !== version)
  await mkdir(join(changesDirectory(ctx.home), 'setup-imports'), { recursive: true, mode: 0o700 })
  await writeFileAtomic(recordPath(ctx), `${JSON.stringify([...kept, { version, changes }])}\n`, { mode: PROTECTED_FILE_MODE })
}

/**
 * Discard the pending reviews an import created, when the profile goes back to the version saved before it. Reviews
 * already decided stay as they are.
 * @param ctx - the profile.
 * @param version - the history version the profile was restored to.
 * @returns the changes discarded.
 */
export async function discardImportReviews(ctx: ChangesContext, version: string): Promise<readonly string[]> {
  const record = await readRecord(ctx)
  const imported = record.find(item => item.version === version)
  if (imported === undefined) return []
  return locked(ctx, async () => {
    let log = await readChangeLog(ctx.home, ctx.profile)
    const discarded: string[] = []
    for (const id of imported.changes) {
      const entry = findEntry(log, id as ChangeId)
      if (entry?.state !== 'pending') continue
      log = withEntry(log, { ...entry, state: 'discarded', decidedAt: timeOf(ctx) })
      discarded.push(id)
    }
    if (discarded.length > 0) await writeChangeLog(ctx.home, ctx.profile, log)
    await mkdir(join(changesDirectory(ctx.home), 'setup-imports'), { recursive: true, mode: 0o700 })
    await writeFileAtomic(recordPath(ctx), `${JSON.stringify(record.filter(item => item.version !== version))}\n`, { mode: PROTECTED_FILE_MODE })
    return discarded
  })
}
