/**
 * The studio's side of the update: reads the Host's update state, keeps what the sidebar notice, the Settings panel and
 * the dialogs show, runs each action through the update routes and reloads the page once when the Host runs another
 * release than the one this page loaded. A refused action is reported as a {@link UpdateRefusal} for the screen to
 * word; a request that never reached the Host rejects with the fetch error.
 * @module @delorun/plugin-update/client/controller
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { fetchedPath, type FaceGrant } from '@delorun/plugin-changes/face-grant'
import {
  UPDATE_PATHS,
  type PreparedUpdateView,
  type RollbackBody,
  type UpdateApplyBody,
  type UpdateBegunView,
  type UpdateCancelView,
  type UpdateCheckedView,
  type UpdateControl,
  type UpdateStateView,
} from '../wire.ts'

/** The refusal code of a request that needs the person at their computer or an unlock entered on this device. */
export const ELEVATION_REQUIRED = 'ELEVATION_REQUIRED'

/** How often the state is read while nothing runs, in milliseconds. */
export const IDLE_REFRESH_MS = 15_000

/** How often the state is read while an update, a rollback or a preparation runs, in milliseconds. */
export const BUSY_REFRESH_MS = 2000

/** What the screens show: the first load, a failed first load, or the state. */
export type UpdateLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready', readonly state: UpdateStateView, readonly reconnecting: boolean }

/** A refusal of an update route, as the Host answered it. */
export interface UpdateRefusal {
  readonly code: string
  readonly message: string
}

/** What an action came to: its answer, or the Host's refusal. */
export type Outcome<V> =
  | { readonly ok: true, readonly value: V }
  | { readonly ok: false, readonly refusal: UpdateRefusal }

/** What the controller needs from the page. */
export interface UpdateControllerDeps {
  /**
   * Called when a route refused this device until it is unlocked, so the studio opens its unlock dialog.
   * @param control - the control that was refused.
   */
  readonly unlockNeeded: (control: UpdateControl) => void
  /** Reload the page, once the Host runs another release than the loaded one. */
  readonly reload: () => void
  /**
   * The page's Face ID confirmation, read at each call, or undefined while the page has no such service. Without it a
   * control that needs Face ID is sent plain and the home refuses it.
   */
  readonly faceGrant?: () => FaceGrant | undefined
}

/** One request's sender, bound to the control it belongs to. */
type Send = <V>(path: string, body?: object) => Promise<V>

/** The person cancelled the Face ID confirmation, so the request was not sent. */
class FaceCancelled extends Error {}

/** The answer of the prepare route: the prepared update under `prepared`. */
export interface PreparedUpdateAnswer {
  readonly prepared: PreparedUpdateView
}

/** Thrown by {@link request} for a non-2xx answer. */
class RouteRefused extends Error {
  readonly refusal: UpdateRefusal
  /**
   * @param refusal - the Host's code and sentence.
   */
  constructor(refusal: UpdateRefusal) {
    super(`delorun-update: the Host refused ${refusal.code}`)
    this.refusal = refusal
  }
}

/**
 * Ask one route, relative to the document so the studio's own origin and path prefix apply.
 * @param path - the route from `wire.ts`.
 * @param body - the JSON body of a `POST`; a `GET` without it.
 * @param grantId - the Face ID grant the home checks against this exact call, in `Delorun-Grant`.
 * @returns the JSON answer.
 * @throws {RouteRefused} for a non-2xx answer; a network failure rejects with the fetch error.
 */
async function request<V>(path: string, body?: object, grantId?: string): Promise<V> {
  const response = await fetch(path.slice(1), body === undefined
    ? { method: 'GET', headers: { accept: 'application/json' } }
    : { method: 'POST', headers: { 'content-type': 'application/json', ...(grantId === undefined ? {} : { 'Delorun-Grant': grantId }) }, body: JSON.stringify(body) })
  if (!response.ok) {
    const said = await response.json().catch((): undefined => undefined) as Partial<UpdateRefusal> | undefined
    throw new RouteRefused({ code: said?.code ?? 'UPDATE_FAILED', message: said?.message ?? '' })
  }
  return await response.json() as V
}

/** Owns the update state and every request to the Host's update routes for one page. */
export class UpdateController {
  /** The state the screens read. */
  readonly state = createSnapshotStore<UpdateLoad>({ status: 'loading' })
  /** True from this page's update or rollback until a state read shows the outcome; the page then says it reconnects. */
  readonly switching = createSnapshotStore(false)
  /** The release the first state read named: the release this page's code belongs to. */
  #loaded: string | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #disposed = false
  private readonly deps: UpdateControllerDeps

  /**
   * @param deps - what the controller needs from the page.
   */
  constructor(deps: UpdateControllerDeps) {
    this.deps = deps
  }

