// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore, type ComponentType } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, DIRECTORY_FLOW_HOLES, inject, NS, OVERLAY_ID, type DelorunNewWorkspace } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import type { OpenFlow, OverlayInjected } from '../src/client/Overlay.tsx'
import { ADD_WORKSPACE_PATH, PLACES_PATH } from '../src/wire.ts'
import { HOME, listingOf, PLACES } from './fixtures.client.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const settle = async () => { await act(async () => { for (let n = 0; n < 6; n++) await Promise.resolve() }) }
const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }); await settle() }

interface Entry {
  readonly options: { readonly name: string, readonly id?: string, readonly locale?: string, readonly inject?: () => unknown }
  readonly component: ComponentType<Record<string, unknown>>
}

/** What the page's `fetch` answers: the places, and every add as a new workspace. */
function stubHost(overrides: Readonly<Record<string, () => Response>> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const path = `/${String(input)}`
    const custom = overrides[path]
    if (custom !== undefined) return custom()
    if (path === PLACES_PATH) return Response.json(PLACES)
    if (path === ADD_WORKSPACE_PATH) return Response.json({ result: 'added', workspaceId: 'workspace-1', path: `${HOME}/src/delorun`, kind: 'code' })
    return Response.json({}, { status: 404 })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

/** The page as far as the plugin uses it, with the Delorun look on unless asked otherwise. */
async function harness(options: { readonly studio?: boolean, readonly language?: string } = {}) {
  const ctx = new Context()
  const dictionaries = new Map<string, unknown>()
  ctx.provide('locale', {
    bind: () => makeTranslate(en),
    getLocale: () => ({ active: options.language ?? 'en' }),
    register: (namespace: string, dictionary: unknown) => {
      dictionaries.set(namespace, dictionary)
      return () => { dictionaries.delete(namespace) }
    },
  })
  const entries = new Map<string, Entry>()
  ctx.provide('slots', {
    inject: (_: string, register: () => () => void) => register(),
    register: (registered: Entry['options'], component: Entry['component']) => {
      const key = `${registered.name}#${registered.id ?? ''}`
      entries.set(key, { options: registered, component })
      return () => { entries.delete(key) }
    },
  })
  const listDirectory = vi.fn(async (path?: string, _signal?: AbortSignal) => listingOf(path ?? HOME, ['src']))
  ctx.provide('uiWorkspace', { listDirectory, createDirectory: vi.fn() })
  if (options.studio !== false) ctx.provide('delorunStudio', {})
  const denied: unknown[] = []
  ctx.on('remote/call-denied', (denial) => { denied.push(denial) })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, dictionaries, entries, listDirectory, denied }
}

/** Draw the overlay entry the way the slot machinery does: the hook bound to the injected store. */
function mountOverlay(entries: Map<string, Entry>) {
  const entry = entries.get(`shell.overlay#${OVERLAY_ID}`) as Entry
  const { hooks, ...rest } = (entry.options.inject?.() ?? {}) as OverlayInjected
  const Component = entry.component
  const Host = () => {
    const useOpen = <T,>(select: (flow: OpenFlow | null) => T): T => useSyncExternalStore(hooks.open.subscribe, () => select(hooks.open.getSnapshot()))
    return <Component {...{ t: makeTranslate(en), useOpen, ...rest }} />
  }
  render(<Host />)
}

describe('the stock look', () => {
  it('registers nothing until the Delorun look provides delorunStudio, and everything leaves with it', async () => {
    const { ctx, dictionaries, entries } = await harness({ studio: false })
    expect(inject).not.toContain('delorunStudio')
    expect([dictionaries.size, entries.size, ctx.get('delorunNewWorkspace')]).toEqual([0, 0, undefined])
    const studio = ctx.plugin({ apply: (scope: Context) => { scope.provide('delorunStudio', {}) } })
    await studio.await()
    expect(dictionaries.get(NS)).toEqual({ en, zh })
    expect([...entries.keys()].sort()).toEqual([`shell.overlay#${OVERLAY_ID}`, ...DIRECTORY_FLOW_HOLES.map(([hole]) => `${hole}#`)].sort())
    expect(ctx.get('delorunNewWorkspace')).toBeDefined()
    await studio.dispose()
    expect([dictionaries.size, entries.size, ctx.get('delorunNewWorkspace')]).toEqual([0, 0, undefined])
  })

  it('draws nothing while the flow is closed', async () => {
    const { entries } = await harness()
    mountOverlay(entries)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(entries.get(`shell.overlay#${OVERLAY_ID}`)?.options.locale).toBe(NS)
  })
})

