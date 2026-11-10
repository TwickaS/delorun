// @vitest-environment jsdom
/** The studio half: the menu actions, the hidden chats, the outcome toast and the Trash section against a stand-in harness. */
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { FunctionComponent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, NS, SESSION_MENU_ORDER, TRASH_ICON_KEY, TRASH_SECTION_ID, TRASH_SECTION_ORDER, WORKSPACE_MENU_ORDER } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { TRASH_PATHS, type TrashEntry } from '../src/wire.ts'

const DAY = 86_400_000
const HOST = '0b6f2c6e-4f4a-4d6a-9a52-3d1f0f5c7a11'

/** A chat or workspace item as the harness lists it. */
function entry(fields: Partial<TrashEntry> & Pick<TrashEntry, 'id'>): TrashEntry {
  return {
    kind: 'chat', label: fields.id, deletedAt: Date.now() - 3 * 3_600_000, expiresAt: Date.now() + 29 * DAY - 60_000,
    sessionIds: [`${fields.id}-chat`], workspaceIds: [], ...fields,
  }
}

type Route = (body: Record<string, unknown>) => Response | Promise<Response>

/** A stand-in harness: every route answers from its list, a route can be replaced to fail. */
function harness(initial: readonly TrashEntry[] = []) {
  const items = [...initial]
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  const replaced = new Map<string, Route>()
  const gone = (id: unknown): TrashEntry => {
    const index = items.findIndex(item => item.id === id)
    return items.splice(index, 1)[0] as TrashEntry
  }
  const routes: Record<string, Route> = {
    [TRASH_PATHS.list]: () => Response.json({ items, damaged: [], retentionDays: 30, residueDays: 7 }),
    [TRASH_PATHS.deleteChat]: (body) => {
      const added = entry({ id: `item-${String(body.sessionId)}`, label: String(body.label), sessionIds: [String(body.sessionId)] })
      items.push(added)
      return Response.json(added)
    },
    [TRASH_PATHS.deleteWorkspace]: (body) => {
      const added = entry({ id: `item-${String(body.workspaceId)}`, kind: 'workspace', sessionIds: ['w-1', 'w-2'], workspaceIds: [String(body.workspaceId)] })
      items.push(added)
      return Response.json(added)
    },
    [TRASH_PATHS.restore]: body => Response.json(gone(body.itemId)),
    [TRASH_PATHS.purge]: body => Response.json({ item: gone(body.itemId), removedFrom: [], logsCleared: body.clearLogs === true, residueMaxDays: 0 }),
    [TRASH_PATHS.empty]: body => Response.json({ items: items.splice(0), logsCleared: body.clearLogs === true, residueMaxDays: 0 }),
  }
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = `/${String(input)}`
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ path, body })
    expect(init?.method).toBe('POST')
    return await (replaced.get(path) ?? routes[path] as Route)(body)
  })
  vi.stubGlobal('fetch', fetch)
  const callsTo = (path: string) => calls.filter(call => call.path === path).map(call => call.body)
  return { items, calls, callsTo, replace: (path: string, route: Route) => { replaced.set(path, route) } }
}

type Entry = {
  readonly options: { readonly name: string; readonly id?: string; readonly key?: string; readonly order?: number; readonly label?: () => string; readonly inject?: () => object }
  readonly component: FunctionComponent<object>
}
type Contribution = {
  readonly id: string; readonly target: string; readonly order: number; readonly observe?: () => unknown[]
  readonly resolve: (target: object, signal: AbortSignal) => Array<{ id: string; label: string; icon?: { key: string }; danger?: boolean; separatorBefore?: boolean; run: () => Promise<void> }>
}

/** A chat as the page's session list holds it; `open` marks the chat the main pane shows. */
interface PageChat { readonly id: string; readonly open?: boolean }

/** A workspace as the page's workspace list holds it. */
interface PageWorkspace { readonly workspaceId: string; readonly sessionIds: readonly string[] }

