import { describe, expect, it } from 'vitest'
import { DEFAULT_MULTIVIEW_SETTINGS } from '../../src/config.ts'
import { MULTIVIEW_NS } from '../../src/client/contract.ts'
import { en, zh } from '../../src/entry/locales.ts'
import { MULTIVIEW_ROW_ID } from '../../src/config.ts'
import { A, B, C, CHAT, sid } from './fixtures.ts'
import { harness } from './harness.tsx'

const OTHER = 'other-chat'

describe('registration', () => {
  it('registers the copy, the pin button, the popover footer and the toggle at the end of the agents action, and offers the service', async () => {
    const h = harness()
    await h.fiber.await()
    expect(h.dictionaries.get(MULTIVIEW_NS)).toEqual({ en, zh })
    expect([...h.entries.keys()].sort()).toEqual([
      'conversation.session.header.actions.subagent.end#multiview-toggle',
      'conversation.session.header.actions.subagent.footer#multiview-footer',
      'conversation.session.header.actions.subagent.row.trail#multiview-pin',
    ])
    expect([...h.entries.keys()].some(key => key.startsWith('conversation.session.header.actions#'))).toBe(false)
    expect(h.ctx.get('multiview')).toBe(h.store)
    expect(h.formIds).toEqual([MULTIVIEW_ROW_ID])
    await h.fiber.dispose()
    expect([h.dictionaries.size, h.entries.size]).toEqual([0, 0])
    expect(h.ctx.get('multiview')).toBeUndefined()
  })

  it('uses the defaults until the settings load, then the loaded values, each missing field at its default', async () => {
    const h = harness()
    await h.fiber.await()
    expect(h.service.settings.getSnapshot()).toEqual(DEFAULT_MULTIVIEW_SETTINGS)
    expect(h.service.settings.getSnapshot()).toBe(h.service.settings.getSnapshot())
    h.setSettings({ maxPanes: 4, compactComposer: false })
    expect(h.service.settings.getSnapshot()).toEqual({ ...DEFAULT_MULTIVIEW_SETTINGS, maxPanes: 4, compactComposer: false })
  })
})

describe('while the Multiview layer is not registered', () => {
  const ENTRY_KEYS = [
    'conversation.session.header.actions.subagent.end#multiview-toggle',
    'conversation.session.header.actions.subagent.footer#multiview-footer',
    'conversation.session.header.actions.subagent.row.trail#multiview-pin',
  ]

  it('shows no pin button, footer or toggle, and still offers the service', async () => {
    const h = harness({ layer: false })
    await h.fiber.await()
    expect(h.entries.size).toBe(0)
    expect(h.ctx.get('multiview')).toBe(h.store)
  })

  it('does not pin or open anything for a hand-off', async () => {
    const h = harness({ layer: false, list: { main: CHAT, catalogs: { [CHAT]: [] } } })
    await h.fiber.await()
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A] } })
    expect(h.state(CHAT)).toMatchObject({ pins: [], open: false })
  })

  it('lights up when the layer is registered: the entry points appear and later hand-offs pin', async () => {
    const h = harness({ layer: false, list: { main: CHAT, catalogs: { [CHAT]: [A] } } })
    await h.fiber.await()
    h.registerLayer(true)
    expect([...h.entries.keys()].sort()).toEqual(ENTRY_KEYS)
    expect(h.state(CHAT).pins).toEqual([])
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A, B] } })
    expect(h.state(CHAT).pins).toEqual([B])
    expect(h.state(CHAT).open).toBe(true)
  })

  it('takes the entry points away again when the layer goes, and stops the hand-off observer', async () => {
    const h = harness({ list: { main: CHAT, catalogs: { [CHAT]: [] } } })
    await h.fiber.await()
    expect([...h.entries.keys()].sort()).toEqual(ENTRY_KEYS)
    h.registerLayer(false)
    expect(h.entries.size).toBe(0)
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A] } })
    expect(h.state(CHAT).pins).toEqual([])
  })

  it('registers each entry point once however often the slot changes', async () => {
    const h = harness()
    await h.fiber.await()
    h.registerLayer(true)
    h.registerLayer(true)
    expect(h.entries.size).toBe(3)
    await h.fiber.dispose()
    expect(h.entries.size).toBe(0)
  })
})

