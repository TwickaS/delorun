/**
 * Whole-file captures around file-tool edits: the content of a path before
 * the turn's first mutation of it and at turn end, stored content-addressed
 * under the Session's private directory so both sides of a comparison
 * survive later edits without depending on git.
 */
import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isMissing, openRegularFile, writeNewFile, type PrivateTree } from './files.ts'

/** Bytes git inspects for a NUL byte before treating content as binary. */
const BINARY_PROBE_BYTES = 8000

/** One captured side of a path. */
export type Capture =
  /** No file at the path. */
  | { kind: 'absent' }
  /** A regular file larger than the configured cap; its content is not stored. */
  | { kind: 'oversized' }
  /** A stored copy, named by the SHA-1 of its bytes. */
  | { kind: 'file'; file: string; binary: boolean }

/** SHA-1 of bytes as lowercase hex. */
function digest(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex')
}

/**
 * Content-addressed copies in a `captures` directory this store creates exclusively inside the private directory.
 * The store remembers every copy it wrote: identical content reuses that copy, while an existing entry it did not
 * write is refused. A copy is read back only as a regular file whose bytes still hash to its name. Callers do not
 * overlap calls to {@link CaptureStore.capture}.
 */
export class CaptureStore {
  private directory: Promise<string> | undefined
  /** The tree the copies live in, verified before every write and read. */
  private tree: PrivateTree | undefined
  /** Names of the copies this store wrote. */
  private readonly written = new Set<string>()

  /**
   * @param parent - yields the private directory's tree to hold `captures`, verified; called before every write.
   */
  constructor(private readonly parent: () => Promise<PrivateTree>) {}

  /**
   * Store the current content of one path. The path's type is read without following a link and before it is
   * opened, so a named pipe or device is never opened; the open itself never blocks and is checked again. At most
   * `maxBytes + 1` bytes are read, so a file that grows past the cap while it is read costs no more memory than the cap.
   * @param absolute - canonical absolute path of the file.
   * @param maxBytes - inclusive byte cap on a stored copy.
   * @returns the capture, or undefined for a path that is neither absent nor a regular file.
   * @throws when the path cannot be read for a reason other than absence, it changed type while being opened, or
   *   the copy cannot be written, including when an entry this store did not write holds its name.
   */
  async capture(absolute: string, maxBytes: number): Promise<Capture | undefined> {
    try {
      if (!(await lstat(absolute)).isFile()) return undefined
    } catch (error: unknown) {
      /* v8 ignore next -- an unreadable present path needs permissions the tests cannot revoke on every host. */
      if (!isMissing(error)) throw error
      return { kind: 'absent' }
    }
    const handle = await openRegularFile(absolute)
    let bytes: Buffer
    try {
      const probe = Buffer.allocUnsafe(maxBytes + 1)
      let length = 0
      while (length < probe.length) {
        const { bytesRead } = await handle.read(probe, length, probe.length - length, length)
        if (bytesRead === 0) break
        length += bytesRead
      }
      if (length > maxBytes) return { kind: 'oversized' }
      bytes = probe.subarray(0, length)
    } finally {
      await handle.close()
    }
    const tree = await this.parent()
    this.tree = tree
    this.directory ??= tree.directory('captures')
    const name = digest(bytes)
    const file = join(await this.directory, name)
    if (!this.written.has(name)) {
      await tree.verify()
      await writeNewFile(file, bytes)
      this.written.add(name)
    }
    return { kind: 'file', file, binary: bytes.subarray(0, BINARY_PROBE_BYTES).includes(0) }
  }

  /**
   * The text of a stored copy.
   * @param capture - a copy this store returned.
   * @param signal - cancels the read.
   * @returns the copy decoded as UTF-8.
   * @throws when the read is aborted, or the copy is no longer a regular file or its bytes no longer hash to its name.
   */
  async read(capture: Extract<Capture, { kind: 'file' }>, signal: AbortSignal): Promise<string> {
    // A stored copy exists only after a write, which set the tree.
    await (this.tree as PrivateTree).verify()
    const handle = await openRegularFile(capture.file)
    let bytes: Buffer
    try {
      bytes = await handle.readFile({ signal })
    } finally {
      await handle.close()
    }
    if (digest(bytes) !== basename(capture.file)) throw new Error(`captured copy ${capture.file} changed after it was written`)
    return bytes.toString('utf8')
  }
}

/**
 * Whether two captures are known to hold the same content. Two absent sides
 * are the same; two stored copies are the same when their bytes hash alike;
 * an oversized side is never known to match anything, since its content was
 * not read.
 * @param a - one side.
 * @param b - the other side.
 * @returns true only when both sides are known to match.
 */
export function sameCapture(a: Capture, b: Capture): boolean {
  if (a.kind === 'absent' || b.kind === 'absent') return a.kind === b.kind
  return a.kind === 'file' && b.kind === 'file' && a.file === b.file
}
