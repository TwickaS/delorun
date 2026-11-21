/**
 * The studio's side of Changes: reads the harness's Changes routes, keeps the state the Settings section and the
 * work-session badge show, runs each action and reports its outcome as a toast.
 * @module @delorun/plugin-changes/client/controller
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  ACTION_PATHS,
  CHANGED_SINCE_REVIEW,
  CONFIRM_PROTECTION,
  CONFIRM_RISK,
  ELEVATION_REQUIRED,
  HARNESS_PATHS,
  LOOPBACK_REQUIRED,
  NOTICE_SEEN_PATH,
  PROTECTION_PATHS,
  RESTART_PATHS,
  SHOW_PATH,
  STATE_PATH,
  WORKSPACES_PATH,
  type ActionView,
  type ChangesControl,
  type MayView,
  type ChangesStateView,
  type CreatedView,
  type DiscardView,
  type DoneView,
  type HarnessActionView,
  type HarnessCopyView,
  type HarnessDiscardView,
  type HarnessEffectView,
  type InstallReloadView,
  type InstallView,
  type PendingListView,
  type RefusalView,
  type RestartBegunView,
  type RestartCancelView,
  type RequestedView,
  type RevealedView,
  type SafeModeView,
  type ReloadView,
  type RiskKindView,
  type ShownView,
  type StartedView,
  type ProtectionChangedView,
  type WillLoadView,
  type WorkReviewView,
  type WorkspacesView,
} from '../wire.ts'
import { fetchedPath, PASS_GRANT_ID, type FaceGrant } from './face-grant.ts'
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

/**
 * What an action came to: done, a second confirmation the route asks for (a flagged change's, or turning protection
 * off's with what would load without review), or not done.
 */
export type ActionOutcome =
  | { readonly kind: 'done' }
  | { readonly kind: 'confirm', readonly kinds: readonly RiskKindView[], readonly notShown: readonly string[] }
  | { readonly kind: 'confirm-protection', readonly willLoad: WillLoadView }
  | { readonly kind: 'refused' }

/** What Make my copy came to: the copy made or found, or not done (the toast said why). */
export type CopyOutcome = { readonly kind: 'done', readonly copy: HarnessCopyView } | { readonly kind: 'refused' }

/**
 * When each change to Delorun itself this page applied or undid takes effect, by change id, as the harness route
 * answered; the log does not keep it, so a reload of the page forgets it.
 */
export type HarnessEffects = Readonly<Record<string, HarnessEffectView>>

/** How often the state is read while Delorun restarts, in milliseconds. */
export const RESTART_REFRESH_MS = 2000

/** A refusal with the fields `CONFIRM_PROTECTION` adds. */
type ProtectionRefusal = RefusalView & { readonly willLoad?: WillLoadView }

/** What the controller needs from the page. */
export interface ChangesControllerDeps {
  /**
   * Show one outcome.
   * @param notice - the outcome.
   */
  readonly report: (notice: ChangesNotice) => void
  /**
   * The page's Face ID confirmation, read at each call, or undefined while the page has no such service. Without it a control that needs Face ID
   * is sent plain and the home refuses it.
   */
  readonly faceGrant?: () => FaceGrant | undefined
}

/** One request's sender, bound to the control it belongs to. */
type Send = <T>(path: string, body?: object) => Promise<T>

/** The person cancelled the Face ID confirmation, so the request was not sent. */
class FaceCancelled extends Error {}

/** The body fields that answer a second confirmation. */
const CONFIRMATION_FIELDS: readonly string[] = ['confirmedRisk', 'confirmed']

/**
 * @param body - a request's body.
 * @returns the body without the fields that answer a second confirmation, which the home leaves out when it checks a grant.
 */
function withoutConfirmation(body: object): object {
  return Object.fromEntries(Object.entries(body).filter(([field]) => !CONFIRMATION_FIELDS.includes(field)))
}

/**
 * Whether the home asks for Face ID before this control.
 * @param may - the state's decision for the control.
 * @returns true when it needs a grant.
 */
function mayNeedsFace(may: MayView): boolean {
  return !may.ok && may.needs === 'face'
}

/**
 * The notice for when a decided change to Delorun itself takes effect.
 * @param effect - the harness route's answer.
 * @param action - whether it was applied or undone.
 * @returns the notice.
 */
