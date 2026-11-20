// @vitest-environment jsdom
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MultiviewSettings } from '../../src/config.ts'
import { Footer, HeaderButton, PinButton, type EntryInjected, type FooterProps, type HeaderButtonProps, type PinButtonProps } from '../../src/entry/Entry.tsx'
import { en } from '../../src/entry/locales.ts'
import { A, B, C, CHAT, makeStore, sid } from './fixtures.ts'
import { listOf, slotProps, type ListSpec } from './harness.tsx'

afterEach(cleanup)

const t = makeTranslate(en)

/** Slot props for a component in the chat header or a row, over a store and a session list. */
interface SetupOptions { settings?: Partial<MultiviewSettings>; list?: ListSpec; pending?: readonly string[]; child?: boolean; open?: boolean }

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
  const injected: EntryInjected = { multiview: store }
  const useSessions = <S,>(selector: (state: ReturnType<typeof list.getSnapshot>) => S): S => selector(list.getSnapshot())
  const useSessionStatus = <S,>(selector: (state: ReturnType<typeof statuses.getSnapshot>) => S): S => selector(statuses.getSnapshot())
  const useSession = <S,>(selector: (state: { subagent: null | object }) => S): S => selector({ subagent: options.child === true ? {} : null })
  return { ...made, list, statuses, opened, injected, useSessions, useSessionStatus, useSession }
}

const row = (agent: string, label: string) => ({ sessionId: sid(agent), label })

function renderPin(h: ReturnType<typeof setup>, agent: string, label: string) {
  return render(<PinButton {...slotProps<PinButtonProps>({ ...row(agent, label), useSessions: h.useSessions, t, ...h.injected })} />)
}

function renderFooter(h: ReturnType<typeof setup>) {
  return render(<Footer {...slotProps<FooterProps>({ sessionId: CHAT, useSessions: h.useSessions, t, ...h.injected })} />)
}

function renderHeader(h: ReturnType<typeof setup>) {
  return render(<HeaderButton {...slotProps<HeaderButtonProps>({ sessionId: CHAT, useSessions: h.useSessions, useSessionStatus: h.useSessionStatus, useSession: h.useSession, t, ...h.injected })} />)
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

describe('the header button', () => {
  it('shows the pinned count and no dot while nobody waits', () => {
    const h = setup()
    h.store.pinAll(CHAT, [A, B])
    renderHeader(h)
    const button = screen.getByRole('button', { name: 'Multiview, 2 pinned' })
    expect(button.textContent).toContain('2')
    expect(button.querySelector('[class*="dot"]')).toBeNull()
  })

  it('shows an amber dot, and says so, while a pinned agent waits for approval', () => {
    const h = setup({ pending: [B] })
    h.store.pinAll(CHAT, [A, B])
    renderHeader(h)
    const button = screen.getByRole('button', { name: 'Multiview, 2 pinned, An agent is waiting for you' })
    expect(button.querySelector('[class*="dot"]')).not.toBeNull()
  })

  it('shows no dot for an agent that waits but is not pinned', () => {
    const h = setup({ pending: [C] })
    h.store.pinAll(CHAT, [A])
    renderHeader(h)
    expect(screen.getByRole('button', { name: 'Multiview, 1 pinned' }).querySelector('[class*="dot"]')).toBeNull()
  })

  it('shows no count with nothing pinned', () => {
    const h = setup()
    renderHeader(h)
    const button = screen.getByRole('button', { name: 'Multiview' })
    expect(button.querySelector('[class*="count"]')).toBeNull()
  })

  it('pins every running agent first when nothing is pinned, then opens', () => {
    const h = setup()
    renderHeader(h)
    fireEvent.click(screen.getByRole('button', { name: 'Multiview' }))
    expect(h.store.of(CHAT).getSnapshot()).toMatchObject({ pins: [A, B], open: true })
  })

  it('closes while Multiview shows', () => {
    const h = setup({ open: true })
    h.store.pin(CHAT, A)
    renderHeader(h)
    const button = screen.getByRole('button', { name: 'Multiview, 1 pinned' })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(button)
    expect(h.opened).toEqual([false])
  })

  it('is disabled with the reason when nothing runs and nothing is pinned', () => {
    const h = setup({ list: { main: CHAT, catalogs: { [CHAT]: [A] } } })
    renderHeader(h)
    const button = screen.getByRole('button', { name: 'Multiview' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(button)
    expect(h.opened).toEqual([])
  })

  it('renders nothing in an agent\'s own chat', () => {
    expect(renderHeader(setup({ child: true })) && screen.queryByRole('button')).toBeNull()
    cleanup()
    const listed = setup({ list: { main: A, catalogs: { [CHAT]: [A] } } })
    render(<HeaderButton {...slotProps<HeaderButtonProps>({ sessionId: A, useSessions: listed.useSessions, useSessionStatus: listed.useSessionStatus, useSession: listed.useSession, t, ...listed.injected })} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers the Layout menu only while Multiview shows, with the presets and Reset to default', () => {
    const closed = setup()
    renderHeader(closed)
    expect(screen.queryByRole('button', { name: 'Layout' })).toBeNull()
    cleanup()
    const h = setup({ open: true })
    h.store.pinAll(CHAT, [A, B])
    renderHeader(h)
    fireEvent.click(screen.getByRole('button', { name: 'Layout' }))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Main and column', 'Side by side', 'Grid', 'Main on top', 'Reset to default'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Grid' }))
    expect(h.store.of(CHAT).getSnapshot().layout).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Layout' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reset to default' }))
    expect(h.store.of(CHAT).getSnapshot().layout).not.toBeNull()
  })
})
