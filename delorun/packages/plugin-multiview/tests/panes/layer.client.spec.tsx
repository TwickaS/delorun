// @vitest-environment jsdom
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { layoutOf, layoutsEn, leafOf, splitOf } from '../../src/layout/index.ts'
import { createLayerRegistry } from '../../src/panel/keys.ts'
import { MultiviewLayer, type LayerProps } from '../../src/panel/Layer.tsx'
import { createPhoneDots } from '../../src/panel/dots.tsx'
import { en } from '../../src/panes/locales.ts'
import type { PaneBodyOwnerProps, PaneHeaderOwnerProps } from '../../src/panes/slots.ts'
import { A, B, CHAT, makeStore } from '../entry/fixtures.ts'
import { listOf } from '../entry/harness.tsx'
import { fakeViewport } from '../phone/helpers.tsx'

const t = makeTranslate(en)
let viewport: ReturnType<typeof fakeViewport>
// jsdom does no layout: give every element the size of a desktop window so the layout's pane capacity admits the panes.
beforeEach(() => {
  viewport = fakeViewport(1440)
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1400 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 900 })
})
afterEach(() => {
  cleanup()
  viewport.restore()
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
})

/** A session reference that records what it is asked. */
interface FakeReference {
  readonly sessionId: string
  readonly cancel: ReturnType<typeof vi.fn>
  readonly release: ReturnType<typeof vi.fn>
}

/** How many times each chat's pane body rendered. */
const bodyRenders = new Map<string, number>()

const ChatContext = createContext<FakeReference | undefined>(undefined)

function setup(options: { settings?: { compactComposer?: boolean; maxPanes?: number }; pins?: readonly string[]; waiting?: readonly string[]; open?: boolean } = {}) {
  const made = makeStore(options.settings === undefined ? {} : { settings: options.settings })
  for (const pin of options.pins ?? [A, B]) made.store.pin(CHAT, pin as typeof A)
  if (options.open !== false) made.store.open(CHAT)
  const list = createSnapshotStore(listOf({ main: CHAT, catalogs: { [CHAT]: [A, B] }, running: [A] }))
  const statuses = createSnapshotStore(new Map((options.waiting ?? []).map(id => [id, { pendingInteraction: { kind: 'approval' } }])))
  const refs = new Map<string, FakeReference[]>()
  const sessions = {
    subagentAddress: () => undefined,
    retain: (target: string) => {
      const reference: FakeReference = { sessionId: target, cancel: vi.fn(() => Promise.resolve({ ok: true })), release: vi.fn() }
      refs.set(target, [...(refs.get(target) ?? []), reference])
      return { sessionId: target, binding: { session: { cancel: reference.cancel } }, release: reference.release } as never
    },
  }
  const owners = { header: new Map<string, PaneHeaderOwnerProps>(), body: new Map<string, PaneBodyOwnerProps>() }
  const openFull = vi.fn()
  const renderSlot = (key: string, owner: object): ReactNode => <Probe slot={key} owner={owner} owners={owners} />
  const props = {
    sessionId: CHAT,
    children: <div data-main-content />,
    useSessions: <S,>(selector: (state: ReturnType<typeof list.getSnapshot>) => S): S => useSyncExternalStore(list.subscribe, () => selector(list.getSnapshot())),
    useSessionStatus: <S,>(selector: (state: ReturnType<typeof statuses.getSnapshot>) => S): S => useSyncExternalStore(statuses.subscribe, () => selector(statuses.getSnapshot())),
    SessionProvider: ({ session, children }: { session: FakeReference; children: ReactNode }) => <ChatContext.Provider value={session}>{children}</ChatContext.Provider>,
    renderSlot,
    multiview: made.store, sessions, openFull, clock: String, dots: createPhoneDots(), t, layoutsT: makeTranslate(layoutsEn), layers: createLayerRegistry(),
  }
  const view = render(<MultiviewLayer {...(props as never as LayerProps)} />)
  const live = (chat: string): number => (refs.get(chat) ?? []).filter(reference => reference.release.mock.calls.length === 0).length
  return { ...made, view, props, refs, owners, openFull, live, list, dots: props.dots }
}

