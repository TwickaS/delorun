// @vitest-environment jsdom
import { qualifiedPersistKey } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_PANES_RANGE } from '../../src/config.ts'
import { EMPTY_CHAT_MULTIVIEW, type ChatMultiview } from '../../src/client/contract.ts'
import { buildPreset, layoutOf, leafOf, panesOf, splitOf, type LayoutNode } from '../../src/layout/index.ts'
import {
  browserStorage, localPersistence, MULTIVIEW_INDEX_NAME, MULTIVIEW_PERSIST_NAME, type MultiviewStorage,
} from '../../src/store/persist.ts'

const id = (value: string): SessionId => SessionId(value)
const CHAT = id('chat-1')
const keyOf = (chat: string): string => qualifiedPersistKey(MULTIVIEW_PERSIST_NAME, chat)
const key = keyOf(CHAT)
const indexKey = qualifiedPersistKey(MULTIVIEW_INDEX_NAME)
const KEEP = 50

const warn = vi.fn()
const persistence = () => localPersistence(() => localStorage, warn)

beforeEach(() => {
  localStorage.clear()
  warn.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
})

const state = (): ChatMultiview => ({
  pins: [id('a'), id('b')],
  layout: buildPreset('grid', CHAT, [id('a'), id('b')]),
  open: true,
})

const leafJson = (panes: string[], active = panes[0]) => ({ kind: 'leaf', panes, active, size: 50 })
const splitJson = (children: unknown[]) => ({ kind: 'split', orientation: 'horizontal', size: 100, children })
const savedJson = (layout: unknown, pins: string[] = []) => ({ v: 1, pins, layout: layout === null ? null : { version: 1, root: layout }, open: true })

