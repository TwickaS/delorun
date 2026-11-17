/**
 * The page's copy of the Host's requirement check. Plugins reads it when a row or a bundle page mounts and when the window
 * regains focus, so a need the person just met clears without a restart. Overlapping reads share one request.
 * @module @delorun/bundle-local/client/requirements-store
 */
import { readRequirements, type RequirementsAnswer } from './requirements-api.ts'
import type { HostFetch } from './host-api.ts'

/** What the page last learned; `failed` keeps the previous answer, if any, so a lost connection does not hide a state. */
export interface RequirementsSnapshot {
  readonly answer: RequirementsAnswer | null
  readonly failed: boolean
}

/** Observable copy of the check. */
export class RequirementsStore {
  readonly #fetch: HostFetch
  readonly #language: () => string
  readonly #listeners = new Set<() => void>()
  #snapshot: RequirementsSnapshot = { answer: null, failed: false }
  #reading: Promise<void> | undefined

  /**
   * @param fetch - the request function.
   * @param language - the studio's language at the time of each read.
   */
  constructor(fetch: HostFetch, language: () => string) {
    this.#fetch = fetch
    this.#language = language
  }

  /** The last answer, a stable reference until the next read ends. */
  readonly getSnapshot = (): RequirementsSnapshot => this.#snapshot

  /**
   * Observe changes.
   * @param listener - called after each read ends.
   * @returns the unsubscribe function.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /**
   * Read the check again; a read already running answers this call too.
   * @returns a promise that settles when the read ends; it never rejects.
   */
  refresh(): Promise<void> {
    this.#reading ??= readRequirements(this.#fetch, this.#language()).then(
      (answer) => { this.#snapshot = { answer, failed: false } },
      () => { this.#snapshot = { answer: this.#snapshot.answer, failed: true } },
    ).finally(() => {
      this.#reading = undefined
      for (const listener of this.#listeners) listener()
    })
    return this.#reading
  }
}

/**
 * The language the Host reads texts in.
 * @returns `zh` when the document language is Chinese, otherwise `en`.
 */
export function documentLanguage(): string {
  return document.documentElement.lang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}
