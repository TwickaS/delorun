/** The panel's data seat: the typed client interface the panel reads, the fake that stands in for it and the shared hub. */

import type { Translate } from './locales.ts'

/** Where one download stands; the install queue's states plus `waiting-for-unlock` for a phone install that awaits the unlock (A408, A413). */
export type DownloadState =
  | 'queued' | 'waiting-for-unlock' | 'downloading' | 'verifying' | 'installing'
  | 'ready' | 'needs-reload' | 'failed' | 'cancelled'

/** One plugin in the queue, as the panel shows it. */
export interface DownloadItem {
  /** The package name, the item's identity. */
  readonly key: string
  /** The person's words for the plugin, when there is one. */
  readonly title?: string
  /** The plugin's icon, when it has one. */
  readonly iconUrl?: string
  /** Where it stands. */
  readonly state: DownloadState
  /** Bytes received while downloading. */
  readonly receivedBytes: number
  /** Total bytes, when known. */
  readonly totalBytes?: number
  /** `1` for the next item to start; absent once started. */
  readonly position?: number
  /** Present while `failed`: a sentence for the person. */
  readonly failure?: { readonly code: 'offline' | 'interrupted' | 'failed'; readonly message: string }
  /**
   * Present for a download this page runs itself, outside the Host's install queue ({@link startPageDownload}): it
   * cannot be cancelled, and a failed one offers Try again only when its starter gave a way to.
   */
  readonly local?: { readonly retry: boolean }
}

/**
 * What the panel reads and does. The install queue's remote actions (`@delorun/plugin-packs`) back the real one.
 */
export interface DownloadsSource {
  /**
   * The items in queue order. The same array is returned until an item changes, so React can compare it.
   * @returns the items.
   */
  snapshot(): readonly DownloadItem[]
  /**
   * Follow every change.
   * @param listener - called after each change.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void
  /** Read the install list again now, for a surface that queued an install through another path. */
  refresh(): void
  /**
   * Add a plugin pack to the queue.
   * @param key - the package name.
   */
  enqueue(key: string): void
  /**
   * Stop a queued or running item.
   * @param key - the package name.
   */
  cancel(key: string): void
  /**
   * Start a failed item again.
   * @param key - the package name.
   */
  retry(key: string): void
  /**
   * Take a failed or finished item off the list.
   * @param key - the package name.
   */
  remove(key: string): void
}

/** The states in which an item is still going to finish or fail. */
export const ACTIVE_STATES: ReadonlySet<DownloadState> = new Set(['queued', 'waiting-for-unlock', 'downloading', 'verifying', 'installing'])

/**
 * Whether an item is still queued or running.
 * @param item - the item.
 * @returns true while it is.
 */
export function isActive(item: DownloadItem): boolean {
  return ACTIVE_STATES.has(item.state)
}

/**
 * Whether an item has been added.
 * @param item - the item.
 * @returns true for `ready` and `needs-reload`.
 */
export function isDone(item: DownloadItem): boolean {
  return item.state === 'ready' || item.state === 'needs-reload'
}

/** A source with the controls a test or the harness page drives. */
export interface FakeDownloadsSource extends DownloadsSource {
  /**
   * Replace the items.
   * @param items - the new list.
   */
  set(items: readonly DownloadItem[]): void
  /**
   * Change one item and keep its place.
   * @param key - the package name.
   * @param patch - the changed fields.
   */
  update(key: string, patch: Partial<DownloadItem>): void
  /** The calls the person made, in order, as `action:key`. */
  readonly calls: string[]
}

/**
 * A source that holds its items in memory. `cancel` marks an item cancelled, `retry` queues it, `remove` drops it.
 * @param initial - the starting items.
 * @returns the source with its test controls.
 */
export function createFakeDownloadsSource(initial: readonly DownloadItem[] = []): FakeDownloadsSource {
  let items = initial
  const listeners = new Set<() => void>()
  const calls: string[] = []
  const set = (next: readonly DownloadItem[]): void => {
    items = next
    for (const listener of [...listeners]) listener()
  }
  const change = (key: string, patch: Partial<DownloadItem>): void => {
    set(items.map(item => (item.key === key ? { ...item, ...patch } : item)))
  }
  return {
    calls,
    snapshot: () => items,
    refresh: () => { calls.push('refresh') },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set,
    update: change,
    enqueue: (key) => { calls.push(`enqueue:${key}`); set([...items.filter(item => item.key !== key), { key, state: 'queued', receivedBytes: 0 }]) },
    cancel: (key) => { calls.push(`cancel:${key}`); change(key, { state: 'cancelled' }) },
    retry: (key) => { calls.push(`retry:${key}`); change(key, { state: 'queued', receivedBytes: 0 }) },
    remove: (key) => { calls.push(`remove:${key}`); set(items.filter(item => item.key !== key)) },
  }
}

