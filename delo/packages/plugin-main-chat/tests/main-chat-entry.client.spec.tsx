// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
// Type-only: the 'sidebar.panellist' SlotMap entry, whose owner props the glyph takes.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject, LIST_WAIT_MS, NS, PANEL_ID, PANEL_ORDER, type MainChatOpeningInjected } from '../src/client/index.ts'
import { MainChatOpening } from '../src/client/MainChatOpening.tsx'
import { MainChatIcon, type MainChatIconInjected } from '../src/client/MainChatEntry.tsx'
import { en, zh } from '../src/client/locales.ts'
import { MAIN_CHAT_PATHS, MAIN_CHAT_SESSION_ID } from '../src/wire.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// A chat list as the studio has it.
const chat = (id: string, fields: Partial<SessionSummary> = {}): SessionSummary => ({
  id: SessionId(id), title: id, displayTitle: id, cwd: '/workspace/api', updatedAt: Date.now(), running: false, blank: false, retainedBy: {}, ...fields,
})
const listOf = (...chats: SessionSummary[]): SessionListState => ({
  ids: chats.map(each => each.id), byId: Object.fromEntries(chats.map(each => [each.id, each])), phase: 'ready', projectionsBySession: {},
})
const pendingListOf = (...chats: SessionSummary[]): SessionListState => ({ ...listOf(...chats), phase: 'pending' })