describe('the studio services the dialog reads', () => {
  const injected = (entries: Map<string, Entry>) => (entries.get(`shell.overlay#${OVERLAY_ID}`)?.options.inject?.() ?? {}) as OverlayInjected

  it('reads the model catalogue from the session remote and the home\'s default with it', async () => {
    const { ctx, entries } = await harness()
    const modelCatalog = vi.fn(async () => ({
      ok: true as const,
      value: { default: { provider: 'deepseek', model: 'pro', reasoningEffort: 'high' }, groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'pro', name: 'Pro' }] }] },
    }))
    ctx.provide('remote.session', { modelCatalog } as never)
    expect(await injected(entries).readModels()).toEqual({
      default: { provider: 'deepseek', model: 'pro', reasoningEffort: 'high' },
      options: [{ provider: 'deepseek', providerName: 'DeepSeek', id: 'pro', name: 'Pro', efforts: [], defaultEffort: undefined }],
    })
  })

  it('reads no catalogue when the session remote is absent, answers an error or fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, entries } = await harness()
    expect(await injected(entries).readModels()).toBeUndefined()
    const answers = [async () => ({ ok: false, error: { code: 'x', message: 'y' } }), async () => { throw new Error('offline') }]
    ctx.provide('remote.session', { modelCatalog: () => answers.shift()?.() } as never)
    expect(await injected(entries).readModels()).toBeUndefined()
    expect(await injected(entries).readModels()).toBeUndefined()
  })

  it('opens a Settings section through the shell, and offers it only while a shell exists', async () => {
    const { ctx, entries } = await harness()
    const { settings } = injected(entries).browser
    expect(settings.available()).toBe(false)
    expect(() => { settings.open('plugins') }).not.toThrow()
    const openSection = vi.fn<(id: string) => void>()
    ctx.provide('settingsShell', { open: vi.fn(), openSection, openOnboarding: vi.fn() } as never)
    expect(settings.available()).toBe(true)
    settings.open('plugins')
    expect(openSection).toHaveBeenCalledExactlyOnceWith('plugins')
  })

  it('reads whether Browser is ready from the Host in the studio\'s language, once per page', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ rows: [], problems: [] }))
    vi.stubGlobal('fetch', fetch)
    const { entries } = await harness({ language: 'zh-CN' })
    const { setup } = injected(entries).browser
    expect(setup.getSnapshot()).toEqual({ kind: 'checking' })
    expect(await setup.refresh()).toEqual({ kind: 'not-added' })
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual(['/api/delorunRequirements.check?language=zh'])
  })

  it('asks the Full access consent service for one workspace, or says it is absent', async () => {
    const { ctx, entries } = await harness()
    const { fullAccess } = injected(entries)
    expect(fullAccess.available()).toBe(false)
    expect(await fullAccess.ask('/x')).toBe(false)
    const askForWorkspace = vi.fn(async (_path: string) => true)
    ctx.provide('delorunFullAccess', { askForWorkspace })
    expect(fullAccess.available()).toBe(true)
    expect(await fullAccess.ask(`${HOME}/src/site`)).toBe(true)
    expect(askForWorkspace).toHaveBeenCalledExactlyOnceWith(`${HOME}/src/site`)
  })

  it('sends a network change through the studio\'s Face ID fetch, and opens no unlock', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, entries, denied } = await harness()
    // Pins the wiring: a plugin route a device needs a grant for goes through the Face ID step, never the unlock dialog.
    const sent = vi.fn((_input: string, _init?: RequestInit) => Promise.resolve(Response.json({ error: 'ELEVATION_REQUIRED', action: 'plugin-permission-defaults/network-set' }, { status: 403 })))
    ctx.provide('delorunFaceGrant', { grant: () => Promise.resolve(undefined), fetch: sent })
    await injected(entries).api.setNetwork('/x', { access: 'off', hosts: [] })
    expect(sent).toHaveBeenCalledOnce()
    expect(sent.mock.calls[0]?.[0]).toBe('api/delorunNetwork.set')
    expect(denied).toEqual([])
  })
})

