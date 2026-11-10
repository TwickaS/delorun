// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply, inject, loadSetupRecord, NS, ONBOARDING_STEP, SHOW_AGAIN_ROW, STARTER_ENTRY, type OnboardingInjected, type OnboardingStep, type StarterInjected, type ShowAgainInjected,
} from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { NO_RECORD, SETUP_RECORD_PATH } from '../src/wire.ts'
import { ONBOARDING_ROW_ID, THEME_ROW_ID, type OnboardingSettings } from '../src/config.ts'
import { liveForm, settings, THEME } from './fixtures.client.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

interface Registered {
  readonly options: { readonly name: string; readonly id?: string; readonly order?: number; readonly locale?: string; readonly inject?: () => unknown }
  readonly component: unknown
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

/** Every service the plugin reads, faked, with the studio look on unless asked otherwise. */
async function harness(options: { readonly studio?: boolean; readonly provide?: Record<string, unknown> } = {}) {
  const ctx = new Context()
  const dictionaries = new Map<string, unknown>()
  const bound: string[] = []
  const language = { active: 'en', locales: [{ id: 'en', label: 'English' }], revision: 1 }
  const localeListeners = new Set<() => void>()
  const setLocale = vi.fn()
  ctx.provide('locale', {
    bind: (ns: string) => { bound.push(ns); return makeTranslate(ns === 'deloPrivacy' ? { 'notice.title': 'Preview', 'notice.body': 'First.\n\nSecond.' } : en) },
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
      const key = `${registered.name}#${registered.id}`
      entries.set(key, { options: registered, component })
      return () => { entries.delete(key) }
    },
  } as never)
  const progress = liveForm<OnboardingSettings>(settings())
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
  const useStockLook = vi.fn(() => Promise.resolve(true))
  const deloStudio = options.studio === false ? undefined : { useStockLook }
  if (deloStudio !== undefined) ctx.provide('deloStudio', deloStudio as never)
  for (const [name, value] of Object.entries(options.provide ?? {})) ctx.provide(name as never, value as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
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

describe('the stock look', () => {
  it('registers nothing until the Delo look provides deloStudio, and everything leaves with it', async () => {
    const { ctx, dictionaries, entries, served, fiber } = await harness({ studio: false })
    expect(inject).toContain('deloStudio')
    expect([dictionaries.size, entries.size, served.ids]).toEqual([0, 0, []])
    expect(ctx.get('deloOnboarding')).toBeUndefined()
    const studio = ctx.plugin({ apply: (scope: Context) => { scope.provide('deloStudio', { useStockLook: () => Promise.resolve(true) } as never) } })
    await studio.await()
    expect(dictionaries.has(NS)).toBe(true)
    expect(served.ids).toEqual([ONBOARDING_ROW_ID])
    served.on()
    expect(entries.size).toBe(3)
    await studio.dispose()
    expect([dictionaries.size, entries.size, ctx.get('deloOnboarding')]).toEqual([0, 0, undefined])
    await fiber.dispose()
  })

  it('removes its dictionaries, service and registrations when it is disposed', async () => {
    const { dictionaries, entries, served, fiber, ctx } = await harness()
    served.on()
    expect(ctx.get('deloOnboarding')).toBeDefined()
    await fiber.dispose()
    expect([dictionaries.size, entries.size, ctx.get('deloOnboarding')]).toEqual([0, 0, undefined])
  })
})

describe('the registrations', () => {
  it('register English and Chinese copy under its namespace', async () => {
    const { dictionaries } = await harness()
    expect(dictionaries.get(NS)).toEqual({ en, zh })
  })

  it('wait until the host serves the row, register the step before the preview notice\'s own, the General row and the starter prompts, and leave when the row goes', async () => {
    const { entries, served } = await harness()
    expect([...entries.keys()]).toEqual([])
    served.on()
    expect([...entries.keys()].toSorted()).toEqual([DOCK_KEY, ROW_KEY, STEP_KEY].toSorted())
    expect(entries.get(STEP_KEY)?.options).toMatchObject({ name: 'settings.onboarding', id: 'delo-onboarding', order: -200, locale: NS })
    // bundle-local's step registers at -100, so this one is mounted first.
    expect(ONBOARDING_STEP.order).toBeLessThan(-100)
    expect(entries.get(ROW_KEY)?.options).toMatchObject({ name: 'settings.general.item', id: 'delo-onboarding', locale: NS })
    expect(entries.get(DOCK_KEY)?.options).toMatchObject({ name: 'conversation.input.dock', locale: NS })
    served.off()
    expect(entries.size).toBe(0)
  })

  it('open onboarding explicitly from the General row by the step\'s id', async () => {
    const openOnboarding = vi.fn()
    const { entries, served } = await harness({ provide: { settingsShell: { openOnboarding } } })
    served.on()
    face<ShowAgainInjected>(entries, ROW_KEY).show()
    expect(openOnboarding).toHaveBeenCalledExactlyOnceWith('delo-onboarding')
  })
})

describe('the steps other plugins add', () => {
  const step = (id: string, order: number): OnboardingStep => ({ id, order, title: () => id, component: () => null })

  it('are kept in the service, replaced by id, and removed with their disposer', async () => {
    const { entries, served, ctx } = await harness()
    served.on()
    const injected = face<OnboardingInjected>(entries, STEP_KEY)
    const service = ctx.get('deloOnboarding')
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
    const present = await harness({ provide: { deloNotice: service } })
    present.served.on()
    const notice = face<OnboardingInjected>(present.entries, STEP_KEY).services.notice
    expect(present.bound).toContain('deloPrivacy')
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
    ctx.provide('deloNotice', { acknowledged: () => true, acknowledge: () => {} })
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

describe('opening the first chat', () => {
  const WORKSPACE = 'workspace-1'

  async function chat(options: { readonly workspaces?: unknown; readonly uiWorkspace?: unknown | null } = {}) {
    const openWorkspace = vi.fn(async (_id: string, beforeOpen?: (sessionId: string) => void) => { beforeOpen?.('session-9') })
    const startSession = vi.fn()
    const initializeDefault = vi.fn(async () => ({ workspaceId: WORKSPACE }))
    const provide: Record<string, unknown> = {}
    if (options.uiWorkspace !== null) provide.uiWorkspace = options.uiWorkspace ?? { openWorkspace, startSession }
    if (options.workspaces === undefined) provide.workspaces = { initializeDefault }
    else if (options.workspaces !== 'absent') provide.workspaces = options.workspaces
    const made = await harness({ provide })
    made.served.on()
    const { startChat } = face<OnboardingInjected>(made.entries, STEP_KEY)
    return { ...made, startChat, openWorkspace, startSession, initializeDefault }
  }

  it('opens a new chat in the default workspace and remembers it as the one that offers starter prompts', async () => {
    const { startChat, openWorkspace, startSession, progress } = await chat()
    await startChat()
    expect(openWorkspace).toHaveBeenCalledWith(WORKSPACE, expect.any(Function))
    expect(startSession).not.toHaveBeenCalled()
    expect(progress.value()?.starterSession).toBe('session-9')
  })

  it('does nothing where the studio has no workspace navigation', async () => {
    const { startChat, progress } = await chat({ uiWorkspace: null })
    await startChat()
    expect(progress.set).not.toHaveBeenCalled()
  })

  it.each<readonly [string, unknown, number]>([
    ['cannot be resolved', { initializeDefault: async () => undefined }, 0],
    ['is not offered by this studio', 'absent', 0],
    ['fails to resolve', { initializeDefault: async () => { throw new Error('host down') } }, 1],
  ])('falls back to the workspace UI\'s own New Session when the default workspace %s, and offers no starter prompts', async (_, workspaces, warnings) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { startChat, startSession, openWorkspace, progress } = await chat({ workspaces })
    await startChat()
    expect(startSession).toHaveBeenCalledOnce()
    expect(openWorkspace).not.toHaveBeenCalled()
    expect(progress.set).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(warnings)
  })

  it('warns, and leaves the workspace UI\'s notice to the person, when the chat is refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refusing = { openWorkspace: vi.fn(async () => { throw new Error('refused') }), startSession: vi.fn() }
    const { startChat } = await chat({ uiWorkspace: refusing })
    await startChat()
    expect(warn).toHaveBeenCalledOnce()
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
    progress.publish({ value: settings({ starterSession: 'session-9' }) })
    expect(services.starter.getSnapshot()).toBe('session-9')
    expect(listener).toHaveBeenCalledOnce()
    progress.publish({ value: undefined })
    expect(services.starter.getSnapshot()).toBe('')
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

  it('stop offering the prompts when dismissed, and warn if that cannot be saved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { face: services, progress } = await starters()
    services.dismiss()
    expect(progress.set).toHaveBeenCalledWith('starterSession', '')
    progress.set.mockRejectedValueOnce(new Error('transport'))
    services.dismiss()
    await flush()
    expect(warn).toHaveBeenCalledWith('delo onboarding: progress was not saved', expect.any(Error))
  })
})
