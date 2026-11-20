import { describe, expect, it } from 'vitest'
import { DEFAULT_MULTIVIEW_SETTINGS } from '../../src/config.ts'
import { MULTIVIEW_NS } from '../../src/client/contract.ts'
import { en, zh } from '../../src/entry/locales.ts'
import { HEADER_ORDER } from '../../src/entry/register.ts'
import { MULTIVIEW_ROW_ID } from '../../src/config.ts'
import { A, B, C, CHAT, sid } from './fixtures.ts'
import { harness } from './harness.tsx'

const OTHER = 'other-chat'

describe('registration', () => {
  it('registers the copy, the pin button, the popover footer and the header button, and offers the service', async () => {
    const h = harness()
    await h.fiber.await()
    expect(h.dictionaries.get(MULTIVIEW_NS)).toEqual({ en, zh })
    expect([...h.entries.keys()].sort()).toEqual([
      'conversation.session.header.actions#multiview-button',
      'conversation.session.header.actions.subagent.footer#multiview-footer',
      'conversation.session.header.actions.subagent.row.trail#multiview-pin',
    ])
    expect(h.entries.get('conversation.session.header.actions#multiview-button')?.order).toBe(HEADER_ORDER)
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

describe('while the Multiview panel is not registered', () => {
  const ENTRY_KEYS = [
    'conversation.session.header.actions#multiview-button',
    'conversation.session.header.actions.subagent.footer#multiview-footer',
    'conversation.session.header.actions.subagent.row.trail#multiview-pin',
  ]

  it('shows no pin button, footer or header button, and still offers the service', async () => {
    const h = harness({ panel: false })
    await h.fiber.await()
    expect(h.entries.size).toBe(0)
    expect(h.ctx.get('multiview')).toBe(h.store)
  })

  it('does not pin, open or select anything for a hand-off', async () => {
    const h = harness({ panel: false, list: { main: CHAT, catalogs: { [CHAT]: [] } } })
    await h.fiber.await()
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A] } })
    expect(h.state(CHAT)).toMatchObject({ pins: [], open: false })
    expect(h.selected).toEqual([])
  })

  it('does not reopen a chat that was open', async () => {
    const h = harness({ panel: false, initial: { [CHAT]: { pins: [A], layout: null, open: true } }, list: { main: OTHER, catalogs: { [OTHER]: [] } } })
    await h.fiber.await()
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A] } })
    expect(h.selected).toEqual([])
  })

  it('lights up when the panel is registered: the entry points appear and later hand-offs pin', async () => {
    const h = harness({ panel: false, list: { main: CHAT, catalogs: { [CHAT]: [A] } } })
    await h.fiber.await()
    h.registerPanel(true)
    expect([...h.entries.keys()].sort()).toEqual(ENTRY_KEYS)
    expect(h.state(CHAT).pins).toEqual([])
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A, B] } })
    expect(h.state(CHAT).pins).toEqual([B])
    expect(h.selected).toEqual(['multiview'])
  })

  it('takes the entry points away again when the panel goes, and stops the hand-off observer', async () => {
    const h = harness({ list: { main: CHAT, catalogs: { [CHAT]: [] } } })
    await h.fiber.await()
    expect([...h.entries.keys()].sort()).toEqual(ENTRY_KEYS)
    h.registerPanel(false)
    expect(h.entries.size).toBe(0)
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A] } })
    expect(h.state(CHAT).pins).toEqual([])
  })

  it('registers each entry point once however often the slot changes', async () => {
    const h = harness()
    await h.fiber.await()
    h.registerPanel(true)
    h.registerPanel(true)
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
    expect(h.selected).toEqual([])
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A, B] } })
    expect(h.state(CHAT).pins).toEqual([])
  })

  it('pins a new catalog entry and opens Multiview', async () => {
    const h = harness({ list: { main: CHAT, catalogs: { [CHAT]: [A] } } })
    await h.fiber.await()
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A, B] } })
    expect(h.state(CHAT).pins).toEqual([B])
    expect(h.state(CHAT).open).toBe(true)
    expect(h.selected).toEqual(['multiview'])
  })

  it('opens again for every hand-off, also after the person closed it', async () => {
    const h = harness({ list: { main: CHAT, catalogs: { [CHAT]: [] } } })
    await h.fiber.await()
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A] } })
    expect(h.selected).toEqual(['multiview'])
    h.service.close(sid(CHAT))
    expect(h.selected).toEqual(['multiview', null])
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A, B] } })
    expect(h.state(CHAT)).toMatchObject({ pins: [A, B], open: true })
    expect(h.selected).toEqual(['multiview', null, 'multiview'])
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
    expect(h.selected).toEqual([])
  })

  it('with auto-open off pins the agent but leaves Multiview closed', async () => {
    const h = harness({ settings: { autoOpen: false }, list: { main: CHAT, catalogs: { [CHAT]: [] } } })
    await h.fiber.await()
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A] } })
    expect(h.state(CHAT)).toMatchObject({ pins: [A], open: false })
    expect(h.selected).toEqual([])
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

describe('reopen on return', () => {
  const saved = { [CHAT]: { pins: [A], layout: null, open: true } }

  it('reopens a chat that had Multiview open when it becomes the main view', async () => {
    const h = harness({ initial: saved, list: { main: OTHER, catalogs: { [OTHER]: [] } } })
    await h.fiber.await()
    expect(h.selected).toEqual([])
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A] } })
    expect(h.selected).toEqual(['multiview'])
  })

  it('reopens a chat on a page load that finds it open', async () => {
    const h = harness({ initial: saved, list: { main: CHAT, catalogs: { [CHAT]: [A] } } })
    await h.fiber.await()
    expect(h.selected).toEqual(['multiview'])
  })

  it('leaves the chat alone when reopening is off', async () => {
    const h = harness({ settings: { reopenOnReturn: false }, initial: saved, list: { main: OTHER, catalogs: { [OTHER]: [] } } })
    await h.fiber.await()
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A] } })
    expect(h.selected).toEqual([])
  })

  it('does not reopen a chat that was closed', async () => {
    const h = harness({ initial: { [CHAT]: { pins: [A], layout: null, open: false } }, list: { main: OTHER, catalogs: { [OTHER]: [] } } })
    await h.fiber.await()
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A] } })
    expect(h.selected).toEqual([])
  })
})

describe('closing from outside', () => {
  it('records a close the panel made in the same chat, such as Open full chat', async () => {
    const h = harness({ list: { main: CHAT, catalogs: { [CHAT]: [] } } })
    await h.fiber.await()
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A] } })
    expect(h.state(CHAT).open).toBe(true)
    h.panelInfo.set({ activePanelId: null })
    expect(h.state(CHAT).open).toBe(false)
  })

  it('keeps Multiview open for the chat the person left, so it reopens on return', async () => {
    const h = harness({ list: { main: CHAT, catalogs: { [CHAT]: [] } } })
    await h.fiber.await()
    h.setList({ main: CHAT, catalogs: { [CHAT]: [A] } })
    h.setList({ main: OTHER, catalogs: { [OTHER]: [], [CHAT]: [A] } })
    h.panelInfo.set({ activePanelId: null })
    expect(h.state(CHAT).open).toBe(true)
    h.setList({ main: CHAT, catalogs: { [OTHER]: [], [CHAT]: [A] } })
    expect(h.selected.at(-1)).toBe('multiview')
  })
})
