/**
 * The staging directory of contract C8's import. Nothing is written until the
 * whole archive has validated, and everything an import writes goes into a
 * directory this module created: the root is created with `mkdir` without
 * `recursive`, so a directory that already exists is refused rather than
 * reused, and every entry path is resolved inside it. A path that resolves
 * outside the staging root is refused, so an extraction never writes outside
 * its destination even when a path passed the lexical rules. The root is 0700
 * and every file 0600, because an archive's objects carry the person's chat
 * content.
 *
 * @module @delo/archive/staging
 */
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { ArchiveError, failureCode } from './errors.ts'
import { resolveInside } from './paths.ts'

/** The permission bits of the staging root: readable by its owner only. */
export const STAGING_DIRECTORY_MODE = 0o700

/** The permission bits of one staged file: readable by its owner only. */
export const STAGED_FILE_MODE = 0o600

/** One file an import stages. */
export interface StagedEntry {
  /** The archive path of the entry, relative to the staging root. */
  readonly path: string
  /** The entry's bytes, or the read that produces them when the entry is written, so an import holds one entry at a time. */
  readonly bytes: Uint8Array | (() => Uint8Array)
}

/**
 * Write a staging directory and every entry in it.
 * @param root - the absolute path of the staging root, which must not exist yet.
 * @param entries - the entries to write, in the order they should be written.
 * @returns the staging root, for a caller that publishes from it.
 * @throws ArchiveError `ARCHIVE_PATH_REJECTED` when an entry path resolves outside the root, and `ARCHIVE_STAGING_FAILED` when the root or an entry cannot be written.
 */
export async function writeStaging(root: string, entries: readonly StagedEntry[]): Promise<string> {
  try {
    await mkdir(dirname(root), { recursive: true, mode: STAGING_DIRECTORY_MODE })
    // Not recursive: a root that exists already belongs to someone else, and reusing it would put this import's files beside theirs.
    await mkdir(root, { mode: STAGING_DIRECTORY_MODE })
  } catch (error: unknown) {
    throw stagingFailure(undefined, error)
  }
  for (const entry of entries) {
    const target = resolveInside(root, entry.path)
    try {
      await mkdir(dirname(target), { recursive: true, mode: STAGING_DIRECTORY_MODE })
      const bytes = typeof entry.bytes === 'function' ? entry.bytes() : entry.bytes
      // `wx` fails on an existing path, so an entry never replaces a file this import did not write.
      await writeFile(target, bytes, { flag: 'wx', mode: STAGED_FILE_MODE })
    } catch (error: unknown) {
      if (error instanceof ArchiveError) throw error
      throw stagingFailure(entry.path, error)
    }
  }
  return root
}

/**
 * Remove one staging root with everything in it. A root that does not exist,
 * because a file stands where its parent would be, has nothing to remove; any
 * other failure propagates, because the root may still hold chat content.
 * @param root - the absolute path of the staging root.
 */
export async function removeStaging(root: string): Promise<void> {
  try {
    await rm(root, { recursive: true, force: true })
  } catch (error: unknown) {
    // ENOTDIR: a file stands where the root's parent would be, so the root was never created.
    if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error
  }
}

/**
 * The refusal that wraps a staging failure, named by the entry path or by the
 * system's error code, and never by an absolute host path: the message a
 * person reads names the archive's own entry and the reason.
 * @param subject - the entry path that could not be written, or absent when the staging root itself could not be created.
 * @param error - the failure.
 * @returns the refusal, for the caller to throw.
 */
function stagingFailure(subject: string | undefined, error: unknown): ArchiveError {
  const code = failureCode(error)
  if (subject === undefined) return new ArchiveError('ARCHIVE_STAGING_FAILED', `the staging root could not be created (${code})`)
  return new ArchiveError('ARCHIVE_STAGING_FAILED', `the staging directory could not hold the entry ${JSON.stringify(subject)} (${code})`)
}

/**
 * Refuse a directory, or the directory that holds it, that is a symbolic
 * link: an import writes only into directories that are what they name, so a
 * link planted at `archive/` or `archive/staging` cannot redirect staged chat
 * content or a published workspace elsewhere.
 * @param path - the directory an import writes into.
 * @throws ArchiveError `ARCHIVE_STAGING_FAILED` naming the link.
 */
export async function refuseLinkedDirectory(path: string): Promise<void> {
  for (const candidate of [dirname(path), path]) {
    let linked: boolean
    try {
      linked = (await lstat(candidate)).isSymbolicLink()
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (linked) throw new ArchiveError('ARCHIVE_STAGING_FAILED', `${basename(candidate)} is a symbolic link, and an import writes only into a directory that is what it names`)
  }
}
