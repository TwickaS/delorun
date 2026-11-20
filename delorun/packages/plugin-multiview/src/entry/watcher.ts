/**
 * The hand-off watcher: which agents of the open chat are new since it opened. The agents already present when the chat
 * became the main view are its baseline and are never reported.
 * @module @delorun/plugin-multiview/entry/watcher
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One catalog entry, as far as the watcher reads it. */
export interface CatalogIdentity {
  /** The agent's chat. */
  readonly id: SessionId
}

/** Reports the agents a chat gains while it is the main view. */
export class HandOffWatcher {
  #chat: SessionId | undefined
  #baseline: Set<SessionId> | undefined

  /**
   * Observe the main chat and its agent catalog.
   * @param chat - the chat that is the main view, or undefined when none is.
   * @param catalog - the chat's catalog, or undefined until its first read.
   * @returns the agents that joined the catalog since the previous call; empty on the call that sets the baseline, and for
   *   a chat that just became the main view, whose present agents are its baseline.
   */
  observe(chat: SessionId | undefined, catalog: readonly CatalogIdentity[] | undefined): readonly SessionId[] {
    if (chat !== this.#chat) {
      this.#chat = chat
      this.#baseline = undefined
    }
    if (chat === undefined || catalog === undefined) return []
    const baseline = this.#baseline
    if (baseline === undefined) {
      this.#baseline = new Set(catalog.map(entry => entry.id))
      return []
    }
    const fresh = catalog.map(entry => entry.id).filter(id => !baseline.has(id))
    for (const id of fresh) baseline.add(id)
    return fresh
  }
}
