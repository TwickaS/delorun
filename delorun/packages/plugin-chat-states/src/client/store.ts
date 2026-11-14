/**
 * The studio's copy of the chat states: read when the studio starts, at the
 * configured interval and whenever the window regains focus, and replaced by
 * each change's answer. It derives the members of the Snoozed and Settled
 * shelves and the woke chats, waking a snoozed chat when its snooze ends.
 * @module @delorun/plugin-chat-states/client/store
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatState, ChatStateRequest } from '../wire.ts'
import type { ChatStatesApi } from './api.ts'

/** The longest timer a browser keeps, about 24.8 days; a later wake is checked again then. */
const MAX_TIMER_MS = 2_147_483_647

/** The states, the shelves' members and the last failure. */
export class ChatStateStore {
  /** Each chat's state, by session id. */
  readonly states = createSnapshotStore<Readonly<Record<string, ChatState>>>({})
  /** Snoozed chats, with the time each was snoozed. */
  readonly snoozed = createSnapshotStore<ReadonlyMap<SessionId, number>>(new Map())
  /** Settled chats, with the time each was settled. */
  readonly settled = createSnapshotStore<ReadonlyMap<SessionId, number>>(new Map())
  /** Chats whose snooze ended by its time and that the person has not seen since, with the time each woke. */
  readonly woke = createSnapshotStore<ReadonlyMap<SessionId, number>>(new Map())
  /** Chats the person returned to the list, with the time each was returned; auto-settle counts idle days from then. */
  readonly kept = createSnapshotStore<ReadonlyMap<SessionId, number>>(new Map())
  /** Whether the last change failed, for the notice. */
  readonly failed = createSnapshotStore(false)
  #wake: ReturnType<typeof setTimeout> | undefined
  /** How many changes were sent, which numbers each change and tells a read whether one started after it. */
  #changesSent = 0
  /** How many changes await their answer. */
  #changesPending = 0
  /** The number of the latest change whose answer was shown, so a slower answer to an earlier change does not replace it. */
  #changeShown = 0

  /** The routes. */
  private readonly api: ChatStatesApi
  /** The clock. */
  private readonly now: () => number

  /**
   * @param api - the routes.
   * @param now - the clock.
   */
  constructor(api: ChatStatesApi, now: () => number = Date.now) {
    this.api = api
    this.now = now
  }

  /**
   * Read the states now, at the interval and on focus.
   * @param refreshSeconds - the seconds between reads; a change re-arms the interval.
   * @returns the disposer that stops reading.
   */
  start(refreshSeconds: HostObservable<number>): () => void {
    const lifetime = new AbortController()
    const refresh = (): void => {
      // A read sent while a change is pending, or overtaken by one, may not show it; the next read does.
      const sentClean = this.#changesPending === 0
      const sentAt = this.#changesSent
      this.api.list(lifetime.signal).then((answer) => {
        if (!lifetime.signal.aborted && sentClean && this.#changesSent === sentAt) this.accept(answer.chats)
      }, (error: unknown) => {
        // A read that failed keeps the last states; the next read tries again.
        if (!lifetime.signal.aborted) console.warn('delorun chat states: could not read the chat states', error)
      })
    }
    refresh()
    let armed = refreshSeconds.getSnapshot()
    let timer = setInterval(refresh, armed * 1000)
    const unsubscribe = refreshSeconds.subscribe(() => {
      const next = refreshSeconds.getSnapshot()
      if (next === armed) return
      armed = next
      clearInterval(timer)
      timer = setInterval(refresh, armed * 1000)
    })
    window.addEventListener('focus', refresh)
    return () => {
      lifetime.abort()
      unsubscribe()
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      clearTimeout(this.#wake)
    }
  }

  /**
   * Ask the harness for a change and show its answer, or the failure notice.
   * @param request - the change.
   */
  async change(request: ChatStateRequest): Promise<void> {
    this.failed.set(false)
    this.#changesPending += 1
    const number = ++this.#changesSent
    try {
      const answer = await this.api.set(request)
      if (number > this.#changeShown) {
        this.#changeShown = number
        this.accept(answer.chats)
      }
    } catch (error) {
      console.warn('delorun chat states: could not save a change', error)
      this.failed.set(true)
    } finally {
      this.#changesPending -= 1
    }
  }

  /** Take the harness's states and derive the shelves. */
  private accept(chats: Readonly<Record<string, ChatState>>): void {
    this.states.set(chats)
    this.derive()
  }

  /** Recompute the shelves' members, and wake the next snooze when it ends. */
  private derive(): void {
    const now = this.now()
    const snoozed = new Map<SessionId, number>()
    const settled = new Map<SessionId, number>()
    const woke = new Map<SessionId, number>()
    const kept = new Map<SessionId, number>()
    let next: number | undefined
    for (const [session, state] of Object.entries(this.states.getSnapshot())) {
      const id = SessionId(session)
      if (state.settledAt !== undefined) settled.set(id, state.settledAt)
      if (state.wokeAt !== undefined) woke.set(id, state.wokeAt)
      if (state.keptAt !== undefined) kept.set(id, state.keptAt)
      if (state.snoozedAt !== undefined && state.snoozedUntil !== undefined) {
        // A snooze that ended here wakes before the harness next lists it as a waking.
        if (state.snoozedUntil <= now) {
          woke.set(id, state.snoozedUntil)
          continue
        }
        snoozed.set(id, state.snoozedAt)
        next = Math.min(next ?? state.snoozedUntil, state.snoozedUntil)
      }
    }
    this.snoozed.set(snoozed)
    this.settled.set(settled)
    this.woke.set(woke)
    this.kept.set(kept)
    clearTimeout(this.#wake)
    if (next !== undefined) this.#wake = setTimeout(() => { this.derive() }, Math.min(next - now, MAX_TIMER_MS))
  }
}
