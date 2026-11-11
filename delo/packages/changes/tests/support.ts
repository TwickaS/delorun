/**
 * Temporary directories and folder fixtures for the Changes specs.
 *
 * @module @delo/changes/tests/support
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, vi } from 'vitest'
import { ChangesError, type ChangesCode } from '../src/errors.ts'

const created: string[] = []

afterEach(() => {
  for (const directory of created.splice(0)) {
    chmodTree(directory)
    rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * Give every directory below a root its owner bits back, so a test that took them away can still be cleaned up.
 * @param root - the directory.
 */
function chmodTree(root: string): void {
  execFileSync('chmod', ['-R', 'u+rwx', root], { timeout: 30_000 })
}

/**
 * A new empty directory under the system's temporary directory, removed after the test.
 * @param prefix - the name prefix.
 * @returns its real path.
 */
export function temporaryDirectory(prefix = 'delo-changes-'): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  created.push(directory)
  return directory
}

/**
 * Write files below a root, creating their directories.
 * @param root - the directory.
 * @param files - contents by relative `/`-separated path.
 */
export function writeFiles(root: string, files: Readonly<Record<string, string | Uint8Array>>): void {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'))
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }
}

/**
 * Create a FIFO.
 * @param path - where.
 */
export function makeFifo(path: string): void {
  execFileSync('mkfifo', [path], { timeout: 30_000 })
}

/**
 * A path's permission bits.
 * @param path - the path.
 * @returns the low nine mode bits.
 */
export function modeOf(path: string): number {
  return lstatSync(path).mode & 0o777
}

/**
 * Take every permission from a path, for a test of a filesystem error.
 * @param path - the path.
 */
export function lockOut(path: string): void {
  chmodSync(path, 0o000)
}

/**
 * The prototype every `FileHandle` of `node:fs/promises` shares, whose methods a spec replaces to watch or alter reads.
 * @returns the prototype.
 */
async function fileHandlePrototype(): Promise<FileHandle> {
  const handle = await open(import.meta.filename, 'r')
  try {
    return Object.getPrototypeOf(handle) as FileHandle
  } finally {
    await handle.close()
  }
}

/**
 * Make every open handle of one file report a smaller size than it holds, as a file that grows after its status was
 * read does, until the returned function is called.
 * @param path - the file.
 * @param size - the size its handles report.
 * @returns what puts the handles' status back.
 */
export async function understateSize(path: string, size: number): Promise<() => void> {
  const { dev, ino } = statSync(path)
  const prototype = await fileHandlePrototype()
  const original = prototype.stat
  const spy = vi.spyOn(prototype, 'stat').mockImplementation(async function (this: FileHandle) {
    const stats = await original.call(this)
    if (stats.dev === dev && stats.ino === ino) stats.size = size
    return stats
  })
  return () => { spy.mockRestore() }
}

/**
 * Count the bytes every open handle of one file reads, until the returned `restore` is called. The file is known by
 * its device and inode now, which rewriting it in place keeps.
 * @param path - the file.
 * @returns the bytes read so far and what stops counting.
 */
export async function countReads(path: string): Promise<{ readonly read: () => number, readonly restore: () => void }> {
  const { dev, ino } = statSync(path)
  const prototype = await fileHandlePrototype()
  const original = prototype.read as (this: FileHandle, buffer: Buffer, offset: number, length: number, position: number | null) => Promise<{ bytesRead: number, buffer: Buffer }>
  let read = 0
  const spy = vi.spyOn(prototype, 'read').mockImplementation(async function (this: FileHandle, buffer: Buffer, offset: number, length: number, position: number | null) {
    const result = await original.call(this, buffer, offset, length, position)
    const stats = await this.stat()
    if (stats.dev === dev && stats.ino === ino) read += result.bytesRead
    return result
  } as FileHandle['read'])
  return { read: () => read, restore: () => { spy.mockRestore() } }
}

/**
 * The ChangesError a promise rejects with, checked for its code.
 * @param promise - the call.
 * @param code - the expected code.
 * @returns the error.
 */
export async function rejection(promise: Promise<unknown>, code: ChangesCode): Promise<ChangesError> {
  const error: unknown = await promise.then(() => undefined, (reason: unknown) => reason)
  expect(error).toBeInstanceOf(ChangesError)
  expect((error as ChangesError).code).toBe(code)
  return error as ChangesError
}