/**
 * The page as far as the plugin uses it: slots, the locale, the context menus, the workspace's hidden chats and New
 * chat, and the session and workspace lists.
 * @param page - the chats and workspaces on the page; by default `chat-1`, open, in workspace `ws-1`.
 */
async function load(page: { readonly chats?: readonly PageChat[]; readonly workspaces?: readonly PageWorkspace[] } = {}) {
  const ctx = new Context()
  const dictionaries = new Map<string, unknown>()
  ctx.provide('locale', {
    bind: () => makeTranslate(en),
    register: (ns: string, dicts: unknown) => { dictionaries.set(ns, dicts); return () => { dictionaries.delete(ns) } },
  })
  const entries = new Set<Entry>()
  ctx.provide('slots', {
    inject: (_: string, register: () => () => void) => { register() },
    register: (options: Entry['options'], component: Entry['component']) => {
      const added = { options, component }
      entries.add(added)
      return () => { entries.delete(added) }
    },
  })
  const contributions = new Set<Contribution>()
  ctx.provide('contextMenus', {
    register: (contribution: Contribution) => { contributions.add(contribution); return () => { contributions.delete(contribution) } },
  })
  const hidden = new Set<string>()
  const sessionList = (chats: readonly PageChat[]) => ({
    ids: chats.map(chat => chat.id),
    byId: Object.fromEntries(chats.map(chat => [chat.id, { id: chat.id, retainedBy: chat.open === true ? { mainView: 1 } : {} }])),
  })
  const sessions = createSnapshotStore(sessionList(page.chats ?? [{ id: 'chat-1', open: true }]))
  const workspaces = createSnapshotStore({ items: page.workspaces ?? [{ workspaceId: 'ws-1', sessionIds: ['chat-1'] }] })
  const started: Array<string | undefined> = []
  ctx.provide('uiWorkspace', {
    hideSession: (id: string) => { hidden.add(id); return () => { hidden.delete(id) } },
    startSession: (workspaceId?: string) => { started.push(workspaceId) },
  })
  ctx.provide('sessions', { list: sessions })
  ctx.provide('workspaces', { list: workspaces })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const entryOf = (name: string): Entry => [...entries].find(candidate => candidate.options.name === name) as Entry
  const menu = (target: string): Contribution => [...contributions].find(candidate => candidate.target === target) as Contribution
  /** Render a slot entry with the props the renderer would bind from its injected face. */
  const mount = (name: string) => {
    const { options, component } = entryOf(name)
    const face = (options.inject?.() ?? {}) as { hooks?: Record<string, never> } & Record<string, unknown>
    const hooks = Object.fromEntries(Object.entries(face.hooks ?? {}).map(([key, source]) =>
      [`use${key.charAt(0).toUpperCase()}${key.slice(1)}`, bindSnapshotSelector(source)]))
    const props = { t: makeTranslate(en), close: () => {}, ...face, ...hooks }
    const Component = component
    return render(<Component {...props} />)
  }
  return {
    ctx, fiber, dictionaries, entries, contributions, hidden, entryOf, menu, mount, started,
    /** Show another set of chats, as the session list does after a navigation. */
    showChats: (chats: readonly PageChat[]) => { sessions.set(sessionList(chats)) },
    /** Show another workspace list. */
    showWorkspaces: (items: readonly PageWorkspace[]) => { workspaces.set({ items }) },
    dispose: () => fiber.dispose(),
  }
}

