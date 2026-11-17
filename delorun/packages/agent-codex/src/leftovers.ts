/**
 * Codex's sandbox mounts over `.git`, `.agents` and `.codex` in every writable root, creating an empty folder for each
 * one that is missing, and leaves them behind when its process is killed. The driver records which of the three names
 * are absent from each writable root before the program starts, and after the process ends removes only those that
 * were absent and are now empty folders: never a file, a link, a folder with anything in it, or anything recursively.
 *
 * A writable root such as `/tmp` can be shared with another sandbox that is still running. Linux lets `rmdir` remove a
 * folder that is a mount point in another mount namespace and detaches that mount, which would take the protection
 * away from the other sandbox's running command. So a folder that is a mount point in any mount namespace this user
 * can read is kept.
 * @module @delorun/agent-codex/leftovers
 */
import { lstatSync, readdirSync, readFileSync, readlinkSync, rmdirSync } from 'node:fs'
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
  const candidates = records.flatMap(({ root, absent }) => absent.map(name => join(root, name))).filter(isEmptyFolder)
  if (candidates.length === 0) return []
  const mounted = mountPoints()
  const removed: string[] = []
  for (const path of candidates) {
    if (mounted.has(path)) continue
    try {
      // rmdir removes only an empty folder, and refuses one that is a mount point in this namespace.
      rmdirSync(path)
    } catch (_kept) {
      // Filled, mounted here or removed meanwhile: it stays as it is.
      continue
    }
    removed.push(path)
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

/**
 * The mount points of every mount namespace whose `/proc` entry this user can read, as paths seen from each process's
 * root. Without `/proc`, as on macOS, there are none.
 * @param proc - the proc file system's folder.
 * @returns the mount points.
 */
export function mountPoints(proc = '/proc'): Set<string> {
  const points = new Set<string>()
  const seen = new Set<string>()
  let entries: string[]
  try {
    entries = readdirSync(proc)
  } catch (_noProc) {
    // No proc file system: no mount namespaces to consult.
    return points
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    let namespace: string
    let text: string
    try {
      namespace = readlinkSync(join(proc, entry, 'ns', 'mnt'))
      if (seen.has(namespace)) continue
      text = readFileSync(join(proc, entry, 'mountinfo'), 'utf8')
    } catch (_unreadable) {
      // Another user's process, or one that has exited.
      continue
    }
    seen.add(namespace)
    for (const point of parseMountPoints(text)) points.add(point)
  }
  return points
}

/**
 * The mount points listed in one `mountinfo` file, with its octal escapes decoded.
 * @param mountinfo - the file's text.
 * @returns the mount points.
 */
export function parseMountPoints(mountinfo: string): string[] {
  return mountinfo.split('\n').flatMap((line) => {
    const point = line.split(' ')[4]
    return point === undefined ? [] : [point.replace(/\\([0-7]{3})/g, (_escape, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))]
  })
}
