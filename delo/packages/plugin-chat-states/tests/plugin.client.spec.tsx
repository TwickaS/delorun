// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply, inject, MENU, MENU_ICON_KEYS, NS, ROW_ACTION, SECTION, SHELVES, type ConnectionStatusInjected, type CustomSnoozeInjected, type DeloChatStates,
  type SnoozeSettingsInjected,
} from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import type { ChatStatesInjected } from '../src/client/ChatStateActions.tsx'
import { CHAT_STATES_ROW_ID, DEFAULT_CHAT_STATES_SETTINGS, type ChatStatesSettings } from '../src/config.ts'
import type { ChatState } from '../src/wire.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const sid = (id: string) => SessionId(id)

/** Tuesday 3 November 2026, 10:00 local time. */
const NOW = new Date(2026, 10, 3, 10, 0).getTime()

interface MenuContribution {
  readonly id: string
  readonly target: string
  readonly order: number
  readonly observe: (target: { sessionId: SessionId }) => readonly unknown[]
  readonly resolve: (target: { sessionId: SessionId; displayTitle: string }, signal: AbortSignal) => readonly {
    readonly id: string; readonly label: string; readonly icon: { readonly key: string }; readonly run: () => void
  }[]
}

/** The services the studio half injects, recording what it registers. */
function harness(options: { readonly studio?: boolean; readonly settings?: ChatStatesSettings | undefined; readonly served?: boolean; readonly chats?: Record<string, ChatState> } = {}) {
  vi.useFakeTimers({ now: NOW })
  const chats: Record<string, ChatState> = { ...options.chats }
  const fetch = vi.fn(async (_path: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const request = JSON.parse(String(init.body)) as { action: string; session: string }
      chats[request.session] = request.action === 'settle' ? { settledAt: 1 } : {}
    }
    return new Response(JSON.stringify({ chats }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetch)
  const ctx = new Context()
  const dictionaries = new Map<string, unknown>()
  const locale = createSnapshotStore({ active: 'en' })
  ctx.provide('locale', {
    bind: () => makeTranslate(en),
    getLocale: () => ({ active: 'en' }),
    getSnapshot: locale.getSnapshot, subscribe: locale.subscribe,
    register: (ns: string, dicts: unknown) => { dictionaries.set(ns, dicts); return () => { dictionaries.delete(ns) } },
  } as never)
  const shelves = new Map<string, { id: string; order: number; label: () => string; members: { getSnapshot(): ReadonlyMap<string, number> } }>()
  ctx.provide('uiWorkspace', {
    registerShelf: (shelf: { id: string; order: number; label: () => string; members: { getSnapshot(): ReadonlyMap<string, number> } }) => {
      shelves.set(shelf.id, shelf)
      return () => { shelves.delete(shelf.id) }
    },
  } as never)
  const entries = new Map<string, { component: unknown; inject?: () => unknown; order?: number; label?: () => string }>()
  const registered = (options: { name: string; id?: string; key?: string }) => `${options.name}#${options.id ?? options.key}`
  ctx.provide('slots', {
    inject: (_: string, register: () => (() => void) | Generator<() => void>) => {
      const result = register()
      if (typeof result === 'function') return result
      const disposers = [...result]
      return () => { for (const dispose of disposers) dispose() }
    },
    register: (slot: { name: string; id?: string; key?: string; order?: number; label?: () => string; inject?: () => unknown }, component: unknown) => {
      const key = registered(slot)
      entries.set(key, { component, ...slot.inject === undefined ? {} : { inject: slot.inject }, ...slot.order === undefined ? {} : { order: slot.order }, ...slot.label === undefined ? {} : { label: slot.label } })
      return () => { entries.delete(key) }
    },
  } as never)
  const snapshot: ConfigFormSnapshot<ChatStatesSettings> = {
    status: options.settings === undefined ? 'loading' : 'ready', value: options.settings, base: undefined, user: undefined, revision: 1, writable: true,
  }
  const formListeners = new Set<() => void>()
  let current = snapshot
  const form: ConfigForm<ChatStatesSettings> = {
    getSnapshot: () => current,
    subscribe: (listener) => { formListeners.add(listener); return () => { formListeners.delete(listener) } },
    set: () => Promise.resolve(true), unset: () => Promise.resolve(true), mutate: () => Promise.resolve(true),
  }
  const forms: string[] = []
  ctx.provide('configForms', {
    get: (id: string) => { forms.push(id); return form },
    whileServed: (_: readonly string[], register: () => () => void) => (options.served === false ? () => {} : register()),
  } as never)
  const menus = new Map<string, MenuContribution>()
  ctx.provide('contextMenus', {
    register: (contribution: MenuContribution) => { menus.set(contribution.id, contribution); return () => { menus.delete(contribution.id) } },
  } as never)
  const workspaces = createSnapshotStore({ archivedSessionIds: [] as SessionId[] })
  ctx.provide('workspaces', { list: workspaces } as never)
  const connection = createSnapshotStore<'connected' | 'connecting' | 'disconnected' | undefined>('connected')
  ctx.provide('connection', { state: connection } as never)
  if (options.studio !== false) ctx.provide('deloStudio', {} as never)
  const fiber = ctx.plugin({ name: 'delo-chat-states', inject: [...inject], apply })
  return {
    ctx, fiber, dictionaries, shelves, entries, menus, fetch, forms, workspaces, chats, locale, connection,
    setSettings: (value: ChatStatesSettings) => { current = { ...current, value, status: 'ready' }; for (const listener of [...formListeners]) listener() },
    face: <T,>(key: string): T => {
      const entry = entries.get(key)
      if (entry?.inject === undefined) throw new Error(`no injected entry ${key}`)
      return entry.inject() as T
    },
  }
}

const SETTINGS: ChatStatesSettings = { snoozePresets: [{ kind: 'after', minutes: 30 }], autoSettleDays: 5, refreshSeconds: 10 }

describe('the studio half', () => {
  it('registers its copy, the shelves, the menu entries and their icons, the hover button, the overlay entries and the settings section', async () => {
    const h = harness({ settings: SETTINGS })
    await h.fiber.await()
    expect(h.dictionaries.get(NS)).toEqual({ en, zh })
    expect([...h.shelves.values()].map(shelf => [shelf.id, shelf.order, shelf.label()])).toEqual([
      [SHELVES.snoozed.id, SHELVES.snoozed.order, en['shelf.snoozed']], [SHELVES.settled.id, SHELVES.settled.order, en['shelf.settled']],
    ])
    expect([...h.menus.values()].map(menu => [menu.id, menu.target, menu.order])).toEqual([
      [MENU.snooze.id, 'session', MENU.snooze.order], [MENU.settle.id, 'session', MENU.settle.order],
    ])
    expect([...h.entries.keys()].sort()).toEqual([
      `contextMenu.icon#${MENU_ICON_KEYS.settle}`, `contextMenu.icon#${MENU_ICON_KEYS.settled}`, `contextMenu.icon#${MENU_ICON_KEYS.snooze}`,
      `settings.section#${SECTION.id}`, 'shell.overlay#delo-chat-states.connection', 'shell.overlay#delo-chat-states.failure', 'shell.overlay#delo-chat-states.snooze',
      `sidebar.workspaces.session.row.action#${ROW_ACTION.id}`,
    ].sort())
    expect(h.entries.get(`sidebar.workspaces.session.row.action#${ROW_ACTION.id}`)?.order).toBe(ROW_ACTION.order)
    expect(h.entries.get(`settings.section#${SECTION.id}`)?.order).toBe(SECTION.order)
    expect(h.entries.get(`settings.section#${SECTION.id}`)?.label?.()).toBe(en['settings.nav'])
    expect(h.forms).toEqual([CHAT_STATES_ROW_ID])
    await h.fiber.dispose()
    expect([h.dictionaries.size, h.shelves.size, h.menus.size, h.entries.size]).toEqual([0, 0, 0, 0])
    expect(h.ctx.get('deloChatStates')).toBeUndefined()
  })

  it('registers nothing, and offers no service, while the Delo look is off', async () => {
    const h = harness({ settings: SETTINGS, studio: false })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect([h.dictionaries.size, h.shelves.size, h.menus.size, h.entries.size, h.forms.length, h.fetch.mock.calls.length]).toEqual([0, 0, 0, 0, 0, 0])
    expect(h.ctx.get('deloChatStates')).toBeUndefined()
    h.ctx.provide('deloStudio', {} as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.shelves.size).toBe(2)
    expect(h.ctx.get('deloChatStates')).toBeDefined()
  })

  it('stays an active entry under the stock look: the Delo look is injected inside apply, not required', () => {
    expect(inject).not.toContain('deloStudio')
  })

  it('gives the connection announcements the page\'s connection state', async () => {
    const h = harness({ settings: SETTINGS })
    await h.fiber.await()
    const face = h.face<ConnectionStatusInjected>('shell.overlay#delo-chat-states.connection')
    expect(face.hooks.connectionState).toBe(h.connection)
  })

  it('shows the Snooze and settle section only while the settings are served', async () => {
    const h = harness({ settings: SETTINGS, served: false })
    await h.fiber.await()
    expect(h.entries.has(`settings.section#${SECTION.id}`)).toBe(false)
  })

  it('shares the states, the worded snooze menu, the time left and the settings through ctx.deloChatStates', async () => {
    const h = harness({ settings: SETTINGS, chats: { a: { settledAt: 5 } } })
    await h.fiber.await()
    await vi.advanceTimersByTimeAsync(0)
    const service = h.ctx.get('deloChatStates') as DeloChatStates
    expect(service.snoozeOptions().map(option => option.id)).toEqual(['after:30'])
    expect([service.autoSettleDays.getSnapshot(), service.kept.getSnapshot().size, service.woke.getSnapshot().size, service.snoozed.getSnapshot().size]).toEqual([5, 0, 0, 0])
    expect([...service.settled.getSnapshot()]).toEqual([[sid('a'), 5]])
    expect(service.states.getSnapshot()).toEqual({ a: { settledAt: 5 } })
    expect(service.snoozeLeft(NOW + 90 * 60_000)).toBe('2h')
    await service.change({ action: 'settle', session: sid('b') })
    expect(service.settled.getSnapshot().has(sid('b'))).toBe(true)
    const heard = vi.fn()
    service.autoSettleDays.subscribe(heard)
    h.setSettings({ ...SETTINGS, autoSettleDays: 9 })
    expect([service.autoSettleDays.getSnapshot(), heard.mock.calls.length]).toEqual([9, 1])
  })

  it('uses the default settings until the stored ones arrive', async () => {
    const h = harness({ settings: undefined })
    await h.fiber.await()
    const service = h.ctx.get('deloChatStates') as DeloChatStates
    expect(service.autoSettleDays.getSnapshot()).toBe(DEFAULT_CHAT_STATES_SETTINGS.autoSettleDays)
    expect(service.snoozeOptions().map(option => option.id)).toEqual(['after:60', 'after:180', 'at:today:18:00', 'at:tomorrow:09:00', 'at:monday:09:00'])
  })

  it('reads at the interval the settings name, and re-arms it when they change', async () => {
    const h = harness({ settings: SETTINGS })
    await h.fiber.await()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.fetch).toHaveBeenCalledTimes(2)
    h.setSettings({ ...SETTINGS, refreshSeconds: 60 })
    await vi.advanceTimersByTimeAsync(59_000)
    expect(h.fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.fetch).toHaveBeenCalledTimes(3)
  })
})

describe('a chat\'s menu entries', () => {
  const target = (id: string) => ({ sessionId: sid(id), displayTitle: id })
  const signal = new AbortController().signal

  it('offer Snooze and Settle for a chat, and re-resolve when the states, the archive or the language change', async () => {
    const h = harness({ settings: SETTINGS })
    await h.fiber.await()
    const snooze = h.menus.get(MENU.snooze.id)!
    const settle = h.menus.get(MENU.settle.id)!
    expect(snooze.resolve(target('a'), signal).map(({ id, label, icon }) => [id, label, icon.key])).toEqual([['snooze', en['snooze.open'], MENU_ICON_KEYS.snooze]])
    expect(settle.resolve(target('a'), signal).map(({ id, label, icon }) => [id, label, icon.key])).toEqual([['settle', en.settle, MENU_ICON_KEYS.settle]])
    expect(snooze.observe(target('a'))).toHaveLength(3)
    expect(settle.observe(target('a'))).toHaveLength(3)
  })

  it('offer Wake now for a snoozed chat and Return to the list for a settled one, from the states as they are now', async () => {
    const h = harness({ settings: SETTINGS, chats: { s: { settledAt: 5 }, z: { snoozedAt: 1, snoozedUntil: NOW + 60_000 }, over: { snoozedAt: 1, snoozedUntil: NOW - 1 } } })
    await h.fiber.await()
    await vi.advanceTimersByTimeAsync(0)
    const label = (menu: string, id: string) => h.menus.get(menu)!.resolve(target(id), signal).map(entry => [entry.label, entry.icon.key])
    expect(label(MENU.snooze.id, 'z')).toEqual([[en['snooze.wake'], MENU_ICON_KEYS.snooze]])
    expect(label(MENU.snooze.id, 'over')).toEqual([[en['snooze.open'], MENU_ICON_KEYS.snooze]])
    expect(label(MENU.settle.id, 's')).toEqual([[en['settle.undo'], MENU_ICON_KEYS.settled]])
  })

  it('offer nothing on an archived chat', async () => {
    const h = harness({ settings: SETTINGS })
    await h.fiber.await()
    h.workspaces.set({ archivedSessionIds: [sid('x')] })
    expect(h.menus.get(MENU.snooze.id)!.resolve(target('x'), signal)).toEqual([])
    expect(h.menus.get(MENU.settle.id)!.resolve(target('x'), signal)).toEqual([])
  })

  const posts = (h: ReturnType<typeof harness>) => h.fetch.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]): unknown => JSON.parse(String(init?.body)))

  it('open the snooze dialog for a chat that is not snoozed, and wake one that is', async () => {
    const h = harness({ settings: SETTINGS, chats: { z: { snoozedAt: 1, snoozedUntil: NOW + 60_000 } } })
    await h.fiber.await()
    await vi.advanceTimersByTimeAsync(0)
    const dialog = h.face<CustomSnoozeInjected>('shell.overlay#delo-chat-states.snooze')
    h.menus.get(MENU.snooze.id)!.resolve(target('a'), signal)[0]!.run()
    expect(dialog.custom.getSnapshot()).toBe('a')
    dialog.closeCustom()
    expect(dialog.custom.getSnapshot()).toBeNull()
    h.menus.get(MENU.snooze.id)!.resolve(target('z'), signal)[0]!.run()
    expect(posts(h)).toEqual([{ action: 'wake', session: 'z' }])
  })

  it('read the states again when they run, since another browser can change a chat while a menu is open', async () => {
    const h = harness({ settings: SETTINGS, chats: { z: { snoozedAt: 1, snoozedUntil: NOW + 60_000 } } })
    await h.fiber.await()
    await vi.advanceTimersByTimeAsync(0)
    const service = h.ctx.get('deloChatStates') as DeloChatStates
    const dialog = h.face<CustomSnoozeInjected>('shell.overlay#delo-chat-states.snooze')
    const wake = h.menus.get(MENU.snooze.id)!.resolve(target('z'), signal)[0]!
    const settle = h.menus.get(MENU.settle.id)!.resolve(target('z'), signal)[0]!
    await service.change({ action: 'wake', session: sid('z') })
    await service.change({ action: 'settle', session: sid('z') })
    wake.run()
    expect(dialog.custom.getSnapshot()).toBe('z')
    settle.run()
    expect(posts(h)).toEqual([{ action: 'wake', session: 'z' }, { action: 'settle', session: 'z' }, { action: 'unsettle', session: 'z' }])
  })

  it('settle a chat, and return a settled one to the list', async () => {
    const h = harness({ settings: SETTINGS, chats: { s: { settledAt: 5 } } })
    await h.fiber.await()
    await vi.advanceTimersByTimeAsync(0)
    h.menus.get(MENU.settle.id)!.resolve(target('a'), signal)[0]!.run()
    h.menus.get(MENU.settle.id)!.resolve(target('s'), signal)[0]!.run()
    expect(posts(h)).toEqual([{ action: 'settle', session: 'a' }, { action: 'unsettle', session: 's' }])
  })
})