describe('auto-pin on a hand-off', () => {
  it('does not pin the agents that were in the chat when it opened', async () => {
    const h = harness({ list: { main: CHAT, catalogs: { [CHAT]: [A, B] } } })
    await h.fiber.await()
    expect(h.state(CHAT).pins).toEqual([])
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A, B] } })
    expect(h.state(CHAT).pins).toEqual([])
  })

  it('pins a new catalog entry and opens Multiview', async () => {
    const h = harness({ list: { main: CHAT, catalogs: { [CHAT]: [A] } } })
    await h.fiber.await()
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A, B] } })
    expect(h.state(CHAT).pins).toEqual([B])
    expect(h.state(CHAT).open).toBe(true)
  })

  it('opens again for every hand-off while the person has not closed it', async () => {
    const h = harness({ list: { main: CHAT, catalogs: { [CHAT]: [] } } })
    await h.fiber.await()
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A] } })
    expect(h.state(CHAT).open).toBe(true)
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A, B] } })
    expect(h.state(CHAT)).toMatchObject({ pins: [A, B], open: true })
  })

  it('pins each of several hand-offs that arrive together', async () => {
    const h = harness({ list: { main: CHAT, catalogs: { [CHAT]: [] } } })
    await h.fiber.await()
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A, B, C] } })
    expect(h.state(CHAT).pins).toEqual([A, B, C])
  })

  it('pins nothing past the pane limit, and still opens for the ones that fit', async () => {
    const h = harness({ settings: { maxPanes: 3 }, list: { main: CHAT, catalogs: { [CHAT]: [] } } })
    await h.fiber.await()
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A, B, C] } })
    expect(h.state(CHAT).pins).toEqual([A, B])
    expect(h.state(CHAT).open).toBe(true)
  })

  it('does not pin a new agent when the limit is full, and opens for the agents already pinned', async () => {
    const h = harness({ settings: { maxPanes: 2 }, initial: { [CHAT]: { pins: [A], layout: null, open: false } }, list: { main: CHAT, catalogs: { [CHAT]: [A] } } })
    await h.fiber.await()
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A, B] } })
    expect(h.state(CHAT)).toMatchObject({ pins: [A], open: true })
  })

  it('opens nothing when no agent is pinned and the limit kept the new one out', async () => {
    const h = harness({ settings: { maxPanes: 1 }, list: { main: CHAT, catalogs: { [CHAT]: [] } } })
    await h.fiber.await()
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A] } })
    expect(h.state(CHAT)).toMatchObject({ pins: [], open: false })
  })

  it('with auto-open off pins the agent but leaves Multiview closed, and never opens it by itself', async () => {
    const h = harness({ settings: { autoOpen: false }, list: { main: CHAT, catalogs: { [CHAT]: [] } } })
    await h.fiber.await()
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A] } })
    expect(h.state(CHAT)).toMatchObject({ pins: [A], open: false })
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A, B] } })
    expect(h.state(CHAT)).toMatchObject({ pins: [A, B], open: false })
    // The setting stops auto-open; it does not close what the person opened.
    h.service.open(sid(CHAT))
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A, B, C] } })
    expect(h.state(CHAT)).toMatchObject({ pins: [A, B, C], open: true })
  })

  it('leaves Multiview closed after the person closed it, and pins the agent that arrives', async () => {
    const h = harness({ list: { main: CHAT, catalogs: { [CHAT]: [] } } })
    await h.fiber.await()
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A] } })
    expect(h.state(CHAT).open).toBe(true)
    h.service.closeByPerson(sid(CHAT))
    expect(h.state(CHAT).open).toBe(false)
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A, B] } })
    expect(h.state(CHAT)).toMatchObject({ pins: [A, B], open: false })
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A, B, C] } })
    expect(h.state(CHAT)).toMatchObject({ pins: [A, B, C], open: false })
  })

  it('opens for a hand-off again once the person opened Multiview themselves', async () => {
    const h = harness({ list: { main: CHAT, catalogs: { [CHAT]: [] } } })
    await h.fiber.await()
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A] } })
    h.service.closeByPerson(sid(CHAT))
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A, B] } })
    expect(h.state(CHAT).open).toBe(false)
    h.service.open(sid(CHAT))
    expect(h.state(CHAT).open).toBe(true)
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A, B, C] } })
    expect(h.state(CHAT)).toMatchObject({ pins: [A, B, C], open: true })
  })

  it('keeps a close the layer made for its own reasons from suppressing a hand-off', async () => {
    const h = harness({ list: { main: CHAT, catalogs: { [CHAT]: [] } } })
    await h.fiber.await()
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A] } })
    expect(h.state(CHAT)).toMatchObject({ pins: [A], open: true })
    // The layer closes an emptied catalog itself, since the toggle hides with it; that is not the person's choice.
    h.setList({ main: CHAT, catalogs: { [CHAT]: [] } })
    expect(h.state(CHAT)).toMatchObject({ pins: [A], open: false })
    expect(h.state(CHAT).closedByPerson).toBeUndefined()
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A, B] } })
    expect(h.state(CHAT)).toMatchObject({ pins: [A, B], open: true })
  })

  it('keeps a manual close across a reload, since the flag is saved with the chat', async () => {
    const first = harness({ list: { main: CHAT, catalogs: { [CHAT]: [] } } })
    await first.fiber.await()
    first.setList({ main: CHAT, catalogs: { [CHAT]: [A] } })
    first.service.closeByPerson(sid(CHAT))
    const saved = first.saved.get(CHAT)
    expect(saved).toMatchObject({ open: false, closedByPerson: true })
    await first.fiber.dispose()
    // A new page reads the saved record and starts from it.
    const reloaded = harness({ initial: { [CHAT]: saved! }, list: { main: CHAT, catalogs: { [CHAT]: [A] } } })
    await reloaded.fiber.await()
    reloaded.setList({ main: CHAT, catalogs: { [CHAT]: [A, B] } })
    expect(reloaded.state(CHAT)).toMatchObject({ pins: [A, B], open: false })
  })

  it('treats a chat as new each time it becomes the main view', async () => {
    const h = harness({ list: { main: CHAT, catalogs: { [CHAT]: [A] } } })
    await h.fiber.await()
    h.setList({ main: OTHER, catalogs: { [OTHER]: [], [CHAT]: [A, B] } })
    h.setList({ main: CHAT, catalogs: { [OTHER]: [], [CHAT]: [A, B] } })
    expect(h.state(CHAT).pins).toEqual([])
    h.setList({ main: CHAT, catalogs: { [OTHER]: [], [CHAT]: [A, B, C] } })
    expect(h.state(CHAT).pins).toEqual([C])
  })
})

