/**
 * Reading a stock home without trusting it. The stock home is hostile input:
 * a model, a plugin or a cloned repository may have written into it, and a
 * process may change it while the import reads it.
 *
 * Every entry is classified by `lstat`, so a symbolic link is reported and
 * never followed, a pipe, socket or device is never opened, and an entry on
 * another device than the home's root, such as a mount point inside the home,
 * is left behind. A file with more than one hard link can be a file from
 * anywhere on the same file system, so the reader counts the links it meets
 * and the plan carries such a file only when it met every one of them inside
 * the stock home, as upstream's attachment aliases are.
 *
 * Every directory is opened as a descriptor before it is listed, and every
 * file before it is read: the descriptor's status must be the identity the
 * walk recorded, and the path the descriptor resolves to must be the walked
 * path under the home's real root, so a directory on the way that was swapped
 * for a link after the walk redirects nothing. A file is opened with
 * `O_NOFOLLOW`, so a link at its own path fails to open, and `O_NONBLOCK`, so a
 * pipe swapped in after the walk never blocks the import before its status
 * refuses it. A file is read up to the size the walk recorded and checked
 * again after the read. Every listed name counts against the entry limit, and
 * a directory is listed as a stream that stops at the limit. Nothing here
 * opens a stock file for writing.
 *
 * @module @delo/archive/dsh-import/source
 */
