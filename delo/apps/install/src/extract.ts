/**
 * Extraction of a verified runtime archive into the staging directory (contract C1, "Installing"): the archive holds
 * only regular files, and the extraction accepts exactly the files the signed list names, each with the list's length
 * and SHA-256, at the list's mode. An entry the archive format forbids, a path the list does not name, a repeated
 * path, and a length or digest the list contradicts all stop the extraction with the staging directory left for the
 * caller to remove; nothing is written outside the staging directory.
 *
 * @module @delo/install/extract
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { entryPathError, modeBits, type ArchiveFormat } from '@delo/release-formats/archive/entry'
import { archiveEntries } from '@delo/release-formats/archive/inspect'
import type { RuntimeFileList } from '@delo/contract-release-manifest'
import { InstallError, messageOf } from './errors.ts'

/** What one extraction is given. */
export interface ExtractRequest {
  /** The downloaded archive. */
  readonly archive: string
  /** Its format, which the platform decides. */
  readonly format: ArchiveFormat
  /** The verified file list the archive must reproduce. */
  readonly files: RuntimeFileList
  /** The new staging directory. */
  readonly directory: string
}

/**
 * The absolute path an entry is written to, checked against C1's path rules and against the staging directory it must
 * stay inside.
 * @param directory - the staging directory.
 * @param path - the entry's relative, `/`-separated path.
 * @returns the absolute path to write.
 * @throws {InstallError} `ARCHIVE_REFUSED` when the path is invalid or lands outside the directory.
 */
export function extractionPath(directory: string, path: string): string {
  const problem = entryPathError(path)
  if (problem !== undefined) throw new InstallError('ARCHIVE_REFUSED', path, `the archive entry ${JSON.stringify(path)} cannot be extracted: ${problem}`)
  const root = resolve(directory)
  const target = resolve(root, ...path.split('/'))
  const inside = relative(root, target)
  if (inside.length === 0 || inside === '..' || inside.startsWith(`..${sep}`)) {
    throw new InstallError('ARCHIVE_REFUSED', path, `the archive entry ${JSON.stringify(path)} lands outside ${directory}`)
  }
  return target
}

/**
 * Extract a verified archive into the staging directory, checking every entry against the signed file list as it
 * arrives.
 * @param request - the archive, its format, the verified list and the staging directory.
 * @returns how many files were written.
 * @throws {InstallError} `ARCHIVE_REFUSED` for an entry type, path or name the archive may not hold, or one the list
 *   does not name; `INSTALL_VERIFY_FAILED` for a length or digest the list contradicts, or a listed file the archive
 *   does not hold.
 */
export async function extractArchive(request: ExtractRequest): Promise<{ readonly written: number }> {
  const listed = new Map(request.files.files.map(file => [file.path, file]))
  const written = new Set<string>()
  try {
    for await (const entry of archiveEntries(request.archive, request.format)) {
      const expected = listed.get(entry.path)
      if (expected === undefined) {
        throw new InstallError('ARCHIVE_REFUSED', entry.path, `${request.archive} holds ${entry.path}, which its signed file list does not name`)
      }
      if (written.has(entry.path)) {
        throw new InstallError('ARCHIVE_REFUSED', entry.path, `${request.archive} holds ${entry.path} twice`)
      }
      const target = extractionPath(request.directory, entry.path)
      const sha256 = createHash('sha256').update(entry.data).digest('hex')
      if (entry.data.byteLength !== expected.length || sha256 !== expected.sha256) {
        throw new InstallError('INSTALL_VERIFY_FAILED', entry.path, `${entry.path} in ${request.archive} has ${String(entry.data.byteLength)} bytes and SHA-256 ${sha256}; its signed file list lists ${String(expected.length)} bytes and ${expected.sha256}`)
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o755 })
      await writeFile(target, entry.data, { mode: modeBits(expected.mode), flag: 'wx' })
      written.add(entry.path)
    }
  } catch (error) {
    if (error instanceof InstallError) throw error
    throw new InstallError('ARCHIVE_REFUSED', request.archive, `${request.archive} cannot be read as a ${request.format} archive: ${messageOf(error)}`, { cause: error })
  }
  if (written.size !== request.files.files.length) {
    const missing = request.files.files.map(file => file.path).filter(path => !written.has(path))
    throw new InstallError('INSTALL_VERIFY_FAILED', request.archive, `${request.archive} holds ${String(written.size)} of the ${String(request.files.files.length)} files its signed list names; it lacks ${missing.slice(0, 10).join(', ')}`)
  }
  return { written: written.size }
}
