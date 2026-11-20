/**
 * How the entry points read a chat's agents out of the session list: the parent of an agent chat, the chat that owns its
 * Multiview, and the agents that run now.
 * @module @delorun/plugin-multiview/entry/read
 */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CatalogIdentity } from './watcher.ts'

/** The deepest agent chain walked to find a Multiview owner; a longer chain stops at its last parent. */
const MAX_DEPTH = 16

/**
 * The chat whose catalog lists an agent chat.
 * @param state - the session list.
 * @param agent - the agent's chat.
 * @returns the parent chat, or undefined for a chat no catalog lists.
 */
export function parentOf(state: SessionListState, agent: SessionId): SessionId | undefined {
  for (const [parent, snapshot] of Object.entries(state.projectionsBySession)) {
    if (snapshot.values.subagentCatalog?.some(entry => entry.id === agent) === true) return parent as SessionId
  }
  const summary = state.byId[agent]
  return summary?.origin === 'subagent' ? summary.parentId : undefined
}

/**
 * The chat a Multiview belongs to for an agent anywhere in a chat's tree: the top of its chain.
 * @param state - the session list.
 * @param agent - the agent's chat.
 * @returns the top chat; the agent itself when nothing lists it.
 */
export function ownerOf(state: SessionListState, agent: SessionId): SessionId {
  let current = agent
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const parent = parentOf(state, current)
    if (parent === undefined) return current
    current = parent
  }
  return current
}

/**
 * The chat that is the main view.
 * @param state - the session list.
 * @returns the chat, or undefined while none is shown.
 */
export function mainChatOf(state: SessionListState): SessionId | undefined {
  return Object.values(state.byId).find(summary => (summary.retainedBy.mainView ?? 0) > 0)?.id
}

/**
 * A chat's agent catalog, when its projection has been read.
 * @param state - the session list.
 * @param chat - the chat.
 * @returns the catalog entries, or undefined until the chat's projections are read.
 */
export function catalogOf(state: SessionListState, chat: SessionId): readonly CatalogIdentity[] | undefined {
  const snapshot = state.projectionsBySession[chat]
  if (snapshot === undefined) return undefined
  return snapshot.values.subagentCatalog ?? (snapshot.state === 'ready' ? [] : undefined)
}

/**
 * The agents of a chat that are running now.
 * @param state - the session list.
 * @param chat - the chat.
 * @returns their chats in catalog order.
 */
export function runningAgentsOf(state: SessionListState, chat: SessionId): readonly SessionId[] {
  return (catalogOf(state, chat) ?? []).filter(entry => state.byId[entry.id]?.running === true).map(entry => entry.id)
}
