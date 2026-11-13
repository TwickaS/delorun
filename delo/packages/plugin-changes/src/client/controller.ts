/**
 * The studio's side of Changes: reads the harness's Changes routes, keeps the state the Settings section and the
 * work-session badge show, runs each action and reports its outcome as a toast.
 * @module @delo/plugin-changes/client/controller
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  ACTION_PATHS,
  CHANGED_SINCE_REVIEW,
  CONFIRM_RISK,
  LOOPBACK_REQUIRED,
  SHOW_PATH,
  STATE_PATH,
  type ActionView,
  type ChangesStateView,
  type DiscardView,
  type DoneView,
  type InstallReloadView,
  type InstallView,
  type PendingListView,
  type PendingView,
  type RefusalView,
  type ReloadView,
  type RiskKindView,
  type ShownView,
  type StartedView,
  type WorkReviewView,
} from '../wire.ts'
import type { ChangesToastKey } from './locales.ts'

/** What the section shows: the first load, a failed load with nothing to show, or the state. */
export type ChangesLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready', readonly state: ChangesStateView }

/** One outcome for the toast: the copy, its values and whether the action succeeded. */
export interface ChangesNotice {
  readonly key: ChangesToastKey
  readonly values?: Readonly<Record<string, string>>
  readonly ok: boolean
}

/** What an action came to: done, a second confirmation the route asks for, or not done. */
export type ActionOutcome =
  | { readonly kind: 'done' }
  | { readonly kind: 'confirm', readonly kinds: readonly RiskKindView[], readonly notShown: readonly string[] }
  | { readonly kind: 'refused' }

/** What the controller needs from the page. */
export interface ChangesControllerDeps {
  /**
   * Show one outcome.
   * @param notice - the outcome.
   */
  readonly report: (notice: ChangesNotice) => void
}

/** A route's refusal or failed answer. */
export class ChangesRequestError extends Error {
  /** The HTTP status. */
  readonly status: number
  /** The refusal's code and sentence, or undefined when the answer carried none. */
  readonly refusal: RefusalView | undefined

  /**
   * @param status - the HTTP status.
   * @param refusal - the refusal's code and sentence, or undefined when the answer carried none.
   */
  constructor(status: number, refusal: RefusalView | undefined) {
    super(`delo-changes: the harness answered ${String(status)}${refusal === undefined ? '' : ` ${refusal.code}`}`)
    this.status = status
    this.refusal = refusal
  }
}

/**
 * Ask one route, relative to the document so the studio's own origin and path prefix apply.
 * @param path - the route from `wire.ts`, with its query.
 * @param body - the JSON body of a `POST`; a `GET` without it.
 * @returns the JSON answer.
 * @throws {ChangesRequestError} for a non-2xx answer; a network failure rejects with the fetch error.
 */
async function request<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(path.slice(1), body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) {
    const refusal = (await response.json().catch(() => undefined)) as RefusalView | undefined
    throw new ChangesRequestError(response.status, refusal)
  }
  return await response.json() as T
}

/**
 * The notice for how the running Host took an action that succeeded.
 * @param reload - the Host's answer.
 * @param done - the copy for a change the Host loaded.
 * @returns the notice.
 */
function reloadNotice(reload: ReloadView, done: ChangesToastKey): ChangesNotice {
  switch (reload.kind) {
    case 'reloaded': return { ok: true, key: done }
    case 'not-running': return { ok: true, key: 'toast.notRunning' }
    case 'went-back': return { ok: false, key: 'toast.wentBack', values: { failure: reload.failure } }
  }
}

/**
 * The notice for how the running Host took an applied agent's plugin request.
 * @param reload - the Host's answer.
 * @returns the notice.
 */
function installNotice(reload: InstallReloadView): ChangesNotice {
  switch (reload.kind) {
    case 'reloaded': return { ok: true, key: 'toast.applied' }
    case 'not-running': return { ok: true, key: 'toast.notRunning' }
    case 'failed': return { ok: false, key: 'toast.installNotLoaded', values: { failure: reload.failure } }
  }
}

/** Owns the Changes state and every request to the harness for one page. */
export class ChangesController {
  /** The state the section and the badge read. */
  readonly state = createSnapshotStore<ChangesLoad>({ status: 'loading' })
  /** Whether an action was refused because this page is not at the computer, which the state may not say yet. */
  readonly refusedRemote = createSnapshotStore<boolean>(false)

  /** The page's toast. */
  private readonly deps: ChangesControllerDeps

  /** @param deps - the page's toast. */
  constructor(deps: ChangesControllerDeps) {
    this.deps = deps
  }

  /**
   * Read the state. A failure keeps a state already shown.
   * @returns after the state is current; never rejects.
   */
  async refresh(): Promise<void> {
    let state: ChangesStateView
    try {
      state = await request<ChangesStateView>(STATE_PATH)
    } catch (error) {
      console.warn('delo-changes: the state was not read:', error)
      if (this.state.getSnapshot().status !== 'ready') this.state.set({ status: 'error' })
      return
    }
    this.state.set({ status: 'ready', state })
  }

  /**
   * Show the first-load state again and read the state.
   * @returns after the state is current.
   */
  async retry(): Promise<void> {
    this.state.set({ status: 'loading' })
    await this.refresh()
  }

  /**
   * Read the state every `intervalMs` while the page is visible, and when it becomes visible again.
   * @param intervalMs - the interval.
   * @returns the disposer that stops reading.
   */
  poll(intervalMs: number): () => void {
    const tick = (): void => {
      if (document.visibilityState === 'visible') void this.refresh()
    }
    const timer = setInterval(tick, intervalMs)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }

  /**
   * Read one change.
   * @param id - the change.
   * @returns the change, or its log entry when it no longer waits.
   * @throws {ChangesRequestError} when the route refuses; a network failure rejects with the fetch error.
   */
  async show(id: string): Promise<ShownView> {
    return await request<ShownView>(`${SHOW_PATH}?${new URLSearchParams({ id }).toString()}`)
  }

  /**
   * Read the plugins' folders and list the changes waiting for review in them; the read stores their content.
   * @returns the changes.
   * @throws {ChangesRequestError} when the route refuses; a network failure rejects with the fetch error.
   */
  async listPending(): Promise<readonly PendingView[]> {
    return (await request<PendingListView>(`${SHOW_PATH}?pending`)).pending
  }

  /**
   * Read the open work session's folder against the content it started from.
   * @param plugin - the plugin worked on.
   * @returns the version `done` approves, with its difference.
   * @throws {ChangesRequestError} when the route refuses; a network failure rejects with the fetch error.
   */
  async reviewWork(plugin: string): Promise<WorkReviewView> {
    return await request<WorkReviewView>(`${SHOW_PATH}?${new URLSearchParams({ work: plugin }).toString()}`)
  }

  /**
   * Apply a change, or apply a change left out at a start again.
   * @param id - the change.
   * @param confirmedRisk - whether the person confirmed the flagged kinds a second time.
   * @returns the outcome; `confirm` when the route asks the second confirmation.
   */
  async apply(id: string, confirmedRisk: boolean): Promise<ActionOutcome> {
    return await this.act(() => request<ActionView>(ACTION_PATHS.apply, confirmedRisk ? { id, confirmedRisk } : { id }),
      result => reloadNotice(result.reload, 'toast.applied'))
  }

  /**
   * Apply an agent's plugin request: the Host runs the plugin operation and reloads.
   * @param id - the request.
   * @param confirmedRisk - whether the person confirmed a second time, which every request needs.
   * @returns the outcome; `confirm` when the route asks the second confirmation.
   */
  async applyRequest(id: string, confirmedRisk: boolean): Promise<ActionOutcome> {
    return await this.act(() => request<InstallView>(ACTION_PATHS.apply, confirmedRisk ? { id, confirmedRisk } : { id }), result => installNotice(result.reload))
  }

  /**
   * Discard a change.
   * @param id - the change.
   * @returns the outcome.
   */
  async discard(id: string): Promise<ActionOutcome> {
    return await this.act(() => request<DiscardView>(ACTION_PATHS.discard, { id }), () => ({ ok: true, key: 'toast.discarded' }))
  }

  /**
   * Undo an applied change, or a change left out at a start.
   * @param id - the change.
   * @returns the outcome.
   */
  async undo(id: string): Promise<ActionOutcome> {
    return await this.act(() => request<ActionView>(ACTION_PATHS.undo, { id }), result => reloadNotice(result.reload, 'toast.undone'))
  }

  /**
   * Open a work session on a plugin, for the route's default length.
   * @param plugin - the plugin.
   * @returns the outcome.
   */
  async beginWork(plugin: string): Promise<ActionOutcome> {
    return await this.act(() => request<StartedView>(ACTION_PATHS.work, { plugin }), started => started.load.kind === 'loaded'
      ? { ok: true, key: 'toast.workStarted' }
      : { ok: false, key: 'toast.wentBack', values: { failure: started.load.failure } })
  }

  /**
   * End the work session, approving exactly the version the person was shown.
   * @param plugin - the plugin.
   * @param version - the version `reviewWork` returned.
   * @param confirmedRisk - whether the person confirmed the flagged kinds a second time.
   * @returns the outcome; `confirm` when the route asks the second confirmation.
   */
  async done(plugin: string, version: string, confirmedRisk: boolean): Promise<ActionOutcome> {
    return await this.act(() => request<DoneView>(ACTION_PATHS.done, confirmedRisk ? { plugin, version, confirmedRisk } : { plugin, version }),
      result => result.kind === 'ended' ? { ok: true, key: 'toast.workEnded' } : { ok: false, key: 'toast.wentBack', values: { failure: result.failure } })
  }

  private async act<T>(run: () => Promise<T>, notice: (result: T) => ChangesNotice): Promise<ActionOutcome> {
    let result: T
    try {
      result = await run()
    } catch (error) {
      const refusal = error instanceof ChangesRequestError ? error.refusal : undefined
      if (refusal?.code === CONFIRM_RISK) return { kind: 'confirm', kinds: refusal.kinds ?? [], notShown: refusal.notShown ?? [] }
      console.warn('delo-changes: the action was not done:', error)
      if (refusal?.code === LOOPBACK_REQUIRED) {
        this.refusedRemote.set(true)
        this.deps.report({ ok: false, key: 'toast.remote' })
      } else if (refusal?.code === CHANGED_SINCE_REVIEW) {
        this.deps.report({ ok: false, key: 'toast.changedSinceReview' })
      } else if (refusal === undefined) {
        this.deps.report({ ok: false, key: 'toast.unreachable' })
      } else {
        this.deps.report({ ok: false, key: 'toast.failed', values: { message: refusal.message } })
      }
      await this.refresh()
      return { kind: 'refused' }
    }
    this.deps.report(notice(result))
    await this.refresh()
    return { kind: 'done' }
  }
}
