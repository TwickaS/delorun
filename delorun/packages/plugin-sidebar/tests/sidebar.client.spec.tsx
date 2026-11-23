// @vitest-environment jsdom
// Type-only: the 'sidebar.workspaces.list' owner props and the 'workspace' context-menu target, which the list reads.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ContextMenuTarget } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useRef, useState, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RowStateActions } from '../src/client/ChatRow.tsx'
import type { ChatStatusFacts } from '../src/client/sections.ts'
import { en } from '../src/client/locales.ts'
import { Sidebar, type SidebarProps } from '../src/client/Sidebar.tsx'
import { TOUCH_QUERY } from '../src/client/pointer.ts'
import { createUndoLine } from '../src/client/undo.ts'
import { UndoNotice } from '../src/client/UndoNotice.tsx'
import { DEFAULT_SIDEBAR_SETTINGS, type SidebarSettings } from '../src/config.ts'
import type { UpdateNotice } from '@delorun/contract-update-report'
import { DEFAULT_WORKSPACE_ICON } from '../src/workspace-icon.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const sid = (id: string) => SessionId(id)
const wid = (id: string) => id as WorkspaceId
const NOW = Date.now()
const summary = (id: string, fields: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sid(id), title: id, displayTitle: id, cwd: '/workspace/api', updatedAt: NOW, running: false, blank: false, retainedBy: {}, ...fields,
})
const listOf = (...chats: SessionSummary[]): SessionListState => ({
  ids: chats.map(each => each.id), byId: Object.fromEntries(chats.map(each => [each.id, each])), phase: 'ready', projectionsBySession: {},
})
const api: WorkspaceView = {
  workspaceId: wid('w-api'), title: 'api', path: '/workspace/api', sessionIds: [sid('a'), sid('b'), sid('w')],
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
}
const site: WorkspaceView = { ...api, workspaceId: wid('w-site'), title: 'site', path: '/workspace/site', sessionIds: [sid('s')] }
const facts = (fields: Partial<ChatStatusFacts>): ChatStatusFacts => ({ running: false, pendingInteraction: undefined, completionUnread: false, ...fields })
/** A chat's summary fields for a run begun at a time. */
const promptedAt = (since: number): Partial<SessionSummary> => ({ projectionValues: { sessionListMetadata: { lastPromptAt: since } } } as Partial<SessionSummary>)
const source = <T,>(value: T) => <R,>(select: (state: T) => R): R => select(value)

function actions(): RowStateActions {
  return {
    settle: vi.fn(), unsettle: vi.fn(), snooze: vi.fn(), wake: vi.fn(), seen: vi.fn(), openCustom: vi.fn(),
    snoozeOptions: () => [{ id: 'after:60', label: 'In 1 hour', when: '11:00', until: NOW + 3_600_000 }],
    snoozeLeft: () => '2h',
  }
}

