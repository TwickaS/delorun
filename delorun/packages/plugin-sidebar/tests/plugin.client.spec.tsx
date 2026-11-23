// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the 'sidebar.footer.action' SlotMap entry, whose owner props the undo notice reads.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentType } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALERT_CLASSES } from '@delorun/brand/alert'
import type { DelorunChatStates } from '@delorun/plugin-chat-states/client'
import { FootLauncher } from '../src/client/FootLauncher.tsx'
import { HeaderArt } from '../src/client/HeaderArt.tsx'
import {
  apply, createUndoLine, inject, LAUNCHER_PRIORITY, NS, optionalSource, preference, SECTION, snoozeEnds, stateActions, UNDO_NOTICE,
  type DelorunSidebar, type HeaderArtInjected, type SidebarInjected, type UndoNoticeInjected,
} from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { UndoNotice } from '../src/client/UndoNotice.tsx'
import { UpdateNoticeCard } from '../src/client/UpdateNotice.tsx'
import { DEFAULT_SIDEBAR_SETTINGS, MAX_WORKSPACE_ICONS, SIDEBAR_ROW_ID, type SidebarSettings } from '../src/config.ts'
import { DEFAULT_WORKSPACE_ICON } from '../src/workspace-icon.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

const t = makeTranslate(en)

interface Entry {
  readonly options: { name: string; id?: string; inject?: () => unknown; label?: () => string; order?: number; priority?: number; locale?: string }
  readonly component: ComponentType<never>
}

/** The services the studio half injects, recording what it registers and every layout change. */
function harness(options: {
  readonly studio?: boolean; readonly settings?: SidebarSettings | undefined; readonly served?: boolean; readonly set?: ConfigForm<SidebarSettings>['set']
  /** The page's remote media mode, as the connection service states it; no connection service without it. */
  readonly remoteMedia?: 'load' | 'placeholder'
  /** The release check's row: `on` by default; `loading` until `checkChange` is called. */
  readonly releaseCheck?: 'on' | 'off' | 'loading' | 'unavailable'
} = {}) {
  const ctx = new Context()
  if (options.remoteMedia !== undefined) ctx.provide('connection', { remoteMedia: options.remoteMedia } as never)
  const dictionaries = new Map<string, unknown>()
  ctx.provide('locale', {
    bind: () => t,
    register: (ns: string, dicts: unknown) => { dictionaries.set(ns, dicts); return () => { dictionaries.delete(ns) } },
  } as never)
  const entries = new Map<string, Entry>()
  ctx.provide('slots', {
    inject: (_: string, register: () => () => void) => register(),
    register: (registered: Entry['options'], component: ComponentType<never>) => {
      const key = `${registered.name}#${registered.id ?? ''}`
      entries.set(key, { options: registered, component })
      return () => { entries.delete(key) }
    },
  } as never)
  const uiWorkspace = { pinSession: vi.fn(() => Promise.resolve()), unpinSession: vi.fn(() => Promise.reject(new Error('down'))) }
  ctx.provide('uiWorkspace', uiWorkspace as never)
  const forms: string[] = []
  const listeners = new Set<() => void>()
  let snapshot: ConfigFormSnapshot<SidebarSettings> = {
    status: options.settings === undefined ? 'unavailable' : 'ready', value: options.settings, base: undefined, user: undefined, revision: 1, writable: true,
  }
  const defaultSet = vi.fn<ConfigForm<SidebarSettings>['set']>(() => Promise.resolve(true))
  const set = options.set ?? defaultSet
  const form: ConfigForm<SidebarSettings> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set, unset: () => Promise.resolve(true), mutate: () => Promise.resolve(true),
  }
  const checkListeners = new Set<() => void>()
  const releaseCheck = options.releaseCheck ?? 'on'
  let checkSnapshot: ConfigFormSnapshot<{ enabled: boolean }> = {
    status: releaseCheck === 'unavailable' ? 'unavailable' : releaseCheck === 'loading' ? 'loading' : 'ready',
    value: releaseCheck === 'on' || releaseCheck === 'off' ? { enabled: releaseCheck === 'on' } : undefined, base: undefined, user: undefined, revision: 1, writable: true,
  }
  const checkForm = {
    getSnapshot: () => checkSnapshot,
    subscribe: (listener: () => void) => { checkListeners.add(listener); return () => { checkListeners.delete(listener) } },
  }
  ctx.provide('configForms', {
    get: (id: string) => (id === 'delorun-update-check' ? checkForm : (forms.push(id), form)),
    whileServed: (_: readonly string[], register: () => () => void) => (options.served === false ? () => {} : register()),
  } as never)
  const menuTarget = createSnapshotStore<null>(null)
  ctx.provide('contextMenus', { active: menuTarget } as never)
  const shown: boolean[] = []
  const rows: boolean[] = []
  const placements: string[] = []
  const peeks: unknown[] = []
  ctx.provide('sidebarLayout', {
    setNewSessionButton: (value: boolean) => { shown.push(value); return () => { shown.push(true) } },
    setFootRow: (row: boolean) => { rows.push(row); return () => { rows.push(false) } },
    setPanelPlacement: (placement: string) => { placements.push(placement); return () => { placements.push('top') } },
    setHoverPeek: (value: unknown) => { peeks.push(value); return () => { peeks.push('restored') } },
  } as never)
  const widths: unknown[] = []
  ctx.provide('layout', {
    setSidebarWidths: (value: unknown) => { widths.push(value); return () => { widths.push('restored') } },
  } as never)
  const studio = options.studio === false ? undefined : ctx.provide('delorunStudio', {} as never)
  void studio
  const fiber = ctx.plugin({ name: 'delorun-sidebar', inject, apply })
  return {
    ctx, fiber, dictionaries, entries, forms, shown, rows, placements, peeks, widths, uiWorkspace, setCalls: defaultSet.mock.calls,
    checkChange: (enabled: boolean) => { checkSnapshot = { ...checkSnapshot, status: 'ready', value: { enabled } }; for (const listener of [...checkListeners]) listener() },
    change: (value: SidebarSettings | undefined) => { snapshot = { ...snapshot, value, status: 'ready' }; for (const listener of [...listeners]) listener() },
    face: <T,>(key: string): T => {
      const entry = entries.get(key)
      if (entry?.options.inject === undefined) throw new Error(`no injected entry ${key}`)
      return entry.options.inject() as T
    },
  }
}

