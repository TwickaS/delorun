import { describe, expect, it } from 'vitest'
import { buildPreset, hasPane, paneCount, panesOf } from '../../src/layout/index.ts'
import { A, B, C, CHAT, makeStore } from './fixtures.ts'

describe('MultiviewStore pins', () => {
  it('pins an agent, keeps pin order and saves each change', () => {
    const { store, saves } = makeStore()
    expect(store.pin(CHAT, A)).toEqual({ ok: true })
    expect(store.pin(CHAT, B)).toEqual({ ok: true })
    expect(store.of(CHAT).getSnapshot().pins).toEqual([A, B])
    expect(saves.at(-1)?.value.pins).toEqual([A, B])
  })

  it('refuses the chat itself and an agent that is already pinned', () => {
    const { store } = makeStore()
    expect(store.pin(CHAT, CHAT)).toEqual({ ok: false, reason: 'main-chat' })
    store.pin(CHAT, A)
    expect(store.pin(CHAT, A)).toEqual({ ok: false, reason: 'already-pinned' })
    expect(store.of(CHAT).getSnapshot().pins).toEqual([A])
  })

  it('refuses a pin at the pane limit, counting the main chat, and says max-panes', () => {
    const { store } = makeStore({ settings: { maxPanes: 3 } })
    expect(store.capacityRefusal(CHAT)).toBeUndefined()
    store.pin(CHAT, A)
    store.pin(CHAT, B)
    expect(store.capacityRefusal(CHAT)).toBe('max-panes')
    expect(store.pin(CHAT, C)).toEqual({ ok: false, reason: 'max-panes' })
    expect(store.of(CHAT).getSnapshot().pins).toEqual([A, B])
  })

  it('applies a changed limit to the next pin', () => {
    const { store, change } = makeStore({ settings: { maxPanes: 2 } })
    store.pin(CHAT, A)
    expect(store.pin(CHAT, B)).toEqual({ ok: false, reason: 'max-panes' })
    change({ maxPanes: 4 })
    expect(store.pin(CHAT, B)).toEqual({ ok: true })
  })

  it('refuses a pin when the window cannot hold another pane of the least size, and says no-room', () => {
    const { store } = makeStore({ window: { width: 700, height: 300 } })
    store.pin(CHAT, A)
    expect(store.pin(CHAT, B)).toEqual({ ok: false, reason: 'no-room' })
    store.reportArea({ width: 2000, height: 1000 })
    expect(store.pin(CHAT, B)).toEqual({ ok: true })
  })

  it('pins every agent that fits and counts the ones the limit kept out', () => {
    const { store } = makeStore({ settings: { maxPanes: 3 } })
    expect(store.pinAll(CHAT, [A, B, C])).toEqual({ pinned: 2, refused: 1 })
    expect(store.of(CHAT).getSnapshot().pins).toEqual([A, B])
  })

  it('unpins an agent and drops its pane from an existing layout', () => {
    const { store } = makeStore()
    store.pinAll(CHAT, [A, B])
    store.applyPreset(CHAT, 'grid')
    store.unpin(CHAT, A)
    const state = store.of(CHAT).getSnapshot()
    expect(state.pins).toEqual([B])
    expect(state.layout !== null && hasPane(state.layout, A)).toBe(false)
    expect(state.layout !== null && panesOf(state.layout)).toEqual([CHAT, B])
  })

  it('adds a new pin to the layout the chat follows and leaves an unset layout unset', () => {
    const { store } = makeStore()
    store.pin(CHAT, A)
    expect(store.of(CHAT).getSnapshot().layout).toBeNull()
    store.applyPreset(CHAT, 'side-by-side')
    store.pin(CHAT, B)
    expect(paneCount(store.layoutFor(CHAT))).toBe(3)
    expect(store.arrangementOf(CHAT)).toBe('side-by-side')
  })

  it('keeps each chat apart', () => {
    const { store } = makeStore()
    store.pin(CHAT, A)
    expect(store.of(B).getSnapshot().pins).toEqual([])
  })
})

describe('MultiviewStore open, layout and persistence', () => {
  it('records open and close', () => {
    const { store } = makeStore()
    store.open(CHAT)
    expect(store.of(CHAT).getSnapshot().open).toBe(true)
    store.close(CHAT)
    expect(store.of(CHAT).getSnapshot().open).toBe(false)
  })

  it('records a close the person made, and clears it on the next open', () => {
    const { store, saves } = makeStore()
    store.open(CHAT)
    expect(store.of(CHAT).getSnapshot().closedByPerson).toBeUndefined()
    store.closeByPerson(CHAT)
    expect(store.of(CHAT).getSnapshot()).toMatchObject({ open: false, closedByPerson: true })
    expect(saves.at(-1)?.value).toMatchObject({ open: false, closedByPerson: true })
    store.open(CHAT)
    expect(store.of(CHAT).getSnapshot()).toMatchObject({ open: true })
    expect(store.of(CHAT).getSnapshot().closedByPerson).toBeUndefined()
  })

  it('leaves the person\'s close alone when the layer closes the chat for its own reason', () => {
    const { store } = makeStore()
    store.closeByPerson(CHAT)
    store.close(CHAT)
    expect(store.of(CHAT).getSnapshot()).toMatchObject({ open: false, closedByPerson: true })
  })

  it('rearranges in a preset, which becomes the default, and resets a hand arrangement to it without closing a pane', () => {
    const { store } = makeStore()
    store.pinAll(CHAT, [A, B])
    store.applyPreset(CHAT, 'main-top')
    const top = store.of(CHAT).getSnapshot().layout
    expect(top !== null && panesOf(top)).toEqual([CHAT, A, B])
    store.setLayout(CHAT, buildPreset('rows', CHAT, [B, A]))
    store.resetLayout(CHAT)
    expect(store.arrangementOf(CHAT)).toBe('main-top')
    expect(panesOf(store.layoutFor(CHAT))).toEqual([CHAT, A, B])
  })

  it('replaces the layout when the panel reports a change', () => {
    const { store } = makeStore()
    store.pinAll(CHAT, [A])
    store.applyPreset(CHAT, 'grid')
    const layout = store.of(CHAT).getSnapshot().layout!
    store.setLayout(CHAT, { ...layout })
    expect(store.of(CHAT).getSnapshot().layout).toEqual(layout)
  })

  it('saves each change with the number of chats to keep now in force', () => {
    const { store, saves, change } = makeStore({ settings: { keepChats: 7 } })
    store.pin(CHAT, A)
    change({ keepChats: 3 })
    store.pin(CHAT, B)
    expect(saves.map(save => save.keepChats)).toEqual([7, 3])
  })

  it('loads a chat saved earlier', () => {
    const { store } = makeStore({ initial: { [CHAT]: { pins: [A], layout: null, open: true } } })
    expect(store.of(CHAT).getSnapshot()).toEqual({ pins: [A], layout: null, open: true })
  })

  it('notifies subscribers of a change', () => {
    const { store } = makeStore()
    let calls = 0
    const stop = store.of(CHAT).subscribe(() => { calls += 1 })
    store.pin(CHAT, A)
    stop()
    store.pin(CHAT, B)
    expect(calls).toBe(1)
  })
})
