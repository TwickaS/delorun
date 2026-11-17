/**
 * The panel's data seat over the `packs` remote: reads the install list, follows the Host's install announcements, and
 * sends cancel, retry and remove. A refusal that asks for an unlock keeps the row on `waiting-for-unlock` (A408, A413).
 * @module @delorun/plugin-downloads/client/remote
 */
import type { InstallItem, PacksResult, PacksSnapshot } from '@delorun/plugin-packs/wire'
import type { DownloadItem, DownloadsSource } from './source.ts'

/** The part of the `packs` remote the panel uses. */
export interface PacksPanelRemote {
  /**
   * Read the packs and the install list.
   * @returns the snapshot.
   */
  list(): Promise<PacksSnapshot>
  /**
   * Add packs to the install list.
   * @param request - the package names.
   * @returns the new snapshot, or why nothing was added.
   */
  enqueue(request: { readonly names: readonly string[] }): Promise<PacksResult>
  /**
   * Cancel a queued or working install.
   * @param request - the package name.
   * @returns the new snapshot.
   */
  cancel(request: { readonly name: string }): Promise<PacksResult>
  /**
   * Queue a failed or cancelled install again.
   * @param request - the package name.
   * @returns the new snapshot.
   */
  retry(request: { readonly name: string }): Promise<PacksResult>
  /**
   * Clear a failed or cancelled item from the list; allowed without an unlock.
   * @param request - the package name.
   * @returns the new snapshot.
   */
  dismiss(request: { readonly name: string }): Promise<PacksResult>
  /**
   * Take a finished item off the list.
   * @param request - the package name.
   * @returns the new snapshot.
   */
  remove(request: { readonly name: string }): Promise<PacksResult>
}

/** What the adapter needs besides the remote. */
export interface RemoteSourceOptions {
  /**
   * Call `refresh` whenever the Host announces progress or the connection resets.
   * @param refresh - the function to call.
   * @returns the unsubscribe function.
   */
  readonly follow: (refresh: () => void) => () => void
  /** Milliseconds between reads while an item is queued or working. */
  readonly pollMs: number
  /**
   * Called when the Host refused an action until the device is unlocked, so the studio can open its unlock dialog.
   * @param action - the action refused: `enqueue`, `retry` or `remove`.
   * @param reason - the refusal in the unlock dialog's form, `elevation-required: packs/<action>`.
   */
  readonly unlockNeeded?: (action: string, reason: string) => void
}

/** The refusal reason prefix that asks for an unlock (contract C14). */
const ELEVATION_REQUIRED = 'elevation-required'

/**
 * Whether a failed remote call was refused until the device is unlocked.
 * @param error - what the call threw, or the failure it returned.
 * @returns true for an `elevation-required` refusal.
 */
export function needsUnlock(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const details: unknown = Reflect.get(error, 'details')
  const reason: unknown = typeof details === 'object' && details !== null ? Reflect.get(details, 'reason') : undefined
  const message: unknown = Reflect.get(error, 'message')
  return [reason, message].some(text => typeof text === 'string' && text.includes(ELEVATION_REQUIRED))
}

/**
 * The refusal reason in the unlock dialog's form.
 * @param error - what the call threw.
 * @param action - the action refused.
 * @returns `elevation-required: packs/<action>`, or the Host's own reason when it gave one.
 */
function reasonOf(error: unknown, action: string): string {
  const details: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'details') : undefined
  const reason: unknown = typeof details === 'object' && details !== null ? Reflect.get(details, 'reason') : undefined
  return typeof reason === 'string' ? reason : `${ELEVATION_REQUIRED}: packs/${action}`
}

function toItem(item: InstallItem): DownloadItem {
  return {
    key: item.key,
    ...item.title === undefined ? {} : { title: item.title },
    state: item.state,
    receivedBytes: item.receivedBytes,
    ...item.totalBytes === undefined ? {} : { totalBytes: item.totalBytes },
    ...item.position === undefined ? {} : { position: item.position },
    ...item.failure === undefined ? {} : { failure: item.failure },
  }
}

/**
 * The same list again when nothing changed, so React can compare it.
 * @param before - the items held.
 * @param after - the items just read.
 * @returns `before` when equal.
 */