/** Stands in for the slot a pane renders: it tells which chat it is bound to and what the panel gave it. */
function Probe({ slot, owner, owners }: { slot: string; owner: object; owners: { header: Map<string, PaneHeaderOwnerProps>; body: Map<string, PaneBodyOwnerProps> } }) {
  const chat = useContext(ChatContext)?.sessionId ?? 'none'
  if (slot === 'multiview.pane.header') {
    const header = owner as PaneHeaderOwnerProps
    owners.header.set(chat, header)
    return (
      <div data-header={chat}>
        <button type="button" onClick={header.onStop}>Stop {chat}</button>
        <button type="button" onClick={header.onClose}>Close {chat}</button>
        <button type="button" onClick={header.onOpen}>Open {chat}</button>
      </div>
    )
  }
  const body = owner as PaneBodyOwnerProps
  owners.body.set(chat, body)
  bodyRenders.set(chat, (bodyRenders.get(chat) ?? 0) + 1)
  return <div data-body={chat} data-compact={body.compact} />
}

describe('the multiview layer', () => {
  it('renders the main content again without rendering the agent panes again', () => {
    bodyRenders.clear()
    const h = setup()
    const before = [...bodyRenders.entries()]
    act(() => { h.view.rerender(<MultiviewLayer {...({ ...h.props, children: <div data-main-content data-changed /> } as never as LayerProps)} />) })
    expect(document.querySelector('[data-main-content]')!.hasAttribute('data-changed')).toBe(true)
    expect([...bodyRenders.entries()]).toEqual(before)
  })

  it('leaves the main content as it is while Multiview is closed', () => {
    const h = setup({ open: false })
    expect(document.querySelector('[data-main-content]')).not.toBeNull()
    expect(document.querySelector('[data-multiview-panel]')).toBeNull()
    expect(h.refs.size).toBe(0)
  })

  it('draws the main content in the main chat pane and one pane body for each pin, each in its own chat reference', () => {
    const h = setup()
    expect(document.querySelector('[data-main-content]')!.closest('[data-pane-body]')).not.toBeNull()
    expect(document.querySelector(`[data-body="${CHAT}"]`)).toBeNull()
    for (const chat of [CHAT, A, B]) expect(document.querySelector(`[data-header="${chat}"]`)).not.toBeNull()
    for (const chat of [A, B]) expect(document.querySelector(`[data-body="${chat}"]`)).not.toBeNull()
    expect([CHAT, A, B].map(chat => h.live(chat))).toEqual([1, 1, 1])
  })

  it('retains each chat once while panes move, and releases a closed pane and every pane when the panel closes', () => {
    const h = setup()
    expect(h.refs.get(A)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: `Close ${A}` }))
    expect(h.store.of(CHAT).getSnapshot().pins).toEqual([B])
    expect(h.live(A)).toBe(0)
    expect(h.live(B)).toBe(1)
    expect(h.refs.get(B)).toHaveLength(1)
    h.view.unmount()
    expect([CHAT, A, B].map(chat => h.live(chat))).toEqual([0, 0, 0])
  })

  it('stops only the chat whose header Stop was pressed', () => {
    const h = setup()
    fireEvent.click(screen.getByRole('button', { name: `Stop ${A}` }))
    expect(h.refs.get(A)![0]!.cancel).toHaveBeenCalledTimes(1)
    expect(h.refs.get(B)![0]!.cancel).not.toHaveBeenCalled()
    expect(h.refs.get(CHAT)![0]!.cancel).not.toHaveBeenCalled()
  })

  it('opens the pane chat in the main view', () => {
    const h = setup()
    fireEvent.click(screen.getByRole('button', { name: `Open ${B}` }))
    expect(h.openFull).toHaveBeenCalledWith(B)
  })

  it('gives agent panes the compact reply box, and the full composer everywhere when the setting is off', () => {
    setup()
    expect(document.querySelector(`[data-body="${A}"]`)!.getAttribute('data-compact')).toBe('true')
    cleanup()
    setup({ settings: { compactComposer: false } })
    expect(document.querySelector(`[data-body="${A}"]`)!.getAttribute('data-compact')).toBe('false')
  })

  it('marks the pane of a chat that waits for approval', () => {
    setup({ waiting: [A] })
    expect(document.querySelector(`[data-body="${A}"]`)!.closest('[data-pane-body]')!.hasAttribute('data-waiting')).toBe(true)
    expect(document.querySelector(`[data-body="${B}"]`)!.closest('[data-pane-body]')!.hasAttribute('data-waiting')).toBe(false)
  })

  it('counts the main chat\'s own request on the phone: its chip shows the dot, and a waiting page stays mounted far from the shown one', () => {
    viewport.resize(390)
    setup({ pins: [A, B], waiting: [CHAT] })
    expect(document.querySelector(`[data-page-chip="${CHAT}"]`)!.hasAttribute('data-needs-attention')).toBe(true)
    fireEvent.click(screen.getAllByRole('tab')[2]!)
    expect(document.querySelector(`[data-page-chat="${CHAT}"] [data-main-content]`)).not.toBeNull()
  })

  it('marks the tab of a waiting pane that shares a leaf with another', () => {
    const h = setup({ waiting: [B] })
    act(() => { h.store.adoptArrangement(CHAT, layoutOf(splitOf('horizontal', [leafOf([CHAT]), leafOf([A, B], 100, A)])), 'move') })
    expect(screen.getAllByRole('tab').map(tab => tab.querySelector('[data-attention-dot]') !== null)).toEqual([false, true])
  })

  it('turns panes that do not fit into tabs instead of hiding them, and marks a waiting one', () => {
    // Room for two columns of the least width: Auto's three columns become the main chat beside the two agents as tabs.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 700 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 300 })
    setup({ waiting: [B], pins: [A, B] })
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getAllByRole('tab').map(tab => tab.querySelector('[data-attention-dot]') !== null)).toEqual([false, true])
  })

  it('says "Saved as your default layout" with Undo once the Host accepts a swap as the default, and a refusal when it refuses', async () => {
    const accepted = setup()
    accepted.store.attachHost({ write: async (patch) => { accepted.change(patch); return true } })
    act(() => { accepted.owners.header.get(A)!.controls.actions.swap(A, B) })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain(layoutsEn['saved.studio']) })
    expect(screen.getByRole('button', { name: layoutsEn['saved.undo'] })).toBeTruthy()
    cleanup()
    const refused = setup()
    refused.store.attachHost({ write: async () => false })
    act(() => { refused.owners.header.get(A)!.controls.actions.swap(A, B) })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain(layoutsEn['saved.refused']) })
    expect(screen.getByRole('alert').textContent).not.toContain(layoutsEn['saved.studio'])
    expect(screen.queryByRole('button', { name: layoutsEn['saved.undo'] })).toBeNull()
  })

  it('returns to the normal chat when the last pinned pane is closed', () => {
    const h = setup({ pins: [A] })
    fireEvent.click(screen.getByRole('button', { name: `Close ${A}` }))
    expect(h.store.of(CHAT).getSnapshot().open).toBe(false)
    expect(document.querySelector('[data-main-content]')).not.toBeNull()
    expect(document.querySelector('[data-multiview-panel]')).toBeNull()
  })

  it('leaves a content with no chat as it is', () => {
    const h = setup()
    h.view.rerender(<MultiviewLayer {...({ ...h.props, sessionId: undefined } as never as LayerProps)} />)
    expect(document.querySelector('[data-multiview-panel]')).toBeNull()
  })

  it('reports the area it fills and clears it when it closes', () => {
    const h = setup()
    const report = vi.spyOn(h.store, 'reportArea')
    h.view.unmount()
    expect(report).toHaveBeenLastCalledWith(undefined)
  })
})