function effectNotice(effect: HarnessEffectView, action: 'apply' | 'undo'): ChangesNotice {
  switch (effect.kind) {
    case 'live': return { ok: true, key: action === 'undo' ? 'toast.self.undoneLive' : effect.page ? 'toast.self.livePage' : 'toast.self.live' }
    case 'restart': return { ok: true, key: action === 'apply' ? 'toast.self.restart' : 'toast.self.undoneRestart' }
    case 'not-running': return { ok: true, key: 'toast.self.nextStart' }
    case 'left-out': return { ok: false, key: 'toast.self.leftOut', values: { failure: effect.failure } }
  }
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
    super(`delorun-changes: the harness answered ${String(status)}${refusal === undefined ? '' : ` ${refusal.code}`}`)
    this.status = status
    this.refusal = refusal
  }
}

/**
 * Ask one route, relative to the document so the studio's own origin and path prefix apply.
 * @param path - the route from `wire.ts`, with its query.
 * @param body - the JSON body of a `POST`; a `GET` without it.
 * @param grantId - the Face ID grant the home checks against this exact call, in `Delorun-Grant`.
 * @returns the JSON answer.
 * @throws {ChangesRequestError} for a non-2xx answer; a network failure rejects with the fetch error.
 */
async function request<T>(path: string, body?: object, grantId?: string): Promise<T> {
  const response = await fetch(path.slice(1), body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'content-type': 'application/json', ...(grantId === undefined ? {} : { 'Delorun-Grant': grantId }) }, body: JSON.stringify(body) })
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
  /** When the changes to Delorun itself this page decided take effect. */
  readonly harnessEffects = createSnapshotStore<HarnessEffects>({})
  /** True from this page's Restart until a state read shows no restart under way. */
  readonly restarting = createSnapshotStore(false)
  /** The quick read that runs while a restart is under way. */
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  /** Whether {@link dispose} ran, after which no quick read starts. */
  private disposed = false

  /** The page's toast. */
  private readonly deps: ChangesControllerDeps
  /** The Face ID grants of requests the home answered with a second confirmation, by the call they cover, for the confirmed request. */
  private readonly carried = new Map<string, string>()

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
      console.warn('delorun-changes: the state was not read:', error)
      if (this.state.getSnapshot().status !== 'ready') this.state.set({ status: 'error' })
      this.followRestart()
      return
    }
    this.state.set({ status: 'ready', state })
    if (this.restarting.getSnapshot() && state.restart?.kind !== 'restarting') {
      this.restarting.set(false)
      if (state.restart === undefined) this.deps.report({ ok: true, key: 'toast.restarted' })
    }
    this.followRestart()
  }

  /** While a restart is under way, read the state again after {@link RESTART_REFRESH_MS}; a failed read keeps waiting. */
  private followRestart(): void {
    const load = this.state.getSnapshot()
    const under = this.restarting.getSnapshot() || (load.status === 'ready' && load.state.restart?.kind === 'restarting')
    if (!under || this.disposed || this.restartTimer !== undefined) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      void this.refresh()
    }, RESTART_REFRESH_MS)
  }

  /** Stop the quick read of a restart under way. */
  dispose(): void {
    this.disposed = true
    if (this.restartTimer !== undefined) clearTimeout(this.restartTimer)
    this.restartTimer = undefined
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
   * Read the plugins' folders and the person's copy of Delorun, and list the changes waiting for review in them; the
   * read stores their content.
   * @returns the changes, and why the copy could not be read when it could not.
   * @throws {ChangesRequestError} when the route refuses; a network failure rejects with the fetch error.
   */
  async listPending(): Promise<PendingListView> {
    return await request<PendingListView>(`${SHOW_PATH}?pending`)
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
    return await this.act('plugin-apply', send => send<ActionView>(ACTION_PATHS.apply, confirmedRisk ? { id, confirmedRisk } : { id }),
      result => reloadNotice(result.reload, 'toast.applied'))
  }

  /**
   * Apply an agent's plugin request: the Host runs the plugin operation and reloads.
   * @param id - the request.
   * @param confirmedRisk - whether the person confirmed a second time, which every request needs.
   * @returns the outcome; `confirm` when the route asks the second confirmation.
   */
  async applyRequest(id: string, confirmedRisk: boolean): Promise<ActionOutcome> {
    return await this.act('plugin-apply', send => send<InstallView>(ACTION_PATHS.apply, confirmedRisk ? { id, confirmedRisk } : { id }), result => installNotice(result.reload))
  }

  /**
   * Discard a change.
   * @param id - the change.
   * @returns the outcome.
   */
  async discard(id: string): Promise<ActionOutcome> {
    return await this.act('plugin-discard', send => send<DiscardView>(ACTION_PATHS.discard, { id }), () => ({ ok: true, key: 'toast.discarded' }))
  }

  /**
   * Undo an applied change, or a change left out at a start.
   * @param id - the change.
   * @returns the outcome.
   */
  async undo(id: string): Promise<ActionOutcome> {
    return await this.act('plugin-undo', send => send<ActionView>(ACTION_PATHS.undo, { id }), result => reloadNotice(result.reload, 'toast.undone'))
  }

  /**
   * Open a work session on a plugin, for the route's default length.
   * @param plugin - the plugin.
   * @returns the outcome.
   */
  async beginWork(plugin: string): Promise<ActionOutcome> {
    return await this.act('plugin-other', send => send<StartedView>(ACTION_PATHS.work, { plugin }), started => started.load.kind === 'loaded'
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
    return await this.act('plugin-other', send => send<DoneView>(ACTION_PATHS.done, confirmedRisk ? { plugin, version, confirmedRisk } : { plugin, version }),
      result => result.kind === 'ended' ? { ok: true, key: 'toast.workEnded' } : { ok: false, key: 'toast.wentBack', values: { failure: result.failure } })
  }

  /**
   * Apply a change waiting in the person's copy of Delorun, naming the content the review showed.
   * @param id - the change.
   * @param to - the full content version the review showed; the route refuses another.
   * @param confirmedRisk - whether the person confirmed the flagged kinds a second time.
   * @returns the outcome; `confirm` when the route asks the second confirmation.
   */
  async harnessApply(id: string, to: string, confirmedRisk: boolean): Promise<ActionOutcome> {
    return await this.act('harness-apply', send => send<HarnessActionView>(HARNESS_PATHS.apply, confirmedRisk ? { id, to, confirmedRisk } : { id, to }),
      result => this.decidedSelf(result, 'apply'))
  }

  /**
   * Undo a change to Delorun itself.
   * @param id - the change.
   * @returns the outcome.
   */
  async harnessUndo(id: string): Promise<ActionOutcome> {
    return await this.act('harness-undo', send => send<HarnessActionView>(HARNESS_PATHS.undo, { id }), result => this.decidedSelf(result, 'undo'))
  }

  /**
   * Discard a change waiting in the person's copy of Delorun: the copy's file goes back to the release's.
   * @param id - the change.
   * @returns the outcome.
   */
  async harnessDiscard(id: string): Promise<ActionOutcome> {
    return await this.act('harness-discard', send => send<HarnessDiscardView>(HARNESS_PATHS.discard, { id }), () => ({ ok: true, key: 'toast.discarded' }))
  }

  /**
   * Make the person's copy of Delorun, or find the one that exists.
   * @returns the copy, or `refused` after the toast said why.
   */
  async makeCopy(): Promise<CopyOutcome> {
    let copy: HarnessCopyView | undefined
    const outcome = await this.act('make-copy', send => send<HarnessCopyView>(HARNESS_PATHS.copy, {}), (made) => {
      copy = made
      return { ok: true, key: made.created ? 'toast.copy.made' : 'toast.copy.found' }
    })
    return outcome.kind === 'done' && copy !== undefined ? { kind: 'done', copy } : { kind: 'refused' }
  }

  /**
   * Ask for safe mode at the next start: Delorun's own plugins only.
   * @returns the outcome.
   */
  async startSafeMode(): Promise<ActionOutcome> {
    return await this.act('plugin-other', send => send<SafeModeView>(ACTION_PATHS['safe-mode'], {}), () => ({ ok: true, key: 'toast.safeMode.on' }))
  }

  /**
   * End safe mode, so the next start loads the whole profile again.
   * @returns the outcome.
   */
  async exitSafeMode(): Promise<ActionOutcome> {
    return await this.act('plugin-other', send => send<SafeModeView>(ACTION_PATHS['exit-safe-mode'], {}), () => ({ ok: true, key: 'toast.safeMode.off' }))
  }

  /**
   * Turn protection on.
   * @returns the outcome.
   */
  async protectionOn(): Promise<ActionOutcome> {
    return await this.act('protection-on', send => send<ProtectionChangedView>(PROTECTION_PATHS.on, {}), () => ({ ok: true, key: 'toast.protection.on' }))
  }

  /**
   * Turn protection off. Without `confirmed` the route asks the second time and names what would load without review.
   * @param confirmed - whether the person confirmed a second time.
   * @returns the outcome; `confirm-protection` with what would load when the route asks the second time.
   */
  async protectionOff(confirmed: boolean): Promise<ActionOutcome> {
    return await this.act('protection-off', send => send<ProtectionChangedView>(PROTECTION_PATHS.off, confirmed ? { confirmed } : {}), () => ({ ok: true, key: 'toast.protection.off' }))
  }

  /**
   * Dismiss a notice that a paired device changed the protection setting.
   * @param id - the notice.
   * @returns the outcome.
   */
  async noticeSeen(id: string): Promise<ActionOutcome> {
    return await this.act('notice-seen', send => send<{ readonly dismissed: boolean }>(NOTICE_SEEN_PATH, { id }), () => undefined)
  }

  /**
   * Read the workspaces a plugin may be created in.
   * @returns them, the default first, and whether this page is at the computer.
   * @throws {ChangesRequestError} when the route refuses; a network failure rejects with the fetch error.
   */
  async workspaces(): Promise<WorkspacesView> {
    return await request<WorkspacesView>(WORKSPACES_PATH)
  }

  /**
   * Create a plugin in a workspace. A refusal is returned for the form to show beside its fields, not toasted.
   * @param name - the package name.
   * @param kind - the plugin kind.
   * @param workspace - the workspace's id.
   * @returns the created plugin, or the refusal's sentence.
   */
  async createPlugin(name: string, kind: string, workspace: string): Promise<CreatedView | { readonly refused: string }> {
    try {
      return await this.sender('plugin-other')<CreatedView>(ACTION_PATHS.create, { name, kind, workspace })
    } catch (error) {
      return this.refusedWords(error)
    }
  }

  /**
   * Ask for the created plugin to be turned on: the install from its folder waits for the person's review in Changes.
   * @param name - the package name.
   * @param workspace - the workspace's id.
   * @returns the outcome.
   */
  async requestPlugin(name: string, workspace: string): Promise<ActionOutcome> {
    return await this.act('plugin-other', send => send<RequestedView>(ACTION_PATHS.request, { name, workspace }), () => ({ ok: true, key: 'toast.requested' }))
  }

  /**
   * Show a created plugin's folder in the computer's file manager.
   * @param name - the package name.
   * @param workspace - the workspace's id.
   * @returns the outcome.
   */
  async revealPlugin(name: string, workspace: string): Promise<ActionOutcome> {
    return await this.act('plugin-other', send => send<RevealedView>(ACTION_PATHS.reveal, { name, workspace }), () => ({ ok: true, key: 'toast.revealed' }))
  }

  /**
   * Restart Delorun so the changes to Delorun itself that wait for a restart run; the state is read every
   * {@link RESTART_REFRESH_MS} until the restart ends.
   * @param stopChats - stop the running chats instead of waiting for them.
   * @returns the outcome.
   */
  async restart(stopChats: boolean): Promise<ActionOutcome> {
    return await this.act('restart', async (send) => {
      const begun = await send<RestartBegunView>(RESTART_PATHS.restart, stopChats ? { stopChats } : {})
      this.restarting.set(true)
      return begun
    }, () => undefined)
  }

  /**
   * End a restart that still waits for running chats.
   * @returns the outcome.
   */
  async cancelRestart(): Promise<ActionOutcome> {
    return await this.act('restart', send => send<RestartCancelView>(RESTART_PATHS.cancel, {}), (result) => {
      if (!result.cancelled) return undefined
      this.restarting.set(false)
      return { ok: true, key: 'toast.restartCancelled' }
    })
  }

  private refusedWords(error: unknown): { readonly refused: string } {
    console.warn('delorun-changes: the plugin was not created:', error)
    const refusal = error instanceof ChangesRequestError ? error.refusal : undefined
    return { refused: refusal?.message ?? '' }
  }

  /**
   * Remember when a decided change to Delorun itself takes effect, and word it.
   * @param result - the harness route's answer.
   * @param action - whether it was applied or undone.
   * @returns the notice.
   */
  private decidedSelf(result: HarnessActionView, action: 'apply' | 'undo'): ChangesNotice {
    this.harnessEffects.set({ ...this.harnessEffects.getSnapshot(), [result.entry.id]: result.effect })
    return effectNotice(result.effect, action)
  }

  /**
   * The sender of one control's requests. While the page's state says the control needs Face ID, a `POST` first asks for
   * a grant covering exactly that call and carries it in `Delorun-Grant`. A call sent under the page's Face ID pass
   * ({@link PASS_GRANT_ID}) that the home refuses for want of a grant (the pass ended in between) is asked once more,
   * which shows the sheet.
   * @param control - the control the requests belong to.
   * @returns the sender.
   * @throws {FaceCancelled} from a send whose grant the person did not give.
   */
  private sender(control: ChangesControl): Send {
    return async <T>(path: string, body?: object): Promise<T> => {
      const ask = this.deps.faceGrant?.()
      const load = this.state.getSnapshot()
      if (body === undefined || ask === undefined || load.status !== 'ready' || !mayNeedsFace(load.state.access.may[control])) return await request<T>(path, body)
      // The home hashes the call without the fields that answer a second confirmation, so one grant covers a call and its confirmed retry.
      const covered = withoutConfirmation(body)
      const call = { action: `changes/${control}`, call: { method: 'POST', path: fetchedPath(path), body: covered } }
      const key = `${control} ${path} ${JSON.stringify(covered)}`
      const earlier = this.carried.get(key)
      this.carried.delete(key)
      const grantId = earlier ?? await ask(call)
      if (grantId === undefined) throw new FaceCancelled()
      try {
        return await this.sendGranted<T>(path, body, grantId, key)
      } catch (error) {
        const expired = error instanceof ChangesRequestError && error.refusal?.code === ELEVATION_REQUIRED
        if (!expired || (grantId !== PASS_GRANT_ID && earlier === undefined)) throw error
        const again = await ask(call)
        if (again === undefined) throw new FaceCancelled()
        if (again === PASS_GRANT_ID) throw error
        return await this.sendGranted<T>(path, body, again, key)
      }
    }
  }

  /**
   * Send a request under a grant, and keep the grant for the confirmed request when the home asks for a second confirmation.
   * @param path - the route.
   * @param body - the body.
   * @param grantId - the grant, or the page's Face ID pass.
   * @param key - the call the grant covers.
   * @returns the answer.
   * @throws {ChangesRequestError} the home's refusal.
   */
  private async sendGranted<T>(path: string, body: object, grantId: string, key: string): Promise<T> {
    try {
      return await request<T>(path, body, grantId)
    } catch (error) {
      const code = error instanceof ChangesRequestError ? error.refusal?.code : undefined
      if ((code === CONFIRM_RISK || code === CONFIRM_PROTECTION) && grantId !== PASS_GRANT_ID) this.carried.set(key, grantId)
      throw error
    }
  }

  /**
   * Run one action and report its outcome; a refusal is worded, except the second confirmations the section asks.
   * @param control - the control, which names the route to the unlock dialog.
   * @param run - the request, which sends through the control's own sender.
   * @param notice - the outcome's notice, or undefined for none.
   * @returns the outcome.
   */
  private async act<T>(control: ChangesControl, run: (send: Send) => Promise<T>, notice: (result: T) => ChangesNotice | undefined): Promise<ActionOutcome> {
    let result: T
    try {
      result = await run(this.sender(control))
    } catch (error) {
      if (error instanceof FaceCancelled) return { kind: 'refused' }
      const refusal: ProtectionRefusal | undefined = error instanceof ChangesRequestError ? error.refusal : undefined
      if (refusal?.code === CONFIRM_RISK) return { kind: 'confirm', kinds: refusal.kinds ?? [], notShown: refusal.notShown ?? [] }
      if (refusal?.code === CONFIRM_PROTECTION) return { kind: 'confirm-protection', willLoad: refusal.willLoad ?? { plugins: [], harnessFiles: 0 } }
      console.warn('delorun-changes: the action was not done:', error)
      if (refusal?.code === LOOPBACK_REQUIRED) {
        this.deps.report({ ok: false, key: 'toast.remote' })
      } else if (refusal?.code === ELEVATION_REQUIRED) {
        this.deps.report({ ok: false, key: 'toast.unlock' })
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
    const said = notice(result)
    if (said !== undefined) this.deps.report(said)
    await this.refresh()
    return { kind: 'done' }
  }
}
