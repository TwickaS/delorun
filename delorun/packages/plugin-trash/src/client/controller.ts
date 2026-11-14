/**
 * The studio's side of the trash: asks the harness's routes, keeps the listing the Settings section shows, hides the
 * chats that sit in the trash from the sidebar, and reports each outcome as a toast.
 * @module @delorun/plugin-trash/client/controller
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { removeDraftEntries, type DraftStorage } from '@delorun/trash/drafts'
import { TRASH_PATHS, type EmptyOutcome, type PurgeOutcome, type TrashEntry, type TrashListing } from '../wire.ts'
import type { TrashToastKey } from './locales.ts'

/** What the Settings section shows: the first load, a failed load with nothing to show, or the listing. */
export type TrashState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly listing: TrashListing }

/** One outcome for the toast: the copy to show and whether the action succeeded. */
export interface TrashNotice {
  /** The toast copy's dictionary key. */
  readonly key: TrashToastKey
  /** Whether the action succeeded. */
  readonly ok: boolean
}

/** What the controller needs from the page. */
export interface TrashControllerDeps {
  /**
   * Hide a chat from the sidebar.
   * @param sessionId - the chat.
   * @returns the disposer that shows it again.
   */
  readonly hide: (sessionId: string) => () => void
  /** The page's draft storage. */
  readonly drafts: DraftStorage
  /**
   * Show one outcome.
   * @param notice - the outcome.
   */
  readonly report: (notice: TrashNotice) => void
}

/** A route's refusal or failed answer. */
export class TrashRequestError extends Error {
  /** The HTTP status. */
  readonly status: number
  /** The refusal's code, or an empty string when the answer carried none. */
  readonly code: string

  /**
   * @param status - the HTTP status.
   * @param code - the refusal's code, or an empty string when the answer carried none.
   */
  constructor(status: number, code: string) {
    super(`delorun-trash: the harness answered ${String(status)}${code === '' ? '' : ` ${code}`}`)
    this.status = status
    this.code = code
  }
}

/**
 * Ask one route.
 * @param path - the route from {@link TRASH_PATHS}, fetched relative to the document without its leading slash.
 * @param body - the JSON request body.
 * @returns the JSON answer.
 * @throws {TrashRequestError} for a non-2xx answer; a network failure rejects with the fetch error.
 */
async function post<T>(path: string, body: object): Promise<T> {
  const response = await fetch(path.slice(1), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!response.ok) {
    const refusal = (await response.json().catch(() => undefined)) as { readonly code?: string } | undefined
    throw new TrashRequestError(response.status, refusal?.code ?? '')
  }
  return await response.json() as T
}

/** The copy for the refusals that say more than the action's own failure does. */
const SPECIFIC: Readonly<Partial<Record<string, TrashToastKey>>> = {
  TRASH_ITEM_NOT_FOUND: 'toast.notFound',
  TRASH_RESTORE_CONFLICT: 'toast.restoreConflict',
  WORKSPACE_NOT_FOUND: 'toast.workspaceMissing',
}

/**
 * The notice for a purge whose log clear was asked for and did not fully succeed.
 * @param asked - whether the person asked to clear the logs.
 * @param cleared - whether every log was cleared.
 * @returns the failure notice, or `undefined` when there is nothing to say beyond the purge itself.
 */
function logsOutcome(asked: boolean, cleared: boolean): TrashNotice | undefined {
  return asked && !cleared ? { ok: false, key: 'toast.logsNotCleared' } : undefined
}

/** The browser's `localStorage` as the draft storage the purge clears. */
export const localDrafts: DraftStorage = {
  keys: () => Array.from({ length: localStorage.length }, (_, index) => String(localStorage.key(index))),
  remove: (key) => { localStorage.removeItem(key) },
}

/** Owns the trash's state and every request to the harness for one page. */
export class TrashController {
  /** The state the Settings section reads. */
  readonly state = createSnapshotStore<TrashState>({ status: 'loading' })
  private readonly hides = new Map<string, readonly (() => void)[]>()
  private disposed = false

  /** The page's hide, draft storage and toast. */
  private readonly deps: TrashControllerDeps

  /** @param deps - the page's hide, draft storage and toast. */
  constructor(deps: TrashControllerDeps) {
    this.deps = deps
  }

