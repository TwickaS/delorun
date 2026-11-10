/**
 * Temporary directories and folder fixtures for the Changes specs.
 *
 * @module @delo/changes/tests/support
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect } from 'vitest'
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