const ICON_X = { ...DEFAULT_WORKSPACE_ICON, letters: 'x' }
const ICON_Y = { ...DEFAULT_WORKSPACE_ICON, letters: 'y' }

describe('the studio half', () => {
  it('registers its copy, the art, the Sidebar section, the list, the foot, the Settings button and the layout, and removes them on disposal', async () => {
    const h = harness({ settings: { ...DEFAULT_SIDEBAR_SETTINGS, width: 300 } })
    await h.fiber.await()
    expect(h.dictionaries.get(NS)).toEqual({ en, zh })
    expect(h.forms).toEqual([SIDEBAR_ROW_ID])
    expect([...h.entries.keys()].sort()).toEqual([
      'settings.launcher#', `settings.section#${SECTION.id}`, 'sidebar.backdrop#', `sidebar.footer.action#${UNDO_NOTICE.id}`, 'sidebar.workspaces.list#',
    ])
    expect(h.entries.get('settings.launcher#')?.options.priority).toBe(LAUNCHER_PRIORITY)
    expect(h.entries.get(`sidebar.footer.action#${UNDO_NOTICE.id}`)?.options.order).toBe(UNDO_NOTICE.order)
    const section = h.entries.get(`settings.section#${SECTION.id}`)?.options
    expect([section?.label?.(), section?.order]).toEqual([en['settings.nav'], SECTION.order])
    expect(h.entries.get('sidebar.backdrop#')?.component).toBe(HeaderArt)
    expect(h.shown).toEqual([false])
    expect(h.rows).toEqual([true])
    expect(h.placements).toEqual(['footer'])
    expect(h.widths).toEqual([{ default: 300, min: 264 }])
    await h.fiber.dispose()
    expect([h.dictionaries.size, h.entries.size]).toEqual([0, 0])
    expect(h.shown).toEqual([false, true])
    expect(h.rows).toEqual([true, false])
    expect(h.placements).toEqual(['footer', 'top'])
    expect(h.widths).toEqual([{ default: 300, min: 264 }, 'restored'])
  })

  it('registers nothing, changes no layout, and keeps no form while the Delorun look is off', async () => {
    const h = harness({ settings: DEFAULT_SIDEBAR_SETTINGS, studio: false })
    await Promise.resolve()
    expect([h.dictionaries.size, h.entries.size, h.forms.length, h.shown.length, h.rows.length, h.placements.length, h.widths.length]).toEqual([0, 0, 0, 0, 0, 0, 0])
    h.ctx.provide('delorunStudio', {} as never)
    await vi.waitFor(() => { expect(h.entries.size).toBe(5) })
    expect([h.shown, h.rows, h.placements]).toEqual([[false], [true], ['footer']])
  })

  it('undoes every sidebar and layout change when the Delorun look goes away', async () => {
    const ctx = new Context()
    const h = harness({ studio: false, settings: DEFAULT_SIDEBAR_SETTINGS })
    void ctx
    const look = h.ctx.plugin({ name: 'look', apply: (child: Context) => { child.provide('delorunStudio', {} as never) } })
    await look.await()
    await vi.waitFor(() => { expect(h.entries.size).toBe(5) })
    await look.dispose()
    await vi.waitFor(() => { expect(h.entries.size).toBe(0) })
    expect([h.shown, h.rows, h.placements, h.widths]).toEqual([[false, true], [true, false], ['footer', 'top'], [{ default: 256, min: 256 }, 'restored']])
  })

  it('stays an active entry under the stock look: the Delorun look is injected inside apply, not required', () => {
    expect(inject).not.toContain('delorunStudio')
  })

  it('shows the Sidebar section only while the settings are served, with the settings as its only injection', async () => {
    const h = harness({ served: false })
    await h.fiber.await()
    expect(h.entries.has(`settings.section#${SECTION.id}`)).toBe(false)
    const served = harness({ settings: DEFAULT_SIDEBAR_SETTINGS })
    await served.fiber.await()
    expect(Object.keys(served.face<object>(`settings.section#${SECTION.id}`))).toEqual(['settings'])
  })

  it('follows the stored width, and keeps the layout call when another setting changes', async () => {
    const h = harness({ settings: DEFAULT_SIDEBAR_SETTINGS })
    await h.fiber.await()
    h.change({ ...DEFAULT_SIDEBAR_SETTINGS, artSeed: 7 })
    expect(h.widths).toEqual([{ default: 256, min: 256 }])
    h.change({ ...DEFAULT_SIDEBAR_SETTINGS, width: 240 })
    expect(h.widths).toEqual([{ default: 256, min: 256 }, { default: 240, min: 240 }])
    await h.fiber.dispose()
    expect(h.widths.at(-1)).toBe('restored')
  })

  it('hands the hover peek to the layout and follows live changes to it, swapping before it restores', async () => {
    const h = harness({ settings: DEFAULT_SIDEBAR_SETTINGS })
    await h.fiber.await()
    expect(h.peeks).toEqual([{ enabled: true, delayMs: 350 }])
    h.change({ ...DEFAULT_SIDEBAR_SETTINGS, artSeed: 7 })
    expect(h.peeks).toEqual([{ enabled: true, delayMs: 350 }])
    h.change({ ...DEFAULT_SIDEBAR_SETTINGS, peekOnHover: false, peekDelayMs: 0 })
    expect(h.peeks).toEqual([{ enabled: true, delayMs: 350 }, { enabled: false, delayMs: 0 }, 'restored'])
    await h.fiber.dispose()
    expect(h.peeks.at(-1)).toBe('restored')
  })

  it('uses the default settings until the stored ones arrive', async () => {
    const h = harness({ settings: undefined })
    await h.fiber.await()
    const list = h.face<SidebarInjected>('sidebar.workspaces.list#')
    expect(list.hooks.settings.getSnapshot()).toEqual(DEFAULT_SIDEBAR_SETTINGS)
    expect(list.hooks.settings.getSnapshot()).toBe(list.hooks.settings.getSnapshot())
    expect(h.widths).toEqual([{ default: 256, min: 256 }])
    h.change({ ...DEFAULT_SIDEBAR_SETTINGS, view: 'folders' })
    expect(list.hooks.settings.getSnapshot().view).toBe('folders')
    h.change(undefined)
    expect(list.hooks.settings.getSnapshot()).toEqual(DEFAULT_SIDEBAR_SETTINGS)
  })

  it('gives the list the open menu, falls back without chat states, and saves, clears and reports workspace icons and pins', async () => {
    const h = harness({ settings: { ...DEFAULT_SIDEBAR_SETTINGS, workspaceIcons: { w1: ICON_X, w2: ICON_Y } } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await h.fiber.await()
    const list = h.face<SidebarInjected>('sidebar.workspaces.list#')
    expect(list.hooks.menuTarget.getSnapshot()).toBeNull()
    expect([list.states(), list.hooks.chatStatesReady.getSnapshot(), list.hooks.snoozed.getSnapshot().size, list.hooks.autoSettleDays.getSnapshot()]).toEqual([null, false, 0, 0])
    list.setWorkspaceIcon('w1', DEFAULT_WORKSPACE_ICON)
    list.setWorkspaceIcon('w2', null)
    expect(h.setCalls).toEqual([
      ['workspaceIcons', { w2: ICON_Y, w1: DEFAULT_WORKSPACE_ICON }],
      ['workspaceIcons', { w1: ICON_X }],
    ])
    h.uiWorkspace.pinSession.mockRejectedValueOnce(new Error('down'))
    list.pin(SessionId('a'))
    list.unpin(SessionId('a'))
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith('delorun sidebar: the chat was not pinned', expect.any(Error)) })
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith('delorun sidebar: the chat was not unpinned', expect.any(Error)) })
    expect(h.face<HeaderArtInjected>('sidebar.backdrop#').hooks.settings).toBe(list.hooks.settings)
    expect(h.uiWorkspace.pinSession).toHaveBeenCalledWith('a')
  })

  it('keeps the saved icons within the bound, dropping the oldest, and prunes the icons of removed workspaces only when some are stale', async () => {
    const icons = Object.fromEntries(Array.from({ length: MAX_WORKSPACE_ICONS }, (_, index) => [`w${String(index)}`, ICON_X]))
    const h = harness({ settings: { ...DEFAULT_SIDEBAR_SETTINGS, workspaceIcons: icons } })
    await h.fiber.await()
    const list = h.face<SidebarInjected>('sidebar.workspaces.list#')
    list.setWorkspaceIcon('fresh', DEFAULT_WORKSPACE_ICON)
    const saved = h.setCalls[0]?.[1] as Record<string, unknown>
    expect(Object.keys(saved)).toHaveLength(MAX_WORKSPACE_ICONS)
    expect([Object.keys(saved)[0], Object.keys(saved).at(-1)]).toEqual(['w1', 'fresh'])
    list.pruneIcons(new Set(['w0', 'w1', 'w2']))
    expect(h.setCalls[1]).toEqual(['workspaceIcons', { w0: ICON_X, w1: ICON_X, w2: ICON_X }])
    list.pruneIcons(new Set(Object.keys(icons)))
    expect(h.setCalls).toHaveLength(2)
  })

  it('provides ctx.delorunSidebar while the list is mounted, following the owner\'s latest props, and withdraws it', async () => {
    const h = harness({ settings: DEFAULT_SIDEBAR_SETTINGS })
    await h.fiber.await()
    const list = h.face<SidebarInjected>('sidebar.workspaces.list#')
    expect(h.ctx.get('delorunSidebar')).toBeUndefined()
    const first = vi.fn()
    const owner = { current: { canAddWorkspace: true, addWorkspace: first } }
    const detach = list.attach(owner)
    const service = h.ctx.get('delorunSidebar') as DelorunSidebar
    expect(service.canAddWorkspace()).toBe(true)
    service.addWorkspace()
    const second = vi.fn()
    owner.current = { canAddWorkspace: false, addWorkspace: second }
    expect(service.canAddWorkspace()).toBe(false)
    service.addWorkspace()
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 1])
    detach()
    expect(h.ctx.get('delorunSidebar')).toBeUndefined()
    list.attach(owner)
    expect(h.ctx.get('delorunSidebar')).toBeDefined()
    await h.fiber.dispose()
    expect(h.ctx.get('delorunSidebar')).toBeUndefined()
  })

  it('reports the pruning of icons that the harness did not accept, or could not be reached', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const settings = { ...DEFAULT_SIDEBAR_SETTINGS, workspaceIcons: { gone: ICON_X } }
    const refused = harness({ settings, set: vi.fn(() => Promise.resolve(false)) })
    await refused.fiber.await()
    refused.face<SidebarInjected>('sidebar.workspaces.list#').pruneIcons(new Set())
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith('delorun sidebar: the icons of removed workspaces were not dropped') })
    const failed = harness({ settings, set: vi.fn(() => Promise.reject(new Error('down'))) })
    await failed.fiber.await()
    failed.face<SidebarInjected>('sidebar.workspaces.list#').pruneIcons(new Set())
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith('delorun sidebar: the icons of removed workspaces were not dropped', expect.any(Error)) })
  })

  it('reports a workspace icon the harness did not accept, or could not be reached', async () => {
    const refused = harness({ settings: DEFAULT_SIDEBAR_SETTINGS, set: vi.fn(() => Promise.resolve(false)) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await refused.fiber.await()
    refused.face<SidebarInjected>('sidebar.workspaces.list#').setWorkspaceIcon('w', null)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith('delorun sidebar: the workspace icon was not saved') })
    const failed = harness({ settings: DEFAULT_SIDEBAR_SETTINGS, set: vi.fn(() => Promise.reject(new Error('down'))) })
    await failed.fiber.await()
    failed.face<SidebarInjected>('sidebar.workspaces.list#').setWorkspaceIcon('w', null)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith('delorun sidebar: the workspace icon was not saved', expect.any(Error)) })
  })

  it('rebuilds the row actions only when the chat-states service changes, and reads its sources once it is there', async () => {
    const h = harness({ settings: DEFAULT_SIDEBAR_SETTINGS })
    await h.fiber.await()
    const list = h.face<SidebarInjected>('sidebar.workspaces.list#')
    const states = { a: { snoozedUntil: 9 } }
    const service = {
      states: { getSnapshot: () => states, subscribe: () => () => {} },
      snoozed: createSnapshotStore(new Map([[SessionId('a'), 1]])), settled: createSnapshotStore(new Map()), woke: createSnapshotStore(new Map()),
      kept: createSnapshotStore(new Map()), autoSettleDays: createSnapshotStore(4),
      change: vi.fn(() => Promise.resolve()), snoozeOptions: () => [], snoozeLeft: () => '1h', openCustom: vi.fn(),
    }
    const provider = h.ctx.plugin({ name: 'states', apply: (child: Context) => { child.provide('delorunChatStates', service as never) } })
    await provider.await()
    const stopReady = list.hooks.chatStatesReady.subscribe(() => {})
    stopReady()
    const first = list.states()
    expect(first).not.toBeNull()
    expect(list.states()).toBe(first)
    expect([list.hooks.chatStatesReady.getSnapshot(), list.hooks.autoSettleDays.getSnapshot(), list.hooks.snoozed.getSnapshot().size, [...list.hooks.snoozedUntil.getSnapshot()]])
      .toEqual([true, 4, 1, [['a', 9]]])
    expect([list.hooks.settled.getSnapshot().size, list.hooks.woke.getSnapshot().size, list.hooks.kept.getSnapshot().size]).toEqual([0, 0, 0])
    expect(h.face<UndoNoticeInjected>(`sidebar.footer.action#${UNDO_NOTICE.id}`).undoLine.getSnapshot()).toBeNull()
    await provider.dispose()
    expect(list.states()).toBeNull()
  })
})

