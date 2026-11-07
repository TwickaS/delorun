/**
 * Mount aliases: the other paths at which a file or directory is reachable through another mount of the same
 * filesystem, such as a bind mount or a second mount of the root filesystem. Path-based profiles that hide or deny a
 * path must cover each alias too, because the kernel reaches the same file through it.
 *
 * @module @deepseek-ai/dsh-sandbox-local/mounts
 */

import { readFileSync, statSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { posix } from 'node:path'
import { SandboxUnsupportedPolicyError, pathWithin } from '@deepseek-ai/dsh-sandbox'

/** One line of `/proc/self/mountinfo`: which part of which filesystem is mounted where. */
export interface MountEntry {
  /** The filesystem's device, as `major:minor`. */
  readonly device: string
  /** The path inside that filesystem that is mounted. */
  readonly root: string
  /** Where it is mounted. */
  readonly mountPoint: string
}

/** Decode mountinfo's octal escapes (`\040` for a space, `\134` for a backslash). */
function unescape(field: string): string {
  return field.replaceAll(/\\([0-7]{3})/gu, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))
}

/**
 * Parse `/proc/self/mountinfo`. Entries whose mounted path was deleted (` //deleted`) are left out, because no path
 * reaches them.
 * @param text - the file's contents.
 * @returns one entry per mount, in the file's order.
 */
export function parseMountInfo(text: string): MountEntry[] {
  const entries: MountEntry[] = []
  for (const line of text.split('\n')) {
    const fields = line.split(' ')
    const [, , device, root, mountPoint] = fields
    if (device === undefined || root === undefined || mountPoint === undefined || root.endsWith('//deleted')) continue
    entries.push({ device, root: unescape(root), mountPoint: unescape(mountPoint) })
  }
  return entries
}

/**
 * Read this process's mount table.
 * @param platform - the operating system; only Linux has a mount table to read.
 * @param read - reads the mountinfo file.
 * @returns the entries, or none off Linux.
 * @throws {SandboxUnsupportedPolicyError} when the Linux mount table cannot be read, because aliases cannot be found.
 */
export function readMountTable(platform: string = process.platform, read: () => string = () => readFileSync('/proc/self/mountinfo', 'utf8')): MountEntry[] {
  if (platform !== 'linux') return []
  let text: string
  try {
    text = read()
  } catch (error) {
    throw new SandboxUnsupportedPolicyError(`cannot read /proc/self/mountinfo to find mount aliases of the protected paths: ${String(error)}`)
  }
  return parseMountInfo(text)
}

/**
 * The `major:minor` spelling of a Linux device number, as mountinfo writes it.
 * @param dev - `st_dev` from a bigint stat.
 * @returns the device as `major:minor`.
 */
export function deviceName(dev: bigint): string {
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n)
  const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n)
  return `${String(major)}:${String(minor)}`
}

/** A stat that reports absence as `undefined`. */
function statOf(path: string): BigIntStats | undefined {
  try {
    return statSync(path, { bigint: true })
  } catch {
    // Missing or unreadable: the path names no file to compare.
    return undefined
  }
}

/**
 * The other paths that reach `path`, or a part of it, through another mount of its filesystem: a mount of the path or
 * of a directory above it, and a bind mount of a directory or file inside it. Each candidate is computed from the
 * mount's root and confirmed by device and inode, so an overmounted or stale candidate is left out; a mount inside
 * `path` itself is not an alias, because it is reached through `path`.
 * @param path - a canonical path.
 * @param mounts - the mount table.
 * @returns the aliases, without `path` itself; none when `path` does not exist or its mount is not in the table.
 */
export function mountAliases(path: string, mounts: readonly MountEntry[]): string[] {
  const own = statOf(path)
  if (own === undefined) return []
  const device = deviceName(own.dev)
  let containing: MountEntry | undefined
  for (const entry of mounts) {
    if (entry.device !== device || !pathWithin(path, entry.mountPoint)) continue
    if (containing === undefined || entry.mountPoint.length >= containing.mountPoint.length) containing = entry
  }
  if (containing === undefined) return []
  const inFilesystem = posix.join(containing.root, posix.relative(containing.mountPoint, path))
  const aliases = new Set<string>()
  for (const entry of mounts) {
    if (entry.device !== device) continue
    // A mount of the path or of a directory above it reaches the path itself; a mount of a directory inside it
    // reaches that part of it.
    const covers = pathWithin(inFilesystem, entry.root)
    if (!covers && !pathWithin(entry.root, inFilesystem)) continue
    const candidate = covers ? posix.join(entry.mountPoint, posix.relative(entry.root, inFilesystem)) : entry.mountPoint
    const original = covers ? path : posix.join(path, posix.relative(inFilesystem, entry.root))
    if (candidate === original || pathWithin(candidate, path)) continue
    const found = statOf(candidate)
    const expected = covers ? own : statOf(original)
    if (found !== undefined && expected !== undefined && found.dev === expected.dev && found.ino === expected.ino) aliases.add(candidate)
  }
  return [...aliases]
}

/** Where macOS mounts the Data volume; `/Users`, `/private` and the other firmlinked paths reach it under here. */
export const DATA_VOLUME = '/System/Volumes/Data'

/**
 * The Data-volume spelling of a path on macOS, where a firmlink such as `/Users` makes
 * `/System/Volumes/Data/Users/...` reach the same file, confirmed by device and inode.
 * @param path - a canonical path.
 * @param dataVolume - the Data volume's mount point.
 * @returns the spelling under the Data volume when it reaches the same file; none elsewhere, including off macOS.
 */
export function firmlinkAliases(path: string, dataVolume: string = DATA_VOLUME): string[] {
  if (pathWithin(path, dataVolume)) return []
  const own = statOf(path)
  const candidate = posix.join(dataVolume, path)
  const found = statOf(candidate)
  return own !== undefined && found !== undefined && found.dev === own.dev && found.ino === own.ino ? [candidate] : []
}
