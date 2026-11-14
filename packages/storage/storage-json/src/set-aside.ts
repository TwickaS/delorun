/**
 * File-level recovery helpers of a recoverable JSON unit: the rolling `.previous` copy and the
 * `<file>.quarantined-<UTC timestamp>.json` set-aside files. Nothing here deletes or overwrites an
 * earlier quarantine file; the `delorun` recovery commands use the same helpers.
 * @module @deepseek-ai/dsh-storage-json/src/set-aside
 */

import { link, open, readFile, unlink } from 'node:fs/promises'
import { writeAtomic } from './atomic.ts'

/** Owner-only mode of the backup and set-aside files, like the unit file. */
const FILE_MODE = 0o600

/**
 * Path of the rolling backup of a unit file.
 * @param path - Unit file path.
 * @returns the path of the previous good copy.
 */
export function previousPath(path: string): string {
  return `${path}.previous`
}

/**
 * Candidate set-aside path for a unit file.
 * @param path - Unit file path.
 * @param at - Time the file is set aside.
 * @param attempt - Zero for the first candidate; a larger number adds a suffix when the name is taken.
 * @returns `<path>.quarantined-<UTC timestamp>[-n].json`, with `:` and `.` of the ISO time replaced by `-`.
 */
export function quarantinePath(path: string, at: Date, attempt: number): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-')
  return `${path}.quarantined-${stamp}${attempt === 0 ? '' : `-${String(attempt)}`}.json`
}

/**
 * Whether an error is an `EEXIST` from a no-clobber create.
 * @param error - Caught value.
 * @returns true for `EEXIST`.
 */
function isExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}

/**
 * Move a file aside to a fresh quarantine name without overwriting an earlier quarantine file.
 * @param path - File to move; it no longer exists at `path` afterwards.
 * @param at - Time stamped into the name.
 * @returns the quarantine path.
 */
export async function setAsideFile(path: string, at: Date = new Date()): Promise<string> {
  for (let attempt = 0;; attempt += 1) {
    const target = quarantinePath(path, at, attempt)
    try {
      await link(path, target)
    } catch (error) {
      if (isExists(error)) continue
      throw error
    }
    await unlink(path)
    return target
  }
}

/**
 * Write text to a fresh quarantine file next to a unit file, never replacing an earlier one.
 * @param path - Unit file path the quarantine file is named after.
 * @param text - Complete file content.
 * @param at - Time stamped into the name.
 * @returns the quarantine path.
 */
export async function writeSetAside(path: string, text: string, at: Date = new Date()): Promise<string> {
  for (let attempt = 0;; attempt += 1) {
    const target = quarantinePath(path, at, attempt)
    let handle
    try {
      handle = await open(target, 'wx', FILE_MODE)
    } catch (error) {
      if (isExists(error)) continue
      throw error
    }
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    return target
  }
}

/**
 * Keep the current content of a unit file as its single rolling backup, replaced atomically.
 * @param path - Unit file path; nothing happens when it does not exist.
 * @returns resolution once the backup is durable.
 */
export async function rotatePrevious(path: string): Promise<void> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  await writeAtomic(previousPath(path), text)
}
