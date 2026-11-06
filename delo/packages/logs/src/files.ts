/**
 * Where each C20 surface keeps its files, and how they are created and opened: log directories at mode 0700 and log
 * files at 0600 through exclusive creation. An existing directory or file passes `@delo/home`'s check of C1's
 * refusal rule first, which refuses a symbolic link, another user's path or one with a group or other permission
 * bit, with the command that fixes it.
 *
 * @module @delo/logs/files
 */
import { checkPrivateDirectorySync, checkProtectedFileSync, HomeLayoutError } from '@delo/home'
import { KEPT_FILES, LOG_DIR_MODE, LOG_FILE_MODE, SURFACE_FILES, type SurfaceKind, type SurfaceName } from '@delo/contract-operational-logs'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, type Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { LogsError } from './errors.ts'

/** Where one surface's log lives. */
export interface SurfaceLocation {
  /** The surface name a record carries, such as `home-default`. */
  readonly surface: SurfaceName
  /** The surface's directory. */
  readonly dir: string
  /** The active file; rotated files are `<file>.1` to `<file>.4`. */
  readonly file: string
}

/** A request for a surface's location. */
export interface SurfaceRequest {
  /** The surface kind. */
  readonly kind: SurfaceKind
  /** The resolved Delo home (C1); not read for the relay, whose file is inside its container. */
  readonly home: string
  /** The CLI profile; required for the home process and the supervisor. */
  readonly profile?: string
}

/** Profile names a surface directory may carry: a letter or digit, then letters, digits, `.`, `_` or `-`. */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * Check a profile name before it becomes part of a path.
 * @param profile - the CLI profile.
 * @returns the profile.
 * @throws LogsError `PROFILE_INVALID` for a name outside {@link PROFILE_NAME}, such as one holding a path separator.
 */
export function checkProfile(profile: string): string {
  if (!PROFILE_NAME.test(profile)) throw new LogsError('PROFILE_INVALID', `"${profile}" is not a profile name: use letters, digits, ".", "_" and "-", starting with a letter or digit`)
  return profile
}

/**
 * Resolve a surface's directory and active file from C20's table.
 * @param request - the surface, the home and the profile.
 * @returns the location.
 * @throws LogsError `PROFILE_INVALID` when a per-profile surface has no valid profile, or the home is not absolute.
 */
export function resolveSurface(request: SurfaceRequest): SurfaceLocation {
  const { kind } = request
  if (kind === 'relay') return { surface: 'relay', dir: dirname(SURFACE_FILES.relay), file: SURFACE_FILES.relay }
  if (!isAbsolute(request.home)) throw new LogsError('PROFILE_INVALID', `the Delo home "${request.home}" is not an absolute path`)
  switch (kind) {
    case 'home':
    case 'supervisor': {
      if (request.profile === undefined) throw new LogsError('PROFILE_INVALID', `the ${kind} surface needs a profile`)
      const profile = checkProfile(request.profile)
      const file = join(request.home, SURFACE_FILES[kind].replace('<profile>', profile))
      return { surface: `${kind}-${profile}`, dir: dirname(file), file }
    }
    case 'desktop-host': {
      const file = join(request.home, SURFACE_FILES['desktop-host'])
      return { surface: 'desktop-host', dir: dirname(file), file }
    }
  }
}

/**
 * The surface a directory under `logs/` belongs to, by its name.
 * @param home - the Delo home.
 * @param name - a directory name under `<home>/logs`.
 * @returns its location, or `undefined` when the name is no C20 surface's.
 */
export function surfaceOfDirectory(home: string, name: string): SurfaceLocation | undefined {
  if (name === 'desktop-host') return resolveSurface({ kind: 'desktop-host', home })
  const match = /^(home|supervisor)-(.+)$/.exec(name)
  const profile = match?.[2]
  if (profile === undefined || !PROFILE_NAME.test(profile)) return undefined
  return resolveSurface({ kind: match?.[1] === 'home' ? 'home' : 'supervisor', home, profile })
}

/**
 * A rotated file's path.
 * @param location - the surface.
 * @param index - 1 for the newest rotated file.
 * @returns `<file>.<index>`.
 */
export function rotatedFile(location: SurfaceLocation, index: number): string {
  return `${location.file}.${String(index)}`
}

/**
 * The index of a rotated file of the surface, by its name.
 * @param location - the surface.
 * @param name - a file name in the surface's directory.
 * @returns the index, or `undefined` for any other name.
 */
export function rotatedIndex(location: SurfaceLocation, name: string): number | undefined {
  const match = new RegExp(`^${basename(location.file).replaceAll('.', '\\.')}\\.([1-9][0-9]*)$`).exec(name)
  return match === null ? undefined : Number(match[1])
}

/** The highest rotated index C20 keeps (`.4`). */
export const LAST_ROTATED_INDEX = KEPT_FILES - 1

function isMissing(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * The `lstat` of a path, or `undefined` when it does not exist.
 * @param path - the path.
 * @returns its stats.
 */
export function lstatOrMissing(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (error: unknown) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/**
 * Check an existing log file with C1's refusal rule, or report that it does not exist.
 * @param path - the file.
 * @returns the `lstat` result the check passed, or `undefined` when the file does not exist.
 * @throws {HomeLayoutError} `SECRET_FILE_MODE` when the file is refused.
 */
export function checkedLogFile(path: string): Stats | undefined {
  try {
    return checkProtectedFileSync(path)
  } catch (error: unknown) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/**
 * Create a surface's directory at mode 0700, with `logs/` and any missing parent at 0700, or check the existing one.
 * @param location - the surface.
 * @throws {HomeLayoutError} `HOME_MODE` when the existing directory is refused.
 */
export function ensureSurfaceDirectory(location: SurfaceLocation): void {
  mkdirSync(dirname(location.dir), { recursive: true, mode: LOG_DIR_MODE })
  try {
    mkdirSync(location.dir, { mode: LOG_DIR_MODE })
    return
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  checkPrivateDirectorySync(location.dir)
}

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

/**
 * Open a log file for appending: create it at mode 0600 through exclusive creation, or open the existing file after
 * checking it, never following a symbolic link.
 * @param path - the file.
 * @returns the file descriptor.
 * @throws {HomeLayoutError} `SECRET_FILE_MODE` when the existing file is refused.
 */
export function openForAppend(path: string): number {
  for (let attempt = 0; ; attempt += 1) {
    const stats = checkedLogFile(path)
    if (stats === undefined) {
      try {
        return openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, LOG_FILE_MODE)
      } catch (error: unknown) {
        // Another writer created it between the check and the open; check what it created.
        if ((error as NodeJS.ErrnoException).code === 'EEXIST' && attempt === 0) continue
        throw error
      }
    }
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | NO_FOLLOW)
    const opened = fstatSync(fd)
    if (opened.ino === stats.ino && opened.dev === stats.dev) return fd
    closeSync(fd)
    // The path was replaced between the check and the open.
    if (attempt > 0) throw new HomeLayoutError('SECRET_FILE_MODE', path, `${path} was replaced while it was being opened`)
  }
}
