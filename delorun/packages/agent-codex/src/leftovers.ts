/**
 * Codex's sandbox mounts over `.git`, `.agents` and `.codex` in every writable root, creating an empty folder for each
 * one that is missing, and leaves them behind when its process is killed. The driver records which of the three names
 * are absent from each writable root before the program starts, and after the process ends removes only those that
 * were absent and are now empty folders: never a file, a link, a folder with anything in it, or anything recursively.
 * @module @delorun/agent-codex/leftovers
 */
import { lstatSync, readdirSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'

/** The names Codex's sandbox protects in each writable root. */
export const SANDBOX_NAMES: readonly string[] = ['.git', '.agents', '.codex']

/** The protected names one writable root did not have before the program started. */
export interface AbsentNames {
  /** The writable root. */
  readonly root: string
  /** The names absent from it. */
  readonly absent: readonly string[]
}

/**
 * Record which protected names each writable root lacks. A name that cannot be checked counts as present, so it is
 * never removed.
 * @param roots - the writable roots.
 * @returns one record per root.
 */
export function recordAbsentNames(roots: readonly string[]): AbsentNames[] {
  return [...new Set(roots)].map(root => ({
    root,
    absent: SANDBOX_NAMES.filter((name) => {
      try {
        lstatSync(join(root, name))
        return false
      } catch (error: unknown) {
        return error instanceof Error && Reflect.get(error, 'code') === 'ENOENT'
      }
    }),
  }))
}

/**
 * Remove the protected names that were absent before and are now empty folders.
 * @param records - what {@link recordAbsentNames} recorded before the program started.
 * @returns the paths removed.
 */
export function removeSandboxLeftovers(records: readonly AbsentNames[]): string[] {
  const removed: string[] = []
  for (const { root, absent } of records) {
    for (const name of absent) {
      const path = join(root, name)
      if (!isEmptyFolder(path)) continue
      try {
        // rmdir removes only an empty folder, and refuses one that is still a mount point.
        rmdirSync(path)
      } catch (_kept) {
        // Filled, still mounted or removed meanwhile: it stays as it is.
        continue
      }
      removed.push(path)
    }
  }
  return removed
}

/** Whether a path is a folder, not a link, with nothing in it. */
function isEmptyFolder(path: string): boolean {
  let isFolder: boolean
  try {
    isFolder = lstatSync(path).isDirectory()
  } catch (_gone) {
    // Nothing there: nothing to remove.
    return false
  }
  if (!isFolder) return false
  try {
    return readdirSync(path).length === 0
  } catch (_unreadable) {
    // A folder the driver cannot list is not one it removes.
    return false
  }
}
