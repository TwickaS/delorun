/**
 * The home process's side of a work session (contract C21, "Work sessions"): while a session is open, each settled
 * change in the plugin's folder loads live in the running Host through [`loadWorkSession`](../../../../packages/changes/src/work.ts),
 * which copies the folder's content into the plugin's active directory and reloads the Host as `changes.reload` does
 * ([reload](./reload.ts)), going back to the content that last loaded when the reload fails.
 *
 * Delo watches the folder itself instead of setting upstream's `hmr.root`, because the Host loads the plugin from its
 * active directory, so a source watch of the folder would watch files that are not loaded.
 *
 * The watcher follows `changes/profiles/<profile>/work-session.json`, so a session opened or closed by
 * `delorun changes work` or `done` is noticed, and while one is open it watches the plugin's folder recursively, leaving
 * out `.git`. Events are debounced; loads run one at a time under the profile write lock. At the session's end time
 * the watcher ends it without the person through the injected `expire`, which approves nothing and puts the version the
 * session started from back, and logs why it ended.
 *
 * @module @delo/cli/changes/work-watch
 */
import { mkdirSync, watch, type FSWatcher, type WatchListener } from 'node:fs'
import { sep } from 'node:path'
import {
  CHANGES_ENTRIES,
  EXCLUDED_DIRECTORY,
  isChangesError,
  loadWorkSession,
  profileChangesDirectory,
  readWorkSession,
  WORK_SESSION_MAX_MINUTES,
  workFinishedLine,
  type ReloadHost,
  type WorkFinished,
  type WorkSync,
} from '@delo/changes'
import { PRIVATE_DIR_MODE } from '@delo/contract-home-layout'
import type { DeloLogger } from '@delo/logs'

/** How long, in milliseconds, the folder and the session record stay quiet before a change loads. */
export const WORK_DEBOUNCE_MS = 300

/** The profile whose work sessions the home process follows. */
export interface WorkWatchOptions {
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
  /**
   * End the open session without the person once its end time passed; the start module passes the `@delo/changes/stop`
   * entry's function with the reason `expired` and the Host's reload.
   * @returns what ending it did; undefined when no session's end time passed.
   */
  readonly expire: () => Promise<WorkFinished | undefined>
  /** How long events settle before a load; {@link WORK_DEBOUNCE_MS} by default. */
  readonly debounceMs?: number
  /** The clock that decides when a session's end time passed; `() => new Date()` by default. */
  readonly now?: () => Date
}

/** A running watcher. */
export interface WorkWatch {
  /**
   * Stop watching and wait for a load in progress.
   * @returns when nothing of the watcher runs.
   */
  close(): Promise<void>
}

/**
 * Whether a watch event names a path inside a `.git` directory, which is not part of a plugin's content.
 * @param name - a path relative to the watched folder, as a watch event names it.
 * @returns whether it is inside a `.git` directory.
 */
export function inGit(name: string | null): boolean {
  return name !== null && name.split(sep).includes(EXCLUDED_DIRECTORY)
}

/**
 * Watch a path without keeping the process alive; a watcher that fails later is logged and stays closed.
 * @param logger - receives the failure.
 * @param path - the folder or directory.
 * @param recursive - whether to watch below it.
 * @param listener - receives each event.
 * @returns the watcher.
 * @throws the filesystem error when the path cannot be watched.
 */
export function openWatch(logger: DeloLogger, path: string, recursive: boolean, listener: WatchListener<string>): FSWatcher {
  const watcher = watch(path, { recursive, persistent: false }, listener)
  watcher.on('error', (error) => { logger.warn(`Delo stopped watching ${path}: ${error.message}`) })
  return watcher
}

/**
 * Follow the profile's work sessions and load each settled change of the open session's folder.
 * @param options - the profile, the Host's reload, the logger and the debounce.
 * @returns the watcher.
 */
export function watchWork(options: WorkWatchOptions): WorkWatch {
  const { home, profile, profileDir, reload, logger, expire } = options
  const debounceMs = options.debounceMs ?? WORK_DEBOUNCE_MS
  const now = options.now ?? (() => new Date())
  const ctx = { home, profile, profileDir, now }
  let timer: NodeJS.Timeout | undefined
  let ending: NodeJS.Timeout | undefined
  let settling = Promise.resolve()
  let folder: { readonly source: string, readonly watcher: FSWatcher } | undefined

  const open = (path: string, recursive: boolean, listener: WatchListener<string>): FSWatcher => openWatch(logger, path, recursive, listener)
  const schedule = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => { settling = settling.then(settle) }, debounceMs)
    timer.unref()
  }
  const follow = (source: string | undefined): void => {
    if (folder?.source === source) return
    if (folder !== undefined) {
      folder.watcher.close()
      logger.info(`Delo no longer watches ${folder.source}: the work session on it ended.`)
    }
    folder = undefined
    if (source === undefined) return
    try {
      folder = { source, watcher: open(source, true, (_event, name) => { if (!inGit(name)) schedule() }) }
    } catch (error) {
      logger.warn(`Delo cannot watch ${source} for your work session: ${(error as Error).message}`)
    }
  }
  const endAt = (endsAt: string | undefined): void => {
    clearTimeout(ending)
    if (endsAt === undefined) return
    // A later look arms the timer again, so a far end time read from the record never overflows the timer's range.
    const delay = Math.min(Math.max(Date.parse(endsAt) - now().getTime(), 0), WORK_SESSION_MAX_MINUTES * 60_000)
    ending = setTimeout(schedule, delay)
    ending.unref()
  }
  const ended = (finished: WorkFinished | undefined, endsAt: string): void => {
    if (finished === undefined) return
    logger.info(`Your work session on ${finished.plugin} ended at its time limit, ${endsAt}. ${workFinishedLine(finished)}`)
    if (finished.reload?.ok === false) logger.error(`Loading the approved version of ${finished.plugin} after the session ended failed: ${finished.reload.error}. Restart Delo.`)
  }
  const report = (sync: WorkSync): void => {
    if (sync.kind === 'loaded') {
      logger.info(`Loaded ${sync.plugin} from its folder in your work session.`)
    } else if (sync.kind === 'went-back') {
      logger.warn(`${sync.plugin} failed to load from its folder: ${sync.failure}. Delo went back to the version that last loaded.`)
      if (sync.again !== undefined && !sync.again.ok) logger.error(`Loading the version of ${sync.plugin} that last loaded also failed: ${sync.again.error}. Restart Delo.`)
    } else if (sync.kind === 'folder-gone') {
      logger.warn(`The folder of ${sync.plugin} is gone; Delo keeps running the version that last loaded.`)
    }
  }
  const settle = async (): Promise<void> => {
    try {
      const session = await readWorkSession(home, profile)
      follow(session?.source)
      endAt(session?.endsAt)
      const sync = await loadWorkSession(ctx, reload)
      if (sync.kind === 'expired') ended(await expire(), sync.endsAt)
      else report(sync)
    } catch (error) {
      logger.warn(`Delo could not load your work session's folder: ${isChangesError(error) ? error.detail : String(error)}`)
    }
  }

  const directory = profileChangesDirectory(home, profile)
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIR_MODE })
  const sessions = open(directory, false, (_event, name) => { if (name === CHANGES_ENTRIES.workSession) schedule() })
  schedule()
  return {
    close: async () => {
      clearTimeout(timer)
      clearTimeout(ending)
      sessions.close()
      folder?.watcher.close()
      // A load already queued still runs, so the Host takes the last edit before the session ends; a folder it began
      // watching meanwhile is closed after it.
      await settling
      clearTimeout(ending)
      folder?.watcher.close()
    },
  }
}
