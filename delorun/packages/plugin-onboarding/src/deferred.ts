/**
 * The steps a phone deferred to the computer, kept in the profile's directory so the computer's studio can offer them
 * later. The file holds only step ids from a closed list; a file that is absent, too large, not JSON or not that list
 * reads as none, and the reason is logged without quoting the file. A write replaces the file whole through a temporary
 * file and a rename, and writes are applied one after another so two requests never overwrite each other.
 * @module @delorun/plugin-onboarding/deferred
 */
import { chmod, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { DEFERRABLE_STEPS, DeferrableStep } from './wire.ts'

/** The file's name inside the profile's directory. */
export const DEFERRED_FILENAME = 'onboarding-deferred.json'

/** The largest file read: it holds at most three ids, so a larger file is not one this plugin wrote. */
export const MAX_DEFERRED_BYTES = 1024

/** The document: a version and the deferred ids. */
const Document = z.strictObject({ version: z.literal(1), deferred: z.array(DeferrableStep).max(DEFERRABLE_STEPS.length) })

/**
 * Put ids in the order of {@link DEFERRABLE_STEPS}, once each.
 * @param ids - the ids.
 * @returns the ordered, unique ids.
 */
function ordered(ids: readonly DeferrableStep[]): DeferrableStep[] {
  return DEFERRABLE_STEPS.filter(id => ids.includes(id))
}

/** The store of one profile directory. */
export interface DeferredStore {
  /**
   * Read the deferred steps.
   * @returns the ids in the order of {@link DEFERRABLE_STEPS}; none when the file is absent or unusable.
   */
  read(): Promise<DeferrableStep[]>
  /**
   * Defer or clear one step.
   * @param id - the step.
   * @param deferred - true to defer it, false to clear it.
   * @returns the deferred steps now.
   * @throws when the file cannot be written.
   */
  set(id: DeferrableStep, deferred: boolean): Promise<DeferrableStep[]>
}

/**
 * Open the store of a profile directory.
 * @param directory - the profile's directory, or undefined where the harness was not launched from a profile; the store then holds nothing and refuses a write.
 * @param warn - called with a sentence when the file exists but cannot be used; the file's contents are never in it.
 * @returns the store.
 */
export function createDeferredStore(directory: string | undefined, warn: (message: string) => void): DeferredStore {
  let queue: Promise<unknown> = Promise.resolve()
  const read = async (): Promise<DeferrableStep[]> => {
    if (directory === undefined) return []
    const path = join(directory, DEFERRED_FILENAME)
    let text: string
    try {
      const status = await stat(path)
      if (!status.isFile() || status.size > MAX_DEFERRED_BYTES) {
        warn(`${DEFERRED_FILENAME} is not a regular file of at most ${String(MAX_DEFERRED_BYTES)} bytes; no step is deferred`)
        return []
      }
      text = await readFile(path, 'utf8')
    } catch (error) {
      // An absent file is the normal state; any other failure is reported without the system's message.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn(`${DEFERRED_FILENAME} could not be read; no step is deferred`)
      return []
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // The parser's message quotes part of the text, so only the fact is reported.
      warn(`${DEFERRED_FILENAME} is not JSON; no step is deferred`)
      return []
    }
    const document = Document.safeParse(parsed)
    if (!document.success) {
      warn(`${DEFERRED_FILENAME} is not a list of deferred steps; no step is deferred`)
      return []
    }
    return ordered(document.data.deferred)
  }
  const set = (id: DeferrableStep, deferred: boolean): Promise<DeferrableStep[]> => {
    const run = async (): Promise<DeferrableStep[]> => {
      if (directory === undefined) throw new Error('the harness has no profile directory, so a deferred step cannot be kept')
      const current = await read()
      const next = ordered(deferred ? [...current, id] : current.filter(other => other !== id))
      if (next.length === current.length && next.every((other, index) => other === current[index])) return next
      const path = join(directory, DEFERRED_FILENAME)
      const staged = `${path}.${String(process.pid)}.tmp`
      await writeFile(staged, `${JSON.stringify({ version: 1, deferred: next })}\n`, { mode: 0o600 })
      await chmod(staged, 0o600)
      await rename(staged, path)
      return next
    }
    const result = queue.then(run, run)
    queue = result.catch(() => undefined)
    return result
  }
  return { read, set }
}