describe('the Main chat panel and row', () => {
  it('opens the main chat once when the row selects it, and shows nothing while it opens', async () => {
    const open = vi.fn<MainChatOpeningInjected['open']>(() => new Promise(() => undefined))
    render(<MainChatOpening t={makeTranslate(en)} open={open} />)
    await waitFor(() => { expect(open).toHaveBeenCalledTimes(1) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says when the main chat did not open, and opens it again on a retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const open = vi.fn<MainChatOpeningInjected['open']>(() => Promise.reject(new Error('answered 502')))
    render(<MainChatOpening t={makeTranslate(en)} open={open} />)
    expect((await screen.findByRole('alert')).textContent).toBe(en['open.failed'])
    open.mockImplementation(() => new Promise(() => undefined))
    fireEvent.click(screen.getByRole('button', { name: en['open.retry'] }))
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('draws the row\'s glyph at the size the sidebar asks for, with the completed-chat dot while a report is unread', () => {
    const t = makeTranslate(en)
    const { container, rerender } = render(<MainChatIcon size={18} active={false} t={t} useUnread={select => select(false)} />)
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('18')
    expect(container.querySelector('[data-delo-main-chat-unread]')).toBeNull()
    rerender(<MainChatIcon size={18} active={false} t={t} useUnread={select => select(true)} />)
    expect(screen.getByRole('img', { name: en['row.unread'] })).toBeDefined()
  })

  it('has the same keys in both dictionaries', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})

describe('the studio half', () => {
  // The locale service, the renderer's slot registry and the workspace navigation, as far as the plugin uses them.
  async function load(ctx = new Context()) {
    const dictionaries = new Map<string, Readonly<Record<string, unknown>>>()
    ctx.provide('locale', {
      bind: () => makeTranslate(en),
      register: (ns: string, dicts: Readonly<Record<string, unknown>>) => { dictionaries.set(ns, dicts); return () => { dictionaries.delete(ns) } },
    })
    const entries = new Set<{ readonly name: string; readonly id?: string; readonly key?: string; readonly order?: number; readonly label?: () => string; readonly inject?: (sessionId?: string) => unknown }>()
    ctx.provide('slots', {
      inject: (_: string, register: () => () => void) => { register() },
      register: (options: { readonly name: string }) => { entries.add(options); return () => { entries.delete(options) } },
    })
    const opened: string[] = []
    const hidden = new Set<string>()
    ctx.provide('uiWorkspace', {
      openSession: (id: string) => { opened.push(id) },
      hideSession: (id: string) => { hidden.add(id); return () => { hidden.delete(id) } },
    })
    let sessionList = listOf()
    const listListeners = new Set<() => void>()
    ctx.provide('sessions', {
      list: {
        getSnapshot: () => sessionList,
        subscribe: (listener: () => void) => { listListeners.add(listener); return () => { listListeners.delete(listener) } },
      },
    })
    const setList = (next: SessionListState): void => {
      sessionList = next
      for (const listener of listListeners) listener()
    }
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const of = (name: string) => [...entries].find(entry => entry.name === name)
    return { fiber, dictionaries, entries, opened, hidden, of, setList }
  }

  it('puts the Main chat row first in the sidebar\'s panel list, with the panel it selects, and the composer, and hides the main chat from the chat list; its disposal removes its dictionaries and shows it again', async () => {
    const { fiber, dictionaries, hidden, of } = await load()
    expect([...hidden]).toEqual([MAIN_CHAT_SESSION_ID])
    expect(dictionaries.get(NS)).toEqual({ en, zh })
    const row = of('sidebar.panellist')
    expect([row?.id, row?.order, row?.label?.()]).toEqual([PANEL_ID, PANEL_ORDER, en.row])
    expect(en.row).toBe('Main chat')
    expect(PANEL_ORDER).toBeLessThan(0)
    expect(of('main')?.key).toBe(PANEL_ID)
    expect(of('conversation.composer')).toBeDefined()
    await fiber.dispose()
    expect(dictionaries.size).toBe(0)
    expect(hidden.size).toBe(0)
  })

  it('opens the main chat once the harness has it, and reports the harness\'s refusal', async () => {
    const { of, opened, setList } = await load()
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response(null, { status: 204 })))
    vi.stubGlobal('fetch', fetch)
    const face: object = of('main')?.inject?.() ?? {}
    const { open } = face as MainChatOpeningInjected
    // The page's chat list holds the main chat a moment after the harness made it.
    const opening = open()
    await Promise.resolve()
    expect(opened).toEqual([])
    setList(listOf(chat('other')))
    setList(pendingListOf(chat(MAIN_CHAT_SESSION_ID)))
    expect(opened).toEqual([])
    setList(listOf(chat(MAIN_CHAT_SESSION_ID)))
    await opening
    expect(fetch).toHaveBeenCalledWith(MAIN_CHAT_PATHS.open.slice(1), { method: 'POST' })
    expect(opened).toEqual([MAIN_CHAT_SESSION_ID])
    fetch.mockImplementation(() => Promise.resolve(new Response(null, { status: 502 })))
    await expect(open()).rejects.toThrow('answered 502')
  })

  it('says the main chat did not open when the chat list does not hold it in time', async () => {
    vi.useFakeTimers()
    const { of } = await load()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))))
    const face: object = of('main')?.inject?.() ?? {}
    const opening = (face as MainChatOpeningInjected).open()
    const failed = expect(opening).rejects.toThrow('did not list the main chat')
    await vi.advanceTimersByTimeAsync(LIST_WAIT_MS)
    await failed
    vi.useRealTimers()
  })

  it('leads the sidebar with the Main chat row, current while the main chat is on screen, and stops on disposal', async () => {
    const ctx = new Context()
    const leads: Array<{ id: string; current: { getSnapshot(): boolean; subscribe(listener: () => void): () => void } }> = []
    ctx.provide('sidebarLayout', {
      setLeadPanel: (id: string, current: { getSnapshot(): boolean; subscribe(listener: () => void): () => void }) => {
        const entry = { id, current }
        leads.push(entry)
        return () => { leads.splice(leads.indexOf(entry), 1) }
      },
    })
    const { fiber, setList } = await load(ctx)
    expect(leads.map(lead => lead.id)).toEqual([PANEL_ID])
    const current = leads[0]?.current
    const changed = vi.fn()
    current?.subscribe(changed)
    expect(current?.getSnapshot()).toBe(false)
    setList(listOf(chat(MAIN_CHAT_SESSION_ID, { retainedBy: { mainView: 1 } })))
    expect([current?.getSnapshot(), changed.mock.calls.length]).toEqual([true, 1])
    await fiber.dispose()
    expect(leads).toEqual([])
  })

  it('marks the row unread while reports wait in the main chat\'s inbox, as soon as the count changes', async () => {
    // The harness's count route: a request after an older version answers at once, one after the current version when the count changes.
    let count = { waiting: 0, version: 0 }
    const waiting: Array<() => void> = []
    const signals: AbortSignal[] = []
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      const after = new URL(String(input), 'https://cell.example/').searchParams.get('after')
      if (init?.signal) signals.push(init.signal)
      if (after === null || count.version > Number(after)) return Promise.resolve(Response.json(count))
      return new Promise((resolve, reject) => {
        waiting.push(() => { resolve(Response.json(count)) })
        init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) })
      })
    })
    const change = (next: typeof count): void => {
      count = next
      for (const answer of waiting.splice(0)) answer()
    }
    vi.stubGlobal('fetch', fetch)
    const { of, fiber } = await load()
    const unread = (of('sidebar.panellist')?.inject?.() as MainChatIconInjected).hooks.unread
    await waitFor(() => { expect(waiting).toHaveLength(1) })
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([MAIN_CHAT_PATHS.reports.slice(1), `${MAIN_CHAT_PATHS.reports.slice(1)}?after=0`])
    expect(unread.getSnapshot()).toBe(false)
    change({ waiting: 1, version: 1 })
    await waitFor(() => { expect(unread.getSnapshot()).toBe(true) })
    await waitFor(() => { expect(waiting).toHaveLength(1) })
    expect(fetch).toHaveBeenLastCalledWith(`${MAIN_CHAT_PATHS.reports.slice(1)}?after=1`, expect.anything())
    // The main chat read the report at its next step.
    change({ waiting: 0, version: 2 })
    await waitFor(() => { expect(unread.getSnapshot()).toBe(false) })
    // Disposal ends the request still waiting.
    await waitFor(() => { expect(waiting).toHaveLength(1) })
    await fiber.dispose()
    expect(signals.at(-1)?.aborted).toBe(true)
  })
})