describe('the overlay entries and the settings section', () => {
  it('hand the hover button and the failure notice the states and the change, and the dialog the presets and the clock', async () => {
    const h = harness({ settings: SETTINGS, chats: { s: { settledAt: 5 } } })
    await h.fiber.await()
    await vi.advanceTimersByTimeAsync(0)
    const row = h.face<ChatStatesInjected>(`sidebar.workspaces.session.row.action#${ROW_ACTION.id}`)
    expect(row.states.getSnapshot()).toEqual({ s: { settledAt: 5 } })
    row.change({ action: 'settle', session: sid('t') })
    await vi.advanceTimersByTimeAsync(0)
    expect(row.states.getSnapshot()['t']).toEqual({ settledAt: 1 })
    const dialog = h.face<CustomSnoozeInjected>('shell.overlay#delo-chat-states.snooze')
    expect([dialog.presets(), dialog.locale(), dialog.now()]).toEqual([SETTINGS.snoozePresets, 'en', NOW])
  })

  it('show the failure notice for a change the harness did not take, until it is dismissed', async () => {
    const h = harness({ settings: SETTINGS })
    await h.fiber.await()
    await vi.advanceTimersByTimeAsync(0)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.fetch.mockImplementationOnce(async () => new Response('{}', { status: 500 }))
    const failure = h.face<ChatStatesInjected>('shell.overlay#delo-chat-states.failure')
    failure.change({ action: 'settle', session: sid('a') })
    await vi.advanceTimersByTimeAsync(0)
    expect(failure.failed.getSnapshot()).toBe(true)
    failure.dismiss()
    expect(failure.failed.getSnapshot()).toBe(false)
  })

  it('give the section the settings form, the language and a way to report a setting it could not save', async () => {
    const h = harness({ settings: SETTINGS })
    await h.fiber.await()
    const section = h.face<SnoozeSettingsInjected>(`settings.section#${SECTION.id}`)
    const failure = h.face<ChatStatesInjected>('shell.overlay#delo-chat-states.failure')
    expect([section.settings.getSnapshot().value, section.locale()]).toEqual([SETTINGS, 'en'])
    section.reportFailure()
    expect(failure.failed.getSnapshot()).toBe(true)
  })
})
