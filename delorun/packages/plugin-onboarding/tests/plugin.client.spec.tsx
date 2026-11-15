// @vitest-environment jsdom
import { Context, FiberState } from '@deepseek-ai/cordis'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore, type ComponentType } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addWorkspaceFolder, apply, hostApi, inject, KEY_BANNER_ENTRY, RENAME_TOOL, SET_ASIDE_ENTRY, type SetAsideInjected, loadSetupRecord, NS, ONBOARDING_STEP, SHOW_AGAIN_ROW, STARTER_ENTRY, type KeyBannerInjected, type OnboardingInjected, type OnboardingStep, type OnboardingStepEntryProps, type ShowAgainRowProps,
  type StarterInjected, type ShowAgainInjected,
} from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { ADD_WORKSPACE_PATH, NO_RECORD, SETUP_RECORD_PATH } from '../src/wire.ts'
import { ONBOARDING_ROW_ID, THEME_ROW_ID, type OnboardingSettings } from '../src/config.ts'
import { liveForm, settings, t, THEME } from './fixtures.client.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

interface Registered {
  readonly options: { readonly name: string; readonly id?: string; readonly key?: string; readonly order?: number; readonly locale?: string; readonly inject?: () => unknown }
  readonly component: unknown
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

/** Every service the plugin reads, faked, with the studio look on unless asked otherwise. */
async function harness(options: { readonly studio?: boolean; readonly provide?: Record<string, unknown>; readonly late?: Record<string, unknown>; readonly progress?: OnboardingSettings } = {}) {
  const ctx = new Context()
  const dictionaries = new Map<string, unknown>()
  const bound: string[] = []
  const language = { active: 'en', locales: [{ id: 'en', label: 'English' }], revision: 1 }
  const localeListeners = new Set<() => void>()
  const setLocale = vi.fn()
  ctx.provide('locale', {
    bind: (ns: string) => { bound.push(ns); return makeTranslate(ns === 'delorunPrivacy' ? { 'notice.title': 'Preview', 'notice.body': 'First.\n\nSecond.' } : en) },
    register: (ns: string, dicts: unknown) => { dictionaries.set(ns, dicts); return () => { dictionaries.delete(ns) } },
    getLocale: () => language,
    subscribe: (listener: () => void) => { localeListeners.add(listener); return () => { localeListeners.delete(listener) } },
    setLocale,
    resolveText: (text: string | { en: string }) => (typeof text === 'string' ? text : text.en),
  } as never)
  const entries = new Map<string, Registered>()
  ctx.provide('slots', {
    inject: (_: string, register: () => () => void) => register(),
    register: (registered: Registered['options'], component: unknown) => {
      const key = `${registered.name}#${registered.id ?? registered.key}`
      entries.set(key, { options: registered, component })
      return () => { entries.delete(key) }
    },
  } as never)
  const progress = liveForm<OnboardingSettings>(options.progress ?? settings())
  const theme = liveForm(THEME)
  ctx.provide('configForms', {
    get: (id: string) => (id === ONBOARDING_ROW_ID ? progress.form : id === THEME_ROW_ID ? theme.form : (() => { throw new Error(`unexpected row ${id}`) })()),
    whileServed: (ids: readonly string[], register: () => () => void) => {
      served.ids = ids
      served.register = register
      return () => { served.off() }
    },
  } as never)
  const served = { ids: [] as readonly string[], register: (): (() => void) => () => {}, off: () => {}, on: () => { served.off = served.register() } }
  const preference = { value: 'system' }
  ctx.provide('theme', {
    getTheme: () => ({ preference: preference.value }),
    setTheme: (next: string) => { preference.value = next; ctx.emit('theme/change' as never) },
  } as never)
  // The providers step's remote namespaces are only read when the step runs, so the activation needs them present.
  for (const name of ['remote', 'remote.credentials', 'remote.llm', 'remote.settings']) ctx.provide(name as never, {} as never)
  const useStockLook = vi.fn(() => Promise.resolve(true))
  const delorunStudio = options.studio === false ? undefined : { useStockLook }
  if (delorunStudio !== undefined) ctx.provide('delorunStudio', delorunStudio as never)
  const provided = { ...options.late === undefined ? { settingsShell: { openOnboarding: vi.fn() } } : {}, ...options.provide }
  for (const [name, value] of Object.entries(provided)) ctx.provide(name as never, value as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  // A service that arrives after this plugin was loaded, as the Settings shell's own plugin does.
  if (options.late !== undefined) {
    const later = ctx.plugin({ apply: (scope: Context) => { for (const [name, value] of Object.entries(options.late ?? {})) scope.provide(name as never, value as never) } })
    await later.await()
  }
  await fiber.await()
  return { ctx, fiber, dictionaries, bound, entries, progress, theme, served, setLocale, localeListeners, useStockLook, preference }
}

const face = <T,>(entries: Map<string, Registered>, key: string): T => {
  const entry = entries.get(key)
  if (entry?.options.inject === undefined) throw new Error(`no face for ${key}`)
  return entry.options.inject() as T
}
const STEP_KEY = `settings.onboarding#${ONBOARDING_STEP.id}`
const ROW_KEY = `settings.general.item#${SHOW_AGAIN_ROW.id}`
const DOCK_KEY = `conversation.input.dock#${STARTER_ENTRY.id}`
const BANNER_KEY = `conversation.input.dock#${KEY_BANNER_ENTRY.id}`
const RENAME_KEY = `tool.call.toolview#${RENAME_TOOL}`
const SET_ASIDE_KEY = `conversation.input.dock#${SET_ASIDE_ENTRY.id}`

describe('the stock look', () => {
  it('registers nothing until the Delorun look provides delorunStudio, and everything leaves with it', async () => {
    const { ctx, dictionaries, entries, served, fiber } = await harness({ studio: false })
    expect(inject).not.toContain('delorunStudio')
    expect([dictionaries.size, entries.size, served.ids]).toEqual([0, 0, []])
    expect(ctx.get('delorunOnboarding')).toBeUndefined()
    const studio = ctx.plugin({ apply: (scope: Context) => { scope.provide('delorunStudio', { useStockLook: () => Promise.resolve(true) } as never) } })
    await studio.await()
    expect(dictionaries.has(NS)).toBe(true)
    expect(served.ids).toEqual([ONBOARDING_ROW_ID])
    served.on()
    expect(entries.size).toBe(6)
    await studio.dispose()
    expect([dictionaries.size, entries.size, ctx.get('delorunOnboarding')]).toEqual([0, 0, undefined])
    await fiber.dispose()
  })

  it('removes its dictionaries, service and registrations when it is disposed', async () => {
    const { dictionaries, entries, served, fiber, ctx } = await harness()
    served.on()
    expect(ctx.get('delorunOnboarding')).toBeDefined()
    await fiber.dispose()
    expect([dictionaries.size, entries.size, ctx.get('delorunOnboarding')]).toEqual([0, 0, undefined])
  })
})

describe('the registrations', () => {
  it('register English and Chinese copy under its namespace', async () => {
    const { dictionaries } = await harness()
    expect(dictionaries.get(NS)).toEqual({ en, zh })
  })

  it('wait until the host serves the row, register the step before the preview notice\'s own, the General row and the starter prompts, and leave when the row goes', async () => {
    const { entries, served } = await harness()
    // The rename row does not wait for the row: it draws a tool call, not onboarding.
    expect([...entries.keys()]).toEqual([RENAME_KEY])
    expect(entries.get(RENAME_KEY)?.options).toMatchObject({ name: 'tool.call.toolview', key: 'rename_workspace', locale: NS })
    served.on()
    expect([...entries.keys()].toSorted()).toEqual([BANNER_KEY, DOCK_KEY, RENAME_KEY, ROW_KEY, SET_ASIDE_KEY, STEP_KEY].toSorted())
    expect(entries.get(STEP_KEY)?.options).toMatchObject({ name: 'settings.onboarding', id: 'delorun-onboarding', order: -200, locale: NS })
    // bundle-local's step registers at -100, so this one is mounted first.
    expect(ONBOARDING_STEP.order).toBeLessThan(-100)
    expect(entries.get(ROW_KEY)?.options).toMatchObject({ name: 'settings.general.item', id: 'delorun-onboarding', locale: NS })
    expect(entries.get(DOCK_KEY)?.options).toMatchObject({ name: 'conversation.input.dock', locale: NS })
    served.off()
    expect([...entries.keys()]).toEqual([RENAME_KEY])
  })

  it('open onboarding explicitly from the General row by the step\'s id', async () => {
    const openOnboarding = vi.fn()
    const { entries, served } = await harness({ provide: { settingsShell: { openOnboarding } } })
    served.on()
    face<ShowAgainInjected>(entries, ROW_KEY).show()
    expect(openOnboarding).toHaveBeenCalledExactlyOnceWith('delorun-onboarding')
  })
})

describe('the steps other plugins add', () => {
  const step = (id: string, order: number): OnboardingStep => ({ id, order, title: () => id, component: () => null })

  it('are kept in the service, replaced by id, and removed with their disposer', async () => {
    const { entries, served, ctx } = await harness()
    served.on()
    const injected = face<OnboardingInjected>(entries, STEP_KEY)
    const service = ctx.get('delorunOnboarding')
    const first = step('a.one', 600)
    const dispose = service?.registerStep(first)
    expect(injected.extra.getSnapshot()).toEqual([first])
    const replacement = step('a.one', 700)
    service?.registerStep(replacement)
    service?.registerStep(step('b.two', 650))
    expect(injected.extra.getSnapshot().map(each => [each.id, each.order])).toEqual([['a.one', 700], ['b.two', 650]])
    dispose?.()
    expect(injected.extra.getSnapshot().map(each => each.id)).toEqual(['a.one', 'b.two'])
    const notified = vi.fn()
    injected.extra.subscribe(notified)
    service?.registerStep(step('c.three', 900))
    expect(notified).toHaveBeenCalled()
  })
})

describe('the services the dialog draws with', () => {
  it('give the language, the colour scheme and the look from the studio\'s own services', async () => {
    const { entries, served, setLocale, theme, useStockLook, preference, ctx } = await harness()
    served.on()
    const { services } = face<OnboardingInjected>(entries, STEP_KEY)
    expect(services.language.getSnapshot().active).toBe('en')
    const listener = vi.fn()
    services.language.subscribe(listener)
    services.language.setLocale('zh')
    expect(setLocale).toHaveBeenCalledWith('zh')
    expect(services.scheme.get()).toBe('system')
    const changed = vi.fn()
    const off = services.scheme.subscribe(changed)
    services.scheme.set('dark')
    expect(preference.value).toBe('dark')
    expect(changed).toHaveBeenCalledOnce()
    off()
    ctx.emit('theme/change' as never)
    expect(changed).toHaveBeenCalledOnce()
    expect(services.look.settings).toBe(theme.form)
    await services.look.useStockLook()
    expect(useStockLook).toHaveBeenCalledOnce()
    expect(services.resolveText({ en: 'Hello' })).toBe('Hello')
    expect(services.appearance('mode')).toBeTruthy()
  })

  it('give the preview notice from bundle-local\'s dictionary and acknowledgement, and none where bundle-local is absent', async () => {
    const service = { acknowledged: vi.fn(() => false), acknowledge: vi.fn() }
    const present = await harness({ provide: { delorunNotice: service } })
    present.served.on()
    const notice = face<OnboardingInjected>(present.entries, STEP_KEY).services.notice
    expect(present.bound).toContain('delorunPrivacy')
    expect([notice?.title(), notice?.paragraphs(), notice?.acknowledged()]).toEqual(['Preview', ['First.', 'Second.'], false])
    notice?.acknowledge()
    expect(service.acknowledge).toHaveBeenCalledOnce()
    const absent = await harness()
    absent.served.on()
    expect(face<OnboardingInjected>(absent.entries, STEP_KEY).services.notice).toBeUndefined()
  })

  it('look for the preview notice when the step is first drawn, so a bundle-local that loads later is still used', async () => {
    const { entries, served, ctx } = await harness()
    served.on()
    ctx.provide('delorunNotice', { acknowledged: () => true, acknowledge: () => {} })
    expect(face<OnboardingInjected>(entries, STEP_KEY).services.notice?.acknowledged()).toBe(true)
  })

  it('hand the dialog the row\'s progress form and the record loader', async () => {
    const { entries, served, progress } = await harness()
    served.on()
    const injected = face<OnboardingInjected>(entries, STEP_KEY)
    expect(injected.progress).toBe(progress.form)
    expect(injected.loadRecord).toBe(loadSetupRecord)
  })
})

describe('the harness\'s routes', () => {
  it('are the guide\'s requests over the page\'s fetch', async () => {
    const { entries, served } = await harness()
    served.on()
    expect(face<OnboardingInjected>(entries, STEP_KEY).services.host).toBe(hostApi)
  })
})

describe('the setup record', () => {
  const stubFetch = (response: () => Response | Promise<Response>) => {
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) => response())
    vi.stubGlobal('fetch', fetch)
    return fetch
  }

  it('is read from the route, relative to the document', async () => {
    const fetch = stubFetch(() => new Response(JSON.stringify({ sections: ['reach'], reachSetUp: true }), { status: 200 }))
    expect(await loadSetupRecord()).toEqual({ sections: ['reach'], reachSetUp: true })
    expect(fetch.mock.calls[0]?.[0]).toBe(SETUP_RECORD_PATH.slice(1))
    expect(fetch.mock.calls[0]?.[0].startsWith('/')).toBe(false)
  })

  it.each<readonly [string, () => Response | Promise<Response>]>([
    ['an answer with a failure status', () => new Response('no', { status: 500 })],
    ['an answer that is not JSON', () => new Response('<html>', { status: 200 })],
    ['an answer with a field it does not know', () => new Response(JSON.stringify({ reachSetUp: true, secret: 'x' }), { status: 200 })],
    ['an answer without reach', () => new Response(JSON.stringify({}), { status: 200 })],
    ['no answer', () => Promise.reject(new Error('offline'))],
  ])('covers nothing, with a warning, after %s', async (_, response) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubFetch(response)
    expect(await loadSetupRecord()).toBe(NO_RECORD)
    expect(warn).toHaveBeenCalledOnce()
  })
})