describe('the multiview layer on a phone', () => {
  it('shows a pager page per chat, only the shown page and its neighbours drawn, and holds every chat reference', () => {
    viewport.resize(390)
    const h = setup({ pins: [A, B] })
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    expect(document.querySelector(`[data-page-chat="${CHAT}"] [data-main-content]`)).not.toBeNull()
    expect([CHAT, A, B].map(chat => h.live(chat))).toEqual([1, 1, 1])
    fireEvent.click(screen.getAllByRole('tab')[2]!)
    expect(document.querySelector(`[data-page-chat="${A}"]`)).not.toBeNull()
    expect(document.querySelector(`[data-page-chat="${CHAT}"] [data-main-content]`)).toBeNull()
    expect([CHAT, A, B].map(chat => h.live(chat))).toEqual([1, 1, 1])
  })

  it('puts an amber dot on the chip of a page that waits and publishes the position for the dots above the reply box', () => {
    viewport.resize(390)
    const h = setup({ pins: [A, B], waiting: [A] })
    expect(document.querySelector(`[data-page-chip="${A}"]`)!.hasAttribute('data-needs-attention')).toBe(true)
    expect(h.dots.getSnapshot()?.ids).toEqual([CHAT, A, B])
    expect(h.dots.getSnapshot()?.active).toBe(CHAT)
    act(() => { h.dots.getSnapshot()?.select(B) })
    expect(h.dots.getSnapshot()?.active).toBe(B)
    h.view.unmount()
    expect(h.dots.getSnapshot()).toBeUndefined()
  })
})
