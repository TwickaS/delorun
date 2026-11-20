/**
 * The session references the panes hold. A pane retains its chat with the `multiviewPane` source for as long as the pane is in the
 * layout, and the last release of a chat tears its scope down, so a closed pane releases its session. The holder lives outside the
 * layout and the phone pager, so moving a pane or paging past a page never releases or re-opens a chat.
 * @module @delorun/plugin-multiview/panes/references
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** A chat shown in a Multiview pane or a phone page. */
    multiviewPane: unknown
  }
}

/** What the holder needs of the sessions service. */
export type PaneSessions = Pick<ISessions, 'retain' | 'subagentAddress'>

/** The references of the panes now in the layout. */
export class PaneReferences {
  readonly #sessions: PaneSessions
  readonly #held = new Map<SessionId, SessionReference>()
  readonly #listeners = new Set<() => void>()
  #snapshot: ReadonlyMap<SessionId, SessionReference> = new Map()

  /** @param sessions - the sessions service that retains the chats. */
  constructor(sessions: PaneSessions) {
    this.#sessions = sessions
  }

  /**
   * Hold a reference for each chat in `ids` and release the references of every other chat. A chat already held keeps its reference.
   * @param ids - the chats whose panes are in the layout.
   */
  sync(ids: readonly SessionId[]): void {
    const wanted = new Set(ids)
    let changed = false
    for (const [id, reference] of this.#held) {
      if (wanted.has(id)) continue
      this.#held.delete(id)
      reference.release()
      changed = true
    }
    for (const id of wanted) {
      if (this.#held.has(id)) continue
      // A child chat is addressed through its parent, as the right Sidebar does, so its history opens under the parent's routing.
      const target = this.#sessions.subagentAddress(id) ?? id
      this.#held.set(id, this.#sessions.retain(target, { source: 'multiviewPane' }))
      changed = true
    }
    if (changed) this.#publish()
  }

  /** Release every reference. */
  releaseAll(): void {
    this.sync([])
  }

  /** The number of chats held. */
  get size(): number {
    return this.#held.size
  }

  /**
   * Observe the held references.
   * @param listener - called after the set of held references changes.
   * @returns the unsubscribe function.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /**
   * The references now held.
   * @returns a map that is replaced, never changed, when the set changes.
   */
  getSnapshot = (): ReadonlyMap<SessionId, SessionReference> => this.#snapshot

  #publish(): void {
    this.#snapshot = new Map(this.#held)
    for (const listener of [...this.#listeners]) listener()
  }
}

/**
 * Hold a reference for each chat in `ids` while the component is mounted.
 * @param sessions - the sessions service.
 * @param ids - the chats whose panes are in the layout.
 * @returns the references held now; a chat is absent from the map until its reference has been taken.
 */
export function usePaneReferences(sessions: PaneSessions, ids: readonly SessionId[]): ReadonlyMap<SessionId, SessionReference> {
  const [holder] = useState(() => new PaneReferences(sessions))
  const key = ids.join('\n')
  useEffect(() => {
    holder.sync(key === '' ? [] : key.split('\n') as SessionId[])
  }, [holder, key])
  useEffect(() => () => { holder.releaseAll() }, [holder])
  return useSyncExternalStore(holder.subscribe, holder.getSnapshot)
}
