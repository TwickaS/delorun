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
  rows: number
  readonly listeners: Set<() => void>
}

const HUB_KEY = Symbol.for('delorun.plugin-downloads.hub')
const NO_ITEMS: readonly DownloadItem[] = []

/** A source with nothing in it; its snapshot is one constant array so React can compare it. */
export const EMPTY_SOURCE: DownloadsSource = { snapshot: () => NO_ITEMS, subscribe: () => () => {}, enqueue: () => {}, cancel: () => {}, retry: () => {}, remove: () => {} }

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
  return hub().source
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
