import { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, vi } from 'vitest'
import { leafOf, splitOf, layoutOf } from '../../src/layout/index.ts'
import { localPersistence, MULTIVIEW_PERSIST_NAME } from '../../src/entry/persistence.ts'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) },
  }
}

const chat = SessionId('chat-1')
const key = `${MULTIVIEW_PERSIST_NAME}.chat-1`

describe('localPersistence', () => {
  it('restores what it saved, pins, layout and open flag', () => {
    const storage = memoryStorage()
    const persistence = localPersistence(storage, vi.fn())
    const layout = layoutOf(splitOf('horizontal', [leafOf([chat]), leafOf([SessionId('a')])]))
    persistence.save(chat, { pins: [SessionId('a')], layout, open: true })
    expect(persistence.load(chat)).toEqual({ pins: ['a'], layout, open: true })
  })

  it('returns nothing for a chat with no saved state', () => {
    expect(localPersistence(memoryStorage(), vi.fn()).load(chat)).toBeUndefined()
  })

  it('discards a value that is not JSON, warns and removes it', () => {
    const storage = memoryStorage({ [key]: '{nope' })
    const warn = vi.fn()
    expect(localPersistence(storage, warn).load(chat)).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not JSON'))
    expect(storage.data.has(key)).toBe(false)
  })

  it.each([
    ['the wrong version', { v: 2, pins: [], layout: null, open: false }],
    ['a pin that is not a string', { v: 1, pins: [3], layout: null, open: false }],
    ['a missing open flag', { v: 1, pins: [], layout: null }],
    ['a layout that shows a pane it does not hold', { v: 1, pins: [], layout: { version: 1, root: { kind: 'leaf', panes: ['a'], active: 'b', size: 100 } }, open: true }],
    ['a pane twice', { v: 1, pins: [], layout: { version: 1, root: { kind: 'split', orientation: 'horizontal', size: 100, children: [{ kind: 'leaf', panes: ['a'], active: 'a', size: 50 }, { kind: 'leaf', panes: ['a'], active: 'a', size: 50 }] } }, open: true }],
  ])('discards %s, warns and removes the value', (_name, value) => {
    const storage = memoryStorage({ [key]: JSON.stringify(value) })
    const warn = vi.fn()
    expect(localPersistence(storage, warn).load(chat)).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not valid'))
    expect(storage.data.has(key)).toBe(false)
  })

  it('warns and keeps going when the storage refuses a write', () => {
    const warn = vi.fn()
    const persistence = localPersistence({
      getItem: () => null,
      setItem: () => { throw new Error('quota') },
      removeItem: () => {},
    }, warn)
    persistence.save(chat, { pins: [], layout: null, open: false })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be saved'))
  })
})