/** The source the plugin provides, the translate it binds and the number of onboarding rows on screen. */
interface Hub {
  source: DownloadsSource
  translate: Translate | undefined
  /** Uninstalls a pack through the plugin manager, as the Plugins page does. */
  uninstall?: (name: string) => Promise<void>
  rows: number
  readonly listeners: Set<() => void>
  /** The downloads this page runs itself, by key, in the order they started; created by the first that starts. */
  page?: PageDownloads
  /** The provided source with the page's downloads after its items, made again when the source changes. */
  merged?: { readonly raw: DownloadsSource, readonly source: DownloadsSource }
}

/** The page's own downloads and who follows them. */
interface PageDownloads {
  readonly entries: Map<string, { readonly item: DownloadItem, readonly retry?: (() => void) | undefined }>
  readonly listeners: Set<() => void>
  /** Bumped on each change, so a merged snapshot is made again only after one. */
  version: number
}

const HUB_KEY = Symbol.for('delorun.plugin-downloads.hub')
const NO_ITEMS: readonly DownloadItem[] = []

/** A source with nothing in it; its snapshot is one constant array so React can compare it. */
export const EMPTY_SOURCE: DownloadsSource = { snapshot: () => NO_ITEMS, subscribe: () => () => {}, refresh: () => {}, enqueue: () => {}, cancel: () => {}, retry: () => {}, remove: () => {} }

/**
 * The hub is shared through a global symbol, because the onboarding plugin's bundle and this one's are separate modules
 * in the page.
 * @returns the one hub.
 */
function hub(): Hub {
  const found = Reflect.get(globalThis, HUB_KEY) as Hub | undefined
  if (found !== undefined) return found
  const made: Hub = { source: EMPTY_SOURCE, translate: undefined, rows: 0, listeners: new Set() }
  Reflect.set(globalThis, HUB_KEY, made)
  return made
}

function notify(): void {
  for (const listener of [...hub().listeners]) listener()
}

/**
 * Make a source the one every surface reads.
 * @param source - the source.
 * @returns the function that takes it back (the empty source returns).
 */
export function provideDownloadsSource(source: DownloadsSource): () => void {
  hub().source = source
  notify()
  return () => {
    if (hub().source === source) { hub().source = EMPTY_SOURCE; notify() }
  }
}

/**
 * The source now provided.
 * @returns it, or an empty one before the plugin applies.
 */
export function currentDownloadsSource(): DownloadsSource {
  const shared = hub()
  if (shared.merged?.raw !== shared.source) shared.merged = { raw: shared.source, source: withPageDownloads(shared.source) }
  return shared.merged.source
}

/**
 * The page's downloads, made on first use.
 * @returns them.
 */
function pageDownloads(): PageDownloads {
  const shared = hub()
  shared.page ??= { entries: new Map(), listeners: new Set(), version: 0 }
  return shared.page
}

/**
 * A source that lists the Host's items, then the page's own downloads the Host does not list. The Host's actions
 * serve its items; a page download is removed here, retried by its starter, and never cancelled.
 * @param raw - the provided source.
 * @returns the source.
 */
function withPageDownloads(raw: DownloadsSource): DownloadsSource {
  let cache: { readonly host: readonly DownloadItem[], readonly version: number, readonly items: readonly DownloadItem[] } | undefined
  const snapshot = (): readonly DownloadItem[] => {
    const host = raw.snapshot()
    const page = pageDownloads()
    if (cache?.host === host && cache.version === page.version) return cache.items
    const own = [...page.entries.values()].map(entry => entry.item).filter(item => !host.some(each => each.key === item.key))
    cache = { host, version: page.version, items: own.length === 0 ? host : [...host, ...own] }
    return cache.items
  }
  const ownEntry = (key: string) => (raw.snapshot().some(item => item.key === key) ? undefined : pageDownloads().entries.get(key))
  return {
    snapshot,
    subscribe: (listener) => {
      const stop = raw.subscribe(listener)
      pageDownloads().listeners.add(listener)
      return () => { stop(); pageDownloads().listeners.delete(listener) }
    },
    refresh: () => { raw.refresh() },
    enqueue: (key) => { raw.enqueue(key) },
    cancel: (key) => { if (ownEntry(key) === undefined) raw.cancel(key) },
    retry: (key) => { const own = ownEntry(key); if (own === undefined) raw.retry(key); else own.retry?.() },
    remove: (key) => { if (ownEntry(key) === undefined) raw.remove(key); else changePage(page => { page.entries.delete(key) }) },
  }
}

