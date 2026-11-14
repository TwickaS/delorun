// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createClientModuleSystem, type BootModuleRow, type ClientBundleRegistration, type ClientModuleLoader, type ClientModuleLoaderTarget, type DshWindow } from '../src/client/index.ts'

const MODULES_ID = '@deepseek-ai/dsh-client-modules'

// The host composes graph rows as app-directory-relative browser references, so these fixtures carry the same form.
const comboReference = (ids: readonly string[], rev: string): string =>
  `plugins/??${ids.map(id => `${id}/client.js`).join(',')}&rev=${rev}`
const APPLICATION_URL = comboReference(['a', 'b'], 'application')
const win = globalThis as DshWindow
const stashGlobal = globalThis as { __DSH_TRUSTED_TYPES__?: unknown }

afterEach(() => {
  vi.restoreAllMocks()
  delete stashGlobal.__DSH_TRUSTED_TYPES__
  delete win.__ModuleLoader__
  for (const el of document.querySelectorAll('script')) el.remove()
})

const row = (id: string, fields: Partial<BootModuleRow> = {}): BootModuleRow =>
  ({
    id,
    url: comboReference([id], '0'),
    initialUrl: APPLICATION_URL,
    rev: '0',
    inject: [],
    external: [],
    ...fields,
  })

/** Build the page-global facade shape consumed by the module system. */
function registrationTarget(): ClientModuleLoaderTarget {
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue: [],
    load: (registration: ClientBundleRegistration) => { target.pendingQueue.push(registration) },
    create: options => createClientModuleSystem(target, { id: MODULES_ID, exports: {} }, options),
  }
  return target
}

/** A system over the default transport, whose script appends are captured. */
function benchWithDefaultTransport(): { loader: ClientModuleLoader } {
  const target = registrationTarget()
  win.__ModuleLoader__ = target
  const loader = target.create({
    boot: {
      rev: 'graph',
      entries: [row('dee')],
      batches: [{ phase: 'application' as const, url: APPLICATION_URL, rev: 'application', entries: ['dee'] }],
    },
    staticModules: {},
  })
  return { loader }
}

/** Capture the classic script the default transport appends, settling each with `settle`. */
function captureScript(settle: (script: HTMLScriptElement) => void): { appended: Array<HTMLScriptElement> } {
  const appended: Array<HTMLScriptElement> = []
  vi.spyOn(document.head, 'append').mockImplementation((...nodes) => {
    const script = nodes[0]
    if (!(script instanceof HTMLScriptElement)) throw new Error('expected script node')
    appended.push(script)
    queueMicrotask(() => { settle(script) })
  })
  return { appended }
}

/** Register the bundle's factory through the page sink, then report the script loaded. */
const registerAndLoad = (marker: string) => (script: HTMLScriptElement): void => {
  win.__ModuleLoader__?.load({ id: 'dee', factory: () => ({ marker }) })
  script.dispatchEvent(new Event('load'))
}

it('assigns script.src through the delorun-plugin-loader policy the page created', async () => {
  const createScriptURL = vi.fn((input: string) => `https://loader.trusted/${encodeURIComponent(input)}`)
  const register = vi.fn()
  stashGlobal.__DSH_TRUSTED_TYPES__ = { pluginLoader: { createScriptURL }, register }
  const { appended } = captureScript(registerAndLoad('via-policy'))
  const { loader } = benchWithDefaultTransport()
  const exports = await loader.import('dee', '', {})
  expect(createScriptURL).toHaveBeenCalledWith(APPLICATION_URL)
  expect(appended[0]?.getAttribute('src')).toBe(`https://loader.trusted/${encodeURIComponent(APPLICATION_URL)}`)
  expect(createScriptURL).toHaveBeenCalledTimes(1)
  // The loader keeps the page's script URL allowlist current with its boot manifest.
  expect(register).toHaveBeenCalledWith(expect.objectContaining({ modules: expect.any(Array) }))
  expect((exports as { marker: string }).marker).toBe('via-policy')
})

it('a URL the policy refuses fails the load without requesting anything', async () => {
  stashGlobal.__DSH_TRUSTED_TYPES__ = { pluginLoader: { createScriptURL: () => null }, register: vi.fn() }
  const { appended } = captureScript(registerAndLoad('never'))
  const { loader } = benchWithDefaultTransport()
  await expect(loader.import('dee', '', {}))
    .rejects.toThrow(`bundle script ${APPLICATION_URL} refused by the delorun-plugin-loader policy`)
  expect(appended).toEqual([])
  expect([...document.querySelectorAll('script')]).toEqual([])
})

it('without the page stash the raw URL is assigned, as on browsers without Trusted Types', async () => {
  const { appended } = captureScript(registerAndLoad('via-raw'))
  const { loader } = benchWithDefaultTransport()
  const exports = await loader.import('dee', '', {})
  expect(appended[0]?.getAttribute('src')).toBe(APPLICATION_URL)
  expect((exports as { marker: string }).marker).toBe('via-raw')
})