  /**
   * Read the listing and hide the chats of every item in it. A failure keeps a listing already shown.
   * @returns after the state is current; never rejects.
   */
  async refresh(): Promise<void> {
    let listing: TrashListing
    try {
      listing = await post<TrashListing>(TRASH_PATHS.list, {})
    } catch (error) {
      console.warn('delorun-trash: the trash was not listed:', error)
      if (this.state.getSnapshot().status !== 'ready') this.state.set({ status: 'error' })
      return
    }
    this.sync(listing.items)
    this.state.set({ status: 'ready', listing })
  }

  /**
   * Show the first-load state again and read the listing.
   * @returns after the state is current.
   */
  async retry(): Promise<void> {
    this.state.set({ status: 'loading' })
    await this.refresh()
  }

  /**
   * Move a chat to the trash.
   * @param sessionId - the chat.
   * @param label - the chat's title as the sidebar shows it.
   * @returns after the outcome is reported, whether the chat moved.
   */
  async trashChat(sessionId: string, label: string): Promise<boolean> {
    return await this.act(() => post<TrashEntry>(TRASH_PATHS.deleteChat, { sessionId, label }),
      'toast.chatTrashed', 'toast.trashFailed', (entry) => { this.track(entry) })
  }

  /**
   * Move a workspace and its chats to the trash.
   * @param workspaceId - the workspace.
   * @returns after the outcome is reported, whether the workspace moved.
   */
  async trashWorkspace(workspaceId: string): Promise<boolean> {
    return await this.act(() => post<TrashEntry>(TRASH_PATHS.deleteWorkspace, { workspaceId }),
      'toast.workspaceTrashed', 'toast.trashFailed', (entry) => { this.track(entry) })
  }

  /**
   * Return an item to where it was deleted from.
   * @param itemId - the item.
   * @returns after the outcome is reported.
   */
  async restore(itemId: string): Promise<void> {
    await this.act(() => post<TrashEntry>(TRASH_PATHS.restore, { itemId }),
      'toast.restored', 'toast.restoreFailed', (entry) => { this.release(entry.id) })
  }

  /**
   * Delete an item forever and clear its drafts from this browser.
   * @param itemId - the item.
   * @param clearLogs - whether to clear the operational logs now.
   * @returns after the outcome is reported.
   */
  async purge(itemId: string, clearLogs: boolean): Promise<void> {
    await this.act(() => post<PurgeOutcome>(TRASH_PATHS.purge, { itemId, clearLogs }),
      'toast.purged', 'toast.purgeFailed', (outcome) => {
        this.forget(outcome.item)
        return logsOutcome(clearLogs, outcome.logsCleared)
      })
  }

  /**
   * Delete every item forever and clear their drafts from this browser.
   * @param clearLogs - whether to clear the operational logs now.
   * @returns after the outcome is reported.
   */
  async empty(clearLogs: boolean): Promise<void> {
    await this.act(() => post<EmptyOutcome>(TRASH_PATHS.empty, { clearLogs }),
      'toast.emptied', 'toast.emptyFailed', (outcome) => {
        for (const item of outcome.items) this.forget(item)
        return logsOutcome(clearLogs && outcome.items.length > 0, outcome.logsCleared)
      })
  }

  /** Show every hidden chat again and ignore later answers. */
  dispose(): void {
    this.disposed = true
    for (const id of [...this.hides.keys()]) this.release(id)
  }

  /** @returns after the outcome is reported and the listing read again, whether the request succeeded. */
  private async act<T>(request: () => Promise<T>, done: TrashToastKey, failed: TrashToastKey, apply: (result: T) => TrashNotice | void): Promise<boolean> {
    let result: T
    try {
      result = await request()
    } catch (error) {
      console.warn('delorun-trash: the request failed:', error)
      this.deps.report({ ok: false, key: (error instanceof TrashRequestError ? SPECIFIC[error.code] : undefined) ?? failed })
      await this.refresh()
      return false
    }
    this.deps.report(apply(result) ?? { ok: true, key: done })
    await this.refresh()
    return true
  }

  private forget(entry: TrashEntry): void {
    this.release(entry.id)
    removeDraftEntries(this.deps.drafts, entry.sessionIds, entry.workspaceIds)
  }

  private sync(items: readonly TrashEntry[]): void {
    const present = new Set(items.map(item => item.id))
    for (const item of items) this.track(item)
    for (const id of [...this.hides.keys()]) if (!present.has(id)) this.release(id)
  }

  private track(entry: TrashEntry): void {
    if (this.disposed || this.hides.has(entry.id)) return
    this.hides.set(entry.id, entry.sessionIds.map(id => this.deps.hide(id)))
  }

  private release(id: string): void {
    for (const show of this.hides.get(id) ?? []) show()
    this.hides.delete(id)
  }
}
