/**
 * Archive entries as the deterministic writers take them and the readers report them. A runtime archive holds only
 * regular files, in byte-wise path order, with mode `0644` or `0755`, owner and group 0 with empty names, and every
 * mtime equal to the release's `SOURCE_DATE_EPOCH` (contract C2, rebuild before signing).
 *
 * @module @delorun/release-formats/archive/entry
 */
import type { RuntimeFileMode, RuntimePlatform } from '@delorun/contract-release-manifest'

/** The two archive formats of runtime closures. */
export type ArchiveFormat = 'tar.gz' | 'zip'

/** One regular file to write into an archive. */
export interface ArchiveEntry {
  /** Relative, `/`-separated, normalised path. */
  readonly path: string
  /** The file's mode. */
  readonly mode: RuntimeFileMode
  /** The file's bytes. */
  readonly data: Buffer
}

/** The largest archive a release publishes: contract C1's download limit, 1 GiB. */
export const MAX_ARCHIVE_BYTES = 1_073_741_824

/**
 * The archive format of a platform's runtime closure.
 * @param platform - the runtime platform.
 * @returns `zip` for `win32-x64`, otherwise `tar.gz`.
 */
export function archiveFormat(platform: RuntimePlatform): ArchiveFormat {
  return platform === 'win32-x64' ? 'zip' : 'tar.gz'
}

/**
 * Order two paths by their UTF-8 bytes, the entry order of every runtime archive.
 * @param left - one path.
 * @param right - the other path.
 * @returns a negative number, zero or a positive number, as `Array.prototype.sort` expects.
 */
export function compareEntryPaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

/**
 * Why a path cannot be an archive entry, or nothing when it can. A path is relative, uses `/`, has no empty, `.` or
 * `..` segment, and holds no backslash, NUL or other control character.
 * @param path - the candidate entry path.
 * @returns the reason, or `undefined` for a valid path.
 */
export function entryPathError(path: string): string | undefined {
  if (path.length === 0) return 'the path is empty'
  if (path.startsWith('/')) return 'the path is absolute'
  if (/[\\\u0000-\u001f\u007f]/u.test(path)) return 'the path holds a backslash or a control character'
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return `the path has a "${segment}" segment`
  }
  return undefined
}

/**
 * The modes C2 allows, as numbers.
 * @param mode - the mode string.
 * @returns the numeric mode.
 */
export function modeBits(mode: RuntimeFileMode): number {
  return mode === '0755' ? 0o755 : 0o644
}

/**
 * Checks entries as a writer receives them: valid paths in strictly increasing byte order.
 */
export class EntryOrder {
  private previous: string | undefined

  /**
   * Accept the next entry's path.
   * @param path - the entry path.
   * @throws Error when the path is invalid, repeats the previous one or comes before it.
   */
  accept(path: string): void {
    const error = entryPathError(path)
    if (error !== undefined) throw new Error(`archive entry ${JSON.stringify(path)}: ${error}`)
    if (this.previous !== undefined && compareEntryPaths(this.previous, path) >= 0) {
      throw new Error(`archive entry ${JSON.stringify(path)} does not follow ${JSON.stringify(this.previous)} in byte-wise path order`)
    }
    this.previous = path
  }
}
