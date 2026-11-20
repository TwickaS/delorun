// @vitest-environment jsdom
import { qualifiedPersistKey } from '@deepseek-ai/dsh-client-store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPreset, panesOf, type PaneId } from '../../src/layout/index.ts'
import {
  clearSavedMultiview, DEFAULT_SAVED, MULTIVIEW_PERSIST_NAME, readSavedMultiview, writeSavedMultiview, type SavedMultiview,
} from '../../src/store/persist.ts'

const id = (value: string): PaneId => value as PaneId
const CHAT = 'chat-1'
const key = qualifiedPersistKey(MULTIVIEW_PERSIST_NAME, CHAT)

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
})

const saved = (): SavedMultiview => ({
  v: 1,
  pins: [id('a'), id('b')],
  layout: buildPreset('grid', id('main'), [id('a'), id('b')]),
  open: true,
})

describe('the saved Multiview preference', () => {
  it('is the default for a chat with nothing saved', () => {
    expect(readSavedMultiview(CHAT)).toEqual(DEFAULT_SAVED)
    expect(DEFAULT_SAVED).toEqual({ v: 1, pins: [], layout: null, open: false })
  })

  it('round-trips pins, layout and open state per chat', () => {
    writeSavedMultiview(CHAT, saved())
    expect(readSavedMultiview(CHAT)).toEqual(saved())
    expect(readSavedMultiview('chat-2')).toEqual(DEFAULT_SAVED)
  })

  it('round-trips a layout with tabs and nested splits', () => {
    const layout = buildPreset('main-column', id('main'), [id('a'), id('b'), id('c')])
    writeSavedMultiview(CHAT, { v: 1, pins: [id('a'), id('b'), id('c')], layout, open: false })
    expect(panesOf(readSavedMultiview(CHAT).layout!)).toEqual([id('main'), id('a'), id('b'), id('c')])
  })

  it('clears one chat without touching another', () => {
    writeSavedMultiview(CHAT, saved())
    writeSavedMultiview('chat-2', saved())
    clearSavedMultiview(CHAT)
    expect(readSavedMultiview(CHAT)).toEqual(DEFAULT_SAVED)
    expect(readSavedMultiview('chat-2')).toEqual(saved())
  })

  const bad: [string, unknown][] = [
    ['text that is not JSON', 'not json {'],
    ['another version', { ...saved(), v: 2 }],
    ['a missing field', { v: 1, pins: [], open: false }],
    ['a pin of the wrong type', { ...saved(), pins: [1] }],
    ['a layout of another version', { ...saved(), layout: { ...saved().layout, version: 2 } }],
    ['a split with one child', { ...saved(), layout: { version: 1, root: { kind: 'split', orientation: 'horizontal', size: 100, children: [{ kind: 'leaf', panes: ['a'], active: 'a', size: 100 }] } } }],
    ['a leaf without panes', { ...saved(), layout: { version: 1, root: { kind: 'leaf', panes: [], active: 'a', size: 100 } } }],
    ['a zero size', { ...saved(), layout: { version: 1, root: { kind: 'leaf', panes: ['a'], active: 'a', size: 0 } } }],
    ['a leaf that shows a pane it does not hold', { ...saved(), layout: { version: 1, root: { kind: 'leaf', panes: ['a'], active: 'b', size: 100 } } }],
    ['a pane twice', { ...saved(), layout: { version: 1, root: { kind: 'split', orientation: 'horizontal', size: 100, children: [{ kind: 'leaf', panes: ['a'], active: 'a', size: 50 }, { kind: 'leaf', panes: ['a'], active: 'a', size: 50 }] } } }],
    ['a pin twice', { ...saved(), pins: [id('a'), id('a')] }],
  ]
  it.each(bad)('falls back to the default with a warning for %s, and clears the bad value', (_name, value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
    expect(readSavedMultiview(CHAT)).toEqual(DEFAULT_SAVED)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain(CHAT)
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('behaves as nothing saved when storage cannot be read, and warns when it cannot be written', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readSavedMultiview(CHAT)).toEqual(DEFAULT_SAVED)
    vi.restoreAllMocks()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeSavedMultiview(CHAT, saved())
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
