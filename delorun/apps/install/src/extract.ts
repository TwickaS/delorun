/**
 * Extraction of a verified runtime archive into the staging directory (contract C1, "Installing"): the archive holds
 * only regular files, and the extraction accepts exactly the files the signed list names, each with the list's length
 * and SHA-256, at the list's mode. An entry the archive format forbids, a path the list does not name, a repeated
 * path, and a length or digest the list contradicts all stop the extraction with the staging directory left for the
 * caller to remove; nothing is written outside the staging directory. Each file is hashed once, from the bytes it is
 * written from, created at its installed mode, and reported with its identity after the last write, so the runtime
 * store confirms the identity instead of reading the file again. Up to {@link EXTRACT_WRITES} files, holding at most
 * {@link EXTRACT_BYTES} bytes between them, are written at once while the archive is read on; every write has ended
 * before the extraction returns or throws, so the caller's removal of the staging directory races no write. No file is
 * synced here: the runtime store syncs the store's directory before and after it moves the staging directory in.
 *
 * @module @delorun/install/extract
 */
import { createHash } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { entryPathError, type ArchiveFormat } from '@delorun/release-formats/archive/entry'
import { archiveEntries } from '@delorun/release-formats/archive/inspect'
import type { RuntimeFileList } from '@delorun/contract-release-manifest'
import { identityOf, installedFileMode } from '@delorun/runtime-store'
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
  /** Told how many files are written after each one; a display only, which decides nothing. */
  readonly onFile?: (written: number, total: number) => void
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

/** What an extraction wrote. */
export interface Extracted {
  /** How many files were written. */
  readonly written: number
  /** Each written file's identity by its list path, from `fstat` after its last write. */
  readonly identities: ReadonlyMap<string, string>
}

/** How many files an extraction writes at once. */
export const EXTRACT_WRITES = 16

/**
 * How many bytes the files being written at once may hold between them; a larger file is written alone, so memory stays
 * near this bound plus the largest file.
 */
export const EXTRACT_BYTES = 64 * 1024 * 1024

/**
 * The writes of one extraction that run at once, within {@link EXTRACT_WRITES} files and {@link EXTRACT_BYTES} bytes.
 * The first write that fails is kept; no write starts after it.
 */
class WritePool {
  private readonly running = new Set<Promise<void>>()
  private bytes = 0
  private failure: { readonly error: unknown } | undefined

  /**
   * Start a write once the pool has room for it.
   * @param size - the bytes it writes.
   * @param write - the write.
   * @returns once the write has started.
   * @throws the first write's failure, when one has failed.
   */
  async add(size: number, write: () => Promise<void>): Promise<void> {
    while (this.failure === undefined && this.running.size > 0 && (this.running.size >= EXTRACT_WRITES || this.bytes + size > EXTRACT_BYTES)) await Promise.race(this.running)
    if (this.failure !== undefined) throw this.failure.error
    this.bytes += size
    const task: Promise<void> = write().then(
      () => undefined,
      (error: unknown) => { this.failure ??= { error } },
    ).finally(() => {
      this.bytes -= size
      this.running.delete(task)
    })
    this.running.add(task)
  }

  /**
   * Wait for every write that started.
   * @returns once none runs.
   * @throws the first write's failure.
   */
  async finish(): Promise<void> {
    await this.drain()
    if (this.failure !== undefined) throw this.failure.error
  }

  /**
   * Wait for every write that started, whatever the outcome.
   * @returns once none runs.
   */
  async drain(): Promise<void> {
    while (this.running.size > 0) await Promise.all(this.running)
  }
}

/**
 * Write one checked entry: create it exclusively at its installed mode, write it, and read its identity from the
 * descriptor after the last write.
 * @param target - the absolute path, inside the staging directory.
 * @param data - the bytes, already checked against the list.
 * @param mode - the installed mode.
 * @returns the file's identity.
 */
async function writeEntry(target: string, data: Buffer, mode: number): Promise<string> {
  // `wx` creates the file exclusively, so an existing entry, a symbolic link included, refuses the write.
  const handle = await open(target, 'wx', mode)
  try {
    await handle.writeFile(data)
    return identityOf(await handle.stat({ bigint: true }))
  } finally {
    await handle.close()
  }
}

