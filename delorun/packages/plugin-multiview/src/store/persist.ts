/**
 * Keeps each chat's Multiview state (pins, layout, open flag, and the arrangement it follows) in the browser's `localStorage`, one key per chat, as a client
 * preference: nothing here reaches a model request. A value that does not parse, fails validation or exceeds the size limits
 * is discarded and removed with a warning, and the chat starts with nothing pinned. An index of the chats saved, most recent
 * first, bounds the storage: saving a chat beyond the limit removes the least recent chats' keys.
 * @module @delorun/plugin-multiview/store/persist
 */
import { qualifiedPersistKey } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'
import { KEPT_CHATS_RANGE, MAX_PANES_RANGE } from '../config.ts'
import { LAYOUT_CHOICE_IDS, layoutProblem, panesOf, shapeProblem, type ChatArrangement, type LayoutNode, type LayoutShape, type ShapeNode } from '../layout/index.ts'
import type { ChatMultiview, MultiviewPersistence } from '../client/contract.ts'

/** The storage key's name; the chat's id and the connection's host id qualify it. The version is part of the name: another version is another key. */
export const MULTIVIEW_PERSIST_NAME = 'dsh.multiview.v1'

/** The key of the index of saved chats. It is a separate name so that no chat id can collide with it. */
export const MULTIVIEW_INDEX_NAME = 'dsh.multiview-index.v1'

/** The storage the persistence reads and writes. */
export type MultiviewStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/**
 * The page's `localStorage`. Some browsers throw a SecurityError when the global is only read, so the read is guarded.
 * @returns the storage, or undefined when it is absent or blocked.
 */
export function browserStorage(): MultiviewStorage | undefined {
  try {
    return globalThis.localStorage
  } catch (_blocked) {
    // A blocked store behaves as if nothing was ever saved.
    return undefined
  }
}

/** The most panes a saved layout may hold: the Config ceiling, which Config also enforces on the limit in force. */
const MAX_SAVED_PANES = MAX_PANES_RANGE.max

const sessionId = z.string().min(1).max(200).transform(value => SessionId(value))
const size = z.number().positive().finite()
const leaf = z.object({
  kind: z.literal('leaf'),
  panes: z.array(sessionId).min(1).max(MAX_SAVED_PANES),
  active: sessionId,
  size,
})

/**
 * A layout node of at most `depth` nested splits; the schema is built level by level, so a deeper value fails before it is walked.
 * @param depth - the splits still allowed.
 * @returns the schema.
 */
function nodeWithin(depth: number): z.ZodType<LayoutNode> {
  if (depth <= 0) return leaf
  return z.union([
    leaf,
    z.object({
      kind: z.literal('split'),
      orientation: z.enum(['horizontal', 'vertical']),
      children: z.array(z.lazy(() => nodeWithin(depth - 1))).min(2).max(MAX_SAVED_PANES),
      size,
    }),
  ])
}

const slot = z.number().int().min(0).max(MAX_SAVED_PANES * 4)
const shapeLeaf = z.object({ kind: z.literal('leaf'), slots: z.array(slot).min(1).max(MAX_SAVED_PANES), active: slot, size })

/** A shape node of at most `depth` nested splits, built level by level like {@link nodeWithin}. */
function shapeWithin(depth: number): z.ZodType<ShapeNode> {
  if (depth <= 0) return shapeLeaf
  return z.union([
    shapeLeaf,
    z.object({
      kind: z.literal('split'),
      orientation: z.enum(['horizontal', 'vertical']),
      children: z.array(z.lazy(() => shapeWithin(depth - 1))).min(2).max(MAX_SAVED_PANES),
      size,
    }),
  ])
}

const shapeSchema: z.ZodType<LayoutShape> = z.object({ version: z.literal(1), root: shapeWithin(MAX_SAVED_PANES - 1) })

const ARRANGEMENTS: readonly [ChatArrangement, ...ChatArrangement[]] = ['custom', ...LAYOUT_CHOICE_IDS]

/** The version this module writes. Version 2 adds `closedByPerson`; a version 1 record has no such field and loads as it did. */
const SAVED_VERSION = 2

const saved = z.object({
  // Version 1 is read as it was written: it has no `closedByPerson`, which reads as "the person has not closed it".
  v: z.union([z.literal(1), z.literal(2)]),
  pins: z.array(sessionId).max(MAX_SAVED_PANES),
  // Every split has two children or more, so a layout of at most this many panes nests at most this many splits.
  layout: z.object({ version: z.literal(1), root: nodeWithin(MAX_SAVED_PANES - 1) }).nullable(),
  open: z.boolean(),
  // Added with the layout picker; a value saved before has none of them and loads as it did.
  arrangement: z.enum(ARRANGEMENTS).optional(),
  slots: z.array(sessionId).max(MAX_SAVED_PANES).optional(),
  shape: shapeSchema.optional(),
  // Added with the manual close; a version 1 record has none of it and loads as it did.
  closedByPerson: z.literal(true).optional(),
})