describe('the default workspace and the first chat', () => {
  const WORKSPACE = 'workspace-1'

  interface ChatOptions {
    readonly workspaces?: unknown
    readonly uiWorkspace?: unknown | null
    readonly items?: readonly unknown[]
  }

  async function chat(options: ChatOptions = {}) {
    const openWorkspace = vi.fn(async (_id: string, beforeOpen?: (sessionId: string) => void) => { beforeOpen?.('session-9') })
    const startSession = vi.fn()
    const pickDirectory = vi.fn(async (): Promise<string | null> => '/work/folder')
    const listDirectory = vi.fn(async (_path?: string, _signal?: AbortSignal) => ({ path: '/home/person' }))
    const createDirectory = vi.fn(async (path: string, name: string) => `${path}/${name}`)
    const initializeDefault = vi.fn(async () => ({ workspaceId: WORKSPACE }))
    const provide: Record<string, unknown> = {}
    if (options.uiWorkspace !== null) {
      provide.uiWorkspace = options.uiWorkspace ?? { openWorkspace, startSession, pickDirectory, listDirectory, createDirectory, holdDefaultWorkspaceNotice: () => () => {} }
    }
    const list = { getSnapshot: () => ({ items: options.items ?? [] }) }
    if (options.workspaces === undefined) provide.workspaces = { initializeDefault, list }
    else if (options.workspaces !== 'absent') provide.workspaces = { list, ...options.workspaces as object }
    const made = await harness({ provide })
    made.served.on()
    const injected = face<OnboardingInjected>(made.entries, STEP_KEY)
    return { ...made, injected, startChat: injected.startChat, start: injected.services.start, openWorkspace, startSession, pickDirectory, listDirectory, createDirectory, initializeDefault }
  }

  it('opens a new chat in the default workspace and remembers it as the one that offers starter prompts', async () => {
    const { startChat, openWorkspace, startSession, progress } = await chat()
    await startChat()
    expect(openWorkspace).toHaveBeenCalledWith(WORKSPACE, expect.any(Function))
    expect(startSession).not.toHaveBeenCalled()
    expect(progress.value()?.starterSession).toBe('session-9')
  })

  it('looks the default workspace up once when the dialog asks up front and the last button then opens it', async () => {
    const { start, startChat, initializeDefault, openWorkspace } = await chat()
    expect(start.target.getSnapshot()).toEqual({ kind: 'checking' })
    start.resolve()
    await flush()
    expect(start.target.getSnapshot()).toEqual({ kind: 'default', workspaceId: WORKSPACE })
    await startChat()
    expect(initializeDefault).toHaveBeenCalledOnce()
    expect(openWorkspace).toHaveBeenCalledOnce()
  })

  it('does nothing where the studio has no workspace navigation', async () => {
    const { startChat, progress } = await chat({ uiWorkspace: null })
    await startChat()
    expect(progress.set).not.toHaveBeenCalled()
  })

  it('holds the workspace UI\'s default-workspace notice and passes on whether the person was told', async () => {
    const release = vi.fn()
    const holdDefaultWorkspaceNotice = vi.fn(() => release)
    const { start } = await chat({ uiWorkspace: { holdDefaultWorkspaceNotice } })
    start.holdNotice()(true)
    start.holdNotice()(false)
    expect(holdDefaultWorkspaceNotice).toHaveBeenCalledTimes(2)
    expect(release.mock.calls).toEqual([[{ told: true }], [{ told: false }]])
  })

  it('holds nothing where the studio has no workspace navigation', async () => {
    const { start } = await chat({ uiWorkspace: null })
    expect(() => { start.holdNotice()(true) }).not.toThrow()
  })

  it('opens the workspace the person chose without asking for the default one', async () => {
    const { startChat, openWorkspace, initializeDefault, progress } = await chat()
    await startChat('workspace-7' as never, 'code')
    expect(initializeDefault).not.toHaveBeenCalled()
    expect(openWorkspace).toHaveBeenCalledWith('workspace-7', expect.any(Function))
    expect(progress.value()).toMatchObject({ starterSession: 'session-9', starterKind: 'code' })
  })

  it.each<readonly [string, ChatOptions, string, number]>([
    ['cannot be resolved and others exist', { workspaces: { initializeDefault: async () => undefined }, items: [{}] }, 'other', 0],
    ['cannot be resolved and none exist', { workspaces: { initializeDefault: async () => undefined } }, 'none', 0],
    ['fails to resolve and none exist', { workspaces: { initializeDefault: async () => { throw new Error('system Documents directory is unavailable') } } }, 'none', 1],
    ['fails to resolve but others exist', { workspaces: { initializeDefault: async () => { throw new Error('host down') } }, items: [{}] }, 'other', 1],
    ['is not offered by this studio', { workspaces: 'absent' }, 'other', 0],
  ])('knows up front when the default workspace %s, falls back to the workspace UI\'s own New Session, and offers no starter prompts', async (_, options, kind, warnings) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { start, startChat, startSession, openWorkspace, progress } = await chat(options)
    start.resolve()
    await flush()
    expect(start.target.getSnapshot()).toEqual({ kind })
    await startChat()
    expect(startSession).toHaveBeenCalledOnce()
    expect(openWorkspace).not.toHaveBeenCalled()
    expect(progress.set).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(warnings)
  })

  it('keeps the newest lookup when an older one settles last', async () => {
    const answers: ((value: { workspaceId: string } | undefined) => void)[] = []
    const { start } = await chat({ workspaces: { initializeDefault: () => new Promise((resolve) => { answers.push(resolve) }) } })
    start.resolve()
    start.resolve()
    answers[1]?.({ workspaceId: 'newer' })
    await flush()
    answers[0]?.(undefined)
    await flush()
    expect(start.target.getSnapshot()).toEqual({ kind: 'default', workspaceId: 'newer' })
  })

  it('warns, and leaves the workspace UI\'s notice to the person, when the chat is refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refusing = { openWorkspace: vi.fn(async () => { throw new Error('refused') }), startSession: vi.fn() }
    const { startChat } = await chat({ uiWorkspace: refusing })
    await startChat()
    expect(warn).toHaveBeenCalledOnce()
  })

  describe('choosing a folder', () => {
    /** The harness's add-workspace route, answering as given, and recording what it is asked. */
    const route = (answer: () => Response | Promise<Response> = () => new Response(JSON.stringify({ result: 'added', workspaceId: 'workspace-7', kind: 'code' }), { status: 200 })) => {
      const fetch = vi.fn(async (_path: string, _init?: RequestInit) => answer())
      vi.stubGlobal('fetch', fetch)
      return fetch
    }

    it('adds the folder the host\'s chooser returns through the harness\'s route, relative to the document', async () => {
      const fetch = route()
      const { start, pickDirectory } = await chat()
      expect(await start.chooseFolder()).toEqual({ kind: 'chosen', workspaceId: 'workspace-7', path: '/work/folder', folder: 'code' })
      expect(pickDirectory).toHaveBeenCalledOnce()
      expect(fetch).toHaveBeenCalledExactlyOnceWith(ADD_WORKSPACE_PATH.slice(1), {
        method: 'POST', headers: { 'accept': 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ path: '/work/folder' }),
      })
    })

    it('changes nothing when the chooser is closed', async () => {
      const fetch = route()
      const { start, pickDirectory } = await chat()
      pickDirectory.mockResolvedValueOnce(null)
      expect(await start.chooseFolder()).toEqual({ kind: 'cancelled' })
      expect(fetch).not.toHaveBeenCalled()
    })

    it('asks the Start step for its own chooser, with a warning, where the host has no native chooser', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const fetch = route()
      const made = await chat()
      made.pickDirectory.mockRejectedValueOnce(new Error('directory picker failed'))
      expect(await made.start.chooseFolder()).toEqual({ kind: 'in-step' })
      expect(warn).toHaveBeenCalledOnce()
      expect(fetch).not.toHaveBeenCalled()
    })

    it('is unavailable without workspace navigation', async () => {
      const { start } = await chat({ uiWorkspace: null })
      expect(await start.chooseFolder()).toEqual({ kind: 'unavailable' })
    })

    it.each<readonly [string, () => Response, unknown]>([
      ['refuses the folder', () => new Response(JSON.stringify({ result: 'refused', problem: 'home-directory' }), { status: 422 }), { kind: 'refused', problem: 'home-directory' }],
      ['cannot add it', () => new Response(JSON.stringify({ result: 'failed' }), { status: 500 }), { kind: 'failed' }],
    ])('passes on that the harness %s', async (_, answer, outcome) => {
      route(answer)
      const { start } = await chat()
      expect(await start.addFolder('/home/person')).toEqual(outcome)
    })

    it.each<readonly [string, () => Response | Promise<Response>]>([
      ['an answer that is not JSON', () => new Response('<html>', { status: 404 })],
      ['an answer it does not know', () => new Response(JSON.stringify({ result: 'added' }), { status: 200 })],
      ['no answer', () => Promise.reject(new Error('offline'))],
    ])('reports a failure, with a warning, after %s', async (_, answer) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      route(answer)
      expect(await addWorkspaceFolder('/home/person/projects')).toEqual({ kind: 'failed' })
      expect(warn).toHaveBeenCalledOnce()
    })

    it('lists and creates folders through the workspace navigation for the Start step\'s own chooser', async () => {
      const { start, listDirectory, createDirectory } = await chat()
      const signal = new AbortController().signal
      expect(await start.browse.list('/home', signal)).toEqual({ path: '/home/person' })
      expect(listDirectory).toHaveBeenCalledExactlyOnceWith('/home', signal)
      expect(await start.browse.create('/home/person', 'work')).toBe('/home/person/work')
      expect(createDirectory).toHaveBeenCalledExactlyOnceWith('/home/person', 'work')
    })

    it('fails to list or create folders where the studio has no workspace navigation', async () => {
      const { start } = await chat({ uiWorkspace: null })
      await expect(start.browse.list()).rejects.toThrow(/no workspace navigation/)
      await expect(start.browse.create('/home/person', 'work')).rejects.toThrow(/no workspace navigation/)
    })
  })
})