const SESSION = { sessionId: 'chat-1', displayTitle: 'Plan the move' }
const WORKSPACE = { workspaceId: 'ws-1', path: '/work/api', displayTitle: 'api' }

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the plugin', () => {
  it('registers its dictionaries, both menu actions, the outcome toast and the Trash section, and removes them on disposal', async () => {
    harness()
    const page = await load()
    expect(page.dictionaries.get(NS)).toEqual({ en, zh })
    const session = page.menu('session')
    const workspace = page.menu('workspace')
    expect([session.id, session.order, workspace.id, workspace.order]).toEqual(['delo-trash.session', SESSION_MENU_ORDER, 'delo-trash.workspace', WORKSPACE_MENU_ORDER])
    // After upstream's Archive (600) and Delete (300).
    expect(SESSION_MENU_ORDER).toBeGreaterThan(600)
    expect(WORKSPACE_MENU_ORDER).toBeGreaterThan(300)
    expect([session.observe?.(), workspace.observe?.()].map(sources => sources?.length)).toEqual([1, 1])
    expect(session.resolve(SESSION, new AbortController().signal)).toMatchObject([{
      id: 'trash', label: en['menu.trash'], icon: { key: TRASH_ICON_KEY }, danger: true, separatorBefore: true,
    }])
    expect(workspace.resolve(WORKSPACE, new AbortController().signal)).toMatchObject([{ label: en['menu.trash'], danger: true, separatorBefore: true }])
    expect(page.entryOf('contextMenu.icon').options.key).toBe(TRASH_ICON_KEY)
    const section = page.entryOf('settings.section').options
    expect([section.id, section.order, section.label?.()]).toEqual([TRASH_SECTION_ID, TRASH_SECTION_ORDER, en.nav])
    expect(page.entryOf('shell.overlay').options.id).toBe('delo-trash.toast')
    await page.dispose()
    expect([page.dictionaries.size, page.contributions.size]).toEqual([0, 0])
  })

  it('has the same keys in both dictionaries', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('leaves the chats in the trash out of the sidebar at start and shows a chat again once it is no longer listed', async () => {
    const fake = harness([entry({ id: 'a', sessionIds: ['a-1', 'a-2'] }), entry({ id: 'b', sessionIds: ['b-1'] })])
    const page = await load()
    await waitFor(() => { expect([...page.hidden].sort()).toEqual(['a-1', 'a-2', 'b-1']) })
    fake.items.splice(0, 1)
    page.mount('settings.section')
    await waitFor(() => { expect([...page.hidden]).toEqual(['b-1']) })
    await page.dispose()
    expect(page.hidden.size).toBe(0)
  })

  it('moves a chat to the trash from its menu, hides it, and says so', async () => {
    const fake = harness()
    const page = await load()
    page.mount('shell.overlay')
    const [action] = page.menu('session').resolve(SESSION, new AbortController().signal)
    await action?.run()
    expect(fake.callsTo(TRASH_PATHS.deleteChat)).toEqual([{ sessionId: 'chat-1', label: 'Plan the move' }])
    expect([...page.hidden]).toEqual(['chat-1'])
    expect((await screen.findByRole('alert')).textContent).toBe(en['toast.chatTrashed'])
    // The listing was read again after the delete.
    expect(fake.callsTo(TRASH_PATHS.list).length).toBeGreaterThanOrEqual(2)
  })

  it('moves a workspace to the trash from its menu and hides its chats', async () => {
    const fake = harness()
    const page = await load()
    page.mount('shell.overlay')
    const [action] = page.menu('workspace').resolve(WORKSPACE, new AbortController().signal)
    await action?.run()
    expect(fake.callsTo(TRASH_PATHS.deleteWorkspace)).toEqual([{ workspaceId: 'ws-1' }])
    expect([...page.hidden].sort()).toEqual(['w-1', 'w-2'])
    expect((await screen.findByRole('alert')).textContent).toBe(en['toast.workspaceTrashed'])
  })

  it('opens a new chat in the workspace of the open chat it moved, and gives the composer the focus the row took away', async () => {
    harness()
    const page = await load()
    const card = document.createElement('div')
    card.tabIndex = -1
    card.setAttribute('data-composer-card', '')
    document.body.append(card)
    const [action] = page.menu('session').resolve(SESSION, new AbortController().signal)
    await action?.run()
    expect(page.started).toEqual(['ws-1'])
    expect(document.activeElement).toBe(document.body)
    // Upstream's New chat lands: the main pane shows the workspace's blank chat.
    act(() => { page.showChats([{ id: 'chat-1' }, { id: 'blank-1', open: true }]) })
    await waitFor(() => { expect(document.activeElement).toBe(card) })
    card.remove()
  })

  it('leaves the main pane alone when the chat it moved was not the open one', async () => {
    harness()
    const page = await load({ chats: [{ id: 'chat-1' }, { id: 'other', open: true }] })
    const [action] = page.menu('session').resolve(SESSION, new AbortController().signal)
    await action?.run()
    expect(page.started).toEqual([])
  })

  it('opens a new chat in the latest workspace once the list drops the moved workspace that held the open chat', async () => {
    harness()
    const page = await load({ workspaces: [{ workspaceId: 'ws-1', sessionIds: ['chat-1'] }, { workspaceId: 'ws-2', sessionIds: [] }] })
    const [action] = page.menu('workspace').resolve(WORKSPACE, new AbortController().signal)
    await action?.run()
    // The list still holds the workspace, so New chat would pick it again.
    expect(page.started).toEqual([])
    act(() => { page.showWorkspaces([{ workspaceId: 'ws-2', sessionIds: [] }]) })
    expect(page.started).toEqual([undefined])
  })

  it('leaves the main pane alone when the workspace holding the open chat could not be moved', async () => {
    const fake = harness()
    fake.replace(TRASH_PATHS.deleteWorkspace, () => new Response(null, { status: 500 }))
    const page = await load({ workspaces: [{ workspaceId: 'ws-1', sessionIds: ['chat-1'] }] })
    const [action] = page.menu('workspace').resolve(WORKSPACE, new AbortController().signal)
    await action?.run()
    act(() => { page.showWorkspaces([]) })
    expect(page.started).toEqual([])
  })

  it('leaves the main pane alone when the moved workspace does not hold the open chat', async () => {
    harness()
    const page = await load({ workspaces: [{ workspaceId: 'ws-1', sessionIds: [] }, { workspaceId: 'ws-2', sessionIds: ['chat-1'] }] })
    const [action] = page.menu('workspace').resolve(WORKSPACE, new AbortController().signal)
    await action?.run()
    act(() => { page.showWorkspaces([{ workspaceId: 'ws-2', sessionIds: ['chat-1'] }]) })
    expect(page.started).toEqual([])
  })

  it.each([
    { name: 'a harness failure with a body', route: () => Response.json({ code: 'TRASH_FAILED', message: 'x' }, { status: 500 }), text: en['toast.trashFailed'] },
    { name: 'a failure without a JSON body', route: () => new Response('<html>', { status: 502 }), text: en['toast.trashFailed'] },
    { name: 'a network failure', route: () => Promise.reject(new TypeError('Failed to fetch')), text: en['toast.trashFailed'] },
    { name: 'a workspace that is gone', route: () => Response.json({ code: 'WORKSPACE_NOT_FOUND', message: 'x' }, { status: 404 }), text: en['toast.workspaceMissing'] },
  ])('keeps the chat where it was and says why after $name', async ({ route, text }) => {
    const fake = harness()
    fake.replace(TRASH_PATHS.deleteChat, route)
    const page = await load()
    page.mount('shell.overlay')
    const [action] = page.menu('session').resolve(SESSION, new AbortController().signal)
    await action?.run()
    expect((await screen.findByRole('alert')).textContent).toBe(text)
    expect(page.hidden.size).toBe(0)
    // The chat stays open: the main pane does not move.
    expect(page.started).toEqual([])
  })

  it('does not hide chats once the page has unloaded the plugin while a delete was in flight', async () => {
    const fake = harness()
    let answer: (response: Response) => void = () => {}
    fake.replace(TRASH_PATHS.deleteChat, () => new Promise<Response>((resolve) => { answer = resolve }))
    const page = await load()
    const [action] = page.menu('session').resolve(SESSION, new AbortController().signal)
    const running = action?.run()
    await waitFor(() => { expect(fake.callsTo(TRASH_PATHS.deleteChat)).toHaveLength(1) })
    await page.dispose()
    answer(Response.json(entry({ id: 'late', sessionIds: ['chat-1'] })))
    await running
    expect(page.hidden.size).toBe(0)
  })

  it('still clears the drafts of an item deleted forever after the plugin unloaded while the delete was in flight', async () => {
    const fake = harness([entry({ id: 'a', sessionIds: ['a-1'] })])
    localStorage.setItem('dsh.conversation.a-1', 'draft')
    let answer: (response: Response) => void = () => {}
    fake.replace(TRASH_PATHS.purge, () => new Promise<Response>((resolve) => { answer = resolve }))
    const page = await load()
    await waitFor(() => { expect(page.hidden.size).toBe(1) })
    const face = page.entryOf('settings.section').options.inject?.() as { purge: (itemId: string, clearLogs: boolean) => Promise<void> }
    const running = face.purge('a', false)
    await waitFor(() => { expect(fake.callsTo(TRASH_PATHS.purge)).toHaveLength(1) })
    await page.dispose()
    answer(Response.json({ item: entry({ id: 'a', sessionIds: ['a-1'] }), removedFrom: [], logsCleared: false, residueMaxDays: 7 }))
    await running
    expect(localStorage.length).toBe(0)
  })

  it('shows the toast of a later outcome in place of the one on display, and clears it when its hold ends', async () => {
    const fake = harness()
    const page = await load()
    page.mount('shell.overlay')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const [action] = page.menu('session').resolve(SESSION, new AbortController().signal)
    await act(async () => { await action?.run() })
    expect(screen.getAllByRole('alert').map(alert => alert.textContent)).toEqual([en['toast.chatTrashed']])
    fake.replace(TRASH_PATHS.deleteChat, () => new Response(null, { status: 500 }))
    await act(async () => { await action?.run() })
    expect(screen.getAllByRole('alert').map(alert => alert.textContent)).toEqual([en['toast.trashFailed']])
    act(() => { vi.advanceTimersByTime(8_000) })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('the Trash section', () => {
  it('lists each item oldest first with what it is, when it was deleted and the days it has left', async () => {
    const fake = harness([
      entry({ id: 'a', label: 'Plan the move', deletedAt: Date.now() - 1_000 }),
      entry({ id: 'b', label: 'api', kind: 'workspace', sessionIds: ['b-1'], deletedAt: Date.now() - 5 * 60_000, expiresAt: Date.now() + DAY - 60_000 }),
      entry({ id: 'c', label: 'Docs', kind: 'workspace', sessionIds: ['c-1', 'c-2'], deletedAt: Date.now() - 3 * 3_600_000, expiresAt: Date.now() + 2 * DAY - 60_000 }),
      entry({ id: 'd', label: 'Old', deletedAt: Date.now() - 12 * DAY, expiresAt: Date.now() - 1_000 }),
      entry({ id: 'e', label: 'Older', deletedAt: Date.now() - 70 * DAY }),
      entry({ id: 'f', label: 'Oldest', deletedAt: Date.now() - 800 * DAY }),
    ])
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    fake.replace(TRASH_PATHS.list, async () => {
      await gate
      return Response.json({ items: fake.items, damaged: [], retentionDays: 30, residueDays: 7 })
    })
    const page = await load()
    page.mount('settings.section')
    expect(screen.getByRole('status').textContent).toBe(en.loading)
    release()
    const rows = await screen.findAllByRole('listitem')
    const text = rows.map(row => row.textContent)
    expect(text[0]).toContain(`Plan the move${en['kind.chat']}${en['deleted.now']}${en['expires.other'].replace('{n}', '29')}`)
    expect(text[1]).toContain(`api${en['kind.workspace.one'].replace('{n}', '1')}${en['deleted.minutes'].replace('{n}', '5')}${en['expires.one'].replace('{n}', '1')}`)
    expect(text[2]).toContain(en['kind.workspace.other'].replace('{n}', '2'))
    expect(text[2]).toContain(en['deleted.hours'].replace('{n}', '3'))
    expect(text[3]).toContain(en['deleted.days'].replace('{n}', '12'))
    expect(text[3]).toContain(en['expires.due'])
    expect(text[4]).toContain(en['deleted.months'].replace('{n}', '2'))
    expect(text[5]).toContain(en['deleted.years'].replace('{n}', '2'))
    expect(screen.getByRole('button', { name: en.emptyAll }).hasAttribute('disabled')).toBe(false)
  })

  it('says the trash is empty, with how long deleted items stay, and disables Empty trash', async () => {
    harness()
    const page = await load()
    page.mount('settings.section')
    expect((await screen.findByText(en['empty.other'].replace('{days}', '30'))).tagName).toBe('P')
    expect(screen.getByRole('button', { name: en.emptyAll }).hasAttribute('disabled')).toBe(true)
  })

  it('restores an item, returns its chats to the sidebar and says so', async () => {
    const fake = harness([entry({ id: 'a', label: 'Plan the move', sessionIds: ['a-1'] })])
    const page = await load()
    page.mount('shell.overlay')
    page.mount('settings.section')
    await screen.findByText('Plan the move')
    expect([...page.hidden]).toEqual(['a-1'])
    fireEvent.click(screen.getByRole('button', { name: en.restore }))
    await waitFor(() => { expect(fake.callsTo(TRASH_PATHS.restore)).toEqual([{ itemId: 'a' }]) })
    await waitFor(() => { expect(screen.queryByText('Plan the move')).toBeNull() })
    expect(page.hidden.size).toBe(0)
    expect(screen.getAllByRole('alert').map(alert => alert.textContent)).toContain(en['toast.restored'])
  })

  it('keeps the item and says why when a restore is refused', async () => {
    const fake = harness([entry({ id: 'a', label: 'Plan the move' })])
    fake.replace(TRASH_PATHS.restore, () => Response.json({ code: 'TRASH_RESTORE_CONFLICT', message: 'x' }, { status: 409 }))
    const page = await load()
    page.mount('shell.overlay')
    page.mount('settings.section')
    fireEvent.click(await screen.findByRole('button', { name: en.restore }))
    expect((await screen.findAllByRole('alert')).map(alert => alert.textContent)).toContain(en['toast.restoreConflict'])
    expect(screen.getByText('Plan the move')).toBeTruthy()
    expect(page.hidden.size).toBe(1)
  })

  /** Seed the browser with draft keys of chat `a-1`, the same chat under a host, and another chat. */
  const seedDrafts = (): void => {
    localStorage.setItem('dsh.conversation.a-1', 'draft')
    localStorage.setItem(`dsh.conversation.${HOST}.a-1`, 'draft')
    localStorage.setItem('dsh.conversation.other-1', 'draft')
  }

  it('deletes an item forever only after the confirmation, without clearing the logs unless asked, and clears its drafts here', async () => {
    const fake = harness([entry({ id: 'a', label: 'Plan the move', sessionIds: ['a-1'] }), entry({ id: 'b', label: 'Docs', sessionIds: ['b-1'] })])
    seedDrafts()
    const page = await load()
    page.mount('shell.overlay')
    page.mount('settings.section')
    const row = (await screen.findByText('Plan the move')).closest('li') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: en.purge }))
    let dialog = screen.getByRole('dialog', { name: en['purge.title'] })
    expect(within(dialog).getByText(en['purge.body'].replace('{name}', 'Plan the move'))).toBeTruthy()
    expect(within(dialog).getByText(en['residue.other'].replace('{days}', '7'))).toBeTruthy()
    expect((within(dialog).getByRole('checkbox', { name: en.clearLogs }) as HTMLInputElement).checked).toBe(false)
    // Cancelling or closing sends nothing.
    fireEvent.click(within(dialog).getByRole('button', { name: en['confirm.cancel'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(within(row).getByRole('button', { name: en.purge }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['confirm.close'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fake.callsTo(TRASH_PATHS.purge)).toEqual([])
    fireEvent.click(within(row).getByRole('button', { name: en.purge }))
    dialog = screen.getByRole('dialog', { name: en['purge.title'] })
    fireEvent.click(within(dialog).getByRole('button', { name: en.purge }))
    await waitFor(() => { expect(fake.callsTo(TRASH_PATHS.purge)).toEqual([{ itemId: 'a', clearLogs: false }]) })
    await waitFor(() => { expect(screen.queryByText('Plan the move')).toBeNull() })
    expect(Object.keys(localStorage).sort()).toEqual(['dsh.conversation.other-1'])
    expect(screen.getAllByRole('alert').map(alert => alert.textContent)).toContain(en['toast.purged'])
    // The next one asks for the logs to be cleared too.
    fireEvent.click(screen.getByRole('button', { name: en.purge }))
    dialog = screen.getByRole('dialog', { name: en['purge.title'] })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: en.clearLogs }))
    fireEvent.click(within(dialog).getByRole('button', { name: en.purge }))
    await waitFor(() => { expect(fake.callsTo(TRASH_PATHS.purge)).toHaveLength(2) })
    expect(fake.callsTo(TRASH_PATHS.purge)[1]).toEqual({ itemId: 'b', clearLogs: true })
  })

  it('says so when the logs it was asked to clear could not all be cleared', async () => {
    const fake = harness([entry({ id: 'a', label: 'Plan the move', sessionIds: ['a-1'] }), entry({ id: 'b', label: 'Docs', sessionIds: ['b-1'] })])
    fake.replace(TRASH_PATHS.purge, body => Response.json({ item: entry({ id: String(body.itemId) }), removedFrom: [], attachmentsKept: 0, logsCleared: false, logFailures: ['logs: mode 0755'], residueMaxDays: 14 }))
    fake.replace(TRASH_PATHS.empty, () => Response.json({ items: [], logsCleared: false, logFailures: [], residueMaxDays: 14 }))
    const page = await load()
    page.mount('shell.overlay')
    page.mount('settings.section')
    const row = (await screen.findByText('Plan the move')).closest('li') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: en.purge }))
    const dialog = screen.getByRole('dialog', { name: en['purge.title'] })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: en.clearLogs }))
    fireEvent.click(within(dialog).getByRole('button', { name: en.purge }))

    await waitFor(() => { expect(screen.getAllByRole('alert').map(alert => alert.textContent)).toContain(en['toast.logsNotCleared']) })
    fireEvent.click(screen.getByRole('button', { name: en.emptyAll }))
    const emptying = screen.getByRole('dialog', { name: en['emptyAll.title'] })
    fireEvent.click(within(emptying).getByRole('checkbox', { name: en.clearLogs }))
    fireEvent.click(within(emptying).getByRole('button', { name: en.emptyAll }))
    await waitFor(() => { expect(screen.getAllByRole('alert').map(alert => alert.textContent)).toContain(en['toast.emptied']) })
  })

  it('says how many items it cannot read, and leaves them alone', async () => {
    const fake = harness([])
    fake.replace(TRASH_PATHS.list, () => Response.json({ items: [], damaged: [{ id: '1-a', directory: '/h/trash/items/1-a', reason: 'torn' }, { id: '2-a', directory: '/h/trash/items/2-a', reason: 'torn' }], retentionDays: 30, residueDays: 14 }))
    const page = await load()
    page.mount('settings.section')

    expect(await screen.findByText(en['damaged.other'].replace('{n}', '2'))).toBeTruthy()
    fake.replace(TRASH_PATHS.list, () => Response.json({ items: [], damaged: [{ id: '1-a', directory: '/h/trash/items/1-a', reason: 'torn' }], retentionDays: 30, residueDays: 14 }))
    cleanup()
    page.mount('settings.section')
    expect(await screen.findByText(en['damaged.one'].replace('{n}', '1'))).toBeTruthy()
  })

  it('keeps the item, its drafts and its chats hidden when a delete forever fails', async () => {
    const fake = harness([entry({ id: 'a', label: 'Plan the move', sessionIds: ['a-1'] })])
    fake.replace(TRASH_PATHS.purge, () => Response.json({ code: 'TRASH_ITEM_NOT_FOUND', message: 'x' }, { status: 404 }))
    seedDrafts()
    const page = await load()
    page.mount('shell.overlay')
    page.mount('settings.section')
    fireEvent.click(await screen.findByRole('button', { name: en.purge }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.purge }))
    expect((await screen.findAllByRole('alert')).map(alert => alert.textContent)).toContain(en['toast.notFound'])
    expect(localStorage.length).toBe(3)
    expect([...page.hidden]).toEqual(['a-1'])
  })

  it('empties the trash after the confirmation and clears every item\'s drafts here', async () => {
    const fake = harness([entry({ id: 'a', sessionIds: ['a-1'] }), entry({ id: 'b', kind: 'workspace', sessionIds: ['b-1'], workspaceIds: ['ws-b'] })])
    seedDrafts()
    localStorage.setItem(`dsh.workspace.view.v5.${HOST}.ws-b`, 'view')
    const page = await load()
    page.mount('shell.overlay')
    page.mount('settings.section')
    fireEvent.click(await screen.findByRole('button', { name: en.emptyAll }))
    const dialog = screen.getByRole('dialog', { name: en['emptyAll.title'] })
    expect(within(dialog).getByText(en['emptyAll.body'])).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: en.clearLogs }))
    fireEvent.click(within(dialog).getByRole('button', { name: en.emptyAll }))
    await waitFor(() => { expect(fake.callsTo(TRASH_PATHS.empty)).toEqual([{ clearLogs: true }]) })
    await screen.findByText(en['empty.other'].replace('{days}', '30'))
    expect(Object.keys(localStorage)).toEqual(['dsh.conversation.other-1'])
    expect(screen.getAllByRole('alert').map(alert => alert.textContent)).toContain(en['toast.emptied'])
    expect(page.hidden.size).toBe(0)
  })

  it('says when the trash was not emptied', async () => {
    const fake = harness([entry({ id: 'a' })])
    fake.replace(TRASH_PATHS.empty, () => new Response(null, { status: 500 }))
    const page = await load()
    page.mount('shell.overlay')
    page.mount('settings.section')
    fireEvent.click(await screen.findByRole('button', { name: en.emptyAll }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.emptyAll }))
    expect((await screen.findAllByRole('alert')).map(alert => alert.textContent)).toContain(en['toast.emptyFailed'])
    expect(screen.getByText('a')).toBeTruthy()
  })

  it('says the trash could not be loaded and loads it again on Retry', async () => {
    const fake = harness([entry({ id: 'a', label: 'Plan the move' })])
    fake.replace(TRASH_PATHS.list, () => new Response(null, { status: 503 }))
    const page = await load()
    page.mount('settings.section')
    expect((await screen.findByRole('alert')).textContent).toBe(en['list.failed'])
    expect(screen.queryByRole('listitem')).toBeNull()
    fake.replace(TRASH_PATHS.list, () => Response.json({ items: fake.items, damaged: [], retentionDays: 30, residueDays: 7 }))
    fireEvent.click(screen.getByRole('button', { name: en['list.retry'] }))
    expect(await screen.findByText('Plan the move')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the listing it has when a later read fails', async () => {
    const fake = harness([entry({ id: 'a', label: 'Plan the move' })])
    const page = await load()
    page.mount('settings.section')
    await screen.findByText('Plan the move')
    fake.replace(TRASH_PATHS.list, () => Promise.reject(new TypeError('Failed to fetch')))
    page.mount('settings.section')
    await waitFor(() => { expect(fake.callsTo(TRASH_PATHS.list).length).toBeGreaterThanOrEqual(3) })
    expect(screen.getAllByText('Plan the move').length).toBeGreaterThan(0)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
