/**
 * The page's copy of the Host's preview flags: one read of {@link PREVIEW_FLAG_ROUTES} that every `usePreviewFlag`
 * call under the same provider shares. Flags change only when Delorun restarts, so the store reads once and again only
 * when asked.
 * @module @delorun/preview-flags/client/store
 */
import type { PreviewFlagId } from '../flags.ts'
import { PREVIEW_FLAG_ROUTES, PreviewFlagsAnswer, type PreviewFlagView } from '../wire.ts'

/** The `fetch` the read goes through: the browser's own, or a spec's fake. */
export type PreviewFlagsFetch = (input: string, init?: RequestInit) => Promise<Response>

/**
 * What the page knows: `loading` before the first answer, `ready` with the declared flags, or `failed` when the route
 * is absent or cannot be read, in which case every flag reads as off.
 */
export interface PreviewFlagsSnapshot {
  readonly status: 'loading' | 'ready' | 'failed'
  readonly flags: readonly PreviewFlagView[]
}

/** The observable copy. */
export interface PreviewFlagsStore {
  /** @returns the last answer, a stable reference until the next read ends. */
  getSnapshot(): PreviewFlagsSnapshot
  /**
   * Observe changes.
   * @param listener - called after each read ends.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void
  /**
   * Read the flags unless they were already read or are being read.
   * @returns a promise that settles when the read ends; it never rejects.
   */
  load(): Promise<void>
  /**
   * Read the flags again.
   * @returns a promise that settles when the read ends; it never rejects.
   */
  refresh(): Promise<void>
}

const LOADING: PreviewFlagsSnapshot = { status: 'loading', flags: [] }
const FAILED: PreviewFlagsSnapshot = { status: 'failed', flags: [] }

/**
 * Create the store.
 * @param send - the `fetch` the read goes through; the browser's own by default.
 * @returns the store; nothing is read until `load` or `refresh` is called.
 */
export function createPreviewFlagsStore(send: PreviewFlagsFetch = (input, init) => globalThis.fetch(input, init)): PreviewFlagsStore {
  const listeners = new Set<() => void>()
  let snapshot = LOADING
  let reading: Promise<void> | undefined
  let loaded: Promise<void> | undefined
  const read = async (): Promise<void> => {
    try {
      // Relative to the document, without the leading slash, as every studio route is fetched.
      const response = await send(PREVIEW_FLAG_ROUTES.list.slice(1), { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`answered ${String(response.status)}`)
      snapshot = { status: 'ready', flags: PreviewFlagsAnswer.parse(await response.json()).flags }
    } catch (error) {
      // A profile without the row answers 404: every flag is off there, which is the state the studio shows.
      console.warn('delorun preview flags: the flags were not read; every flag reads as off', error)
      snapshot = FAILED
    }
    for (const listener of listeners) listener()
  }
  const refresh = (): Promise<void> => {
    reading ??= read().finally(() => { reading = undefined })
    return reading
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    load: () => (loaded ??= refresh()),
    refresh,
  }
}

/**
 * Whether a flag is on in a snapshot.
 * @param snapshot - what the page knows.
 * @param id - the flag.
 * @returns true only for a declared flag the profile turns on.
 */
export function flagOn(snapshot: PreviewFlagsSnapshot, id: PreviewFlagId): boolean {
  return snapshot.flags.some(flag => flag.id === id && flag.on)
}