function sameOr(before: readonly DownloadItem[], after: readonly DownloadItem[]): readonly DownloadItem[] {
  return JSON.stringify(before) === JSON.stringify(after) ? before : after
}

/**
 * Back a {@link DownloadsSource} with the `packs` remote. It reads while something subscribes: on each announcement the
 * Host makes, after a connection reset, and every `pollMs` while an install is queued or working.
 * @param remote - the remote.
 * @param options - how to follow the Host and how often to read.
 * @returns the source.
 */
export function createRemoteDownloadsSource(remote: PacksPanelRemote, options: RemoteSourceOptions): DownloadsSource {
  let items: readonly DownloadItem[] = []
  let waiting = new Set<string>()
  /** Packs whose add awaits an unlock; they have no queue item until the Host accepts it. */
  const unlockAsks = new Set<string>()
  const listeners = new Set<() => void>()
  let stopFollowing: (() => void) | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  const publish = (next: readonly DownloadItem[]): void => {
    const kept = sameOr(items, next)
    if (kept === items) return
    items = kept
    for (const listener of [...listeners]) listener()
  }
  const apply = (snapshot: PacksSnapshot): void => {
    const keys = new Set(snapshot.queue.map(item => item.key))
    waiting = new Set([...waiting].filter(key => keys.has(key)))
    for (const key of keys) unlockAsks.delete(key)
    const queued = snapshot.queue.map(item => (waiting.has(item.key) ? { ...toItem(item), state: 'waiting-for-unlock' as const } : toItem(item)))
    // An add that is waiting for an unlock has no queue item yet.
    const asked = [...unlockAsks].filter(key => !keys.has(key)).map(key => ({ key, state: 'waiting-for-unlock' as const, receivedBytes: 0 }))
    publish([...queued, ...asked])
  }
  const refresh = (): void => {
    remote.list().then(apply, (error: unknown) => { console.warn('delorun downloads: the install list was not read', error) })
  }
  const act = (key: string, action: string, call: (request: { readonly name: string }) => Promise<PacksResult>): void => {
    call({ name: key }).then(
      (result) => {
        if (result.ok) { waiting.delete(key); apply(result.value) }
      },
      (error: unknown) => {
        if (!needsUnlock(error)) { console.warn('delorun downloads: the change was not made', error); return }
        options.unlockNeeded?.(action, reasonOf(error, action))
        waiting.add(key)
        publish(items.map(item => (item.key === key ? { ...item, state: 'waiting-for-unlock' as const } : item)))
      },
    )
  }
  const start = (): void => {
    stopFollowing = options.follow(refresh)
    timer = setInterval(() => { if (items.some(item => item.state === 'queued' || item.state === 'downloading' || item.state === 'verifying' || item.state === 'installing')) refresh() }, options.pollMs)
    refresh()
  }
  const stop = (): void => {
    stopFollowing?.()
    stopFollowing = undefined
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  return {
    snapshot: () => items,
    subscribe: (listener) => {
      if (listeners.size === 0) start()
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stop()
      }
    },
    refresh,
    enqueue: (key) => {
      remote.enqueue({ names: [key] }).then(
        (result) => {
          unlockAsks.delete(key)
          if (result.ok) apply(result.value)
        },
        (error: unknown) => {
          if (!needsUnlock(error)) { console.warn('delorun downloads: the plugin was not added', error); return }
          options.unlockNeeded?.('enqueue', reasonOf(error, 'enqueue'))
          unlockAsks.add(key)
          publish([...items.filter(item => item.key !== key), { key, state: 'waiting-for-unlock', receivedBytes: 0 }])
        },
      )
    },
    cancel: (key) => { act(key, 'cancel', request => remote.cancel(request)) },
    retry: (key) => { act(key, 'retry', request => remote.retry(request)) },
    remove: (key) => {
      const state = items.find(item => item.key === key)?.state
      const dismissing = state === 'failed' || state === 'cancelled'
      act(key, dismissing ? 'dismiss' : 'remove', request => (dismissing ? remote.dismiss(request) : remote.remove(request)))
    },
  }
}