describe('the update notice in the studio', () => {
  const NOTICE = {
    running: { delorun: '0.1.2', dsh: '0.2.2' }, release: { delorun: '0.1.3', dsh: '0.2.2', channel: 'stable', security: true }, kind: 'patch', disables: 0,
  }

  /** Answer every read of the notice route with the notice. */
  function serve() {
    const fetch = vi.fn((_input: string) => Promise.resolve(new Response(JSON.stringify({ notice: NOTICE }))))
    vi.stubGlobal('fetch', fetch)
    return fetch
  }

  it('reads the notice when the studio starts, on each new connection and at the configured interval, and stops when disposed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const fetch = serve()
    const h = harness({ settings: { ...DEFAULT_SIDEBAR_SETTINGS, updateNoticeRefreshMinutes: 5 } })
    await h.fiber.await()
    const face = h.face<SidebarInjected>('sidebar.workspaces.list#').updateNotice
    await vi.waitFor(() => { expect(face.notice.getSnapshot()?.release.delorun).toBe('0.1.3') })
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(['api/delorunUpdateCheck.notice'])
    h.ctx.emit('connection/reset')
    expect(fetch).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(5 * 60_000)
    expect(fetch).toHaveBeenCalledTimes(3)
    h.change({ ...DEFAULT_SIDEBAR_SETTINGS, updateNoticeRefreshMinutes: 60 })
    vi.advanceTimersByTime(5 * 60_000)
    expect(fetch).toHaveBeenCalledTimes(3)
    await h.fiber.dispose()
    h.ctx.emit('connection/reset')
    vi.advanceTimersByTime(24 * 60 * 60_000)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('does not ask for the notice while the release check is off or unread, and asks once it is on', async () => {
    const fetch = serve()
    const h = harness({ settings: DEFAULT_SIDEBAR_SETTINGS, releaseCheck: 'loading' })
    await h.fiber.await()
    expect(fetch).not.toHaveBeenCalled()
    h.checkChange(false)
    expect(fetch).not.toHaveBeenCalled()
    h.checkChange(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    const face = h.face<SidebarInjected>('sidebar.workspaces.list#').updateNotice
    await vi.waitFor(() => { expect(face.notice.getSnapshot()?.release.delorun).toBe('0.1.3') })
    h.checkChange(false)
    expect(face.notice.getSnapshot()).toBeNull()
    h.ctx.emit('connection/reset')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not ask for the notice while the release check row is not exposed, as when the check is off', async () => {
    const fetch = serve()
    const h = harness({ settings: DEFAULT_SIDEBAR_SETTINGS, releaseCheck: 'unavailable' })
    await h.fiber.await()
    expect(fetch).not.toHaveBeenCalled()
    h.ctx.emit('connection/reset')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('hides the notice for the dismissed release on this computer, and keeps the dismissal in the browser', async () => {
    serve()
    const h = harness({ settings: DEFAULT_SIDEBAR_SETTINGS, remoteMedia: 'load' })
    await h.fiber.await()
    const face = h.face<SidebarInjected>('sidebar.workspaces.list#').updateNotice
    render(<UpdateNoticeCard face={face} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: en['update.dismiss'] }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(window.localStorage.getItem('delorun:sidebar:update.dismissed')).toBe('0.1.3')
  })

  it('offers the close button on a page a reach listener served, which keeps the dismissal in that browser and calls no Host route', async () => {
    const fetch = serve()
    const h = harness({ settings: DEFAULT_SIDEBAR_SETTINGS, remoteMedia: 'placeholder' })
    await h.fiber.await()
    const face = h.face<SidebarInjected>('sidebar.workspaces.list#').updateNotice
    expect(face.remote).toBe(true)
    render(<UpdateNoticeCard face={face} t={t} />)
    expect((await screen.findByRole('status')).textContent).toBe(`Delorun 0.1.3${en['update.whatsNew']}`)
    const reads = fetch.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: en['update.dismiss'] }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(window.localStorage.getItem('delorun:sidebar:update.dismissed')).toBe('0.1.3')
    expect(fetch.mock.calls.length).toBe(reads)
  })

})

describe('a viewer\'s preferences', () => {
  it('keeps them in the browser, and keeps the default when storage refuses', () => {
    preference.write('shelf.settled', 'open')
    expect(preference.read('shelf.settled')).toBe('open')
    expect(window.localStorage.getItem('delorun:sidebar:shelf.settled')).toBe('open')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(preference.read('shelf.settled')).toBeNull()
    preference.write('shelf.settled', 'folded')
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('the optional services', () => {
  it('follows a service as it arrives and leaves, with the fallback while it is absent', async () => {
    const ctx = new Context()
    let value = 1
    const listeners = new Set<() => void>()
    const own = { getSnapshot: () => value, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
    const source = optionalSource<{ own: typeof own }, number>(ctx, 'delorunChatStates', service => service.own, 0)
    const heard = vi.fn()
    const stop = source.subscribe(heard)
    expect(source.getSnapshot()).toBe(0)
    const fiber = ctx.plugin({ name: 'states', apply: (child: Context) => { child.provide('delorunChatStates', { own } as never) } })
    await fiber.await()
    expect(source.getSnapshot()).toBe(1)
    expect(source.getSnapshot()).toBe(1)
    value = 2
    for (const listener of listeners) listener()
    expect(heard).toHaveBeenCalled()
    await fiber.dispose()
    expect(source.getSnapshot()).toBe(0)
    stop()
    expect(listeners.size).toBe(0)
  })

  it('ignores another service coming and going', async () => {
    const ctx = new Context()
    const source = optionalSource<object, number>(ctx, 'delorunChatStates', () => ({ getSnapshot: () => 1, subscribe: () => () => {} }), 0)
    const heard = vi.fn()
    const stop = source.subscribe(heard)
    const other = ctx.plugin({ name: 'other', apply: (child: Context) => { child.provide('somethingElse' as never, {} as never) } })
    await other.await()
    expect(heard).not.toHaveBeenCalled()
    stop()
  })

  it('derives each snooze\'s end, and the row actions over the chat-states service', () => {
    let states: Record<string, { snoozedUntil?: number; settledAt?: number }> = { a: { snoozedUntil: 5 }, b: { settledAt: 1 } }
    const change = vi.fn<DelorunChatStates['change']>(() => Promise.resolve())
    const service = {
      states: { getSnapshot: () => states, subscribe: () => () => {} },
      change, snoozeOptions: () => [], snoozeLeft: () => '1h', openCustom: vi.fn(),
    } as Partial<DelorunChatStates> as DelorunChatStates
    const ends = snoozeEnds(service)
    const first = ends.getSnapshot()
    expect([...first]).toEqual([[SessionId('a'), 5]])
    expect(ends.getSnapshot()).toBe(first)
    states = {}
    expect(ends.getSnapshot().size).toBe(0)
    expect(typeof ends.subscribe(() => {})).toBe('function')
    const rows = stateActions(service)
    const id = SessionId('a')
    rows.settle(id); rows.unsettle(id); rows.snooze(id, 9); rows.wake(id); rows.seen(id); rows.openCustom(id)
    expect(change.mock.calls.map(([request]) => request)).toEqual([
      { action: 'settle', session: id }, { action: 'unsettle', session: id }, { action: 'snooze', session: id, until: 9 },
      { action: 'wake', session: id }, { action: 'seen', session: id },
    ])
    expect([rows.snoozeLeft(1), rows.snoozeOptions()]).toEqual(['1h', []])
  })
})

describe('the foot', () => {
  it('opens Settings from the 32px button, and names its shortcut and state', () => {
    const openSettings = vi.fn()
    const { rerender } = render(<FootLauncher settingsOpen={false} settingsShortcut={{ keys: ['Mod', ','], aria: 'Meta+,' }} openSettings={openSettings} t={t} />)
    const button = screen.getByRole('button', { name: en['foot.settings'] })
    expect(button.getAttribute('aria-keyshortcuts')).toBe('Meta+,')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(button)
    expect(openSettings).toHaveBeenCalledOnce()
    rerender(<FootLauncher settingsOpen openSettings={openSettings} t={t} />)
    expect(screen.getByRole('button', { name: en['foot.settings'] }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: en['foot.settings'] }).hasAttribute('aria-keyshortcuts')).toBe(false)
  })

  it('offers the last change to take back until it is taken back, and nothing in the rail', () => {
    const undoLine = createUndoLine()
    const undo = vi.fn()
    const { rerender } = render(<UndoNotice wide undoLine={undoLine} t={t} />)
    expect(screen.queryByRole('status')).toBeNull()
    act(() => { undoLine.set({ kind: 'pin', key: 1, undo }) })
    expect(screen.getByRole('status').textContent).toBe(`${en['undo.pin']}${en.undo}`)
    // The undo line is the studio's alert card: a success row whose one action is Undo.
    expect(screen.getByRole('status').classList.contains(ALERT_CLASSES.root)).toBe(true)
    expect(screen.getByRole('status').getAttribute('data-kind')).toBe('success')
    expect(screen.getByRole('status').getAttribute('data-variant')).toBe('banner')
    rerender(<UndoNotice wide={false} undoLine={undoLine} t={t} />)
    expect(screen.queryByRole('status')).toBeNull()
    rerender(<UndoNotice wide undoLine={undoLine} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: en.undo }))
    expect(undo).toHaveBeenCalledOnce()
    expect(undoLine.getSnapshot()).toBeNull()
  })

  it('stops telling a listener of the undo line once it unsubscribes', () => {
    const undoLine = createUndoLine()
    const heard = vi.fn()
    const stop = undoLine.subscribe(heard)
    undoLine.set(null)
    stop()
    undoLine.set(null)
    expect(heard).toHaveBeenCalledOnce()
  })
})

describe('the copy', () => {
  it('has a Chinese text for every English key and no key that only Chinese has', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en)) expect(zh[key as keyof typeof zh].length).toBeGreaterThan(0)
  })

  it('keeps the same placeholders in both languages', () => {
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
    for (const key of Object.keys(en) as (keyof typeof en)[]) expect(holes(zh[key]), key).toEqual(holes(en[key]))
  })

  it('names no internal product in English except in the credit, and uses plain sentence-case words', () => {
    for (const [key, text] of Object.entries(en)) {
      if (key === 'settings.credit') continue
      expect(text, key).not.toMatch(/upstream|T3 Code|Session\b/i)
    }
    expect(en['action.dismissWoke']).toBe('Mark as seen')
    expect(Object.keys(en).filter(key => key.startsWith('settings.stock'))).toEqual([])
  })

  it('uses the glossary in Chinese: processed, postponed, wake now, ages with 前, the original width', () => {
    const all = Object.values(zh).join('\n')
    expect(all).not.toMatch(/了结|稍后|上游|现在恢复/)
    expect([zh['action.settle'], zh['shelf.settled'], zh['shelf.snoozed'], zh['action.wake']]).toEqual(['标为已处理', '已处理', '已延后', '立即唤醒'])
    for (const key of ['time.minutes', 'time.hours', 'time.days', 'time.months', 'time.years'] as const) expect(zh[key], key).toMatch(/前$/)
    expect(zh['settings.width.lead']).toContain('原版的 280 px')
    expect(zh['settings.art.lead']).toContain('点“随机生成”可重新绘制场景')
    expect([zh['settings.palette.grove'], zh['settings.palette.ocean'], zh['settings.palette.ember'], zh['settings.palette.iris'], zh['icon.style.soft']])
      .toEqual(['林地', '海洋', '余烬', '鸢尾', '柔和'])
  })
})
