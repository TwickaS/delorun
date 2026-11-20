/**
 * @delorun/browser-setup: whether Browser is ready on this computer, for the surfaces that ask whether agents may use a
 * web browser (the setup guide's Browser step and the new-workspace flow). It is the Host's requirement check
 * (`@delorun/bundle-local`'s `GET /api/delorunRequirements.check`, which the Plugins page's "Needs setup" state reads)
 * narrowed to the Browser plugin pack. The check reads the computer afresh on each request, so a need the person just
 * met clears on the next read. The module runs in the browser and imports no Cordis; the choice itself is drawn by
 * `BrowserChoices` (`./client`).
 * @module @delorun/browser-setup
 */
import type { HostFetch } from '@delorun/bundle-local/host-api'
import { readRequirements, type RequirementFix, type RequirementsAnswer } from '@delorun/bundle-local/requirements-api'

export type { RequirementFix } from '@delorun/bundle-local/requirements-api'
export { browserPageState, resolveBrowserSwitch, type BrowserFailure, type BrowserPageInput, type BrowserPageState, type BrowserSwitch, type PackProgress } from './switch.ts'

/** The Browser plugin pack's package name. */
export const BROWSER_BUNDLE = '@delorun/bundle-browser'

/**
 * Where Browser stands: `checking` before the first answer; `not-added` when the Host lists no row of the pack, which
 * is a pack that is not in the profile or has not loaded yet; `ready`; `needs-setup` with the Host's reason and the
 * action that meets it; `problem` when the pack's own declaration cannot be read; `failed` when the check itself
 * cannot be read.
 */
export type BrowserReadiness =
  | { readonly kind: 'checking' }
  | { readonly kind: 'not-added' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'needs-setup'; readonly reason: string; readonly fix: RequirementFix }
  | { readonly kind: 'problem'; readonly message: string }
  | { readonly kind: 'failed' }

const CHECKING: BrowserReadiness = { kind: 'checking' }
const NOT_ADDED: BrowserReadiness = { kind: 'not-added' }
const READY: BrowserReadiness = { kind: 'ready' }
const FAILED: BrowserReadiness = { kind: 'failed' }

/**
 * Narrow the Host's check to Browser.
 * @param answer - every declared row's state.
 * @returns where Browser stands: the first row that needs setup, else ready, else not added.
 */
export function browserReadinessOf(answer: RequirementsAnswer): BrowserReadiness {
  const problem = answer.problems.find(each => each.packageName === BROWSER_BUNDLE)
  if (problem !== undefined) return { kind: 'problem', message: problem.message }
  const rows = answer.rows.filter(row => row.packageName === BROWSER_BUNDLE)
  if (rows.length === 0) return NOT_ADDED
  for (const row of rows) if (row.state === 'needs-setup') return { kind: 'needs-setup', reason: row.reason, fix: row.fix }
  return READY
}

/**
 * Whether the pack is in the profile and loaded, so the Host answers for it.
 * @param setup - where Browser stands.
 * @returns true for every state the Host reports about the pack itself.
 */
export function browserAdded(setup: BrowserReadiness): boolean {
  return setup.kind === 'ready' || setup.kind === 'needs-setup' || setup.kind === 'problem'
}

/** The page's copy of whether Browser is ready. */
export interface BrowserSetupStore {
  /** @returns the last answer, a stable reference until the next read ends. */
  getSnapshot(): BrowserReadiness
  /**
   * Observe changes.
   * @param listener - called after each read ends.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void
  /**
   * Ask the Host again; a read already running answers this call too.
   * @returns where Browser stands; it never rejects.
   */
  refresh(): Promise<BrowserReadiness>
}

/**
 * Create the store.
 * @param fetch - the request function.
 * @param language - the studio's language at the time of each read, as a locale id; Chinese reads Chinese reasons.
 * @returns the store; nothing is read until `refresh` is called.
 */
export function createBrowserSetup(fetch: HostFetch, language: () => string): BrowserSetupStore {
  const listeners = new Set<() => void>()
  let snapshot = CHECKING
  let reading: Promise<BrowserReadiness> | undefined
  const read = async (): Promise<BrowserReadiness> => {
    try {
      snapshot = browserReadinessOf(await readRequirements(fetch, language().toLowerCase().startsWith('zh') ? 'zh' : 'en'))
    } catch (error) {
      console.warn('delorun browser setup: whether Browser is ready was not read', error)
      snapshot = FAILED
    }
    for (const listener of listeners) listener()
    return snapshot
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh: () => (reading ??= read().finally(() => { reading = undefined })),
  }
}
