/**
 * Watching the per-workspace permission store for a change another process wrote — another profile's Host,
 * `delorun workspace full-access` — so a Host reads it again within a second instead of at its next decision. The
 * watch covers the store's directory, because every write renames a new file over the store's path, and is filtered
 * to the store's file name. A watch that cannot start, or fails later, is closed and reported once; the Host then
 * reads the store again at its next decision, as it does in every case.
 *
 * @module @delorun/plugin-permission-defaults/watch
 */
import { mkdirSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import { PRIVATE_DIR_MODE } from '@delorun/contract-home-layout'
import { DANGEROUS_GRANT_FILE } from './store.ts'

/**
 * How long a watch waits after the last change event before it reports a change, in milliseconds: one write raises
 * several events (the temporary file's creation, the rename), and they are reported once.
 */
export const PERMISSION_STORE_WATCH_DEBOUNCE_MS = 100

/** What a watch calls. */
export interface PermissionStoreWatchCalls {
  /** Called once per burst of changes to the store's file. */
  readonly changed: () => void
  /**
   * Called once when the watch cannot start or fails; the watch is closed and calls nothing after it.
   * @param error - the failure.
   */
  readonly failed: (error: unknown) => void
}

/**
 * Watch the store's file and the dangerous-mode grant file beside it. Its directory is created at the private directory mode when missing, so a store not yet
 * written is watched too.
 * @param path - the store's absolute path.
 * @param calls - the change and failure calls.
 * @param grantFile - the dangerous-mode grant file's name in the same directory, whose changes are reported too.
 * @returns the function that closes the watch and drops a pending change.
 */
export function watchPermissionStore(path: string, calls: PermissionStoreWatchCalls, grantFile: string = DANGEROUS_GRANT_FILE): () => void {
  const file = basename(path)
  let timer: NodeJS.Timeout | undefined
  let watcher: FSWatcher | undefined
  const close = (): void => {
    clearTimeout(timer)
    timer = undefined
    watcher?.close()
    watcher = undefined
  }
  try {
    mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE })
    watcher = watch(dirname(path), { persistent: false }, (_event, name) => {
      // A platform that names no file reports some change in the directory; it is read as the store's.
      if (name !== null && name !== file && name !== grantFile) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        calls.changed()
      }, PERMISSION_STORE_WATCH_DEBOUNCE_MS)
    })
  } catch (error) {
    close()
    calls.failed(error)
    return close
  }
  watcher.on('error', (error) => {
    close()
    calls.failed(error)
  })
  return close
}
