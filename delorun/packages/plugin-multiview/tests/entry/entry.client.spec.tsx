// @vitest-environment jsdom
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { MultiviewSettings } from '../../src/config.ts'
import { Footer, MultiviewToggle, PinButton, type EntryInjected, type FooterProps, type PinButtonProps, type ToggleProps } from '../../src/entry/Entry.tsx'
import { localHint, MULTIVIEW_HINT_NAME, type HintPreference } from '../../src/entry/hint.ts'
import { en } from '../../src/entry/locales.ts'
import { A, B, C, CHAT, makeStore, sid } from './fixtures.ts'
import { listOf, slotProps, type ListSpec } from './harness.tsx'

afterEach(cleanup)

const t = makeTranslate(en)

/** Slot props for a component in the chat header or a row, over a store and a session list. */
interface SetupOptions { settings?: Partial<MultiviewSettings>; list?: ListSpec; pending?: readonly string[]; child?: boolean; open?: boolean; keys?: readonly string[] }

function setup(options: SetupOptions = {}) {
  const made = makeStore(options.settings === undefined ? {} : { settings: options.settings })
  const list = createSnapshotStore(listOf(options.list ?? { main: CHAT, catalogs: { [CHAT]: [A, B, C] }, running: [A, B] }))
  const statuses = createSnapshotStore(new Map((options.pending ?? []).map(id => [sid(id), { running: true, pendingInteraction: { kind: 'approval', key: 'k', sessionId: sid(id) }, completionUnread: false }])))
  const opened: boolean[] = []
  const store = made.store
  const open = store.open.bind(store)
  if (options.open === true) open(CHAT)
  store.open = (chat) => { opened.push(true); open(chat) }
  const close = store.close.bind(store)
  store.close = (chat) => { opened.push(false); close(chat) }
  const keys = createSnapshotStore<readonly string[]>(options.keys ?? [])
  const injected: EntryInjected = { multiview: store, focusKeys: keys }
  const useSessions = <S,>(selector: (state: ReturnType<typeof list.getSnapshot>) => S): S => selector(list.getSnapshot())
  const useSessionStatus = <S,>(selector: (state: ReturnType<typeof statuses.getSnapshot>) => S): S => selector(statuses.getSnapshot())
  const useSession = <S,>(selector: (state: { subagent: null | object }) => S): S => selector({ subagent: options.child === true ? {} : null })
  return { ...made, list, statuses, opened, injected, keys, useSessions, useSessionStatus, useSession }
}

const row = (agent: string, label: string) => ({ sessionId: sid(agent), label })

function renderPin(h: ReturnType<typeof setup>, agent: string, label: string) {
  return render(<PinButton {...slotProps<PinButtonProps>({ ...row(agent, label), useSessions: h.useSessions, t, ...h.injected })} />)
}

function renderFooter(h: ReturnType<typeof setup>) {
  return render(<Footer {...slotProps<FooterProps>({ sessionId: CHAT, useSessions: h.useSessions, t, ...h.injected })} />)
}

function renderToggle(h: ReturnType<typeof setup>) {
  return render(<MultiviewToggle {...slotProps<ToggleProps>({ sessionId: CHAT, useSessions: h.useSessions, useSessionStatus: h.useSessionStatus, t, ...h.injected })} />)
}