describe('the saved Multiview state', () => {
  it('is nothing for a chat with nothing saved', () => {
    expect(persistence().load(CHAT)).toBeUndefined()
    expect(EMPTY_CHAT_MULTIVIEW).toEqual({ pins: [], layout: null, open: false })
  })

  it('round-trips pins, layout and open state per chat', () => {
    persistence().save(CHAT, state(), KEEP)
    expect(persistence().load(CHAT)).toEqual(state())
    expect(persistence().load(id('chat-2'))).toBeUndefined()
  })

  it('round-trips a layout with tabs and nested splits', () => {
    const layout = buildPreset('main-column', CHAT, [id('a'), id('b'), id('c')])
    persistence().save(CHAT, { pins: [id('a'), id('b'), id('c')], layout, open: false }, KEEP)
    expect(panesOf(persistence().load(CHAT)!.layout!)).toEqual([CHAT, id('a'), id('b'), id('c')])
  })

  it('accepts a layout that holds a pane the pins do not list: the store reconciles the two when it loads', () => {
    const layout = layoutOf(splitOf('horizontal', [leafOf([CHAT]), leafOf([id('ghost')])]))
    persistence().save(CHAT, { pins: [], layout, open: true }, KEEP)
    expect(persistence().load(CHAT)).toEqual({ pins: [], layout, open: true })
  })

  const bad: [string, unknown][] = [
    ['text that is not JSON', 'not json {'],
    ['another version', { ...savedJson(null), v: 3 }],
    ['a missing field', { v: 1, pins: [], open: false }],
    ['a pin of the wrong type', savedJson(null, [1 as never])],
    ['an empty pin', savedJson(null, [''])],
    ['a layout of another version', { ...savedJson(leafJson(['a'])), layout: { version: 2, root: leafJson(['a']) } }],
    ['a split with one child', savedJson(splitJson([leafJson(['a'])]))],
    ['a leaf without panes', savedJson({ ...leafJson(['a']), panes: [] })],
    ['a zero size', savedJson({ ...leafJson(['a']), size: 0 })],
    ['a size that is not finite', { ...savedJson(leafJson(['a'])), layout: { version: 1, root: { ...leafJson(['a']), size: 'big' } } }],
    ['a leaf that shows a pane it does not hold', savedJson(leafJson(['a'], 'b'))],
    ['a pane twice', savedJson(splitJson([leafJson(['a']), leafJson(['a'])]))],
    ['a pin twice', savedJson(null, ['a', 'a'])],
  ]
  it.each(bad)('discards %s with a warning that names the chat, and removes the value', (_name, value) => {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
    expect(persistence().load(CHAT)).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('chat-1')
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('removes one chat without touching another', () => {
    persistence().save(CHAT, state(), KEEP)
    persistence().save(id('chat-2'), state(), KEEP)
    localStorage.setItem(key, '{')
    persistence().load(CHAT)
    expect(persistence().load(id('chat-2'))).toEqual(state())
  })
})

describe('size limits on a saved value', () => {
  const names = (count: number): string[] => Array.from({ length: count }, (_, i) => `p${i}`)

  it('discards more pins than a layout can hold', () => {
    localStorage.setItem(key, JSON.stringify(savedJson(null, names(MAX_PANES_RANGE.max + 1))))
    expect(persistence().load(CHAT)).toBeUndefined()
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('accepts as many pins as the largest limit', () => {
    localStorage.setItem(key, JSON.stringify(savedJson(null, names(MAX_PANES_RANGE.max))))
    expect(persistence().load(CHAT)?.pins).toHaveLength(MAX_PANES_RANGE.max)
  })

  it('discards a layout with more panes than the largest limit, in one leaf or across leaves', () => {
    localStorage.setItem(key, JSON.stringify(savedJson(leafJson(names(MAX_PANES_RANGE.max + 1)))))
    expect(persistence().load(CHAT)).toBeUndefined()
    localStorage.setItem(key, JSON.stringify(savedJson(splitJson(names(MAX_PANES_RANGE.max + 1).map(name => leafJson([name]))))))
    expect(persistence().load(CHAT)).toBeUndefined()
    const halves = [names(MAX_PANES_RANGE.max / 2 + 1), names(MAX_PANES_RANGE.max / 2 + 1).map(name => `q${name}`)]
    localStorage.setItem(key, JSON.stringify(savedJson(splitJson(halves.map(panes => leafJson(panes))))))
    expect(persistence().load(CHAT)).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(3)
  })

  it('discards a layout nested far deeper than any layout of the largest limit', () => {
    let node: unknown = leafJson(['deep'])
    for (let level = 0; level < 300; level += 1) node = splitJson([node, leafJson([`x${level}`])])
    localStorage.setItem(key, JSON.stringify(savedJson(node)))
    expect(persistence().load(CHAT)).toBeUndefined()
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('accepts the deepest layout of the largest limit', () => {
    let node: LayoutNode = leafOf([id('p0')])
    for (let level = 1; level < MAX_PANES_RANGE.max; level += 1) node = splitOf('horizontal', [node, leafOf([id(`p${level}`)])])
    persistence().save(CHAT, { pins: [], layout: layoutOf(node), open: false }, KEEP)
    expect(panesOf(persistence().load(CHAT)!.layout!)).toHaveLength(MAX_PANES_RANGE.max)
  })

  it('discards a pin or pane id over 200 characters', () => {
    localStorage.setItem(key, JSON.stringify(savedJson(null, ['x'.repeat(201)])))
    expect(persistence().load(CHAT)).toBeUndefined()
  })
})

describe('pruning saved chats', () => {
  const chats = (count: number) => Array.from({ length: count }, (_, i) => id(`c${i}`))

  it('keeps the most recently saved chats and removes the keys of the rest', () => {
    for (const chat of chats(5)) persistence().save(chat, state(), 3)
    expect(localStorage.getItem(keyOf('c0'))).toBeNull()
    expect(localStorage.getItem(keyOf('c1'))).toBeNull()
    for (const kept of ['c2', 'c3', 'c4']) expect(persistence().load(id(kept))).toEqual(state())
    expect(JSON.parse(localStorage.getItem(indexKey)!)).toEqual(['c4', 'c3', 'c2'])
  })

  it('moves a chat to the front each time it is saved, so an active chat is not forgotten', () => {
    for (const chat of chats(3)) persistence().save(chat, state(), 3)
    persistence().save(id('c0'), state(), 3)
    persistence().save(id('c3'), state(), 3)
    expect(localStorage.getItem(keyOf('c1'))).toBeNull()
    expect(persistence().load(id('c0'))).toEqual(state())
    expect(JSON.parse(localStorage.getItem(indexKey)!)).toEqual(['c3', 'c0', 'c2'])
  })

  it('applies a lower limit the next time a chat is saved', () => {
    for (const chat of chats(4)) persistence().save(chat, state(), 10)
    persistence().save(id('c4'), state(), 2)
    expect(JSON.parse(localStorage.getItem(indexKey)!)).toEqual(['c4', 'c3'])
    for (const gone of ['c0', 'c1', 'c2']) expect(localStorage.getItem(keyOf(gone))).toBeNull()
  })

  it('always keeps the chat being saved, even at a limit of one or less', () => {
    persistence().save(id('c0'), state(), 1)
    persistence().save(id('c1'), state(), 0)
    expect(localStorage.getItem(keyOf('c0'))).toBeNull()
    expect(persistence().load(id('c1'))).toEqual(state())
  })

  it.each([['not JSON', '{nope'], ['not a list of ids', '{"a":1}'], ['more ids than a limit allows', JSON.stringify(Array.from({ length: 501 }, (_, i) => `x${i}`))]])('starts the index again when it is %s, and says so', (_name, raw) => {
    localStorage.setItem(indexKey, raw)
    persistence().save(CHAT, state(), KEEP)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('index'))
    expect(JSON.parse(localStorage.getItem(indexKey)!)).toEqual(['chat-1'])
  })
})

describe('storage that is blocked or full', () => {
  it('reads the browser storage, or nothing when the global throws on access', () => {
    expect(browserStorage()).toBe(localStorage)
    vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })
    expect(browserStorage()).toBeUndefined()
    const blocked = localPersistence(browserStorage, warn)
    expect(blocked.load(CHAT)).toBeUndefined()
    expect(() => blocked.save(CHAT, state(), KEEP)).not.toThrow()
  })

  it('behaves as nothing saved when the storage is absent', () => {
    const none = localPersistence(() => undefined, warn)
    expect(none.load(CHAT)).toBeUndefined()
    none.save(CHAT, state(), KEEP)
    expect(warn).not.toHaveBeenCalled()
  })

  it('behaves as nothing saved when a read throws, and does not try to repair it', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(persistence().load(CHAT)).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns when a write is refused, and removes nothing', () => {
    persistence().save(id('old'), state(), 1)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    persistence().save(CHAT, state(), 1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be saved'))
    expect(localStorage.getItem(keyOf('old'))).not.toBeNull()
  })

  it('leaves a bad value in a store that cannot remove it, and reports it again on the next read', () => {
    const data = new Map([[key, '{nope']])
    const stuck: MultiviewStorage = {
      getItem: name => data.get(name) ?? null,
      setItem: (name, value) => { data.set(name, value) },
      removeItem: () => { throw new Error('read only') },
    }
    const stuckPersistence = localPersistence(() => stuck, warn)
    expect(stuckPersistence.load(CHAT)).toBeUndefined()
    expect(stuckPersistence.load(CHAT)).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('the saved state across the layout picker', () => {
  it('loads a value saved before the picker unchanged, with no arrangement, so the chat keeps its layout', () => {
    const layout = buildPreset('main-column', CHAT, [id('a')])
    localStorage.setItem(key, JSON.stringify({ v: 1, pins: ['a'], layout, open: true }))
    expect(persistence().load(CHAT)).toEqual({ pins: [id('a')], layout, open: true })
  })

  it('round-trips the person\'s manual close, and writes the record version that carries it', () => {
    persistence().save(CHAT, { ...state(), open: false, closedByPerson: true }, KEEP)
    expect(persistence().load(CHAT)).toEqual({ ...state(), open: false, closedByPerson: true })
    expect(JSON.parse(localStorage.getItem(key)!).v).toBe(2)
  })

  it('loads a version 1 record as it did, with no manual close recorded', () => {
    localStorage.setItem(key, JSON.stringify({ v: 1, pins: ['a'], layout: null, open: false }))
    expect(persistence().load(CHAT)).toEqual({ pins: [id('a')], layout: null, open: false })
  })

  it('drops a manual close that a record pairs with an open Multiview, since it means nothing while it is open', () => {
    localStorage.setItem(key, JSON.stringify({ v: 2, pins: ['a'], layout: null, open: true, closedByPerson: true }))
    expect(persistence().load(CHAT)).toEqual({ pins: [id('a')], layout: null, open: true })
  })

  it('round-trips the arrangement, the slot order and the chat’s own shape', () => {
    const value: ChatMultiview = {
      ...state(),
      arrangement: 'yours',
      slots: [id('b'), CHAT, id('a')],
      shape: { version: 1, root: { kind: 'split', orientation: 'horizontal', size: 100, children: [
        { kind: 'leaf', slots: [0], active: 0, size: 60 }, { kind: 'leaf', slots: [1, 2], active: 2, size: 40 },
      ] } },
    }
    persistence().save(CHAT, value, KEEP)
    expect(persistence().load(CHAT)).toEqual(value)
  })

  it('discards an unknown arrangement, a slot twice and a shape that is not well formed', () => {
    for (const extra of [
      { arrangement: 'cascade' },
      { slots: ['a', 'a'] },
      { shape: { version: 1, root: { kind: 'leaf', slots: [0, 0], active: 0, size: 100 } } },
    ]) {
      localStorage.setItem(key, JSON.stringify({ ...savedJson(null, ['a']), ...extra }))
      expect(persistence().load(CHAT)).toBeUndefined()
      expect(localStorage.getItem(key)).toBeNull()
    }
  })
})