import { createHash } from 'node:crypto'
import { constants, type Dir, type Stats } from 'node:fs'
import { lstat, open, opendir, readlink, realpath, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { DshImportError, systemCode } from './errors.ts'

/** One regular file of the stock home, with the identity the walk recorded. */
export interface DshImportFile {
  /** The path relative to the stock home, with `/` separators; the same path in the Delo home. */
  readonly path: string
  /** The size the walk recorded, in bytes. */
  readonly size: number
  /** The device the walk recorded. */
  readonly dev: number
  /** The inode the walk recorded. */
  readonly ino: number
  /** The modification time the walk recorded, in milliseconds. */
  readonly mtimeMs: number
  /** The status-change time the walk recorded, in milliseconds, which a write cannot set back as it can the modification time. */
  readonly ctimeMs: number
  /** The hard links the walk recorded. */
  readonly nlink: number
  /** The permission bits the walk recorded. */
  readonly mode: number
  /** The lowercase hexadecimal SHA-256 the plan read, when it hashed the file; the copy must have the same. */
  readonly sha256?: string
}

/** A stock file with the digest the plan read, which the copy must have. */
export type DshHashedFile = DshImportFile & { readonly sha256: string }

/** What one entry of the stock home is. */
export type InspectedEntry =
  | { readonly kind: 'directory' }
  | { readonly kind: 'file', readonly file: DshImportFile }
  | { readonly kind: 'refused', readonly reason: 'symbolic-link' | 'special-file' | 'mount-point' }

/** The file-system calls the reader makes that a spec replaces to stage a change between two of them. */
export interface SourceProbe {
  /**
   * Read one entry's status without following it.
   * @param path - the absolute path.
   * @returns the status.
   */
  readonly lstat: (path: string) => Promise<Stats>
  /**
   * Called before a directory or file is opened.
   * @param path - the path relative to the home.
   */
  readonly beforeOpen: (path: string) => Promise<void> | void
}

/** The real calls, with nothing between them. */
const REAL_PROBE: SourceProbe = { lstat, beforeOpen: () => undefined }

/** The bytes one read moves at a time. */
const CHUNK_BYTES = 1024 * 1024

/** The flags every stock file is opened with: read only, never through a final symbolic link, never waiting on a pipe. */
// Windows defines neither flag; a bitwise or with an undefined constant adds nothing there.
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

/** The flags every stock directory is opened with: a directory only, never through a final symbolic link. */
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY

/**
 * The path an open descriptor resolves to. On Linux it is read from `/proc/self/fd`, which names the object the
 * descriptor holds whatever happened to the path since; elsewhere the path is resolved again, which still refuses a
 * directory on the way that is a link.
 * @param fd - the open descriptor.
 * @param path - the absolute path it was opened at.
 * @returns the real path of what the descriptor holds.
 */
export async function descriptorPath(fd: number, path: string): Promise<string> {
  try {
    return await readlink(`/proc/self/fd/${String(fd)}`)
  } catch (error: unknown) {
    // ENOENT: no procfs on this platform.
    void error
    return realpath(path)
  }
}

/**
 * Open one directory for listing: the descriptor on Linux, so the listing reads what was opened, and the path
 * elsewhere.
 * @param fd - the open descriptor.
 * @param path - the absolute path it was opened at.
 * @returns the directory stream.
 */
export async function openDirectoryAt(fd: number, path: string): Promise<Dir> {
  try {
    return await opendir(`/proc/self/fd/${String(fd)}`)
  } catch (error: unknown) {
    // ENOENT: no procfs on this platform; the descriptor's path was proved before the listing.
    void error
    return opendir(path)
  }
}

/**
 * The reader of one stock home. It counts every name it lists, so a home that
 * holds more entries than the limit is refused before the walk reads them all.
 */
export class SourceReader {
  private listed = 0
  private readonly links = new Map<string, number>()
  private readonly directories = new Map<string, string>()

  /** The absolute, real path of the stock home. */
  readonly root: string
  /** The most names the walk lists before it refuses the home. */
  private readonly maxEntries: number
  /** The device of the home's root; an entry on another device is left behind. */
  readonly rootDevice: number
  /** The file-system calls a spec stages a change between; the real ones by default. */
  private readonly probe: SourceProbe

  /**
   * @param root - the absolute, real path of the stock home.
   * @param maxEntries - the most names the walk lists before it refuses the home.
   * @param rootDevice - the device of the home's root; an entry on another device is left behind.
   * @param probe - the file-system calls a spec stages a change between; the real ones by default.
   */
  constructor(root: string, maxEntries: number, rootDevice: number, probe: SourceProbe = REAL_PROBE) {
    this.root = root
    this.maxEntries = maxEntries
    this.rootDevice = rootDevice
    this.probe = probe
    this.directories.set('', '')
  }

  /**
   * Classify one entry without following it.
   * @param path - the entry's path relative to the home.
   * @returns a directory, a regular file with its identity, or the reason it is refused.
   * @throws DshImportError `DSH_IMPORT_SOURCE_UNUSABLE` when the entry cannot be read.
   */
  async inspect(path: string): Promise<InspectedEntry> {
    let stats: Stats
    try {
      stats = await this.probe.lstat(join(this.root, path))
    } catch (error: unknown) {
      throw new DshImportError('DSH_IMPORT_SOURCE_UNUSABLE', `the stock home's entry ${JSON.stringify(path)} could not be read (${systemCode(error)})`, path)
    }
    if (stats.isSymbolicLink()) return { kind: 'refused', reason: 'symbolic-link' }
    if (stats.dev !== this.rootDevice) return { kind: 'refused', reason: 'mount-point' }
    if (stats.isDirectory()) {
      this.directories.set(path, linkKey(stats))
      return { kind: 'directory' }
    }
    if (!stats.isFile()) return { kind: 'refused', reason: 'special-file' }
    const key = linkKey(stats)
    this.links.set(key, (this.links.get(key) ?? 0) + 1)
    return { kind: 'file', file: { path, size: stats.size, dev: stats.dev, ino: stats.ino, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, nlink: stats.nlink, mode: stats.mode & 0o777 } }
  }

  /**
   * Whether a file has a hard link the walk did not meet inside the stock home.
   * @param file - a file the walk recorded.
   * @returns true when the file has more links than the walk met, so it may be a file from outside the stock home.
   */
  escapes(file: DshImportFile): boolean {
    return file.nlink > (this.links.get(linkKey(file)) ?? 0)
  }

  /**
   * List one directory's names, from a descriptor proved to be the directory the walk inspected.
   * @param path - the directory's path relative to the home, `''` for the home itself.
   * @returns the names in code-unit order, so a plan lists the same order on every run.
   * @throws DshImportError `DSH_IMPORT_SOURCE_UNUSABLE` when the directory cannot be read, `DSH_IMPORT_SOURCE_CHANGED` when it is no longer the one the walk inspected, and `DSH_IMPORT_TOO_MANY_ENTRIES` past the entry limit.
   */
  async list(path: string): Promise<string[]> {
    const absolute = join(this.root, path)
    const named = path === '' ? 'the stock home' : `the stock home's directory ${JSON.stringify(path)}`
    await this.probe.beforeOpen(path)
    let handle: FileHandle
    try {
      handle = await open(absolute, DIRECTORY_FLAGS)
    } catch (error: unknown) {
      throw new DshImportError('DSH_IMPORT_SOURCE_UNUSABLE', `${named} could not be read (${systemCode(error)})`, path === '' ? undefined : path)
    }
    const names: string[] = []
    try {
      const stats = await handle.stat()
      const expected = this.directories.get(path)
      if (stats.dev !== this.rootDevice || (expected !== '' && expected !== linkKey(stats)) || await descriptorPath(handle.fd, absolute) !== absolute) {
        throw new DshImportError('DSH_IMPORT_SOURCE_CHANGED', `${named} changed after the import read it: another directory or a link stands at its path. Stop DeepSeek Harness and run the import again.`, path === '' ? undefined : path)
      }
      for await (const entry of await openDirectoryAt(handle.fd, absolute)) {
        this.listed += 1
        if (this.listed > this.maxEntries) {
          throw new DshImportError('DSH_IMPORT_TOO_MANY_ENTRIES', `the stock home holds more than ${String(this.maxEntries)} entries, which is more than one import reads`)
        }
        names.push(entry.name)
      }
    } finally {
      await handle.close()
    }
    return names.sort(compareNames)
  }

  /**
   * Read one file whole.
   * @param file - the file as the walk recorded it.
   * @returns its bytes.
   * @throws DshImportError `DSH_IMPORT_SOURCE_CHANGED` when the file is no longer the one the walk recorded.
   */
  async read(file: DshImportFile): Promise<Buffer> {
    const chunks: Buffer[] = []
    await this.stream(file, (chunk) => { chunks.push(Buffer.from(chunk)) })
    return Buffer.concat(chunks)
  }

  /**
   * Hash one file, handing each chunk to a reader of its content too.
   * @param file - the file as the walk recorded it.
   * @param sink - receives each chunk after it is hashed, and is awaited before the next read; it must copy a chunk it keeps.
   * @returns the lowercase hexadecimal SHA-256 of its bytes.
   * @throws DshImportError `DSH_IMPORT_SOURCE_CHANGED` when the file is no longer the one the walk recorded.
   */
  async hash(file: DshImportFile, sink?: (chunk: Uint8Array) => Promise<void>): Promise<string> {
    const hash = createHash('sha256')
    await this.stream(file, async (chunk) => {
      hash.update(chunk)
      await sink?.(chunk)
    })
    return hash.digest('hex')
  }

  /**
   * Copy one file into a new file the caller names.
   * @param file - the file as the walk recorded it.
   * @param destination - the absolute path of the copy, which must not exist; it is created with the file's owner permission bits and none for anyone else.
   * @returns the lowercase hexadecimal SHA-256 of the bytes copied.
   * @throws DshImportError `DSH_IMPORT_SOURCE_CHANGED` when the file is no longer the one the walk recorded, and `DSH_IMPORT_STAGING_FAILED` when the copy cannot be written.
   */
  async copy(file: DshImportFile, destination: string): Promise<string> {
    let output: FileHandle
    try {
      // `wx` fails on an existing path, so a copy never replaces a file it did not create.
      output = await open(destination, 'wx', file.mode & 0o700)
    } catch (error: unknown) {
      throw new DshImportError('DSH_IMPORT_STAGING_FAILED', `the import could not stage ${JSON.stringify(file.path)} (${systemCode(error)})`, file.path)
    }
    const hash = createHash('sha256')
    try {
      await this.stream(file, async (chunk) => {
        hash.update(chunk)
        await output.write(chunk)
      })
    } finally {
      await output.close()
    }
    return hash.digest('hex')
  }

  /**
   * Read one file chunk by chunk, after proving it is the file the walk recorded at the walked path, and prove it
   * again afterwards.
   * @param file - the file as the walk recorded it.
   * @param sink - receives each chunk in order and is awaited before the next read; it must copy a chunk it keeps.
   * @throws DshImportError `DSH_IMPORT_SOURCE_CHANGED` when the file is no longer the one the walk recorded.
   */
  private async stream(file: DshImportFile, sink: (chunk: Uint8Array) => void | Promise<void>): Promise<void> {
    const absolute = join(this.root, file.path)
    await this.probe.beforeOpen(file.path)
    let handle: FileHandle
    try {
      handle = await open(absolute, READ_FLAGS)
    } catch (error: unknown) {
      throw changed(file, `it could not be opened (${systemCode(error)})`)
    }
    try {
      checkIdentity(file, await handle.stat())
      if (await descriptorPath(handle.fd, absolute) !== absolute) throw changed(file, 'it is reached through a link')
      const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, Math.max(file.size, 1)))
      let total = 0
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, total)
        if (bytesRead === 0) break
        total += bytesRead
        if (total > file.size) throw changed(file, 'it grew while it was read')
        await sink(buffer.subarray(0, bytesRead))
      }
      if (total !== file.size) throw changed(file, 'it shrank while it was read')
      checkIdentity(file, await handle.stat())
    } finally {
      await handle.close()
    }
  }
}