/** Show tooltips at once in jsdom, which measures nothing. */
function enableTooltips(): void {
  class Measured implements ResizeObserver {
    private readonly callback: ResizeObserverCallback
    constructor(callback: ResizeObserverCallback) { this.callback = callback }
    observe(target: Element): void {
      const size = { inlineSize: 160, blockSize: 30 }
      this.callback([{ target, borderBoxSize: [size], contentBoxSize: [size], devicePixelContentBoxSize: [size], contentRect: new DOMRect() }], this)
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', Measured)
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
}

describe('the pin button of a row', () => {
  it('pins an agent and shows it pinned, then unpins it', () => {
    const h = setup()
    renderPin(h, A, 'Reviewer')
    const button = screen.getByRole('button', { name: 'Pin Reviewer to Multiview' })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(button)
    expect(h.store.of(CHAT).getSnapshot().pins).toEqual([A])
  })

  it('shows a pinned agent with a filled, pressed button that unpins', () => {
    const h = setup()
    h.store.pin(CHAT, A)
    renderPin(h, A, 'Reviewer')
    const button = screen.getByRole('button', { name: 'Unpin Reviewer from Multiview' })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(button)
    expect(h.store.of(CHAT).getSnapshot().pins).toEqual([])
  })

  it('finds the chat an agent in a nested row belongs to', () => {
    const h = setup({ list: { main: CHAT, catalogs: { [CHAT]: [A], [A]: [B] } } })
    renderPin(h, B, 'Nested')
    fireEvent.click(screen.getByRole('button', { name: 'Pin Nested to Multiview' }))
    expect(h.store.of(CHAT).getSnapshot().pins).toEqual([B])
  })

  it('is disabled with the reason at the pane limit, and pins nothing when pressed', () => {
    const h = setup({ settings: { maxPanes: 2 } })
    h.store.pin(CHAT, A)
    renderPin(h, B, 'Second')
    const button = screen.getByRole('button', { name: 'Pin Second to Multiview' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.getAttribute('aria-description')).toBe('Multiview is full: 2 panes at most. Unpin an agent, or raise the limit in Settings.')
    fireEvent.click(button)
    expect(h.store.of(CHAT).getSnapshot().pins).toEqual([A])
  })

  it('says the window is full when no pane of the least size fits', () => {
    const h = makeStore({ window: { width: 500, height: 300 } })
    const list = createSnapshotStore(listOf({ main: CHAT, catalogs: { [CHAT]: [A, B] } }))
    h.store.pin(CHAT, A)
    render(<PinButton {...slotProps<PinButtonProps>({ ...row(B, 'Second'), useSessions: <S,>(select: (state: ReturnType<typeof list.getSnapshot>) => S) => select(list.getSnapshot()), t, multiview: h.store, activePanel: createSnapshotStore<string | null>(null) })} />)
    expect(screen.getByRole('button', { name: 'Pin Second to Multiview' }).getAttribute('aria-description')).toBe(en['pin.refused.no-room'])
  })

  it('keeps a pinned agent\'s button enabled at the limit, so it can be unpinned', () => {
    const h = setup({ settings: { maxPanes: 2 } })
    h.store.pin(CHAT, A)
    renderPin(h, A, 'First')
    expect(screen.getByRole('button', { name: 'Unpin First from Multiview' }).getAttribute('aria-disabled')).toBeNull()
  })

  it('does not let the click reach the row', () => {
    const h = setup()
    const onRow = vi.fn()
    render(<div onClick={onRow} onKeyDown={onRow}><PinButton {...slotProps<PinButtonProps>({ ...row(A, 'Reviewer'), useSessions: h.useSessions, t, ...h.injected })} /></div>)
    const button = screen.getByRole('button')
    fireEvent.click(button)
    fireEvent.keyDown(button, { key: 'Enter' })
    expect(onRow).not.toHaveBeenCalled()
  })
})

describe('the popover footer', () => {
  it('counts the pinned agents and the room left', () => {
    const h = setup()
    h.store.pinAll(CHAT, [A, B])
    renderFooter(h)
    expect(screen.getByText('2 pinned · room for 3 more')).toBeTruthy()
  })

  it('says there is no room when the limit is reached', () => {
    const h = setup({ settings: { maxPanes: 2 } })
    h.store.pin(CHAT, A)
    renderFooter(h)
    expect(screen.getByText('1 pinned · no room for more')).toBeTruthy()
  })

  it('pins every running agent that is not pinned from Pin running', () => {
    const h = setup()
    renderFooter(h)
    fireEvent.click(screen.getByRole('button', { name: 'Pin running' }))
    expect(h.store.of(CHAT).getSnapshot().pins).toEqual([A, B])
  })

  it('disables Pin running with the reason when nothing runs or every running agent is pinned', () => {
    const idle = setup({ list: { main: CHAT, catalogs: { [CHAT]: [A] } } })
    renderFooter(idle)
    expect(screen.getByRole('button', { name: 'Pin running' }).getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Pin running' }))
    expect(idle.store.of(CHAT).getSnapshot().pins).toEqual([])
    cleanup()
    const pinned = setup()
    pinned.store.pinAll(CHAT, [A, B])
    renderFooter(pinned)
    expect(screen.getByRole('button', { name: 'Pin running' }).getAttribute('aria-disabled')).toBe('true')
  })

  it('opens Multiview, pinning the running agents first when none is pinned, and closes it again', () => {
    const h = setup()
    renderFooter(h)
    fireEvent.click(screen.getByRole('button', { name: 'Open Multiview' }))
    expect(h.store.of(CHAT).getSnapshot()).toMatchObject({ pins: [A, B], open: true })
    expect(h.opened).toEqual([true])
    fireEvent.click(screen.getByRole('button', { name: 'Close Multiview' }))
    expect(h.opened).toEqual([true, false])
  })
})

describe('the toggle at the end of the agents action', () => {
  it('is an icon-only toggle named Multiview, not pressed while Multiview is closed', () => {
    const h = setup()
    h.store.pinAll(CHAT, [A, B])
    renderToggle(h)
    const button = screen.getByRole('button', { name: 'Multiview' })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.textContent).toBe('')
    expect(button.getAttribute('aria-description')).toBe('2 pinned')
    expect(button.querySelector('[class*="dot"]')).toBeNull()
  })

  it('follows Multiview: pressed while it shows, and not when it closes from elsewhere', () => {
    const h = setup()
    h.store.pinAll(CHAT, [A, B])
    renderToggle(h)
    const button = screen.getByRole('button', { name: 'Multiview' })
    act(() => { h.store.open(CHAT) })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    act(() => { h.store.close(CHAT) })
    expect(button.getAttribute('aria-pressed')).toBe('false')
  })

  it('opens Multiview, pinning every running agent first when nothing is pinned, and closes it again', () => {
    const h = setup()
    renderToggle(h)
    const button = screen.getByRole('button', { name: 'Multiview' })
    fireEvent.click(button)
    expect(h.store.of(CHAT).getSnapshot()).toMatchObject({ pins: [A, B], open: true })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(button)
    expect(h.opened).toEqual([true, false])
    expect(h.store.of(CHAT).getSnapshot()).toMatchObject({ pins: [A, B], open: false })
    expect(button.getAttribute('aria-pressed')).toBe('false')
  })

  it('shows an amber dot, and says so, while a pinned agent waits for approval', () => {
    const h = setup({ pending: [B] })
    h.store.pinAll(CHAT, [A, B])
    renderToggle(h)
    const button = screen.getByRole('button', { name: 'Multiview' })
    expect(button.getAttribute('aria-description')).toBe('2 pinned, An agent is waiting for you')
    expect(button.querySelector('[class*="dot"]')).not.toBeNull()
  })

  it('shows no dot for an agent that waits but is not pinned', () => {
    const h = setup({ pending: [C] })
    h.store.pinAll(CHAT, [A])
    renderToggle(h)
    expect(screen.getByRole('button', { name: 'Multiview' }).querySelector('[class*="dot"]')).toBeNull()
  })

  it('is disabled with the reason when the chat has agents but none runs and none is pinned', () => {
    const h = setup({ list: { main: CHAT, catalogs: { [CHAT]: [A] } } })
    renderToggle(h)
    const button = screen.getByRole('button', { name: 'Multiview' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(button)
    expect(h.opened).toEqual([])
  })

  it('is absent while the chat has no agents, nothing is pinned and Multiview is closed', () => {
    const h = setup({ list: { main: CHAT, catalogs: { [CHAT]: [] } } })
    renderToggle(h)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('stays while Multiview shows or something is pinned, even with no agents listed', () => {
    const h = setup({ list: { main: CHAT, catalogs: { [CHAT]: [] } } })
    h.store.pin(CHAT, A)
    renderToggle(h)
    expect(screen.getByRole('button', { name: 'Multiview' })).toBeTruthy()
  })

  it('shows the focus command\'s keys in its tooltip only while they are set', async () => {
    enableTooltips()
    onTestFinished(() => { vi.unstubAllGlobals() })
    const h = setup()
    h.store.pinAll(CHAT, [A])
    renderToggle(h)
    const button = screen.getByRole('button', { name: 'Multiview' })
    fireEvent.pointerEnter(button)
    fireEvent.focus(button)
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip.textContent).toBe('Multiview')
    act(() => { h.keys.set(['Ctrl', 'Shift', 'M']) })
    expect(screen.getByRole('tooltip').textContent).toContain('Multiview')
    expect(screen.getByRole('tooltip').getAttribute('aria-label')).toBe('Multiview Ctrl Shift M')
  })
})

describe('the layout picker in the agents list', () => {
  it('shows in the footer whether Multiview is open or closed, above the footer\'s buttons', () => {
    const h = setup()
    h.store.pinAll(CHAT, [A, B])
    renderFooter(h)
    const row = screen.getByRole('group', { name: 'Layout' })
    expect(within(row).getAllByRole('button').map(button => button.getAttribute('aria-label') ?? button.textContent))
      .toEqual(['Main and column', 'Side by side', 'Grid', 'Main on top', 'Reset to default'])
    expect(row.compareDocumentPosition(screen.getByRole('button', { name: 'Pin running' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('applies the chosen layout and resets to the default, keeping every pane and Multiview open', () => {
    const h = setup({ open: true })
    h.store.pinAll(CHAT, [A, B])
    const applied: string[] = []
    const applyPreset = h.store.applyPreset.bind(h.store)
    h.store.applyPreset = (chat, preset) => { applied.push(preset); applyPreset(chat, preset) }
    renderFooter(h)
    fireEvent.click(screen.getByRole('button', { name: 'Side by side' }))
    const sideBySide = h.store.of(CHAT).getSnapshot().layout
    fireEvent.click(screen.getByRole('button', { name: 'Grid' }))
    fireEvent.click(screen.getByRole('button', { name: 'Main on top' }))
    fireEvent.click(screen.getByRole('button', { name: 'Main and column' }))
    expect(applied).toEqual(['side-by-side', 'grid', 'main-top', 'main-column'])
    expect(sideBySide).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }))
    expect(h.store.of(CHAT).getSnapshot()).toMatchObject({ pins: [A, B], open: true })
    expect(h.store.of(CHAT).getSnapshot().layout).not.toEqual(sideBySide)
  })
})

describe('the layouts popover on the toggle', () => {
  it('opens on right-click without toggling Multiview, focuses a choice, and closes on Escape with focus back on the toggle', () => {
    const h = setup()
    h.store.pinAll(CHAT, [A, B])
    renderToggle(h)
    const button = screen.getByRole('button', { name: 'Multiview' })
    fireEvent.contextMenu(button)
    const popover = screen.getByRole('dialog', { name: 'Layout' })
    expect(h.opened).toEqual([])
    expect(popover.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Layout' })).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('applies a choice and closes', () => {
    const h = setup({ open: true })
    h.store.pinAll(CHAT, [A, B])
    renderToggle(h)
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Multiview' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Layout' })).getByRole('button', { name: 'Grid' }))
    expect(screen.queryByRole('dialog', { name: 'Layout' })).toBeNull()
    expect(h.store.of(CHAT).getSnapshot()).toMatchObject({ pins: [A, B], open: true })
  })

  it('closes on a press outside it', () => {
    const h = setup()
    h.store.pinAll(CHAT, [A])
    renderToggle(h)
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Multiview' }))
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog', { name: 'Layout' })).toBeNull()
  })

  it('opens on a held touch without toggling Multiview, and a short tap still toggles', () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const h = setup()
    h.store.pinAll(CHAT, [A])
    renderToggle(h)
    const button = screen.getByRole('button', { name: 'Multiview' })
    fireEvent.pointerDown(button, { pointerType: 'touch', clientX: 10, clientY: 10 })
    act(() => { vi.advanceTimersByTime(500) })
    fireEvent.pointerUp(button, { pointerType: 'touch' })
    fireEvent.click(button)
    expect(screen.getByRole('dialog', { name: 'Layout' })).toBeTruthy()
    expect(h.opened).toEqual([])
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.pointerDown(button, { pointerType: 'touch', clientX: 10, clientY: 10 })
    act(() => { vi.advanceTimersByTime(200) })
    fireEvent.pointerUp(button, { pointerType: 'touch' })
    fireEvent.click(button)
    expect(h.opened).toEqual([true])
    expect(screen.queryByRole('dialog', { name: 'Layout' })).toBeNull()
  })

  it('does not open when a held touch moves away', () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const h = setup()
    h.store.pinAll(CHAT, [A])
    renderToggle(h)
    const button = screen.getByRole('button', { name: 'Multiview' })
    fireEvent.pointerDown(button, { pointerType: 'touch', clientX: 10, clientY: 10 })
    fireEvent.pointerMove(button, { pointerType: 'touch', clientX: 30, clientY: 10 })
    act(() => { vi.advanceTimersByTime(600) })
    expect(screen.queryByRole('dialog', { name: 'Layout' })).toBeNull()
  })
})

describe('the one-time hint', () => {
  /** A hint preference in memory that records how often it was marked. */
  function memoryHint(seen = false) {
    let value = seen
    const marks: number[] = []
    const hint: HintPreference = { seen: () => value, markSeen: () => { value = true; marks.push(1) } }
    return { hint, marks }
  }

  function renderWithHint(h: ReturnType<typeof setup>, hint: HintPreference) {
    return render(<MultiviewToggle {...slotProps<ToggleProps>({ sessionId: CHAT, useSessions: h.useSessions, useSessionStatus: h.useSessionStatus, t, ...h.injected, hint })} />)
  }

  it('shows the first time Multiview opens, is recorded at once, and goes when dismissed', () => {
    const h = setup()
    h.store.pinAll(CHAT, [A])
    const { hint, marks } = memoryHint()
    renderWithHint(h, hint)
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Multiview' }))
    const shown = screen.getByRole('status')
    expect(shown.textContent).toContain('Drag panes to rearrange · more layouts in the agents list')
    expect(marks).toEqual([1])
    fireEvent.click(within(shown).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Multiview' }))
    fireEvent.click(screen.getByRole('button', { name: 'Multiview' }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(marks).toEqual([1])
  })

  it('never shows again once seen', () => {
    const h = setup({ open: true })
    h.store.pinAll(CHAT, [A])
    renderWithHint(h, memoryHint(true).hint)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('goes when Multiview closes', () => {
    const h = setup()
    h.store.pinAll(CHAT, [A])
    renderWithHint(h, memoryHint().hint)
    fireEvent.click(screen.getByRole('button', { name: 'Multiview' }))
    expect(screen.getByRole('status')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Multiview' }))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('waits while a menu or dialog is open, and shows once it closes', async () => {
    const h = setup()
    h.store.pinAll(CHAT, [A])
    const { hint, marks } = memoryHint()
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    document.body.append(menu)
    onTestFinished(() => { menu.remove() })
    renderWithHint(h, hint)
    fireEvent.click(screen.getByRole('button', { name: 'Multiview' }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(marks).toEqual([])
    act(() => { menu.remove() })
    expect(await screen.findByRole('status')).toBeTruthy()
    expect(marks).toEqual([1])
  })

  it('hides when a dialog opens over the header, and stays seen', async () => {
    const h = setup()
    h.store.pinAll(CHAT, [A])
    const { hint } = memoryHint()
    renderWithHint(h, hint)
    fireEvent.click(screen.getByRole('button', { name: 'Multiview' }))
    expect(screen.getByRole('status')).toBeTruthy()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    act(() => { document.body.append(dialog) })
    onTestFinished(() => { dialog.remove() })
    await vi.waitFor(() => { expect(screen.queryByRole('status')).toBeNull() })
    expect(hint.seen()).toBe(true)
  })
})

describe('the hint preference', () => {
  it('keeps the choice in storage under its host-qualified name, and once per page without storage', () => {
    const items = new Map<string, string>()
    const storage = { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value) }, removeItem: (key: string) => { items.delete(key) } }
    const first = localHint(() => storage)
    expect(first.seen()).toBe(false)
    first.markSeen()
    expect([...items.keys()]).toEqual([MULTIVIEW_HINT_NAME])
    expect(localHint(() => storage).seen()).toBe(true)
    const blocked = localHint(() => ({ getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => {} }))
    expect(blocked.seen()).toBe(false)
    blocked.markSeen()
    expect(blocked.seen()).toBe(true)
    const none = localHint(() => undefined)
    none.markSeen()
    expect(none.seen()).toBe(true)
  })
})