describe('a fresh home with no default workspace', () => {
  it('says so on the Workspace step instead of the workspace UI\'s notice, lets the person choose a folder, and then opens a chat there that offers the prompts that fit it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetch = vi.fn(async (path: string, _init?: RequestInit) => new Response(
      JSON.stringify(path === SETUP_RECORD_PATH.slice(1) ? { reachSetUp: false } : path === ADD_WORKSPACE_PATH.slice(1) ? { result: 'added', workspaceId: 'workspace-7', kind: 'empty' } : {}),
      { status: path === ADD_WORKSPACE_PATH.slice(1) || path === SETUP_RECORD_PATH.slice(1) ? 200 : 404 },
    ))
    vi.stubGlobal('fetch', fetch)
    const openWorkspace = vi.fn(async (_id: string, beforeOpen?: (sessionId: string) => void) => { beforeOpen?.('session-9') })
    const pickDirectory = vi.fn(async (): Promise<string | null> => '/work/folder')
    const workspaces = {
      initializeDefault: async () => { throw new Error('system Documents directory is unavailable') },
      list: { getSnapshot: () => ({ items: [] }) },
    }
    const release = vi.fn()
    const holdDefaultWorkspaceNotice = vi.fn(() => release)
    const uiWorkspace = { openWorkspace, startSession: vi.fn(), pickDirectory, holdDefaultWorkspaceNotice }
    const made = await harness({ provide: { workspaces, uiWorkspace } })
    made.served.on()
    const Step = made.entries.get(STEP_KEY)?.component as ComponentType<OnboardingStepEntryProps>
    const view = render(<Step t={t} {...face<OnboardingInjected>(made.entries, STEP_KEY)} explicit complete={vi.fn()} completeStep={vi.fn()} renderSection={() => null} />)
    await act(async () => { await flush() })
    // The Models step has its own Skip for now until its summary.
    for (let n = 0; n < 4; n++) {
      await act(async () => { await flush() })
      await act(async () => { fireEvent.click(screen.queryByRole('button', { name: en.continue }) ?? screen.getByRole('button', { name: en['providers.skip'] })) })
    }
    expect(document.body.textContent).toContain(en['start.lead.none'])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['workspace.folder.choose'] })) })
    await act(async () => { await flush() })
    expect(pickDirectory).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(ADD_WORKSPACE_PATH.slice(1), expect.objectContaining({ method: 'POST', body: JSON.stringify({ path: '/work/folder' }) }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.continue })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.start })) })
    await act(async () => { await flush() })
    expect(openWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-7', expect.any(Function))
    expect(made.progress.value()).toMatchObject({ done: true, starterSession: 'session-9', starterKind: 'empty' })
    expect(holdDefaultWorkspaceNotice).toHaveBeenCalledOnce()
    view.unmount()
    expect(release).toHaveBeenCalledExactlyOnceWith({ told: true })
  })
})