/**
 * Extract a verified archive into the staging directory, checking every entry against the signed file list as it
 * arrives, before it is written.
 * @param request - the archive, its format, the verified list and the staging directory.
 * @returns how many files were written, and each one's identity.
 * @throws {InstallError} `ARCHIVE_REFUSED` for an entry type, path or name the archive may not hold, or one the list
 *   does not name; `INSTALL_VERIFY_FAILED` for a length or digest the list contradicts, or a listed file the archive
 *   does not hold; `ARCHIVE_REFUSED` too for an entry whose file already exists, as two names that differ only by
 *   case do on a file system that ignores case; `DOWNLOAD_FAILED` for a file that cannot be written otherwise, as for a
 *   download that cannot be. Every write has ended when it throws.
 */
export async function extractArchive(request: ExtractRequest): Promise<Extracted> {
  const listed = new Map(request.files.files.map(file => [file.path, file]))
  const seen = new Set<string>()
  const written = new Map<string, string>()
  const directories = new Map<string, Promise<{ readonly error: unknown } | undefined>>()
  const pool = new WritePool()
  try {
    for await (const entry of archiveEntries(request.archive, request.format)) {
      const expected = listed.get(entry.path)
      if (expected === undefined) {
        throw new InstallError('ARCHIVE_REFUSED', entry.path, `${request.archive} holds ${entry.path}, which its signed file list does not name`)
      }
      if (seen.has(entry.path)) {
        throw new InstallError('ARCHIVE_REFUSED', entry.path, `${request.archive} holds ${entry.path} twice`)
      }
      seen.add(entry.path)
      const target = extractionPath(request.directory, entry.path)
      const sha256 = createHash('sha256').update(entry.data).digest('hex')
      if (entry.data.byteLength !== expected.length || sha256 !== expected.sha256) {
        throw new InstallError('INSTALL_VERIFY_FAILED', entry.path, `${entry.path} in ${request.archive} has ${String(entry.data.byteLength)} bytes and SHA-256 ${sha256}; its signed file list lists ${String(expected.length)} bytes and ${expected.sha256}`)
      }
      const parent = dirname(target)
      let directory = directories.get(parent)
      if (directory === undefined) {
        // Settled to a value, so a failure waits for the first write in this directory without being left unhandled.
        directory = mkdir(parent, { recursive: true, mode: 0o755 }).then(() => undefined, (error: unknown) => ({ error }))
        directories.set(parent, directory)
      }
      const created = directory
      const { path, data } = entry
      await pool.add(data.byteLength, async () => {
        try {
          const failed = await created
          if (failed !== undefined) throw failed.error
          written.set(path, await writeEntry(target, data, installedFileMode(expected.mode)))
          request.onFile?.(written.size, request.files.files.length)
        } catch (error) {
          // An entry whose file already exists names one the archive already wrote under another spelling, such as
          // a name that differs only by case on a file system that ignores case: the archive does not fit this one.
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new InstallError('ARCHIVE_REFUSED', path, `${request.archive} holds ${path}, whose file already exists in the staging directory; this file system takes it and another entry for one file, as it does names that differ only by case`, { cause: error })
          }
          // A full disk or a staging directory changed under the install is a write failure, not an unreadable archive.
          throw new InstallError('DOWNLOAD_FAILED', target, `${target} cannot be written: ${messageOf(error)}`, { cause: error })
        }
      })
    }
    await pool.finish()
  } catch (error) {
    await pool.drain()
    if (error instanceof InstallError) throw error
    throw new InstallError('ARCHIVE_REFUSED', request.archive, `${request.archive} cannot be read as a ${request.format} archive: ${messageOf(error)}`, { cause: error })
  }
  if (written.size !== request.files.files.length) {
    const missing = request.files.files.map(file => file.path).filter(path => !written.has(path))
    throw new InstallError('INSTALL_VERIFY_FAILED', request.archive, `${request.archive} holds ${String(written.size)} of the ${String(request.files.files.length)} files its signed list names; it lacks ${missing.slice(0, 10).join(', ')}`)
  }
  return { written: written.size, identities: written }
}
