/**
 * The path rules of contract C8. A manifest path and a ZIP entry name are
 * checked by the same function, so an archive cannot reach a path through the
 * manifest that the ZIP refuses, or the other way round. Extraction resolves
 * every path inside the staging directory and refuses one that resolves
 * outside it, so a path that passes the lexical checks still cannot escape the
 * destination.
 *
 * @module @delo/archive/paths
 */
import { isAbsolute, relative, resolve } from 'node:path'
import { ArchiveError } from './errors.ts'

/**
 * The device names that a Windows path resolves to a device rather than to a
 * file, in either letter case and with or without an extension: an entry named
 * `nul` or `con.txt` writes to the console or to the null device on that
 * platform instead of writing a file.
 */
export const RESERVED_DEVICE_NAMES = [
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
] as const

/** A device name, with its extension when it has one, in either letter case. */
const RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

/** Control characters, which a name must not carry: they split a log line and steer a terminal. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u

/** A leading drive letter with its colon, which names an absolute path on Windows. */
const DRIVE_PREFIX = /^[A-Za-z]:/u

/**
 * Check one archive path against contract C8's rules and return it unchanged.
 * A path is normalised, relative, free of `..` and `.` segments and free of an
 * empty segment, it carries no backslash and no control character, it is not
 * absolute and it names no reserved device.
 * @param path - the path as the manifest or the ZIP entry declares it.
 * @returns the same path, so a caller can use it in place of the argument.
 * @throws ArchiveError `ARCHIVE_PATH_REJECTED` naming the rule the path breaks.
 */
export function checkArchivePath(path: string): string {
  if (path.length === 0) throw new ArchiveError('ARCHIVE_PATH_REJECTED', 'an archive entry has an empty path')
  if (CONTROL_CHARACTER.test(path)) {
    throw new ArchiveError('ARCHIVE_PATH_REJECTED', `the archive path ${JSON.stringify(path)} holds a control character`)
  }
  if (path.includes('\\')) {
    throw new ArchiveError('ARCHIVE_PATH_REJECTED', `the archive path ${JSON.stringify(path)} holds a backslash`)
  }
  if (path.startsWith('/')) {
    throw new ArchiveError('ARCHIVE_PATH_REJECTED', `the archive path ${JSON.stringify(path)} is absolute`)
  }
  if (DRIVE_PREFIX.test(path)) {
    throw new ArchiveError('ARCHIVE_PATH_REJECTED', `the archive path ${JSON.stringify(path)} begins with a drive letter`)
  }
  for (const segment of path.split('/')) {
    if (segment === '') {
      throw new ArchiveError('ARCHIVE_PATH_REJECTED', `the archive path ${JSON.stringify(path)} holds an empty segment`)
    }
    if (segment === '.' || segment === '..') {
      throw new ArchiveError('ARCHIVE_PATH_REJECTED', `the archive path ${JSON.stringify(path)} holds a ${JSON.stringify(segment)} segment`)
    }
    if (RESERVED_DEVICE.test(segment)) {
      throw new ArchiveError('ARCHIVE_PATH_REJECTED', `the archive path ${JSON.stringify(path)} names the reserved device ${JSON.stringify(segment)}`)
    }
  }
  return path
}

/**
 * Check every path of one archive at once for the two collisions contract C8
 * refuses: two entries that differ only in letter case, which overwrite each
 * other on a case-insensitive file system, and two entries that are literally
 * one path, which overwrite each other everywhere.
 * @param paths - every path the archive declares, in archive order.
 * @throws ArchiveError `ARCHIVE_PATH_REJECTED` for a repeated path, `ARCHIVE_CASE_COLLISION` for a case-only difference, and the refusal of {@link checkArchivePath} for a path that breaks a rule.
 */
export function checkPathCollisions(paths: readonly string[]): void {
  const seen = new Map<string, string>()
  for (const path of paths) {
    checkArchivePath(path)
    const folded = path.toLowerCase()
    const previous = seen.get(folded)
    if (previous === path) {
      throw new ArchiveError('ARCHIVE_PATH_REJECTED', `the archive lists the entry ${JSON.stringify(path)} twice`)
    }
    if (previous !== undefined) {
      throw new ArchiveError(
        'ARCHIVE_CASE_COLLISION',
        `the archive holds ${JSON.stringify(previous)} and ${JSON.stringify(path)}, which differ only in letter case`,
      )
    }
    seen.set(folded, path)
  }
}

/**
 * Resolve one archive path inside a destination directory, and refuse a path
 * that resolves outside it. This is the last line of defence of an extraction:
 * even a path that passed {@link checkArchivePath} cannot name a directory
 * outside the destination, so an extraction never writes outside it.
 * @param destination - the absolute directory the extraction writes into.
 * @param path - the archive path to resolve.
 * @returns the absolute path of the entry inside `destination`.
 * @throws ArchiveError `ARCHIVE_PATH_REJECTED` when the path resolves outside the destination or onto the destination itself.
 */
export function resolveInside(destination: string, path: string): string {
  const absolute = resolve(destination, path)
  const inside = relative(destination, absolute)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new ArchiveError('ARCHIVE_PATH_REJECTED', `the archive path ${JSON.stringify(path)} resolves outside the destination directory`)
  }
  return absolute
}
