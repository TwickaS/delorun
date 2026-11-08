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
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ArchiveError } from './errors.ts'
import { resolveInside } from './paths.ts'

/** The permission bits of the staging root: readable by its owner only. */
export const STAGING_DIRECTORY_MODE = 0o700

/** The permission bits of one staged file: readable by its owner only. */
export const STAGED_FILE_MODE = 0o600

/** One file an import stages. */
export interface StagedEntry {
  /** The archive path of the entry, relative to the staging root. */
  readonly path: string
  /** The entry's bytes. */
  readonly bytes: Uint8Array
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
      // `wx` fails on an existing path, so an entry never replaces a file this import did not write.
      await writeFile(target, entry.bytes, { flag: 'wx', mode: STAGED_FILE_MODE })
    } catch (error: unknown) {
      if (error instanceof ArchiveError) throw error
      throw stagingFailure(entry.path, error)
    }
  }
  return root
}

/**
 * Remove one staging root with everything in it. A failure is ignored: the
 * staging root holds no content the import still needs.
 * @param root - the absolute path of the staging root.
 */
export async function removeStaging(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
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
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'unexpected error'
  if (subject === undefined) return new ArchiveError('ARCHIVE_STAGING_FAILED', `the staging root could not be created (${code})`)
  return new ArchiveError('ARCHIVE_STAGING_FAILED', `the staging directory could not hold the entry ${JSON.stringify(subject)} (${code})`)
}
