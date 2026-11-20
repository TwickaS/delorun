/**
 * Keeps a chat's Multiview state in the browser's `localStorage`, one key per chat, as a client preference: nothing here
 * reaches a model request. A value that does not parse or validate is discarded and removed, and the chat starts with
 * nothing pinned.
 * @module @delorun/plugin-multiview/entry/persistence
 */
import { qualifiedPersistKey } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'
import { layoutProblem } from '../layout/index.ts'
import type { ChatMultiview, MultiviewPersistence } from './contract.ts'

/** The persistence namespace, the first part of each chat's key. */
export const MULTIVIEW_PERSIST_NAME = 'dsh.multiview.v1'

const sessionId = z.string().min(1).max(200).transform(value => SessionId(value))

const leaf = z.object({ kind: z.literal('leaf'), panes: z.array(sessionId).min(1), active: sessionId, size: z.number() })
const split = z.object({
  kind: z.literal('split'),
  orientation: z.enum(['horizontal', 'vertical']),
  get children() { return z.array(node).min(2) },
  size: z.number(),
})
const node = z.union([leaf, split])

const saved = z.object({
  v: z.literal(1),
  pins: z.array(sessionId),
  layout: z.object({ version: z.literal(1), root: node }).nullable(),
  open: z.boolean(),
})

/** The storage the persistence reads and writes. */
export type MultiviewStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/**
 * Keep chats' Multiview state in a storage.
 * @param storage - the browser's `localStorage`.
 * @param warn - called with the reason when a saved value is discarded.
 * @returns the persistence.
 */
export function localPersistence(storage: MultiviewStorage, warn: (message: string) => void): MultiviewPersistence {
  const key = (chat: SessionId): string => qualifiedPersistKey(MULTIVIEW_PERSIST_NAME, chat)
  return {
    load(chat) {
      const raw = storage.getItem(key(chat))
      if (raw === null) return undefined
      let value: unknown
      try {
        value = JSON.parse(raw)
      } catch (error) {
        warn(`multiview: the saved state of a chat is not JSON (${String(error)}); it is discarded`)
        storage.removeItem(key(chat))
        return undefined
      }
      const parsed = saved.safeParse(value)
      const problem = parsed.success && parsed.data.layout !== null ? layoutProblem(parsed.data.layout) : undefined
      if (!parsed.success || problem !== undefined) {
        warn(`multiview: the saved state of a chat is not valid (${parsed.success ? problem : parsed.error.message}); it is discarded`)
        storage.removeItem(key(chat))
        return undefined
      }
      const { pins, layout, open } = parsed.data
      return { pins, layout, open }
    },
    save(chat, value: ChatMultiview) {
      try {
        storage.setItem(key(chat), JSON.stringify({ v: 1, pins: value.pins, layout: value.layout, open: value.open }))
      } catch (error) {
        warn(`multiview: the state of a chat could not be saved (${String(error)})`)
      }
    },
  }
}