/**
 * Change the page's downloads and tell their followers.
 * @param change - the change.
 */
function changePage(change: (page: PageDownloads) => void): void {
  const page = pageDownloads()
  change(page)
  page.version += 1
  for (const listener of [...page.listeners]) listener()
}

/** What a page download's starter reports as it goes. */
export interface PageDownload {
  /**
   * Bytes received so far, and the total when known; without a total the panel draws a bar that moves without a measure.
   * @param received - the bytes received.
   * @param total - the size, when known.
   */
  bytes(received: number, total?: number): void
  /** The download is over and the install runs. */
  installing(): void
  /**
   * It finished.
   * @param reload - whether the plugin runs only after the page reloads.
   */
  done(reload?: boolean): void
  /**
   * It failed.
   * @param message - a sentence for the person, when there is one.
   */
  failed(message?: string): void
}

/**
 * Show a download or install the page runs itself, outside the Host's install queue (the plugin manager's own install
 * of a package that is not a plugin pack, or the browser download), in every downloads surface of this tab. It lives
 * only in this tab: it is not persisted and other devices do not see it. A later start under the same key replaces it.
 * @param key - the package name or another identity the panel names it by.
 * @param options - the title to show, and how Try again starts it again.
 * @returns what the starter reports.
 */
export function startPageDownload(key: string, options: { readonly title?: string | undefined, readonly retry?: (() => void) | undefined } = {}): PageDownload {
  const { title, retry } = options
  const start: DownloadItem = { key, state: 'downloading', receivedBytes: 0, local: { retry: retry !== undefined }, ...title === undefined ? {} : { title } }
  changePage((page) => { page.entries.delete(key); page.entries.set(key, { item: start, retry }) })
  const patch = (next: Partial<DownloadItem>): void => {
    changePage((page) => {
      const entry = page.entries.get(key)
      // A newer start under the same key owns the entry, and a removed one stays removed.
      if (entry === undefined || entry.item.local !== start.local) return
      const { failure: _failure, ...rest } = entry.item
      page.entries.set(key, { ...entry, item: { ...rest, ...next } })
    })
  }
  return {
    bytes: (received, total) => { patch({ state: 'downloading', receivedBytes: received, ...total === undefined ? {} : { totalBytes: total } }) },
    installing: () => { patch({ state: 'installing' }) },
    done: (reload = false) => { patch({ state: reload ? 'needs-reload' : 'ready' }) },
    failed: (message) => { patch({ state: 'failed', ...message === undefined || message === '' ? {} : { failure: { code: 'failed', message } } }) },
  }
}

/**
 * Follow a change of the provided source.
 * @param listener - called when the source is replaced or an onboarding row mounts or unmounts.
 * @returns the unsubscribe function.
 */
export function subscribeHub(listener: () => void): () => void {
  hub().listeners.add(listener)
  return () => { hub().listeners.delete(listener) }
}

/**
 * Note that an onboarding row is on screen, so the phone's header icon stays out of its way.
 * @returns the function that notes it left.
 */
export function claimOnboardingRow(): () => void {
  hub().rows += 1
  notify()
  return () => { hub().rows -= 1; notify() }
}

/**
 * Whether an onboarding row is on screen.
 * @returns true while at least one is.
 */
export function onboardingRowShown(): boolean {
  return hub().rows > 0
}

/**
 * Give the standalone row the plugin's bound translate. The hub holds it, because the onboarding bundle carries its own
 * copy of the row's module.
 * @param t - the bound translate.
 * @returns the function that takes it back.
 */
export function provideTranslate(t: Translate): () => void {
  hub().translate = t
  return () => { if (hub().translate === t) hub().translate = undefined }
}

/**
 * The translate the plugin bound.
 * @returns it, or undefined before the plugin applies.
 */
export function providedTranslate(): Translate | undefined {
  return hub().translate
}

/**
 * Give the pack surfaces the way to uninstall a pack: the plugin manager's own removal, the one the Plugins page calls,
 * so the same permission rules and unlock prompts apply.
 * @param uninstall - removes the named bundle; rejects when the removal did not happen.
 * @returns the function that takes it back.
 */
export function provideUninstall(uninstall: (name: string) => Promise<void>): () => void {
  hub().uninstall = uninstall
  return () => { if (hub().uninstall === uninstall) delete hub().uninstall }
}

/**
 * The uninstall the plugin provided.
 * @returns it, or undefined before the plugin applies or where no plugin manager is mounted.
 */
export function providedUninstall(): ((name: string) => Promise<void>) | undefined {
  return hub().uninstall
}
