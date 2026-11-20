/**
 * The Multiview preference for one chat, kept in the browser's `localStorage`: which agents are pinned, how the panes are arranged
 * and whether Multiview was open. It is a client preference, not a Session event: nothing in it reaches a model request. A saved
 * value that cannot be read or fails validation is discarded with a console warning and the default is used.
 * @module @delorun/plugin-multiview/store/persist
 */

import { qualifiedPersistKey } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'
import { layoutProblem, type LayoutModel, type LayoutNode, type PaneId } from '../layout/model.ts'

/** The storage key's name; the chat's id and the connection's host id qualify it. The version is part of the name: another version is another key. */
export const MULTIVIEW_PERSIST_NAME = 'dsh.multiview.v1'

/** What is saved for one chat. */
export interface SavedMultiview {
  readonly v: 1
  /** The pinned agents' chats, in pin order. The source of truth for which agents Multiview shows. */
  readonly pins: readonly SessionId[]
  /** How the panes are arranged, or null for the default arrangement. It only places the pinned agents. */
  readonly layout: LayoutModel | null
  /** Whether Multiview was open when the person left the chat. */
  readonly open: boolean
}

/** The value for a chat with nothing saved. */
export const DEFAULT_SAVED: SavedMultiview = { v: 1, pins: [], layout: null, open: false }

const paneId = z.custom<PaneId>(value => typeof value === 'string' && value.length > 0, 'a pane id is a non-empty string')
const size = z.number().positive().finite()
const leaf = z.object({
  kind: z.literal('leaf'),
  panes: z.array(paneId).min(1),
  active: paneId,
  size,
})
const node: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    leaf,
    z.object({
      kind: z.literal('split'),
      orientation: z.enum(['horizontal', 'vertical']),
      children: z.array(node).min(2),
      size,
    }),
  ]),
)
const saved = z.object({
  v: z.literal(1),
  pins: z.array(paneId),
  layout: z.object({ version: z.literal(1), root: node }).nullable(),
  open: z.boolean(),
})

function invalid(sessionId: string, why: string): SavedMultiview {
  console.warn(`Multiview: the saved layout for chat ${sessionId} is not valid (${why}); using the default.`)
  clearSavedMultiview(sessionId)
  return DEFAULT_SAVED
}

/**
 * Read the saved preference for a chat.
 * @param sessionId - the chat Multiview is opened from.
 * @returns the saved value, or {@link DEFAULT_SAVED} when nothing is saved, storage is unavailable, or the saved value fails validation (which is logged and cleared).
 */
export function readSavedMultiview(sessionId: string): SavedMultiview {
  if (typeof localStorage === 'undefined') return DEFAULT_SAVED
  let raw: string | null
  try {
    raw = localStorage.getItem(qualifiedPersistKey(MULTIVIEW_PERSIST_NAME, sessionId))
  } catch (_storageUnavailable) {
    // Private browsing or a blocked store: behave as if nothing was saved.
    return DEFAULT_SAVED
  }
  if (raw === null) return DEFAULT_SAVED
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    return invalid(sessionId, error instanceof Error ? error.message : 'not JSON')
  }
  const parsed = saved.safeParse(json)
  if (!parsed.success) return invalid(sessionId, parsed.error.issues[0]?.message ?? 'wrong shape')
  const { layout, pins } = parsed.data
  if (new Set(pins).size !== pins.length) return invalid(sessionId, 'a pin appears twice')
  const problem = layout === null ? undefined : layoutProblem(layout)
  if (problem !== undefined) return invalid(sessionId, problem)
  return parsed.data
}

/**
 * Save the preference for a chat.
 * @param sessionId - the chat Multiview is opened from.
 * @param value - what to save.
 */
export function writeSavedMultiview(sessionId: string, value: SavedMultiview): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(qualifiedPersistKey(MULTIVIEW_PERSIST_NAME, sessionId), JSON.stringify(value))
  } catch (error) {
    console.warn('Multiview: the layout could not be saved:', error)
  }
}

/**
 * Remove the saved preference for a chat.
 * @param sessionId - the chat whose preference to discard.
 */
export function clearSavedMultiview(sessionId: string): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(qualifiedPersistKey(MULTIVIEW_PERSIST_NAME, sessionId))
  } catch (_storageUnavailable) {
    // The bad value stays in a store that cannot be written; it is rejected again on the next read.
  }
}
