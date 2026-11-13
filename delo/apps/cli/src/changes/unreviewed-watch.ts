/**
 * The home process's live reload while protection is off (contract C21, "The protection setting"): each settled change
 * in a linked plugin's folder loads in the running Host through [`loadUnreviewed`](../../../../packages/changes/src/unreviewed.ts),
 * which approves the folder's content, records it as an applied change decided `unreviewed` and one profile history
 * version, and reloads the Host as `changes.reload` does ([reload](./reload.ts)); a failed reload goes back to the
 * content that ran before and is logged.
 *
 * The watcher follows `changes/protection.json` and the profile's `package.json`, so turning protection on or off and a
 * plugin linked or removed while Delo runs change which folders it watches without a restart. While protection is on it
 * watches no folder. Each folder is watched recursively, leaving out `.git`; events are debounced per plugin as a work
 * session's are ([work watch](./work-watch.ts)), and loads run one at a time under the profile write lock. A plugin in a
 * work session is left to that session.
 *
 * @module @delo/cli/changes/unreviewed-watch
 */
import { mkdirSync, type FSWatcher } from 'node:fs'
import { CHANGES_ENTRIES, changesDirectory, isChangesError, loadUnreviewed, unreviewedFolders, type ReloadHost, type UnreviewedSync } from '@delo/changes'
import { PRIVATE_DIR_MODE } from '@delo/contract-home-layout'
import type { DeloLogger } from '@delo/logs'
import { inGit, openWatch, WORK_DEBOUNCE_MS } from './work-watch.ts'

/** The profile whose linked plugins the home process reloads while protection is off. */
export interface UnreviewedWatchOptions {
  /** The Delo home. */
  readonly home: string
  /** The profile's name. */
  readonly profile: string
  /** The profile's directory. */
  readonly profileDir: string
  /** Reloads the running Host ([reload](./reload.ts)). */
  readonly reload: ReloadHost
  /** The home process's logger, which receives every load and failure. */
  readonly logger: DeloLogger
  /** How long events settle before a load; {@link WORK_DEBOUNCE_MS} by default. */
  readonly debounceMs?: number
}

/** A running watcher. */
export interface UnreviewedWatch {
  /**
   * Stop watching and wait for a load in progress.
   * @returns when nothing of the watcher runs.
   */
  close(): Promise<void>
}

/**
 * Log what one load did.
 * @param logger - the home process's logger.
 * @param sync - what the load did.
 */
function report(logger: DeloLogger, sync: UnreviewedSync): void {
  switch (sync.kind) {
    case 'loaded':
    case 'not-running':
      logger.info(`Loaded ${sync.plugin} from its folder without review, because protection is off (${sync.entry.id}).`)
      return
    case 'went-back':
      logger.warn(`${sync.plugin} failed to load from its folder: ${sync.failure}. Delo went back to the version that ran before (${sync.entry.id}).`)
      if (sync.again !== undefined && !sync.again.ok) logger.error(`Loading the version of ${sync.plugin} that ran before also failed: ${sync.again.error}. Restart Delo.`)
      return
    case 'unreadable':
      logger.warn(`Delo could not read the folder of ${sync.plugin}, so it keeps running what it ran: ${sync.detail}`)
      return
    case 'protected':
    case 'unchanged':
    case 'skipped':
      return
  }
}

/**
 * Follow the protection setting and the profile's linked plugins, and load each settled change of a linked plugin's
 * folder while protection is off.
 * @param options - the profile, the Host's reload, the logger and the debounce.
 * @returns the watcher.
 */
export function watchUnreviewed(options: UnreviewedWatchOptions): UnreviewedWatch {
  const { home, profile, profileDir, reload, logger } = options
  const debounceMs = options.debounceMs ?? WORK_DEBOUNCE_MS
  const ctx = { home, profile, profileDir }
  const folders = new Map<string, { readonly source: string, readonly watcher: FSWatcher }>()
  const timers = new Map<string, NodeJS.Timeout>()
  let queue = Promise.resolve()
  let closed = false
  let refreshTimer: NodeJS.Timeout | undefined

  const run = (work: () => Promise<void>): void => {
    queue = queue.then(work)
  }
  const load = (plugin: string): void => {
    clearTimeout(timers.get(plugin))
    const timer = setTimeout(() => {
      timers.delete(plugin)
      run(async () => {
        if (closed) return
        try {
          report(logger, await loadUnreviewed(ctx, plugin, reload))
        } catch (error) {
          logger.warn(`Delo could not load ${plugin} from its folder: ${isChangesError(error) ? error.detail : String(error)}`)
        }
      })
    }, debounceMs)
    timer.unref()
    timers.set(plugin, timer)
  }
  const unwatch = (plugin: string): void => {
    folders.get(plugin)?.watcher.close()
    folders.delete(plugin)
    clearTimeout(timers.get(plugin))
    timers.delete(plugin)
  }
  const refresh = async (): Promise<void> => {
    if (closed) return
    let wanted: readonly { readonly plugin: string, readonly source: string }[]
    try {
      wanted = await unreviewedFolders(ctx)
    } catch (error) {
      logger.warn(`Delo could not tell which plugin folders to reload live: ${isChangesError(error) ? error.detail : String(error)}`)
      return
    }
    const names = new Set(wanted.map(({ plugin }) => plugin))
    for (const plugin of [...folders.keys()]) {
      if (!names.has(plugin)) unwatch(plugin)
    }
    for (const { plugin, source } of wanted) {
      if (folders.get(plugin)?.source === source) continue
      unwatch(plugin)
      try {
        folders.set(plugin, { source, watcher: openWatch(logger, source, true, (_event, name) => { if (!inGit(name)) load(plugin) }) })
      } catch (error) {
        logger.warn(`Delo cannot watch ${source} to reload ${plugin} live: ${(error as Error).message}`)
        continue
      }
      // A folder newly watched may have changed since it was last loaded.
      load(plugin)
    }
  }
  const scheduleRefresh = (): void => {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => { run(refresh) }, debounceMs)
    refreshTimer.unref()
  }

  const directory = changesDirectory(home)
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIR_MODE })
  const setting = openWatch(logger, directory, false, (_event, name) => { if (name === CHANGES_ENTRIES.protection) scheduleRefresh() })
  const manifest = openWatch(logger, profileDir, false, (_event, name) => { if (name === 'package.json') scheduleRefresh() })
  run(refresh)
  return {
    close: async () => {
      closed = true
      clearTimeout(refreshTimer)
      setting.close()
      manifest.close()
      for (const plugin of [...folders.keys()]) unwatch(plugin)
      await queue
    },
  }
}