describe('Show again', () => {
  /** The Settings shell as the general-settings plugin provides it: a store that drives the explicitly opened onboarding step. */
  function shell() {
    const requested = createSnapshotStore<string | undefined>(undefined)
    return { requested, service: { open: vi.fn(), openSection: vi.fn(), openOnboarding: (id: string) => { requested.set(id) } } }
  }

  it('opens the onboarding dialog explicitly, from its first screen, through the Settings shell that loads after the plugin', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ reachSetUp: false }), { status: 200 })))
    const { requested, service } = shell()
    const { entries, served } = await harness({ progress: settings({ done: true }), late: { settingsShell: service } })
    served.on()
    const Row = entries.get(ROW_KEY)?.component as ComponentType<ShowAgainRowProps>
    const Step = entries.get(STEP_KEY)?.component as ComponentType<OnboardingStepEntryProps>
    const rowFace = face<ShowAgainInjected>(entries, ROW_KEY)
    const stepFace = face<OnboardingInjected>(entries, STEP_KEY)
    function Settings() {
      const open = useSyncExternalStore(requested.subscribe, requested.getSnapshot)
      return (
        <>
          <Row t={t} {...rowFace} />
          {open === ONBOARDING_STEP.id && <Step t={t} {...stepFace} explicit complete={() => { requested.set(undefined) }} completeStep={vi.fn()} renderSection={() => null} />}
        </>
      )
    }
    render(<Settings />)
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['row.show'] })) })
    await act(async () => { await flush() })
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe(en['step.welcome'])
  })

  it('keeps the reopened guide unfinished, so it shows again after a reload until it is finished or skipped', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ reachSetUp: false }), { status: 200 })))
    const { service } = shell()
    const { entries, served, progress } = await harness({ progress: settings({ done: true, step: 'agents' }), late: { settingsShell: service } })
    served.on()
    face<ShowAgainInjected>(entries, ROW_KEY).show()
    expect(progress.value()).toMatchObject({ done: false, step: '' })
    // A reload: the Settings shell no longer opens the step explicitly, and the profile's settings decide.
    const Step = entries.get(STEP_KEY)?.component as ComponentType<OnboardingStepEntryProps>
    const complete = vi.fn()
    render(<Step t={t} {...face<OnboardingInjected>(entries, STEP_KEY)} complete={complete} completeStep={vi.fn()} renderSection={() => null} />)
    await act(async () => { await flush() })
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe(en['step.welcome'])
    expect(complete).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.skip })) })
    expect(progress.value()).toMatchObject({ done: true, step: '' })
    expect(complete).toHaveBeenCalled()
  })

  it('activates without a Settings shell, as where a plugin draws its own Settings, and Show again still marks the guide unfinished', async () => {
    const { entries, served, progress, fiber } = await harness({ progress: settings({ done: true, step: 'agents' }), late: {} })
    expect(fiber.state).toBe(FiberState.ACTIVE)
    served.on()
    face<ShowAgainInjected>(entries, ROW_KEY).show()
    expect(progress.value()).toMatchObject({ done: false, step: '' })
  })

  it('warns when the reopened state cannot be saved, and still opens the guide', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { requested, service } = shell()
    const { entries, served, progress } = await harness({ progress: settings({ done: true }), late: { settingsShell: service } })
    served.on()
    progress.set.mockRejectedValue(new Error('transport'))
    face<ShowAgainInjected>(entries, ROW_KEY).show()
    await flush()
    expect(requested.getSnapshot()).toBe(ONBOARDING_STEP.id)
    expect(warn).toHaveBeenCalledWith('delorun onboarding: progress was not saved', expect.any(Error))
  })
})