describe('an emptied agent catalog', () => {
  it('closes Multiview when the main chat\'s catalog is loaded and empty, since the toggle hides with it, and keeps the pins', async () => {
    const h = harness({ initial: { [CHAT]: { pins: [A], layout: null, open: true } }, list: { main: CHAT, catalogs: { [CHAT]: [A] } } })
    await h.fiber.await()
    expect(h.state(CHAT).open).toBe(true)
    h.setList({ main: CHAT, catalogs: { [CHAT]: [] } })
    expect(h.state(CHAT)).toMatchObject({ open: false, pins: [A] })
  })

  it('leaves Multiview open while the catalog has not loaded yet', async () => {
    const h = harness({ initial: { [CHAT]: { pins: [A], layout: null, open: true } }, list: { main: CHAT } })
    await h.fiber.await()
    expect(h.state(CHAT).open).toBe(true)
  })
})

describe('reopen on return', () => {
  const saved = { [CHAT]: { pins: [A], layout: null, open: true } }

  it('keeps a chat that had Multiview open open, so it shows again when the chat is the main view', async () => {
    const h = harness({ initial: saved, list: { main: OTHER, catalogs: { [OTHER]: [] } } })
    await h.fiber.await()
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A] } })
    expect(h.state(CHAT).open).toBe(true)
  })

  it('closes a chat that had Multiview open when the person leaves it, with reopening off', async () => {
    const h = harness({ settings: { reopenOnReturn: false }, list: { main: CHAT, catalogs: { [CHAT]: [] } } })
    await h.fiber.await()
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A] } })
    expect(h.state(CHAT).open).toBe(true)
    h.setList({ main: OTHER, catalogs: { [OTHER]: [], [CHAT]: [A] } })
    expect(h.state(CHAT).open).toBe(false)
  })

  it('closes a chat that a page load finds open, with reopening off', async () => {
    const h = harness({ settings: { reopenOnReturn: false }, initial: saved, list: { main: CHAT, catalogs: { [CHAT]: [A] } } })
    await h.fiber.await()
    expect(h.state(CHAT).open).toBe(false)
  })

  it('leaves a chat the person closed closed', async () => {
    const h = harness({ initial: { [CHAT]: { pins: [A], layout: null, open: false } }, list: { main: OTHER, catalogs: { [OTHER]: [] } } })
    await h.fiber.await()
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A] } })
    expect(h.state(CHAT).open).toBe(false)
  })
})