const index = z.array(sessionId).max(KEPT_CHATS_RANGE.max)

/** What a saved value's problem is, or undefined when it is a valid, bounded state. */
function problemOf(value: z.output<typeof saved>): string | undefined {
  if (new Set(value.pins).size !== value.pins.length) return 'a pin appears twice'
  if (value.slots !== undefined && new Set(value.slots).size !== value.slots.length) return 'a slot appears twice'
  if (value.shape !== undefined) {
    const problem = shapeProblem(value.shape)
    if (problem !== undefined) return problem
  }
  if (value.layout === null) return undefined
  if (panesOf(value.layout).length > MAX_SAVED_PANES) return 'the layout holds too many panes'
  return layoutProblem(value.layout)
}

/**
 * Keep chats' Multiview state in a storage.
 * @param storage - reads the storage for each call; {@link browserStorage} for the page. Undefined means nothing is kept.
 * @param warn - called with the reason when a saved value is discarded, the index is rebuilt or a write fails.
 * @returns the persistence.
 */
export function localPersistence(storage: () => MultiviewStorage | undefined, warn: (message: string) => void): MultiviewPersistence {
  const key = (chat: SessionId): string => qualifiedPersistKey(MULTIVIEW_PERSIST_NAME, chat)
  const indexKey = qualifiedPersistKey(MULTIVIEW_INDEX_NAME)

  function read(target: MultiviewStorage, name: string): string | null | undefined {
    try {
      return target.getItem(name)
    } catch (_unavailable) {
      // A blocked or failing store behaves as if nothing was saved.
      return undefined
    }
  }

  function remove(target: MultiviewStorage, name: string): void {
    try {
      target.removeItem(name)
    } catch (_unavailable) {
      // The value stays in a store that cannot be written; it is rejected again on the next read.
    }
  }

  function discard(target: MultiviewStorage, chat: SessionId, why: string): undefined {
    warn(`multiview: the saved state of chat ${chat} is not valid (${why}); it is discarded`)
    remove(target, key(chat))
    return undefined
  }

  function readIndex(target: MultiviewStorage): readonly SessionId[] {
    const raw = read(target, indexKey)
    if (raw === null || raw === undefined) return []
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch (_notJson) {
      warn('multiview: the index of saved chats is not JSON; it starts again')
      return []
    }
    const parsed = index.safeParse(json)
    if (parsed.success) return parsed.data
    warn('multiview: the index of saved chats is not valid; it starts again')
    return []
  }

  return {
    load(chat) {
      const target = storage()
      if (target === undefined) return undefined
      const raw = read(target, key(chat))
      if (raw === null || raw === undefined) return undefined
      let json: unknown
      try {
        json = JSON.parse(raw)
      } catch (error) {
        return discard(target, chat, error instanceof Error ? error.message : 'not JSON')
      }
      const parsed = saved.safeParse(json)
      if (!parsed.success) return discard(target, chat, parsed.error.issues[0]?.message ?? 'wrong format')
      const problem = problemOf(parsed.data)
      if (problem !== undefined) return discard(target, chat, problem)
      const { pins, layout, open, arrangement, slots, shape, closedByPerson } = parsed.data
      return {
        pins, layout, open,
        ...(arrangement === undefined ? {} : { arrangement }),
        ...(slots === undefined ? {} : { slots }),
        ...(shape === undefined ? {} : { shape }),
        // The flag says the person closed Multiview and has not opened it since, so it means nothing while Multiview is open:
        // a record that says both is read as open with no manual close recorded, which never suppresses a hand-off.
        ...(closedByPerson === true && !open ? { closedByPerson: true as const } : {}),
      }
    },
    save(chat, value: ChatMultiview, keepChats) {
      const target = storage()
      if (target === undefined) return
      const kept = [chat, ...readIndex(target).filter(other => other !== chat)]
      const evicted = kept.slice(Math.max(1, keepChats))
      try {
        target.setItem(key(chat), JSON.stringify({
          v: SAVED_VERSION, pins: value.pins, layout: value.layout, open: value.open,
          arrangement: value.arrangement, slots: value.slots, shape: value.shape,
          ...(value.closedByPerson === true ? { closedByPerson: true as const } : {}),
        }))
        target.setItem(indexKey, JSON.stringify(kept.slice(0, Math.max(1, keepChats))))
      } catch (error) {
        warn(`multiview: the state of chat ${chat} could not be saved (${String(error)})`)
        return
      }
      for (const old of evicted) remove(target, key(old))
    },
  }
}
