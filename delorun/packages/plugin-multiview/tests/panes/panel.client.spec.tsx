// @vitest-environment jsdom
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MultiviewPanel, type PanelProps } from '../../src/panel/Panel.tsx'
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

const ChatContext = createContext<FakeReference | undefined>(undefined)

function setup(options: { settings?: { compactComposer?: boolean; maxPanes?: number }; pins?: readonly string[]; waiting?: readonly string[] } = {}) {
  const made = makeStore(options.settings === undefined ? {} : { settings: options.settings })
  for (const pin of options.pins ?? [A, B]) made.store.pin(CHAT, pin as typeof A)
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
    useSessions: <S,>(selector: (state: ReturnType<typeof list.getSnapshot>) => S): S => useSyncExternalStore(list.subscribe, () => selector(list.getSnapshot())),
    useSessionStatus: <S,>(selector: (state: ReturnType<typeof statuses.getSnapshot>) => S): S => useSyncExternalStore(statuses.subscribe, () => selector(statuses.getSnapshot())),
    SessionProvider: ({ session, children }: { session: FakeReference; children: ReactNode }) => <ChatContext.Provider value={session}>{children}</ChatContext.Provider>,
    renderSlot,
    multiview: made.store, sessions, openFull, clock: String, dots: createPhoneDots(), t,
  }
  const view = render(<MultiviewPanel {...(props as never as PanelProps)} />)
  const live = (chat: string): number => (refs.get(chat) ?? []).filter(reference => reference.release.mock.calls.length === 0).length
  return { ...made, view, refs, owners, openFull, live, list, dots: props.dots }
}

/** Stands in for the slot a pane renders: it tells which chat it is bound to and what the panel gave it. */
function Probe({ slot, owner, owners }: { slot: string; owner: object; owners: { header: Map<string, PaneHeaderOwnerProps>; body: Map<string, PaneBodyOwnerProps> } }) {
  const chat = useContext(ChatContext)?.sessionId ?? 'none'
  if (slot === 'conversation.header') return <div data-testid="chat-header" data-chat={chat} />
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
  return <div data-body={chat} data-compact={body.compact} />
}

describe('the multiview panel', () => {
  it('draws the main chat header strip and one pane for the main chat and each pin, each in its own chat reference', () => {
    const h = setup()
    expect(screen.getByTestId('chat-header').getAttribute('data-chat')).toBe(CHAT)
    for (const chat of [CHAT, A, B]) {
      expect(document.querySelector(`[data-header="${chat}"]`)).not.toBeNull()
      expect(document.querySelector(`[data-body="${chat}"]`)).not.toBeNull()
    }
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

  it('gives agent panes the compact reply box and the main chat the full composer, and the full one everywhere when the setting is off', () => {
    setup()
    expect(document.querySelector(`[data-body="${A}"]`)!.getAttribute('data-compact')).toBe('true')
    expect(document.querySelector(`[data-body="${CHAT}"]`)!.getAttribute('data-compact')).toBe('false')
    cleanup()
    setup({ settings: { compactComposer: false } })
    expect(document.querySelector(`[data-body="${A}"]`)!.getAttribute('data-compact')).toBe('false')
  })

  it('marks the pane of a chat that waits for approval', () => {
    setup({ waiting: [A] })
    expect(document.querySelector(`[data-body="${A}"]`)!.closest('[data-pane-body]')!.hasAttribute('data-waiting')).toBe(true)
    expect(document.querySelector(`[data-body="${B}"]`)!.closest('[data-pane-body]')!.hasAttribute('data-waiting')).toBe(false)
  })

  it('returns to the normal chat when the last pinned pane is closed', () => {
    const h = setup({ pins: [A] })
    h.store.open(CHAT)
    fireEvent.click(screen.getByRole('button', { name: `Close ${A}` }))
    expect(h.shown.at(-1)).toEqual({ chat: CHAT, open: false })
  })

  it('says so when no chat is the main view', () => {
    const h = setup()
    act(() => { h.list.set(listOf({})) })
    expect(screen.getByText('Open a chat to use Multiview.')).toBeTruthy()
  })

  it('reports the area it fills and clears it when it closes', () => {
    const h = setup()
    const report = vi.spyOn(h.store, 'reportArea')
    h.view.unmount()
    expect(report).toHaveBeenLastCalledWith(undefined)
  })
})

describe('the multiview panel on a phone', () => {
  it('shows a pager page per chat, only the shown page and its neighbours drawn, and holds every chat reference', () => {
    viewport.resize(390)
    const h = setup({ pins: [A, B] })
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    expect(document.querySelector(`[data-page-chat="${CHAT}"] [data-body="${CHAT}"]`)).not.toBeNull()
    expect([CHAT, A, B].map(chat => h.live(chat))).toEqual([1, 1, 1])
    fireEvent.click(screen.getAllByRole('tab')[2]!)
    expect(document.querySelector(`[data-page-chat="${A}"]`)).not.toBeNull()
    expect(document.querySelector(`[data-page-chat="${CHAT}"] [data-body]`)).toBeNull()
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
