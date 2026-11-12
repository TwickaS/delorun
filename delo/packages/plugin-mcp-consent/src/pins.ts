/**
 * The files an MCP server start runs, pinned by canonical path and contents. A stdio server's executable, and every
 * argument that names an existing regular file, such as the script an interpreter runs, are followed through every
 * symbolic link to the file itself and hashed with SHA-256, so an acceptance covers what those files hold: a file
 * rewritten in place, or a link pointed at another file, is a start the person has not accepted. An argument of the
 * form `--option=value`, such as `--import=./hook.js` or `--require=./hook.js`, pins the file its value names when the
 * whole argument names none. A directory an argument names is not hashed, and neither is a file the program loads by
 * itself, such as a module the script imports.
 *
 * A file is read through one handle opened without following a final symbolic link and without waiting, so a path
 * swapped for a FIFO or a device is refused instead of hanging the review: the handle's own status must name a regular
 * file, its device, inode, size, modification and change times are read before and after the read and must agree, and
 * the path must resolve to the same file afterwards, or the pin is refused. Every pin reads the file again; no digest
 * is kept between reviews, because a file system that does not maintain change times (drvfs, 9p, some FUSE mounts)
 * lets an in-place rewrite keep every status value.
 *
 * @module @delo/plugin-mcp-consent/pins
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { McpServerCommand } from '@deepseek-ai/dsh-mcp-client'
import type { PinnedFile } from './wire.ts'

/** A server start with the files it runs, pinned when the start was reviewed. */
export type PinnedStart = McpServerCommand & {
  /** The executable first, then each argument that names a regular file, in argument order. */
  readonly files: readonly PinnedFile[]
}

/** The size of one read while a file is hashed, in bytes. */
const READ_BYTES = 1 << 20

/**
 * How a pinned file is opened: for reading, without waiting for a writer of a FIFO, and refusing a final symbolic link
 * that replaced the canonical path. Windows defines neither of the last two flags, so each ORs in as 0 there, and its
 * paths name no FIFO.
 */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW

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

/**
 * The values that change when a file is replaced or written: device, inode, size, modification and change times.
 * @param info - the file's status, in nanoseconds.
 * @returns the values as one text.
 */
function keyOf(info: { dev: bigint, ino: bigint, size: bigint, mtimeNs: bigint, ctimeNs: bigint }): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
}

/**
 * Pin one file by its canonical path and the digest of its contents.
 * @param path - an absolute path, which may be a symbolic link.
 * @returns the canonical path and the digest.
 * @throws {FilePinError} when the path does not resolve, is not a regular file, changed while it was read, or resolves
 *   to another file after the read.
 */
export async function pinFile(path: string): Promise<Omit<PinnedFile, 'argument'>> {
  let canonical: string
  try {
    canonical = await realpath(path)
  } catch (error) {
    throw new FilePinError(path, 'does not exist or cannot be resolved', { cause: error })
  }
  const sha256 = await digestOf(canonical)
  if (await realpath(path).catch(() => undefined) !== canonical) throw new FilePinError(path, 'resolved to another file while it was read')
  return { path: canonical, sha256 }
}

/**
 * The regular file an argument names, resolved against the start's working directory: the whole argument, or else the
 * value after the first `=` of an argument that starts with `-`.
 * @param cwd - the start's canonical working directory.
 * @param argument - the argument.
 * @returns the absolute path, or `undefined` when the argument names no regular file.
 */
async function fileNamedBy(cwd: string, argument: string): Promise<string | undefined> {
  const equals = argument.indexOf('=')
  const candidates = argument.startsWith('-') && equals > 0 ? [argument, argument.slice(equals + 1)] : [argument]
  for (const candidate of candidates) {
    if (candidate.length === 0) continue
    const path = resolve(cwd, candidate)
    if ((await stat(path).catch(() => undefined))?.isFile() === true) return path
  }
  return undefined
}

/**
 * The files a start runs: its resolved executable, and each argument that, resolved against the start's working
 * directory, names an existing regular file, by itself or as the value of an `--option=value` argument.
 * @param start - the start under review.
 * @returns the executable's pin, then each argument's pin in order.
 * @throws {FilePinError} when one of those files cannot be pinned.
 */
export async function pinsOf(start: McpServerCommand): Promise<readonly [PinnedFile, ...PinnedFile[]]> {
  const pins: [PinnedFile, ...PinnedFile[]] = [await pinFile(start.resolvedCommand)]
  for (const [index, argument] of start.args.entries()) {
    const path = await fileNamedBy(start.resolvedCwd, argument)
    if (path !== undefined) pins.push({ argument: index, ...await pinFile(path) })
  }
  return pins
}

/**
 * The digest of a file's contents, read through one handle.
 * @param canonical - the file's canonical path.
 * @returns `sha256:` and the hexadecimal digest.
 * @throws {FilePinError} when it cannot be opened, is not a regular file or changed while it was read.
 */
async function digestOf(canonical: string): Promise<string> {
  const handle = await open(canonical, OPEN_FLAGS).catch((error: unknown) => {
    throw new FilePinError(canonical, 'cannot be opened for reading', { cause: error })
  })
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new FilePinError(canonical, 'is not a regular file')
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(READ_BYTES)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, READ_BYTES, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    if (keyOf(await handle.stat({ bigint: true })) !== keyOf(before)) throw new FilePinError(canonical, 'changed while it was read')
    return `sha256:${hash.digest('hex')}`
  } finally {
    await handle.close()
  }
}
