/**
 * The replay-only overlay a recorded-session adapter adds to every process it
 * starts: `DSH_SNAPSHOT_PATCH` names one Cordis patch file, which follows the
 * process's root configuration and precedes every scenario layer, so a
 * scenario's own replay layer keeps the last word. Record and refresh write
 * committed fixtures and expected output, so they refuse the variable.
 */

import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** The variable naming the overlay. */
export const SNAPSHOT_PATCH_ENV = 'DSH_SNAPSHOT_PATCH'

/**
 * The overlay the variable selects, checked against the snapshot mode. Call it when the adapter module loads, before
 * any process starts.
 * @param mode - the adapter's `DSH_SNAPSHOT` value; unset, empty and `replay` replay.
 * @param env - the environment to read.
 * @returns the overlay's absolute path in a one-element list, or an empty list when the variable is unset or empty.
 * @throws Error when the variable is set in `record` or `refresh` mode, or names no file.
 */
export function snapshotPatchOverlay(mode: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  const value = env[SNAPSHOT_PATCH_ENV]
  if (value === undefined || value === '') return []
  if (mode === 'record' || mode === 'refresh') {
    throw new Error(`${SNAPSHOT_PATCH_ENV} selects a replay-only overlay and is refused in DSH_SNAPSHOT=${mode} mode, which writes fixtures and expected output; unset it to ${mode}`)
  }
  const path = isAbsolute(value) ? value : resolve(value)
  if (!existsSync(path)) throw new Error(`${SNAPSHOT_PATCH_ENV} names no file: ${path}`)
  return [path]
}

/**
 * A process's patch list with the overlay after its first patch, the root configuration.
 * @param patches - the patches in load order, the root configuration first.
 * @param overlay - the result of {@link snapshotPatchOverlay}.
 * @returns a new list; `patches` unchanged when the overlay is empty.
 */
export function withSnapshotPatch<T>(patches: readonly T[], overlay: readonly T[]): T[] {
  return [...patches.slice(0, 1), ...overlay, ...patches.slice(1)]
}