describe('the no-key banner\'s services', () => {
  it('ask the key test through the page and open Settings at Models', async () => {
    const openSection = vi.fn()
    const keyTest = vi.spyOn(hostApi, 'keyTest').mockResolvedValue({ providers: [] })
    const { entries, served } = await harness({ provide: { settingsShell: { openSection, openOnboarding: vi.fn() } } })
    served.on()
    expect(entries.get(BANNER_KEY)?.options).toMatchObject({ name: 'conversation.input.dock', order: 5, locale: NS })
    const services = face<KeyBannerInjected>(entries, BANNER_KEY)
    expect(await services.keyTest()).toEqual({ providers: [] })
    expect(keyTest).toHaveBeenCalledOnce()
    services.openModels()
    expect(openSection).toHaveBeenCalledExactlyOnceWith('models')
  })
})

describe('the set-aside notice\'s services', () => {
  it('read the Host\'s answer through the page and stay dismissed once dismissed', async () => {
    const { entries, served } = await harness()
    served.on()
    expect(entries.get(SET_ASIDE_KEY)?.options).toMatchObject({ name: 'conversation.input.dock', order: 6, locale: NS })
    const services = face<SetAsideInjected>(entries, SET_ASIDE_KEY)
    const listener = vi.fn()
    services.dismissed.subscribe(listener)
    expect(services.dismissed.getSnapshot()).toBe(false)
    services.dismiss()
    expect(services.dismissed.getSnapshot()).toBe(true)
    expect(listener).toHaveBeenCalled()
  })
})