/** Upstream's phone-width drawer as far as Escape goes: a modal layer the opener shows, which Escape closes. */
function Drawer({ children }: { readonly children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  useModalLayer(panel, open, () => { setOpen(false) })
  return (
    <>
      <button type="button" onClick={() => { setOpen(true) }}>Open the list</button>
      <div ref={panel} role="dialog" aria-label="Chats" aria-modal={open} hidden={!open}>{children}</div>
    </>
  )
}

/** The list with three chats in api (one pinned, one asking, one working), one in site, and one snoozed and one settled. */
function show(fields: {
  settings?: Partial<SidebarSettings>
  states?: RowStateActions | null
  stored?: Record<string, string>
  list?: SessionListState
  workspaces?: WorkspaceView[]
  autoSettleDays?: number
  woke?: [SessionId, number][]
  snoozedUntil?: [SessionId, number][]
  menuTarget?: ContextMenuTarget | null
  statuses?: Map<SessionId, ChatStatusFacts>
  canAddWorkspace?: boolean
  searchRequest?: number
  searchShortcut?: SidebarProps['searchShortcut']
  pinned?: SessionId[]
  /** Whether the Workspace list has loaded; it has not unless a test says so. */
  workspacesLoaded?: boolean
  /** Whether the list sits in the phone-width drawer. */
  drawer?: boolean
  /** The update notice below the list; none unless a test says so. */
  update?: UpdateNotice
} = {}) {
  const stored = new Map(Object.entries(fields.stored ?? {}))
  const undoLine = createUndoLine()
  const states = fields.states === undefined ? actions() : fields.states
  // Without Delorun's chat states the list's sources fall back to empty maps.
  const shelved = (entries: [SessionId, number][]) => new Map(states === null ? [] : entries)
  const calls = {
    open: vi.fn(), startSession: vi.fn(), pin: vi.fn(), unpin: vi.fn(), renameSession: vi.fn(), renameWorkspace: vi.fn(), deleteWorkspace: vi.fn(),
    addWorkspace: vi.fn(), openSessionMenu: vi.fn(), setWorkspaceIcon: vi.fn(), pruneIcons: vi.fn(), detach: vi.fn(), attach: vi.fn(),
    searchSessions: vi.fn<SidebarProps['searchSessions']>(() => Promise.resolve({ items: [], hasMore: false })),
  }
  const list = fields.list ?? listOf(
    summary('a', { displayTitle: 'Pinned chat' }),
    summary('b', { displayTitle: 'Needs approval', updatedAt: NOW - 1_000 }),
    summary('w', { displayTitle: 'Working chat', running: true, updatedAt: NOW - 2_000 }),
    summary('s', { displayTitle: 'Site chat', updatedAt: NOW - 3_000 }),
    summary('z', { displayTitle: 'Snoozed chat', updatedAt: NOW - 10_000 }),
    summary('d', { displayTitle: 'Settled chat', updatedAt: NOW - 10_000 }),
  )
  const props = {
    list,
    workspaces: fields.workspaces ?? [api, site],
    open: calls.open,
    startSession: calls.startSession,
    canAddWorkspace: fields.canAddWorkspace ?? true,
    addWorkspaceAnchor: () => {},
    addWorkspace: calls.addWorkspace,
    renameSession: calls.renameSession,
    renameWorkspace: calls.renameWorkspace,
    deleteWorkspace: calls.deleteWorkspace,
    searchSessions: calls.searchSessions,
    searchRequest: fields.searchRequest ?? 0,
    searchShortcut: fields.searchShortcut,
    openSessionMenu: calls.openSessionMenu,
    useSessionStatus: source(fields.statuses ?? new Map([[sid('b'), facts({ pendingInteraction: { kind: 'approval' } })]])),
    useWorkspaces: source({ pinnedSessionIds: fields.pinned ?? [sid('a')], archivedSessionIds: [], phase: fields.workspacesLoaded === true ? 'ready' : 'pending' }),
    useSnoozed: source(shelved([[sid('z'), NOW - 5_000]])),
    useSettled: source(shelved([[sid('d'), NOW - 5_000]])),
    useWoke: source(shelved(fields.woke ?? [])),
    useKept: source(shelved([[sid('s'), NOW - 2_000]])),
    useAutoSettleDays: source(fields.autoSettleDays ?? 0),
    useSnoozedUntil: source(shelved(fields.snoozedUntil ?? [[sid('z'), NOW + 7_200_000]])),
    useChatStatesReady: source(states !== null),
    useMenuTarget: source(fields.menuTarget ?? null),
    useSettings: source({ ...DEFAULT_SIDEBAR_SETTINGS, ...fields.settings }),
    states: () => states,
    pin: calls.pin,
    unpin: calls.unpin,
    setWorkspaceIcon: calls.setWorkspaceIcon,
    pruneIcons: calls.pruneIcons,
    attach: (owner: { current: unknown }) => { calls.attach(owner.current); return calls.detach },
    preference: { read: (key: string) => stored.get(key) ?? null, write: (key: string, value: string) => { stored.set(key, value) } },
    undoLine,
    updateNotice: { notice: { getSnapshot: () => fields.update ?? null, subscribe: () => () => {} }, notes: async () => null, open: null, canOpen: { getSnapshot: () => false, subscribe: () => () => {} }, dismiss: null },
    t: makeTranslate(en),
  } as SidebarProps
  // The foot's undo notice offers what the list remembers, as in the studio.
  const sidebar = <Sidebar {...props} />
  const view = render(<>{fields.drawer === true ? <Drawer>{sidebar}</Drawer> : sidebar}<UndoNotice wide undoLine={undoLine} t={makeTranslate(en)} /></>)
  return { ...view, calls, stored, states, undoLine }
}

const row = (container: HTMLElement, id: string): HTMLElement => {
  const found = container.querySelector<HTMLElement>(`[data-sidebar-row="${id}"]`)
  if (found === null) throw new Error(`no row ${id}`)
  return found
}
const shown = (container: HTMLElement): string[] => [...container.querySelectorAll('[data-sidebar-row]')].map(each => each.getAttribute('data-sidebar-row') ?? '')
const shelf = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}\\s*\\d+$`) })

describe('the chat list', () => {
  it('shows Pinned, then the cards, then the Working shelf open and the Snoozed and Settled shelves folded', () => {
    const { container } = show()
    expect(shown(container)).toEqual(['a', 'b', 's', 'w'])
    // As in T3 Code, nothing marks the end of Pinned until a drag.
    expect(container.querySelector('[class*="boundary"]')).toBeNull()
    expect(shelf('Snoozed').getAttribute('aria-expanded')).toBe('false')
    expect(within(row(container, 'b')).getAllByText(en['status.approval']).length).toBeGreaterThan(0)
  })

  it('pins the Working shelf below the scrolling list, last for the keyboard, the screen reader and the Alt jump', () => {
    const { container } = show({ stored: { 'shelf.settled': 'open', 'shelf.snoozed': 'open' } })
    const order = [...container.querySelectorAll('[data-sidebar-row], button[aria-expanded]')]
      .map(each => each.getAttribute('data-sidebar-row') ?? `shelf:${each.textContent?.replace(/\d+$/, '') ?? ''}`)
    expect(order.indexOf('w')).toBe(order.indexOf('shelf:Working') + 1)
    expect(container.querySelector('[data-testid="sidebar-working"]')?.closest('[class*="scroll"]')).toBeNull()
    expect(order.indexOf('d')).toBeLessThan(order.indexOf('shelf:Working'))
    expect(order.indexOf('shelf:Settled')).toBeLessThan(order.indexOf('shelf:Working'))
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('shelf:Settled'))
  })

  it('shows the update notice below the list, outside the region that scrolls, and nothing without one', () => {
    const { container } = show()
    expect(container.querySelector('[data-update-notice]')).toBeNull()
    cleanup()
    const update: UpdateNotice = {
      running: { delorun: '0.1.2', dsh: '0.2.2' } as UpdateNotice['running'],
      release: { delorun: '0.1.3', dsh: '0.2.2', channel: 'stable', security: false } as UpdateNotice['release'],
      kind: 'patch', disables: 0,
    }
    const withNotice = show({ update })
    const notice = withNotice.container.querySelector<HTMLElement>('[data-update-notice="0.1.3"]')
    expect(notice?.textContent).toContain('Delorun 0.1.3 is available')
    // The notice is a sibling after the region that holds the list, so it never covers or moves a row.
    const siblings = [...notice?.parentElement?.children ?? []]
    const region = siblings.find(each => each.querySelector('[data-sidebar-row="a"]') !== null)
    expect(region).toBeDefined()
    expect(siblings.indexOf(notice as Element)).toBeGreaterThan(siblings.indexOf(region as Element))
  })

  it('unfolds a shelf, keeps the choice, and shows a snoozed chat\'s time left', () => {
    const { container, stored } = show()
    fireEvent.click(shelf('Snoozed'))
    expect(shown(container)).toContain('z')
    expect(within(row(container, 'z')).getByText('2h')).toBeTruthy()
    expect(stored.get('shelf.snoozed')).toBe('open')
    fireEvent.click(shelf('Snoozed'))
    expect(stored.get('shelf.snoozed')).toBe('folded')
    cleanup()
    const again = show({ stored: { 'shelf.settled': 'open', 'shelf.working': 'folded' } })
    expect(shown(again.container)).toEqual(['a', 'b', 's', 'd'])
  })

  it('shows ten settled chats, then twenty-five more for each Show more', () => {
    const many = Array.from({ length: 40 }, (_, index) => summary(`old-${String(index)}`, { updatedAt: NOW - 100_000 - index }))
    const { container } = show({
      list: listOf(...many), stored: { 'shelf.settled': 'open' }, pinned: [],
    })
    // Every old chat is settled through the auto-settle days.
    cleanup()
    const settledByDays = show({ list: listOf(...many), stored: { 'shelf.settled': 'open' }, autoSettleDays: 1, pinned: [], settings: { workingShelf: true } })
    void container
    expect(shown(settledByDays.container)).toHaveLength(40)
  })

  it('settles a chat from its card, and Undo returns it', () => {
    const { container, states } = show()
    fireEvent.click(within(row(container, 's')).getByRole('button', { name: en['action.settleChat'] }))
    expect(states?.settle).toHaveBeenCalledWith(sid('s'))
    expect(screen.getByRole('status').textContent).toBe(`${en['undo.settle']}${en.undo}`)
    fireEvent.click(screen.getByRole('button', { name: en.undo }))
    expect(states?.unsettle).toHaveBeenCalledWith(sid('s'))
    expect(screen.queryByRole('button', { name: en.undo })).toBeNull()
  })

  it('offers Undo for returning a settled chat, snoozing one, and waking one, and takes each back', () => {
    const { container, states } = show({ stored: { 'shelf.settled': 'open', 'shelf.snoozed': 'open' }, woke: [] })
    fireEvent.click(within(row(container, 'd')).getByRole('button', { name: en['action.unsettle'] }))
    fireEvent.click(screen.getByRole('button', { name: en.undo }))
    expect(states?.settle).toHaveBeenCalledWith(sid('d'))
    fireEvent.click(within(row(container, 's')).getByRole('button', { name: en['action.snooze'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: /In 1 hour/ }))
    expect(states?.snooze).toHaveBeenCalledWith(sid('s'), expect.any(Number))
    fireEvent.click(screen.getByRole('button', { name: en.undo }))
    expect(states?.wake).toHaveBeenCalledWith(sid('s'))
  })

  it('unpins with Undo, and opens a chat on a click or Enter', () => {
    const { container, calls } = show()
    fireEvent.click(within(row(container, 'a')).getByRole('button', { name: en['action.unpin'] }))
    expect(calls.unpin).toHaveBeenCalledWith(sid('a'))
    fireEvent.click(screen.getByRole('button', { name: en.undo }))
    expect(calls.pin).toHaveBeenCalledWith(sid('a'))
    fireEvent.click(row(container, 's'))
    fireEvent.keyDown(row(container, 'b'), { key: 'Enter' })
    expect(calls.open.mock.calls).toEqual([[sid('s')], [sid('b')]])
    fireEvent.keyDown(row(container, 'b'), { key: 'F2' })
    expect(calls.renameSession).toHaveBeenCalledWith(sid('b'), 'Needs approval')
  })

  it('lets the undo offer lapse after six seconds, unless a newer change replaced it', () => {
    vi.useFakeTimers()
    const { container, undoLine } = show()
    fireEvent.click(within(row(container, 'a')).getByRole('button', { name: en['action.unpin'] }))
    expect(undoLine.getSnapshot()).not.toBeNull()
    act(() => { vi.advanceTimersByTime(6_000) })
    expect(undoLine.getSnapshot()).toBeNull()
    act(() => { undoLine.set({ kind: 'pin', key: 1, undo: () => {} }) })
    const first = undoLine.getSnapshot()
    act(() => { undoLine.set({ kind: 'pin', key: 2, undo: () => {} }) })
    act(() => { vi.advanceTimersByTime(5_999) })
    expect(undoLine.getSnapshot()).not.toBe(first)
    expect(undoLine.getSnapshot()).not.toBeNull()
  })

  it('puts chats idle for the auto-settle days on Settled, counting from a return to the list', () => {
    const DAY = 86_400_000
    const old = (id: string, updatedAt: number) => summary(id, { displayTitle: id, updatedAt })
    const list = listOf(old('idle', NOW - 4 * DAY), old('fresh', NOW - DAY), old('s', NOW - 4 * DAY))
    const { container } = show({ list, autoSettleDays: 3, stored: { 'shelf.settled': 'open' } })
    expect(shown(container)).toEqual(['fresh', 's', 'idle'])
    expect(screen.getByText(en['shelf.settled'])).toBeTruthy()
  })

  it('asks before unpinning when the setting says so, and unpins only on Unpin', () => {
    const { container, calls } = show({ settings: { confirmUnpin: true } })
    const unpin = () => { fireEvent.click(within(row(container, 'a')).getByRole('button', { name: en['action.unpin'] })) }
    unpin()
    expect(screen.getByText(en['unpin.confirm.title'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['unpin.confirm.cancel'] }))
    expect(calls.unpin).not.toHaveBeenCalled()
    unpin()
    fireEvent.click(screen.getByRole('button', { name: en['unpin.confirm.action'] }))
    expect(calls.unpin).toHaveBeenCalledWith(sid('a'))
  })

  it('offers no snoozing or settling without Delorun\'s chat states', () => {
    const { container } = show({ states: null })
    expect(within(row(container, 's')).queryByRole('button', { name: en['action.settleChat'] })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Snoozed\s*\d+$/ })).toBeNull()
  })

  it('keeps working chats among the cards with the Working shelf off', () => {
    const { container } = show({ settings: { workingShelf: false } })
    expect(shown(container)).toEqual(['a', 'b', 'w', 's'])
    expect(screen.queryByRole('button', { name: /^Working\s*\d+$/ })).toBeNull()
  })

  it('sorts the cards by creation when the setting says so', () => {
    const list = listOf(summary('old', { createdAt: 1, updatedAt: NOW }), summary('new', { createdAt: 9, updatedAt: NOW - 5 }))
    const { container } = show({ list, pinned: [], settings: { sort: 'created' } })
    expect(shown(container)).toEqual(['new', 'old'])
  })

  it('starts a chat in the one workspace the filter names', () => {
    const { calls } = show({ stored: { scope: 'w-site' } })
    fireEvent.click(screen.getByRole('button', { name: en['chat.newIn'].replace('{name}', 'site') }))
    expect(calls.startSession).toHaveBeenCalledWith('w-site')
  })

  it('starts a chat with no workspace named, and adds a workspace, when the browser offers it', () => {
    const { calls } = show()
    fireEvent.click(screen.getByRole('button', { name: en['chat.new'] }))
    expect(calls.startSession).toHaveBeenCalledWith(undefined)
    fireEvent.click(screen.getByRole('button', { name: en['workspace.add'] }))
    expect(calls.addWorkspace).toHaveBeenCalledOnce()
    cleanup()
    show({ canAddWorkspace: false })
    expect(screen.queryByRole('button', { name: en['workspace.add'] })).toBeNull()
  })

  it('shows placeholder rows, not an empty message, until the Workspace list has loaded', () => {
    show({ list: listOf() })
    expect(screen.getByTestId('sidebar-skeleton').children).toHaveLength(6)
    expect(screen.queryByText(en['empty.none'])).toBeNull()
  })

  it('says what is missing when the list is empty', () => {
    const none = listOf()
    show({ list: none, workspaces: [], workspacesLoaded: true })
    expect(screen.getByText(en['empty.noWorkspaces'])).toBeTruthy()
    cleanup()
    show({ list: none, workspacesLoaded: true })
    expect(screen.getByText(en['empty.none'])).toBeTruthy()
    cleanup()
    show({ list: none, stored: { scope: 'w-site' }, workspacesLoaded: true })
    expect(screen.getByText(en['empty.scoped'].replace('{name}', 'site'))).toBeTruthy()
    cleanup()
    show({ list: none, stored: { scope: 'w-site\nw-api' }, workspacesLoaded: true })
    expect(screen.getByText(en['empty.scopedMany'])).toBeTruthy()
  })

  it('marks the open chat, and lights the row whose menu is open', () => {
    const open = listOf(summary('a', { retainedBy: { mainView: 1 } }), summary('b'))
    const { container } = show({ list: open, pinned: [], menuTarget: { kind: 'session', value: { sessionId: sid('b'), displayTitle: 'b' } } as ContextMenuTarget })
    expect(row(container, 'a').getAttribute('aria-current')).toBe('page')
    expect(row(container, 'b').getAttribute('data-menu-open')).toBe('true')
    cleanup()
    const other = show({ list: open, pinned: [], menuTarget: { kind: 'workspace', value: { workspaceId: wid('w-api'), path: '/', displayTitle: 'api' } } as ContextMenuTarget })
    expect(row(other.container, 'b').getAttribute('data-menu-open')).toBe('false')
  })

  it('marks a woken chat as seen when it opens', () => {
    const open = listOf(summary('a', { retainedBy: { mainView: 1 } }), summary('b'))
    const { states } = show({ list: open, pinned: [], woke: [[sid('a'), NOW]] })
    expect(states?.seen).toHaveBeenCalledWith(sid('a'))
  })

  it('leaves a chat without a workspace under no workspace', () => {
    const { container } = show({ list: listOf(summary('x', { displayTitle: 'Loose' })), workspaces: [api], pinned: [] })
    expect(within(row(container, 'x')).getByText(en['row.noWorkspace'])).toBeTruthy()
  })
})

describe('a chat\'s menu', () => {
  it('opens the Session menu from the "..." button, from a right-click and from the menu key', () => {
    const { container, calls } = show()
    const card = row(container, 's')
    card.getBoundingClientRect = () => ({ left: 8, bottom: 90, right: 200, top: 40, width: 192, height: 50, x: 8, y: 40, toJSON: () => ({}) })
    fireEvent.click(within(card).getByRole('button', { name: en['action.more'].replace('{name}', 'Site chat') }))
    expect(calls.openSessionMenu).toHaveBeenLastCalledWith(sid('s'), 'Site chat', { x: 0, y: 0 }, 'toggle')
    fireEvent.contextMenu(card, { clientX: 31, clientY: 42 })
    expect(calls.openSessionMenu).toHaveBeenLastCalledWith(sid('s'), 'Site chat', { x: 31, y: 42 })
    fireEvent.keyDown(card, { key: 'ContextMenu' })
    expect(calls.openSessionMenu).toHaveBeenLastCalledWith(sid('s'), 'Site chat', { x: 24, y: 90 })
    fireEvent.keyDown(card, { key: 'F10', shiftKey: true })
    expect(calls.openSessionMenu).toHaveBeenCalledTimes(4)
    fireEvent.keyDown(card, { key: 'F10' })
    expect(calls.openSessionMenu).toHaveBeenCalledTimes(4)
  })

  it('renames on a double-click or F2 from the row, but not from a button inside it or with a modifier held', () => {
    const { container, calls } = show()
    const card = row(container, 's')
    fireEvent.doubleClick(card)
    expect(calls.renameSession).toHaveBeenCalledWith(sid('s'), 'Site chat')
    fireEvent.doubleClick(card, { altKey: true })
    fireEvent.doubleClick(within(card).getByRole('button', { name: en['action.settleChat'] }))
    fireEvent.keyDown(within(card).getByRole('button', { name: en['action.settleChat'] }), { key: 'F2' })
    expect(calls.renameSession).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(card, { key: ' ' })
    fireEvent.keyDown(card, { key: 'x' })
    expect(calls.open).toHaveBeenCalledTimes(1)
  })

  it('snoozes with Custom…', () => {
    const { container, states } = show()
    fireEvent.click(within(row(container, 's')).getByRole('button', { name: en['action.snooze'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: en['action.custom'] }))
    expect(states?.openCustom).toHaveBeenCalledWith(sid('s'))
    expect(states?.snooze).not.toHaveBeenCalled()
  })

  it('offers no snooze on a working card', () => {
    const { container } = show({ settings: { workingShelf: false } })
    expect(within(row(container, 'w')).queryByRole('button', { name: en['action.snooze'] })).toBeNull()
  })
})

describe('what a row says', () => {
  const only = (chat: SessionSummary, fields: Parameters<typeof show>[0] = {}) => show({ list: listOf(chat), pinned: [], ...fields })

  it('names what a chat waits on, in its label and its status', () => {
    for (const [kind, key] of [['approval', 'status.approval'], ['question', 'status.question'], ['plan-review', 'status.plan']] as const) {
      const { container } = only(summary('x', { displayTitle: 'T' }), { statuses: new Map([[sid('x'), facts({ pendingInteraction: { kind } })]]) })
      expect(row(container, 'x').getAttribute('aria-label')).toBe(`T, ${en[key]}`)
      cleanup()
    }
  })

  it('shows a finished unread run as Done, and a woken chat as Woke with a way to dismiss it', () => {
    const done = only(summary('x'), { statuses: new Map([[sid('x'), facts({ completionUnread: true })]]) })
    expect(within(row(done.container, 'x')).getByText(en['status.done'])).toBeTruthy()
    cleanup()
    const woke = only(summary('x'), { woke: [[sid('x'), NOW]] })
    fireEvent.click(within(row(woke.container, 'x')).getByRole('button', { name: en['action.dismissWoke'] }))
    expect(woke.states?.seen).toHaveBeenCalledWith(sid('x'))
    fireEvent.click(row(woke.container, 'x'))
    expect(woke.states?.seen).toHaveBeenCalledTimes(2)
    cleanup()
    const plain = only(summary('x'), { woke: [[sid('x'), NOW]], states: null })
    expect(within(row(plain.container, 'x')).queryByRole('button', { name: en['action.dismissWoke'] })).toBeNull()
    cleanup()
    const quiet = only(summary('x', { updatedAt: NOW - 3 * 3_600_000 }))
    expect(within(row(quiet.container, 'x')).getByText('3h')).toBeTruthy()
  })

  it('times a run in seconds, minutes, and hours with minutes, and ticks each second', () => {
    vi.useFakeTimers({ now: NOW })
    const running = (since: number) => only(summary('x', { running: true, ...promptedAt(since) }), { settings: { workingShelf: false } })
    const { container } = running(NOW - 5_000)
    expect(within(row(container, 'x')).getByText('5s')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(within(row(container, 'x')).getByText('7s')).toBeTruthy()
    cleanup()
    expect(within(row(running(NOW - 150_000).container, 'x')).getByText('2m')).toBeTruthy()
    cleanup()
    expect(within(row(running(NOW - 3_900_000).container, 'x')).getByText('1h 5m')).toBeTruthy()
    cleanup()
    const noStart = only(summary('x', { running: true }), { settings: { workingShelf: false } })
    expect(within(row(noStart.container, 'x')).getByText(en['status.working'])).toBeTruthy()
  })

  it('moves the ages on once a minute', () => {
    vi.useFakeTimers({ now: NOW })
    const { container } = only(summary('x', { updatedAt: NOW - 59 * 60_000 }))
    expect(within(row(container, 'x')).getByText('59m')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(within(row(container, 'x')).getByText('1h')).toBeTruthy()
  })
})

describe('the shelves of slim rows', () => {
  it('lets a snoozed chat wake and a settled one return, and shows the rest of the settled shelf on Show more', () => {
    const { container, states } = show({ stored: { 'shelf.snoozed': 'open', 'shelf.settled': 'open' } })
    fireEvent.click(within(row(container, 'z')).getByRole('button', { name: en['action.wake'] }))
    expect(states?.wake).toHaveBeenCalledWith(sid('z'))
    expect(screen.getByRole('status').textContent).toBe(`${en['undo.wake']}${en.undo}`)
    fireEvent.click(within(row(container, 'd')).getByRole('button', { name: en['action.unsettle'] }))
    expect(states?.unsettle).toHaveBeenCalledWith(sid('d'))
  })

  it('draws the workspace\'s badge on a slim row of a chat in a workspace', () => {
    const { container } = show({ workspaces: [{ ...api, sessionIds: [...api.sessionIds, sid('d')] }, site], stored: { 'shelf.settled': 'open' } })
    expect(within(row(container, 'd')).getByText('AP', { selector: 'text' })).toBeTruthy()
  })

  it('shows ten settled chats, then twenty-five more with each Show more', () => {
    const DAY = 86_400_000
    const many = Array.from({ length: 40 }, (_, index) => summary(`old-${String(index)}`, { updatedAt: NOW - 5 * DAY - index }))
    const { container } = show({ list: listOf(...many), pinned: [], autoSettleDays: 3, stored: { 'shelf.settled': 'open' } })
    expect(shown(container)).toHaveLength(10)
    fireEvent.click(screen.getByRole('button', { name: en['shelf.more'].replace('{n}', '25') }))
    expect(shown(container)).toHaveLength(35)
    fireEvent.click(screen.getByRole('button', { name: en['shelf.more'].replace('{n}', '5') }))
    expect(shown(container)).toHaveLength(40)
    expect(screen.queryByRole('button', { name: /Show/ })).toBeNull()
  })

  it('shows a snoozed chat whose end is not known like any slim row, with its age', () => {
    const { container } = show({ stored: { 'shelf.snoozed': 'open' }, snoozedUntil: [] })
    expect(within(row(container, 'z')).queryByText('2h')).toBeNull()
    expect(within(row(container, 'z')).getByText('now')).toBeTruthy()
  })

  it('shows a chat on a shelf without chat states\' actions as a plain slim row', () => {
    const { container } = show({ stored: { 'shelf.settled': 'open' }, states: null, settings: { view: 'folders' } })
    expect(within(row(container, 'a')).queryByRole('button', { name: en['action.settleChat'] })).toBeNull()
  })
})

describe('the workspace filter', () => {
  const open = () => { fireEvent.click(screen.getByRole('button', { name: en.filter })) }

  it('keeps one or more workspaces, remembers them, and clears with All workspaces', () => {
    const { container, stored } = show()
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: 'site' }))
    expect(shown(container)).toEqual(['s'])
    expect(stored.get('scope')).toBe('w-site')
    fireEvent.click(screen.getByRole('menuitem', { name: 'api' }))
    expect(stored.get('scope')).toBe('w-site\nw-api')
    fireEvent.click(screen.getByRole('menuitem', { name: 'site' }))
    expect(stored.get('scope')).toBe('w-api')
    expect(screen.getByRole('button', { name: en['filter.active'].replace('{names}', 'api') })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: en['filter.all'] }))
    expect(stored.get('scope')).toBe('')
    expect(shown(container)).toEqual(['a', 'b', 's', 'w'])
  })

  it('ignores a stored filter that names a workspace since removed', () => {
    const { container } = show({ stored: { scope: 'gone' } })
    expect(shown(container)).toEqual(['a', 'b', 's', 'w'])
  })

  it('renames and removes a workspace through the browser\'s dialogs', () => {
    const { calls } = show()
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: en['filter.rename'] }))
    fireEvent.click(screen.getAllByRole('menuitem', { name: 'site' }).at(-1) as HTMLElement)
    expect(calls.renameWorkspace).toHaveBeenCalledWith('w-site')
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: en['filter.delete'] }))
    fireEvent.click(screen.getAllByRole('menuitem', { name: 'api' }).at(-1) as HTMLElement)
    expect(calls.deleteWorkspace).toHaveBeenCalledWith('w-api')
  })

  it('has no filter without a workspace', () => {
    show({ workspaces: [] })
    expect(screen.queryByRole('button', { name: en.filter })).toBeNull()
  })

  it('changes a workspace\'s icon through the picker, saves it, and resets it to the monogram', () => {
    const { calls } = show()
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: en['filter.icon'] }))
    fireEvent.click(screen.getAllByRole('menuitem', { name: 'api' }).at(-1) as HTMLElement)
    expect(screen.getByText(en['icon.title'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['icon.save'] }))
    expect(calls.setWorkspaceIcon).toHaveBeenCalledWith('w-api', DEFAULT_WORKSPACE_ICON)
    expect(screen.queryByText(en['icon.title'])).toBeNull()
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: en['filter.icon'] }))
    fireEvent.click(screen.getAllByRole('menuitem', { name: 'api' }).at(-1) as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: en['icon.reset'] }))
    expect(calls.setWorkspaceIcon).toHaveBeenLastCalledWith('w-api', null)
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: en['filter.icon'] }))
    fireEvent.click(screen.getAllByRole('menuitem', { name: 'site' }).at(-1) as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: en['icon.cancel'] }))
    expect(screen.queryByText(en['icon.title'])).toBeNull()
  })

  it('draws a stored icon on every badge, and the monogram where the stored icon is malformed', () => {
    const { container } = show({
      settings: { workspaceIcons: { 'w-api': { kind: 'letters', letters: 'zq' }, 'w-site': { kind: 'glyph', glyph: 'rocket' } } },
    })
    expect(within(row(container, 'a')).getByText('ZQ', { selector: 'text' })).toBeTruthy()
    expect(within(row(container, 's')).getByText('SI', { selector: 'text' })).toBeTruthy()
  })

  it('loads with a stored markup entry, shows that workspace\'s default icon and renders no markup', () => {
    const { container } = show({ settings: { workspaceIcons: { 'w-api': '<img src=x onerror=alert(1)>', 'w-site': { kind: 'letters', letters: 'zq' } } } })
    expect(within(row(container, 'a')).getByText('AP', { selector: 'text' })).toBeTruthy()
    expect(within(row(container, 's')).getByText('ZQ', { selector: 'text' })).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
  })
})

describe('the search', () => {
  it('finds chats by title and by their messages, and opens the highlighted one on Enter', async () => {
    const { calls } = show()
    calls.searchSessions.mockResolvedValue({ items: [{ sessionId: sid('d'), snippet: 'the settled reply' }, { sessionId: sid('gone'), snippet: 'x' }, { sessionId: sid('s'), snippet: 'again' }], hasMore: false } as Awaited<ReturnType<SidebarProps['searchSessions']>>)
    const field = screen.getByRole('combobox', { name: en['search.aria'] })
    fireEvent.change(field, { target: { value: 'chat' } })
    expect(screen.getAllByRole('option').some(option => option.textContent?.endsWith('Site chat'))).toBe(true)
    fireEvent.change(field, { target: { value: 'Site' } })
    expect(await screen.findByText('the settled reply')).toBeTruthy()
    expect(screen.queryByText('again')).toBeNull()
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(calls.open).toHaveBeenCalledWith(sid('d'))
    expect((field as HTMLInputElement).value).toBe('')
  })

  it('moves the highlight with the arrow keys, and opens a result on a click', async () => {
    const { calls } = show()
    const field = screen.getByRole('combobox', { name: en['search.aria'] })
    fireEvent.change(field, { target: { value: 'chat' } })
    const options = screen.getAllByRole('option')
    expect(options.length).toBeGreaterThan(2)
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[1]?.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(field, { key: 'ArrowUp' })
    fireEvent.keyDown(field, { key: 'ArrowUp' })
    expect(screen.getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true')
    for (let step = 0; step < options.length + 1; step++) fireEvent.keyDown(field, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option').at(-1)?.getAttribute('aria-selected')).toBe('true')
    fireEvent.mouseMove(screen.getAllByRole('option')[0] as HTMLElement)
    expect(screen.getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getAllByRole('option')[0] as HTMLElement)
    expect(calls.open).toHaveBeenCalledOnce()
  })

  it('does nothing on Enter or the arrows with no result, and not while composing', async () => {
    const { calls } = show()
    const field = screen.getByRole('combobox', { name: en['search.aria'] })
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.change(field, { target: { value: 'zzzz' } })
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    fireEvent.keyDown(field, { key: 'ArrowUp' })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(calls.open).not.toHaveBeenCalled()
    fireEvent.keyDown(field, { key: 'Escape', isComposing: true })
    expect((field as HTMLInputElement).value).toBe('zzzz')
    await screen.findByText(en['search.empty'], undefined, { timeout: 2_000 })
  })

  it('says it is searching messages, then that nothing matches, and clears on Escape', async () => {
    const { calls } = show()
    let finish: (value: Awaited<ReturnType<SidebarProps['searchSessions']>>) => void = () => {}
    calls.searchSessions.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const field = screen.getByRole('combobox', { name: en['search.aria'] })
    fireEvent.change(field, { target: { value: 'nothing here' } })
    expect(screen.getByText(en['search.searching'])).toBeTruthy()
    await waitFor(() => { expect(calls.searchSessions).toHaveBeenCalled() })
    await act(async () => { finish({ items: [], hasMore: false }) })
    expect(await screen.findByText(en['search.empty'])).toBeTruthy()
    fireEvent.keyDown(field, { key: 'Escape' })
    expect((field as HTMLInputElement).value).toBe('')
  })

  it('says when the messages could not be searched, and ignores a search the query has left behind', async () => {
    const { calls } = show()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    calls.searchSessions.mockRejectedValue(new Error('down'))
    const field = screen.getByRole('combobox', { name: en['search.aria'] })
    fireEvent.change(field, { target: { value: 'nothing here' } })
    expect(await screen.findByText(en['search.failed'])).toBeTruthy()
    const settleLater: Array<{ resolve: (value: Awaited<ReturnType<SidebarProps['searchSessions']>>) => void; reject: (reason: unknown) => void }> = []
    calls.searchSessions.mockImplementation(() => new Promise((resolve, reject) => { settleLater.push({ resolve, reject }) }))
    for (const [index, query] of ['another one', 'third one', 'fourth one'].entries()) {
      fireEvent.change(field, { target: { value: query } })
      await waitFor(() => { expect(settleLater).toHaveLength(index + 1) })
    }
    await act(async () => { settleLater[0]?.resolve({ items: [{ sessionId: sid('d'), snippet: 'stale' }], hasMore: false } as Awaited<ReturnType<SidebarProps['searchSessions']>>) })
    await act(async () => { settleLater[1]?.reject(new Error('stale failure')) })
    expect(screen.queryByText('stale')).toBeNull()
    expect(screen.queryByText(en['search.failed'])).toBeNull()
    await act(async () => { settleLater[2]?.resolve({ items: [], hasMore: false }) })
    expect(await screen.findByText(en['search.empty'])).toBeTruthy()
  })

  it('clears a query on Escape and keeps the keyboard in the field, and leaves Escape to the page with nothing to clear', () => {
    show()
    const field = screen.getByRole('combobox', { name: en['search.aria'] })
    field.focus()
    fireEvent.change(field, { target: { value: 'chat' } })
    expect(fireEvent.keyDown(field, { key: 'Escape' })).toBe(false)
    expect([(field as HTMLInputElement).value, document.activeElement]).toEqual(['', field])
    expect(fireEvent.keyDown(field, { key: 'Escape' })).toBe(true)
    expect(document.activeElement).toBe(field)
  })

  it('lets Escape in the empty field close the phone-width drawer, which returns focus to the control that opened it', () => {
    show({ drawer: true })
    const opener = screen.getByRole('button', { name: 'Open the list' })
    opener.focus()
    fireEvent.click(opener)
    const field = screen.getByRole('combobox', { name: en['search.aria'] })
    field.focus()
    fireEvent.change(field, { target: { value: 'chat' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: 'Chats' }).hidden).toBe(false)
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.getByRole('dialog', { hidden: true }).hidden).toBe(true)
    expect(document.activeElement).toBe(opener)
  })

  it('clears with its button, and takes focus when a search is requested', () => {
    const shortcut: NonNullable<SidebarProps['searchShortcut']> = {
      id: 'session.search' as NonNullable<SidebarProps['searchShortcut']>['id'], label: 'Search', aliases: [], keys: ['Mod', 'K'], aria: undefined, binding: null, modified: false, conflicts: [], issue: null,
    }
    const { rerender } = show({ searchRequest: 1, searchShortcut: shortcut })
    const field = screen.getByRole('combobox', { name: en['search.aria'] })
    expect(document.activeElement).toBe(field)
    fireEvent.change(field, { target: { value: 'chat' } })
    fireEvent.click(screen.getByRole('button', { name: en['search.clear'] }))
    expect((field as HTMLInputElement).value).toBe('')
    void rerender
  })
})

describe('the folders view', () => {
  it('shows a folder per workspace with its chats, folds one with a dot for what waits inside, and starts a chat in it', () => {
    const { container, calls, stored } = show({ settings: { view: 'folders' } })
    expect(shown(container)).toEqual(['a', 'b', 'w', 's'])
    const folder = screen.getByRole('button', { name: /^api/ })
    fireEvent.click(folder)
    expect(stored.get('folder.w-api')).toBe('folded')
    expect(shown(container)).toEqual(['s'])
    expect(screen.getByRole('img', { name: en['folder.waiting'] })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['chat.newIn'].replace('{name}', 'site') }))
    expect(calls.startSession).toHaveBeenCalledWith('w-site')
    fireEvent.click(folder)
    expect(stored.get('folder.w-api')).toBe('open')
  })

  it('keeps chats outside every workspace in a last folder, and a folded one open from the stored choice', () => {
    const list = listOf(summary('loose', { displayTitle: 'Loose' }), summary('s', { displayTitle: 'Site chat' }))
    const { container, calls } = show({ list, settings: { view: 'folders' }, stored: { 'folder.w-api': 'folded' }, pinned: [sid('loose')] })
    expect(shown(container)).toEqual(['s', 'loose'])
    expect(screen.getByRole('button', { name: new RegExp(`^${en['folder.loose']}`) })).toBeTruthy()
    expect(screen.queryByRole('button', { name: en['chat.newIn'].replace('{name}', en['folder.loose']) })).toBeNull()
    expect(calls.startSession).not.toHaveBeenCalled()
  })

  it('shows the dots for a working and a finished folder, and none for a quiet one', () => {
    const list = listOf(summary('w', { running: true }), summary('s'))
    show({
      list, settings: { view: 'folders' }, pinned: [], stored: { 'folder.w-api': 'folded', 'folder.w-site': 'folded' },
      statuses: new Map([[sid('s'), facts({ completionUnread: true })]]),
    })
    expect(screen.getByRole('img', { name: en['folder.working'] })).toBeTruthy()
    expect(screen.getByRole('img', { name: en['folder.done'] })).toBeTruthy()
    cleanup()
    show({ list: listOf(summary('q')), settings: { view: 'folders' }, pinned: [], stored: { 'folder.w-api': 'folded' } })
    expect(screen.queryByRole('img')).toBeNull()
  })
})

describe('the Alt jump', () => {
  const key = (init: KeyboardEventInit) => { act(() => { window.dispatchEvent(new KeyboardEvent('keydown', init)) }) }

  it('shows a digit on each visible chat while Alt is held, and opens the chat Alt and its digit name', () => {
    const { container, calls } = show()
    key({ key: 'Alt', altKey: true })
    expect([...container.querySelectorAll('kbd')].map(each => each.textContent)).toEqual(['1', '2', '3', '4'])
    key({ key: '™', code: 'Digit2', altKey: true })
    expect(calls.open).toHaveBeenCalledWith(sid('b'))
    expect(container.querySelectorAll('kbd')).toHaveLength(0)
    key({ key: '9', code: 'Digit9', altKey: true })
    key({ key: '1', code: 'Digit1', altKey: true, ctrlKey: true })
    expect(calls.open).toHaveBeenCalledTimes(1)
    key({ key: 'Alt', altKey: true })
    act(() => { window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' })) })
    expect(container.querySelectorAll('kbd')).toHaveLength(0)
    key({ key: 'Alt', altKey: true })
    act(() => { window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' })) })
    expect(container.querySelectorAll('kbd')).toHaveLength(4)
    act(() => { window.dispatchEvent(new Event('blur')) })
    expect(container.querySelectorAll('kbd')).toHaveLength(0)
  })

  it('does not jump, or show digits, while a text field or an editable region has the keys', () => {
    const { calls } = show()
    const field = document.createElement('input')
    const region = document.createElement('div')
    region.setAttribute('contenteditable', 'true')
    const inert = document.createElement('div')
    inert.setAttribute('contenteditable', 'false')
    document.body.append(field, region, inert)
    for (const target of [field, region]) {
      act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', altKey: true, bubbles: true })) })
      expect(document.querySelectorAll('kbd')).toHaveLength(0)
      act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: '2', code: 'Digit2', altKey: true, bubbles: true })) })
    }
    expect(calls.open).not.toHaveBeenCalled()
    act(() => { inert.dispatchEvent(new KeyboardEvent('keydown', { key: '2', code: 'Digit2', altKey: true, bubbles: true })) })
    expect(calls.open).toHaveBeenCalledWith(sid('b'))
    field.remove()
    region.remove()
    inert.remove()
  })

  it('numbers the chats of the folders view that are showing', () => {
    const { container } = show({ settings: { view: 'folders' }, stored: { 'folder.w-api': 'folded' } })
    key({ key: 'Alt', altKey: true })
    expect([...container.querySelectorAll('kbd')].map(each => each.textContent)).toEqual(['1'])
  })
})

describe('dragging a chat', () => {
  /** Press a row, move the pointer over another entry of the list, and optionally release there. */
  function drag(container: HTMLElement, from: string, over: string | null, release = true): void {
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => (over === null ? document.body : container.querySelector(`[data-drag-id="${over}"]`)),
    })
    fireEvent.pointerDown(row(container, from), { button: 0, pointerType: 'mouse', clientX: 0, clientY: 0 })
    // The first move starts the drag; the list it draws (an empty shelf to drop on) is under the pointer by the second.
    act(() => { fireEvent.pointerMove(window, { clientX: 0, clientY: 30 }) })
    act(() => { fireEvent.pointerMove(window, { clientX: 0, clientY: 31 }) })
    if (release) act(() => { fireEvent.pointerUp(window) })
  }
  const settledMarker = 'marker:settled-header'
  afterEach(() => { Reflect.deleteProperty(document, 'elementFromPoint') })

  it('pins a card dropped on a pinned chat, names the drop while it is held, keeps the pins\' order, and offers Undo', () => {
    const { container, calls, stored } = show()
    drag(container, 'b', 'a', false)
    expect(within(row(container, 'b')).getByRole('status').textContent).toBe(en['drop.pin'])
    expect(container.querySelector('[data-drag-id="a"]')?.getAttribute('data-over')).toBe('true')
    expect(container.querySelector('[class*="boundaryLabel"]')?.textContent).toBe(en['section.pinned'])
    expect(container.querySelector('[data-dragging="true"][data-target="true"]')).not.toBeNull()
    act(() => { fireEvent.pointerUp(window) })
    expect(calls.pin).toHaveBeenCalledWith(sid('b'))
    expect(stored.get('pinOrder')).toBe('b\na')
    expect(screen.getByRole('status').textContent).toBe(`${en['undo.pin']}${en.undo}`)
    fireEvent.click(screen.getByRole('button', { name: en.undo }))
    expect(calls.unpin).toHaveBeenCalledWith(sid('b'))
    expect(container.querySelector('[class*="boundaryLabel"]')).toBeNull()
  })

  it('keeps a dropped drag from opening the row it was released over', () => {
    const { container, calls } = show()
    drag(container, 'b', 'a')
    fireEvent.click(row(container, 'a'))
    expect(calls.open).not.toHaveBeenCalled()
  })

  it('reorders the pins without changing them, and keeps the order for the next visit', () => {
    const two = listOf(summary('a'), summary('c', { updatedAt: NOW - 500 }))
    const { container, calls, stored } = show({ list: two, pinned: [sid('a'), sid('c')] })
    expect(shown(container)).toEqual(['a', 'c'])
    drag(container, 'c', 'a')
    expect(stored.get('pinOrder')).toBe('c\na')
    expect(calls.pin).not.toHaveBeenCalled()
    expect(calls.unpin).not.toHaveBeenCalled()
    cleanup()
    const again = show({ list: two, pinned: [sid('a'), sid('c')], stored: { pinOrder: 'c\na' } })
    expect(shown(again.container)).toEqual(['c', 'a'])
  })

  it('unpins a pinned card dropped among the cards, asking first when the setting says so', () => {
    const { container, calls } = show()
    drag(container, 'a', 's')
    expect(calls.unpin).toHaveBeenCalledWith(sid('a'))
    expect(screen.getByRole('status').textContent).toBe(`${en['undo.unpin']}${en.undo}`)
    cleanup()
    const asking = show({ settings: { confirmUnpin: true } })
    drag(asking.container, 'a', 's')
    expect(asking.calls.unpin).not.toHaveBeenCalled()
    expect(screen.getByText(en['unpin.confirm.title'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['unpin.confirm.close'] }))
    expect(screen.queryByText(en['unpin.confirm.title'])).toBeNull()
  })

  it('settles a card dropped on the Settled shelf, and a settled row dropped among the cards returns it, each with Undo', () => {
    const { container, states } = show({ stored: { 'shelf.settled': 'open', 'shelf.snoozed': 'open' } })
    drag(container, 's', settledMarker)
    expect(states?.settle).toHaveBeenCalledWith(sid('s'))
    fireEvent.click(screen.getByRole('button', { name: en.undo }))
    expect(states?.unsettle).toHaveBeenCalledWith(sid('s'))
    drag(container, 'd', 's')
    expect(states?.unsettle).toHaveBeenCalledWith(sid('d'))
    fireEvent.click(screen.getByRole('button', { name: en.undo }))
    expect(states?.settle).toHaveBeenCalledWith(sid('d'))
  })

  it('shows an empty Settled shelf to drop on while a card is dragged', () => {
    const noneSettled = listOf(summary('a'), summary('s'))
    const { container, states } = show({ list: noneSettled, pinned: [] })
    expect(screen.queryByRole('button', { name: /^Settled/ })).toBeNull()
    drag(container, 's', settledMarker, false)
    expect(screen.getByRole('button', { name: /^Settled\s*0$/ })).toBeTruthy()
    expect(container.querySelector(`[data-drag-id="${settledMarker}"]`)?.getAttribute('data-over')).toBe('true')
    act(() => { fireEvent.pointerUp(window) })
    expect(states?.settle).toHaveBeenCalledWith(sid('s'))
    expect(screen.queryByRole('button', { name: /^Settled/ })).toBeNull()
  })

  it('wakes a snoozed row dropped among the cards, and Undo snoozes it again until the same time', () => {
    const { container, states } = show({ stored: { 'shelf.snoozed': 'open' } })
    drag(container, 'z', 's')
    expect(states?.wake).toHaveBeenCalledWith(sid('z'))
    fireEvent.click(screen.getByRole('button', { name: en.undo }))
    expect(states?.snooze).toHaveBeenCalledWith(sid('z'), NOW + 7_200_000)
    cleanup()
    const ended = show({ stored: { 'shelf.snoozed': 'open' }, snoozedUntil: [] })
    drag(ended.container, 'z', 's')
    fireEvent.click(screen.getByRole('button', { name: en.undo }))
    expect(ended.states?.snooze).not.toHaveBeenCalled()
    cleanup()
    const past = show({ stored: { 'shelf.snoozed': 'open' }, snoozedUntil: [[sid('z'), NOW - 1_000]] })
    drag(past.container, 'z', 's')
    fireEvent.click(screen.getByRole('button', { name: en.undo }))
    expect(past.states?.snooze).not.toHaveBeenCalled()
  })

  it('does nothing for a drop on the Working or Snoozed shelf, or on nothing', () => {
    const { container, calls, states } = show({ stored: { 'shelf.snoozed': 'open' } })
    drag(container, 's', 'w')
    drag(container, 's', 'marker:snoozed-header')
    drag(container, 's', null)
    expect([calls.pin, calls.unpin, states?.settle, states?.wake].map(fn => (fn as ReturnType<typeof vi.fn>).mock.calls.length)).toEqual([0, 0, 0, 0])
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('drags nothing in the folders view or while searching', () => {
    const { container } = show({ settings: { view: 'folders' } })
    drag(container, 'b', 'a', false)
    expect(container.querySelector('[data-dragging="true"]')).toBeNull()
    act(() => { fireEvent.pointerUp(window) })
    cleanup()
    const searching = show()
    fireEvent.change(screen.getByRole('combobox', { name: en['search.aria'] }), { target: { value: 'chat' } })
    expect(searching.container.querySelector('[data-drag-id]')).toBeNull()
  })

  it('drags a slim row on a shelf, and numbers it for the Alt jump', () => {
    const { container } = show({ stored: { 'shelf.settled': 'open' } })
    drag(container, 'd', 's', false)
    expect(within(row(container, 'd')).getByRole('status').textContent).toBe(en['drop.unsettle'])
    act(() => { fireEvent.pointerUp(window) })
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', altKey: true })) })
    expect(within(row(container, 'd')).getByText('4')).toBeTruthy()
  })
})

describe('the model and details of a chat', () => {
  const selection = (provider: string, model: string): Partial<SessionSummary> => (
    { projectionValues: { modelSelection: { lastUsed: { provider, model } }, agentPreset: 'ptc' } } as Partial<SessionSummary>
  )

  it('marks a chat with DeepSeek\'s whale for a DeepSeek model, by provider or by model name, and an agent glyph for any other', () => {
    const list = listOf(
      summary('p', selection('deepseek', 'v4')), summary('m', selection('other', 'deepseek-chat')), summary('o', selection('other', 'llama')),
    )
    const { container } = show({ list, pinned: [] })
    const mark = (id: string) => row(container, id).querySelector('[title]')?.querySelector('svg')?.getAttribute('data-icon') ?? 'whale'
    expect([mark('p'), mark('m'), mark('o')]).toEqual(['whale', 'whale', 'dsw-icon-agent-preset-outline-regular'])
  })

  /** Hovering needs a screen that can hover, which jsdom does not model. */
  const hoverable = () => { vi.stubGlobal('matchMedia', (query: string) => ({ matches: query !== TOUCH_QUERY, addEventListener: () => {}, removeEventListener: () => {} })) }

  it('opens a card of details on a hover: the workspace and its folder, the model and the mode', () => {
    hoverable()
    vi.useFakeTimers()
    const list = listOf(summary('a', { displayTitle: 'Pinned chat', ...selection('deepseek', 'deepseek-v4') }))
    const { container } = show({ list })
    fireEvent.pointerEnter(row(container, 'a'), { pointerType: 'mouse' })
    act(() => { vi.advanceTimersByTime(700) })
    const card = document.querySelector('[class*="details"]') as HTMLElement
    expect(within(card).getByText('Pinned chat')).toBeTruthy()
    expect(within(card).getByText('/workspace/api')).toBeTruthy()
    expect(within(card).getByText('deepseek-v4')).toBeTruthy()
    expect(within(card).getByText('ptc')).toBeTruthy()
  })

  it('leaves the workspace, model and mode out of the details of a chat that has none', () => {
    hoverable()
    vi.useFakeTimers()
    const { container } = show({ list: listOf(summary('x', { displayTitle: 'Bare' })), pinned: [] })
    fireEvent.pointerEnter(row(container, 'x'), { pointerType: 'mouse' })
    act(() => { vi.advanceTimersByTime(700) })
    const card = document.querySelector('[class*="details"]') as HTMLElement
    expect(card.querySelectorAll('[class*="detailsRow"]')).toHaveLength(0)
  })
})

describe('closing the list\'s menus', () => {
  it('closes the filter and snooze menus on Escape', async () => {
    const { container } = show()
    fireEvent.click(screen.getByRole('button', { name: en.filter }))
    expect(screen.getByRole('menuitem', { name: en['filter.all'] })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('menuitem', { name: en['filter.all'] }), { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('menuitem', { name: en['filter.all'] })).toBeNull() })
    fireEvent.click(within(row(container, 's')).getByRole('button', { name: en['action.snooze'] }))
    expect(screen.getByRole('menuitem', { name: en['action.custom'] })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('menuitem', { name: en['action.custom'] }), { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('menuitem', { name: en['action.custom'] })).toBeNull() })
  })
})

describe('a touch screen', () => {
  /** A screen whose pointer is coarse and cannot hover, with the listeners the page registered for changes. */
  function touchScreen(matches: boolean) {
    const listeners = new Set<() => void>()
    let current = matches
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() { return query === TOUCH_QUERY && current },
      addEventListener: (_: string, listener: () => void) => { listeners.add(listener) },
      removeEventListener: (_: string, listener: () => void) => { listeners.delete(listener) },
    }))
    return { change: (next: boolean) => { current = next; act(() => { for (const listener of [...listeners]) listener() }) }, listeners }
  }

  it('leaves Snooze and Settle to the chat\'s menu and keeps the "..." button, on cards and on shelves', () => {
    touchScreen(true)
    const { container } = show({ settings: { workingShelf: true } })
    for (const id of ['a', 'b', 's']) {
      expect(within(row(container, id)).queryByRole('button', { name: en['action.snooze'] })).toBeNull()
      expect(within(row(container, id)).queryByRole('button', { name: en['action.settleChat'] })).toBeNull()
    }
    expect(within(row(container, 'b')).getByRole('button', { name: en['action.more'].replace('{name}', 'Needs approval') })).toBeTruthy()
    fireEvent.click(shelf(en['shelf.snoozed']))
    fireEvent.click(shelf(en['shelf.settled']))
    expect(within(row(container, 'z')).queryByRole('button', { name: en['action.wake'] })).toBeNull()
    expect(within(row(container, 'd')).queryByRole('button', { name: en['action.unsettle'] })).toBeNull()
    expect(within(row(container, 'z')).getByRole('button', { name: en['action.more'].replace('{name}', 'Snoozed chat') })).toBeTruthy()
  })

  it('shows the buttons again when the screen turns hover-capable, and stops following the query on unmount', () => {
    const screenQuery = touchScreen(true)
    const { container, unmount } = show()
    expect(within(row(container, 'b')).queryByRole('button', { name: en['action.settleChat'] })).toBeNull()
    expect(screenQuery.listeners.size).toBeGreaterThan(0)
    screenQuery.change(false)
    expect(within(row(container, 'b')).getByRole('button', { name: en['action.settleChat'] })).toBeTruthy()
    unmount()
    expect(screenQuery.listeners.size).toBe(0)
  })

  it('shows the buttons where the browser has no media queries', () => {
    vi.stubGlobal('matchMedia', undefined)
    const { container } = show()
    expect(within(row(container, 'b')).getByRole('button', { name: en['action.settleChat'] })).toBeTruthy()
  })
})

describe('the icons of removed workspaces', () => {
  const stored = { 'w-api': { kind: 'letters', letters: 'ap' }, 'w-gone': { kind: 'letters', letters: 'gn' } }

  it('are dropped once the workspace list has loaded, with the workspaces that exist as the live set', () => {
    const { calls } = show({ settings: { workspaceIcons: stored }, workspacesLoaded: true })
    expect(calls.pruneIcons).toHaveBeenCalledOnce()
    expect(calls.pruneIcons).toHaveBeenCalledWith(new Set(['w-api', 'w-site']))
  })

  it('are kept while the workspace list is still loading, which would otherwise drop every icon', () => {
    const { calls } = show({ settings: { workspaceIcons: stored }, workspaces: [], workspacesLoaded: false })
    expect(calls.pruneIcons).not.toHaveBeenCalled()
  })

  it('are left alone when every stored icon belongs to a workspace that exists', () => {
    const { calls } = show({ settings: { workspaceIcons: { 'w-api': stored['w-api'] } }, workspacesLoaded: true })
    expect(calls.pruneIcons).not.toHaveBeenCalled()
  })
})

describe('the add-workspace offer', () => {
  it('is made while the list is mounted with the owner\'s latest props, and withdrawn on unmount', () => {
    const { calls, unmount } = show({ canAddWorkspace: false })
    expect(calls.attach).toHaveBeenCalledOnce()
    expect(calls.attach.mock.calls[0]?.[0]).toMatchObject({ canAddWorkspace: false, addWorkspace: calls.addWorkspace })
    expect(calls.detach).not.toHaveBeenCalled()
    unmount()
    expect(calls.detach).toHaveBeenCalledOnce()
  })
})