/**
 * Refuse an open file that is not the file the walk recorded.
 * @param file - the file as the walk recorded it.
 * @param stats - the open descriptor's status.
 * @throws DshImportError `DSH_IMPORT_SOURCE_CHANGED` for another type, link count, device, inode, size, modification time or status-change time.
 */
function checkIdentity(file: DshImportFile, stats: Stats): void {
  if (!stats.isFile() || stats.nlink !== file.nlink || stats.dev !== file.dev || stats.ino !== file.ino) throw changed(file, 'another file stands at its path')
  if (stats.size !== file.size || stats.mtimeMs !== file.mtimeMs || stats.ctimeMs !== file.ctimeMs) throw changed(file, 'it was written to after the import read the stock home')
}

/**
 * The key of one inode.
 * @param stats - a status or a recorded file.
 * @returns its device and inode.
 */
function linkKey(stats: { readonly dev: number, readonly ino: number }): string {
  return `${String(stats.dev)}:${String(stats.ino)}`
}

/**
 * The refusal of a stock file that changed after the walk.
 * @param file - the file.
 * @param why - what changed.
 * @returns the refusal, for the caller to throw.
 */
function changed(file: DshImportFile, why: string): DshImportError {
  return new DshImportError(
    'DSH_IMPORT_SOURCE_CHANGED',
    `the stock home's file ${JSON.stringify(file.path)} changed: ${why}. Stop DeepSeek Harness and run the import again.`,
    file.path,
  )
}

/**
 * Compare two names by their code units.
 * @param left - one name.
 * @param right - the other name.
 * @returns their order, the same on every platform.
 */
export function compareNames(left: string, right: string): number {
  return Number(left > right) - Number(left < right)
}