describe('the starter prompts\' services', () => {
  const CHAT = SessionId('session-9')

  /** A session scope whose conversation has an input, as the sessions service gives one. */
  function scoped() {
    const input = { setDraft: vi.fn(), focus: vi.fn() }
    const conversation = { input: { for: vi.fn(() => input) } }
    const scope = { get: vi.fn((name: string) => (name === 'conversation' ? conversation : undefined)) }
    const sessions = { scope: vi.fn(() => scope) }
    return { input, conversation, scope, sessions }
  }

  async function starters(provide: Record<string, unknown> = {}, pointer = 'fine') {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === `(pointer: ${pointer})` }))
    const made = await harness({ provide })
    made.served.on()
    return { ...made, face: face<StarterInjected>(made.entries, DOCK_KEY) }
  }

  it('follow the chat the progress names', async () => {
    const { face: services, progress } = await starters()
    expect(services.starter.getSnapshot()).toBe('')
    const listener = vi.fn()
    services.starter.subscribe(listener)
    expect(services.folder()).toBe('')
    progress.publish({ value: settings({ starterSession: 'session-9', starterKind: 'code' }) })
    expect(services.starter.getSnapshot()).toBe('session-9')
    expect(services.folder()).toBe('code')
    expect(listener).toHaveBeenCalledOnce()
    progress.publish({ value: undefined })
    expect([services.starter.getSnapshot(), services.folder()]).toEqual(['', ''])
  })

  it('write a prompt into the chat\'s message box without sending, and put the cursor there for a pointer that can hover', async () => {
    const { sessions, input, scope, conversation } = scoped()
    const { face: services } = await starters({ sessions })
    services.prefill(CHAT, 'Plan a project.')
    expect(sessions.scope).toHaveBeenCalledWith(CHAT)
    expect(scope.get).toHaveBeenCalledWith('conversation')
    expect(conversation.input.for).toHaveBeenCalledWith(scope)
    expect(input.setDraft).toHaveBeenCalledExactlyOnceWith('Plan a project.')
    expect(input.focus).toHaveBeenCalledOnce()
    expect(Object.keys(input)).toEqual(['setDraft', 'focus'])
  })

  it('leave the keyboard down on a touch device', async () => {
    const { sessions, input } = scoped()
    const { face: services } = await starters({ sessions }, 'coarse')
    services.prefill(CHAT, 'Plan a project.')
    expect(input.setDraft).toHaveBeenCalledOnce()
    expect(input.focus).not.toHaveBeenCalled()
  })

  it('write nothing where the chat has no scope or no conversation, or the studio has no sessions', async () => {
    const { input } = scoped()
    const noScope = await starters({ sessions: { scope: () => undefined } })
    noScope.face.prefill(CHAT, 'x')
    const noConversation = await starters({ sessions: { scope: () => ({ get: () => undefined }) } })
    noConversation.face.prefill(CHAT, 'x')
    const none = await starters()
    none.face.prefill(CHAT, 'x')
    expect(input.setDraft).not.toHaveBeenCalled()
  })

  it('take the chat that opens while they are pending', async () => {
    const { face: services, progress } = await starters()
    services.bind(CHAT)
    expect(progress.set).toHaveBeenCalledWith('starterSession', CHAT)
  })

  it('stop offering the prompts when dismissed, and warn if that cannot be saved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { face: services, progress } = await starters()
    services.dismiss()
    expect(progress.set).toHaveBeenCalledWith('starterSession', '')
    progress.set.mockRejectedValueOnce(new Error('transport'))
    services.dismiss()
    await flush()
    expect(warn).toHaveBeenCalledWith('delorun onboarding: progress was not saved', expect.any(Error))
  })
})