describe('the service', () => {
  const service = (ctx: Context): DelorunNewWorkspace => ctx.get('delorunNewWorkspace') as DelorunNewWorkspace

  it('opens the dialog and resolves cancelled when it closes', async () => {
    stubHost()
    const { ctx, entries } = await harness()
    mountOverlay(entries)
    const outcome = service(ctx).open()
    await settle()
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe(en.title)
    expect(document.querySelector('[data-from]')?.getAttribute('data-from')).toBe('sidebar')
    await click(screen.getByRole('button', { name: en.close }))
    expect(await outcome).toEqual({ kind: 'cancelled' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('resolves cancelled on Escape too, and keeps which surface opened it', async () => {
    stubHost()
    const { ctx, entries } = await harness()
    mountOverlay(entries)
    const outcome = service(ctx).open({ from: 'hero' })
    await settle()
    expect(document.querySelector('[data-from]')?.getAttribute('data-from')).toBe('hero')
    await act(async () => { fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }) })
    expect(await outcome).toEqual({ kind: 'cancelled' })
  })

  it('resolves the first opening as cancelled when a second one opens, and starts the second afresh', async () => {
    stubHost()
    const { ctx, entries } = await harness()
    mountOverlay(entries)
    const first = service(ctx).open({ from: 'sidebar' })
    await settle()
    await click(screen.getByRole('button', { name: /^New folder/ }))
    expect((screen.getByRole('button', { name: en.continue }) as HTMLButtonElement).disabled).toBe(false)
    const second = service(ctx).open({ from: 'picker' })
    await settle()
    expect(await first).toEqual({ kind: 'cancelled' })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect((screen.getByRole('button', { name: en.continue }) as HTMLButtonElement).disabled).toBe(true)
    await click(screen.getByRole('button', { name: en.close }))
    expect(await second).toEqual({ kind: 'cancelled' })
  })

  it('resolves created with the workspace, and closes the dialog', async () => {
    const fetch = stubHost()
    const { ctx, entries } = await harness()
    mountOverlay(entries)
    const outcome = service(ctx).open({ from: 'onboarding' })
    await settle()
    await click(screen.getByRole('button', { name: /^delorun/ }))
    expect(await outcome).toEqual({ kind: 'created', workspaceId: 'workspace-1', path: `${HOME}/src/delorun`, folder: 'code' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fetch).toHaveBeenCalledWith(ADD_WORKSPACE_PATH.slice(1), expect.objectContaining({ body: JSON.stringify({ path: `${HOME}/src/delorun` }) }))
  })

  it('resolves cancelled when the plugin is disposed while the flow is open', async () => {
    stubHost()
    const { ctx, fiber, entries } = await harness()
    mountOverlay(entries)
    const outcome = service(ctx).open()
    await settle()
    await fiber.dispose()
    expect(await outcome).toEqual({ kind: 'cancelled' })
  })

  it('lists folders through the studio\'s workspace navigation', async () => {
    stubHost()
    const { ctx, entries, listDirectory } = await harness()
    mountOverlay(entries)
    void service(ctx).open()
    await settle()
    await click(screen.getByRole('button', { name: /^Folder on this computer/ }))
    await click(screen.getByRole('button', { name: en.continue }))
    expect(listDirectory).toHaveBeenCalledWith(undefined, expect.any(AbortSignal))
    expect(screen.getByRole('option', { name: 'src' })).toBeTruthy()
  })

  it('shows its own line after a cancelled Face ID confirmation, and opens no unlock', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubHost({ [PLACES_PATH]: () => Response.json({ error: 'ELEVATION_REQUIRED', action: 'plugin-new-workspace/places' }, { status: 403 }) })
    const { ctx, entries, denied } = await harness()
    mountOverlay(entries)
    void service(ctx).open()
    await settle()
    expect(denied).toEqual([])
    expect(screen.getByRole('alert').textContent).toBe(en['problem.locked'])
  })
})
