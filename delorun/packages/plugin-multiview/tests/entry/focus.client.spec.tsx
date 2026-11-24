import type { ShortcutCatalogEntry, ShortcutCommand, ShortcutCommandId, ShortcutContext } from '@deepseek-ai/dsh-client-shortcuts/client'
import { describe, expect, it } from 'vitest'
import type { EntryInjected } from '../../src/entry/Entry.tsx'
import { FOCUS_COMMAND_ID } from '../../src/entry/focus.ts'
import { A, B, CHAT } from './fixtures.ts'
import { harness, type Harness } from './harness.tsx'

const KEYBOARD: ShortcutContext = { source: 'keyboard', region: 'page', modal: null, target: null }
const TOGGLE = 'conversation.session.header.actions.subagent.end#multiview-toggle'

function command(h: Harness): ShortcutCommand {
  const found = h.commands.get(FOCUS_COMMAND_ID)
  if (found === undefined) throw new Error('the focus command is not registered')
  return found
}

/** Resolve the command as the keyboard registry does, and run it when it is handled. */
function press(h: Harness): string | undefined {
  const resolution = command(h).resolve(KEYBOARD)
  if (resolution.status === 'handled') { resolution.run(); return undefined }
  return resolution.status === 'blocked' ? resolution.reason : 'pass'
}

function row(id: ShortcutCommandId, keys: readonly string[]): ShortcutCatalogEntry {
  return {
    id, label: '', aliases: [], keys, aria: undefined, modified: true, conflicts: [], issue: null,
    binding: keys.length === 0 ? null : { code: 'KeyM', modifiers: ['primary', 'shift'] } as never,
  }
}

describe('the focus command', () => {
  it('is listed in the keyboard settings under its name, with no default keys', async () => {
    const h = harness({ shortcuts: true })
    await h.fiber.await()
    const listed = command(h)
    expect(listed.label()).toBe('Multiview: show the main chat only / show Multiview')
    expect(listed.defaults).toEqual({})
    expect(listed.aliases).toContain('multiview')
    expect(listed.regions).toEqual(['page', 'editable', 'terminal'])
  })

  it('is listed only while the Multiview layer is registered, and goes with the plugin', async () => {
    const h = harness({ shortcuts: true, layer: false })
    await h.fiber.await()
    expect(h.commands.has(FOCUS_COMMAND_ID)).toBe(false)
    h.registerLayer(true)
    expect(h.commands.has(FOCUS_COMMAND_ID)).toBe(true)
    h.registerLayer(false)
    expect(h.commands.has(FOCUS_COMMAND_ID)).toBe(false)
    h.registerLayer(true)
    await h.fiber.dispose()
    expect(h.commands.size).toBe(0)
  })

  it('switches to the main chat alone and back, keeping the pins and the layout', async () => {
    const h = harness({ shortcuts: true, list: { main: CHAT, catalogs: { [CHAT]: [A, B] } } })
    await h.fiber.await()
    h.store.pinAll(CHAT, [A, B])
    h.store.open(CHAT)
    h.store.applyPreset(CHAT, 'grid')
    const before = h.state(CHAT)
    expect(press(h)).toBeUndefined()
    expect(h.state(CHAT)).toMatchObject({ pins: [A, B], open: false, layout: before.layout })
    expect(press(h)).toBeUndefined()
    expect(h.state(CHAT)).toMatchObject({ pins: [A, B], open: true, layout: before.layout })
  })

  it('records its close as the person\'s, so a hand-off leaves Multiview closed until they open it again', async () => {
    const h = harness({ shortcuts: true, list: { main: CHAT, catalogs: { [CHAT]: [A] } } })
    await h.fiber.await()
    h.store.pinAll(CHAT, [A])
    h.store.open(CHAT)
    expect(press(h)).toBeUndefined()
    expect(h.state(CHAT)).toMatchObject({ open: false, closedByPerson: true })
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A, B] } })
    expect(h.state(CHAT)).toMatchObject({ pins: [A, B], open: false })
    expect(press(h)).toBeUndefined()
    expect(h.state(CHAT)).toMatchObject({ open: true })
    expect(h.state(CHAT).closedByPerson).toBeUndefined()
  })

  it('pins the running agents and opens when nothing is pinned, as the toggle does', async () => {
    const h = harness({ shortcuts: true, list: { main: CHAT, catalogs: { [CHAT]: [A, B] }, running: [B] } })
    await h.fiber.await()
    expect(press(h)).toBeUndefined()
    expect(h.state(CHAT)).toMatchObject({ pins: [B], open: true })
  })

  it('says why it does nothing: no chat, an agent\'s own chat, or nothing to show', async () => {
    const h = harness({ shortcuts: true, list: { catalogs: {} } })
    await h.fiber.await()
    expect(press(h)).toBe('No chat is open.')
    h.setList({ main: A, catalogs: { [CHAT]: [A] } })
    expect(press(h)).toBe('This is an agent\'s own chat. Multiview belongs to the chat that started it.')
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A] } })
    expect(press(h)).toBe('Nothing to show yet: pin an agent from the agents list, or start one.')
    expect(h.state(CHAT)).toMatchObject({ pins: [], open: false })
  })

  it('gives the toggle the keys the person set, and none while it is unbound', async () => {
    const h = harness({ shortcuts: true })
    await h.fiber.await()
    const keys = h.face<EntryInjected>(TOGGLE).focusKeys!
    expect(keys.getSnapshot()).toEqual([])
    const seen: Array<readonly string[]> = []
    keys.subscribe(() => { seen.push(keys.getSnapshot()) })
    h.catalog.set([row(FOCUS_COMMAND_ID, ['Ctrl', 'Shift', 'M'])])
    expect(keys.getSnapshot()).toEqual(['Ctrl', 'Shift', 'M'])
    h.catalog.set([row(FOCUS_COMMAND_ID, [])])
    expect(keys.getSnapshot()).toEqual([])
    h.registerLayer(false)
    h.catalog.set([row(FOCUS_COMMAND_ID, ['Ctrl', 'Shift', 'M'])])
    expect(keys.getSnapshot()).toEqual([])
    expect(seen.length).toBeGreaterThan(0)
  })

  it('leaves the toggle without keys in a studio that has no keyboard settings', async () => {
    const h = harness()
    await h.fiber.await()
    expect(h.face<EntryInjected>(TOGGLE).focusKeys?.getSnapshot()).toEqual([])
  })
})
