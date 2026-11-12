/**
 * The files an MCP server start runs, pinned by canonical path and contents. A stdio server's executable, and every
 * argument that names an existing regular file, such as the script an interpreter runs, are followed through every
 * symbolic link to the file itself and hashed with SHA-256, so an acceptance covers what those files hold: a file
 * rewritten in place, or a link pointed at another file, is a start the person has not accepted. A directory an
 * argument names is not hashed, and neither is a file the program loads by itself, such as a module the script
 * imports.
 *
 * A file is read through one open handle: its device, inode, size, modification and change times are read before and
 * after the read and must agree, and its path must resolve to the same file afterwards, or the pin is refused. The
 * hasher keeps each file's digest in this process under those five values and reads the file again when one differs;
 * a digest is kept only when the file's change time is {@link SETTLED_MS} old, because a write within the file
 * system's timestamp granularity can leave every value unchanged.
 *
 * @module @delo/plugin-mcp-consent/pins
 */
import { createHash } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { McpServerCommand } from '@deepseek-ai/dsh-mcp-client'
import type { PinnedFile } from './wire.ts'

/** A server start with the files it runs, pinned when the start was reviewed. */
export type PinnedStart = McpServerCommand & {
  /** The executable first, then each argument that names a regular file, in argument order. */
  readonly files: readonly PinnedFile[]
}

/** How old a file's change time must be, in milliseconds, before its digest is kept for the next review. */
export const SETTLED_MS = 2000

/** The size of one read while a file is hashed, in bytes. */
const READ_BYTES = 1 << 20

/** A file of a start that could not be pinned, so no acceptance covers the start. */
export class FilePinError extends Error {
  /** The path the start names. */
  readonly path: string

  /**
   * @param path - the path the start names.
   * @param reason - why the file could not be pinned.
   * @param options - the failure behind it, when one stands behind it.
   */
  constructor(path: string, reason: string, options?: ErrorOptions) {
    super(`the file ${JSON.stringify(path)} ${reason}`, options)
    this.name = 'FilePinError'
    this.path = path
  }
}

/** A digest kept for a file, with the values its file had when it was read. */
export interface CachedDigest {
  /** The device, inode, size, modification and change times the file had. */
  readonly key: string
  /** The digest of its contents. */
  readonly sha256: string
}

/** What a {@link FileHasher} reads besides the file system. */
export interface FileHasherOptions {
  /** The clock compared with a file's change time; defaults to {@link Date.now}. */
  readonly now?: () => number
  /** The digests kept between reviews, by canonical path; defaults to a new map. */
  readonly cache?: Map<string, CachedDigest>
}

/**
 * The values that change when a file is replaced or written: device, inode, size, modification and change times.
 * @param info - the file's status, in nanoseconds.
 * @returns the values as one text.
 */
function keyOf(info: { dev: bigint, ino: bigint, size: bigint, mtimeNs: bigint, ctimeNs: bigint }): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
}

/** Pins the files of server starts; one per consent service, so its digests live as long as the service. */
export class FileHasher {
  private readonly now: () => number
  private readonly cache: Map<string, CachedDigest>

  /**
   * @param options - the clock and the digest cache.
   */
  constructor(options: FileHasherOptions = {}) {
    this.now = options.now ?? Date.now
    this.cache = options.cache ?? new Map()
  }

  /**
   * Pin one file by its canonical path and the digest of its contents.
   * @param path - an absolute path, which may be a symbolic link.
   * @returns the canonical path and the digest.
   * @throws {FilePinError} when the path does not resolve, is not a regular file, changed while it was read, or
   *   resolves to another file after the read.
   */
  async pin(path: string): Promise<Omit<PinnedFile, 'argument'>> {
    let canonical: string
    try {
      canonical = await realpath(path)
    } catch (error) {
      throw new FilePinError(path, 'does not exist or cannot be resolved', { cause: error })
    }
    const sha256 = await this.digest(canonical)
    if (await realpath(path).catch(() => undefined) !== canonical) throw new FilePinError(path, 'resolved to another file while it was read')
    return { path: canonical, sha256 }
  }

  /**
   * The files a start runs: its resolved executable, and each argument that, resolved against the start's working
   * directory, names an existing regular file.
   * @param start - the start under review.
   * @returns the executable's pin, then each argument's pin in order.
   * @throws {FilePinError} when one of those files cannot be pinned.
   */
  async pinsOf(start: McpServerCommand): Promise<readonly PinnedFile[]> {
    const pins: PinnedFile[] = [await this.pin(start.resolvedCommand)]
    for (const [index, argument] of start.args.entries()) {
      if (argument.length === 0) continue
      const candidate = resolve(start.resolvedCwd, argument)
      const info = await stat(candidate).catch(() => undefined)
      if (info?.isFile() !== true) continue
      pins.push({ argument: index, ...await this.pin(candidate) })
    }
    return pins
  }

  /**
   * The digest of a file's contents, read through one handle, or the kept digest while its status is unchanged.
   * @param canonical - the file's canonical path.
   * @returns `sha256:` and the hexadecimal digest.
   * @throws {FilePinError} when it is not a regular file or changed while it was read.
   */
  private async digest(canonical: string): Promise<string> {
    const handle = await open(canonical, 'r').catch((error: unknown) => {
      throw new FilePinError(canonical, 'cannot be opened for reading', { cause: error })
    })
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile()) throw new FilePinError(canonical, 'is not a regular file')
      const key = keyOf(before)
      const kept = this.cache.get(canonical)
      if (kept?.key === key) return kept.sha256
      const hash = createHash('sha256')
      const buffer = Buffer.alloc(READ_BYTES)
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, READ_BYTES, null)
        if (bytesRead === 0) break
        hash.update(buffer.subarray(0, bytesRead))
      }
      if (keyOf(await handle.stat({ bigint: true })) !== key) throw new FilePinError(canonical, 'changed while it was read')
      const sha256 = `sha256:${hash.digest('hex')}`
      if (this.now() - Number(before.ctimeMs) >= SETTLED_MS) this.cache.set(canonical, { key, sha256 })
      return sha256
    } finally {
      await handle.close()
    }
  }
}