  /**
   * Read the state now. A failed read keeps the state shown, and says the page is reconnecting while this page's own
   * update or rollback runs; with nothing shown it is an error.
   * @returns after the state is current or the read failed.
   */
  async refresh(): Promise<void> {
    try {
      const state = await request<UpdateStateView>(UPDATE_PATHS.state)
      if (this.#disposed) return
      const release = state.release.delorun
      this.#loaded ??= release
      if (release !== this.#loaded) {
        this.deps.reload()
        return
      }
      if (state.progress.kind === 'idle' && state.result !== undefined) this.switching.set(false)
      this.state.set({ status: 'ready', state, reconnecting: false })
    } catch (error) {
      console.warn('delorun-update: the state was not read:', error)
      const shown = this.state.getSnapshot()
      if (shown.status === 'ready') this.state.set({ ...shown, reconnecting: this.switching.getSnapshot() })
      else this.state.set({ status: 'error' })
    }
    this.#schedule()
  }

  /**
   * Read the state every {@link IDLE_REFRESH_MS}, or every {@link BUSY_REFRESH_MS} while something runs.
   * @returns the stop function.
   */
  poll(): () => void {
    void this.refresh()
    return () => { this.dispose() }
  }

  /** Stop reading. */
  dispose(): void {
    this.#disposed = true
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
  }

  /** Arm the next read at the pace the state asks for. */
  #schedule(): void {
    if (this.#disposed) return
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    const shown = this.state.getSnapshot()
    const busy = this.switching.getSnapshot() || (shown.status === 'ready' && shown.state.progress.kind !== 'idle')
    this.#timer = setTimeout(() => { this.#timer = undefined; void this.refresh() }, busy ? BUSY_REFRESH_MS : IDLE_REFRESH_MS)
  }

  /**
   * The sender of one control's requests. While the page's state says the control needs Face ID, a `POST` first asks for
   * a grant covering exactly that call and carries it in `Delorun-Grant`.
   * @param control - the control the requests belong to.
   * @returns the sender.
   * @throws {FaceCancelled} from a send whose grant the person did not give.
   */
  #sender(control: UpdateControl): Send {
    return async <V>(path: string, body?: object): Promise<V> => {
      const ask = this.deps.faceGrant?.()
      const load = this.state.getSnapshot()
      const may = load.status === 'ready' ? load.state.access.may[control] : undefined
      if (body === undefined || ask === undefined || may === undefined || may.ok || may.needs !== 'face') return await request<V>(path, body)
      const grantId = await ask({ action: `changes/${control}`, call: { method: 'POST', path: fetchedPath(path), body } })
      if (grantId === undefined) throw new FaceCancelled()
      return await request<V>(path, body, grantId)
    }
  }

  /**
   * Run one action; a refusal is returned for the screen to word, and an unlock refusal also opens the unlock dialog.
   * @param control - the control the route belongs to.
   * @param run - the request.
   * @returns the answer or the refusal.
   */
  async #act<V>(control: UpdateControl, run: (send: Send) => Promise<V>): Promise<Outcome<V>> {
    try {
      const value = await run(this.#sender(control))
      await this.refresh()
      return { ok: true, value }
    } catch (error) {
      if (error instanceof FaceCancelled) return { ok: false, refusal: { code: 'FACE_CANCELLED', message: '' } }
      if (!(error instanceof RouteRefused)) throw error
      if (error.refusal.code === ELEVATION_REQUIRED) this.deps.unlockNeeded(control)
      await this.refresh()
      return { ok: false, refusal: error.refusal }
    }
  }

  /**
   * Run the release check now.
   * @returns the check.
   */
  check(): Promise<Outcome<UpdateCheckedView>> {
    return this.#act('update-check', send => send<UpdateCheckedView>(UPDATE_PATHS.check, {}))
  }

  /**
   * Fetch, verify and install the newest release, and read C3's report for it.
   * @returns the prepared update, whose handle `apply` takes.
   */
  prepare(): Promise<Outcome<PreparedUpdateAnswer>> {
    return this.#act('update-begin', send => send<PreparedUpdateAnswer>(UPDATE_PATHS.prepare, {}))
  }

  /**
   * Begin the update of a prepared release; the page then waits for the Host to switch and answer again.
   * @param body - the handle, the chat choice, the data copy and the ticks.
   * @returns the begun update.
   */
  async apply(body: UpdateApplyBody): Promise<Outcome<UpdateBegunView>> {
    const outcome = await this.#act('update-begin', send => send<UpdateBegunView>(UPDATE_PATHS.apply, body))
    if (outcome.ok) this.switching.set(true)
    return outcome
  }

  /**
   * End an update or a rollback that still waits for chats.
   * @returns whether anything waited.
   */
  cancel(): Promise<Outcome<UpdateCancelView>> {
    return this.#act('update-cancel', send => send<UpdateCancelView>(UPDATE_PATHS.cancel, {}))
  }

  /**
   * Go back from the committed update.
   * @param body - the chat choice and whether only the settings go back.
   * @returns the begun rollback.
   */
  async rollback(body: RollbackBody): Promise<Outcome<UpdateBegunView>> {
    const outcome = await this.#act('update-rollback', send => send<UpdateBegunView>(UPDATE_PATHS.rollback, body))
    if (outcome.ok) this.switching.set(true)
    return outcome
  }

  /**
   * Forget the outcome record the screen showed.
   * @returns after the record is gone.
   */
  dismiss(): Promise<Outcome<object>> {
    return this.#act('update-dismiss', send => send<object>(UPDATE_PATHS.dismiss, {}))
  }
}
