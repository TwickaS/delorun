// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBundleInstaller, stateOf } from '../src/client/bundles.ts'

afterEach(() => { vi.restoreAllMocks() })

interface Row {
  name: string
  availability: 'installation' | 'profile' | 'missing'
  enabled: boolean
  installTarget?: { spec: string; version: string }
  error?: { code: string; message: string }
  readOnlyReason?: string
  installed?: boolean
  meta?: { title?: string | { en: string }; description?: string }
}

const row = (change: Partial<Row> & { name: string }): Row => ({ availability: 'installation', enabled: false, ...change })
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

/** A context with a scripted plugin manager. */
function bench(rows: readonly Row[] | 'refused' | 'rejects' | 'no-remote', options: { readonly change?: unknown } = {}) {
  const ctx = new Context()
  const pluginManager = {
    listBundles: vi.fn(async () => {
      if (rows === 'rejects') throw new Error('transport')
      return rows === 'refused' ? { ok: false as const, error: { code: 'x', message: 'refused' } } : { ok: true as const, value: rows }
    }),
    setBundleEnabled: vi.fn(async () => ({ ok: true as const, value: options.change ?? { application: 'applied' } })),
    installBundle: vi.fn(async () => ({ ok: true as const, value: options.change ?? { application: 'applied' } })),
  }
  if (rows !== 'no-remote') ctx.provide('remote', { pluginManager } as never)
  const openList = vi.fn()
  ctx.provide('pluginNavigation', { openList } as never)
  const installer = createBundleInstaller(ctx)
  return { ctx, installer, pluginManager, openList, state: (name: string) => installer.views.getSnapshot()[name] }
}

describe('where a listed bundle stands', () => {
  it.each<readonly [string, Row | undefined, string]>([
    ['is not listed', undefined, 'unavailable'],
    ['has a metadata or management error', row({ name: 'a', error: { code: 'x', message: 'y' } }), 'failed'],
    ['cannot be changed through the profile patch', row({ name: 'a', readOnlyReason: 'management-required' }), 'failed'],
    ['is a catalog entry the installation cannot fetch', row({ name: 'a', availability: 'missing' }), 'unavailable'],
    ['is a catalog entry with an install target', row({ name: 'a', availability: 'missing', installTarget: { spec: 'a@1', version: '1' } }), 'available'],
    ['is a catalog entry whose install target could not be worked out, as in a source checkout without its build', row({ name: 'a', availability: 'missing', error: { code: 'operation-error', message: 'built runtime is missing' } }), 'unavailable'],
    ['is a catalog entry this platform cannot run', row({ name: 'a', availability: 'missing', installTarget: { spec: 'a@1', version: '1' }, error: { code: 'unsupported-platform', message: 'x' } }), 'unavailable'],
    ['is recorded by the profile but its files are gone', row({ name: 'a', availability: 'missing', installed: true, installTarget: { spec: 'a@1', version: '1' } }), 'failed'],
    ['ships with the installation and is switched on', row({ name: 'a', enabled: true }), 'installed'],
    ['ships with the installation and is switched off', row({ name: 'a' }), 'available'],
    ['is installed in the profile and switched off', row({ name: 'a', availability: 'profile' }), 'available'],
  ])('says a bundle that %s is %s', (_, bundle, state) => {
    expect(stateOf(bundle as never)).toBe(state)
  })
})

describe('reading the bundles', () => {
  it('marks the names as being checked, then gives each its state, title and description, and changes nothing', async () => {
    const { installer, pluginManager, state } = bench([
      row({ name: 'a', meta: { title: { en: 'A' }, description: 'About a.' } }),
      row({ name: 'b', enabled: true }),
    ])
    installer.refresh(['a', 'b', 'c'])
    expect(state('a')).toEqual({ state: 'checking' })
    await flush()
    expect(state('a')).toEqual({ state: 'available', title: { en: 'A' }, description: 'About a.' })
    expect(state('b')).toEqual({ state: 'installed' })
    expect(state('c')).toEqual({ state: 'unavailable' })
    expect(pluginManager.setBundleEnabled).not.toHaveBeenCalled()
    expect(pluginManager.installBundle).not.toHaveBeenCalled()
  })

  it.each<readonly [string, 'refused' | 'rejects' | 'no-remote']>([
    ['refuses the listing', 'refused'],
    ['cannot be reached', 'rejects'],
    ['is not available in this studio', 'no-remote'],
  ])('shows every name as failed when the plugin manager %s', async (_, rows) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { installer, state } = bench(rows)
    installer.refresh(['a', 'b'])
    await flush()
    expect([state('a')?.state, state('b')?.state]).toEqual(['failed', 'failed'])
    expect(warn).toHaveBeenCalledTimes(rows === 'rejects' ? 1 : 0)
  })
})

describe('adding a bundle', () => {
  it('switches on a bundle the installation ships, and keeps its title', async () => {
    const { installer, pluginManager, state } = bench([row({ name: 'a', meta: { title: 'A' } })])
    installer.refresh(['a'])
    await flush()
    await installer.install('a')
    expect(pluginManager.setBundleEnabled).toHaveBeenCalledWith('a', true)
    expect(pluginManager.installBundle).not.toHaveBeenCalled()
    expect(state('a')).toEqual({ state: 'installed', title: 'A' })
  })

  it('shows the state while it works', async () => {
    const { installer, pluginManager, state } = bench([row({ name: 'a' })])
    let release = (): void => {}
    pluginManager.setBundleEnabled.mockImplementationOnce(() => new Promise((resolve) => { release = () => { resolve({ ok: true, value: { application: 'applied' } }) } }))
    installer.refresh(['a'])
    await flush()
    const adding = installer.install('a')
    expect(state('a')?.state).toBe('installing')
    release()
    await adding
    expect(state('a')?.state).toBe('installed')
  })

  it('installs a catalog entry from its target with the registry the profile names, and pins the version', async () => {
    const { installer, pluginManager, state } = bench([row({ name: 'a', availability: 'missing', installTarget: { spec: '@scope/a@1.2.3', version: '1.2.3' } })])
    installer.refresh(['a'])
    await flush()
    await installer.install('a')
    expect(pluginManager.setBundleEnabled).not.toHaveBeenCalled()
    expect(pluginManager.installBundle).toHaveBeenCalledWith('@scope/a@1.2.3', { enabled: true, registry: null, saveExact: true, requestId: expect.any(String) })
    expect(state('a')?.state).toBe('installed')
  })

  it('does not pin a linked development checkout', async () => {
    const { installer, pluginManager } = bench([row({ name: 'a', availability: 'missing', installTarget: { spec: 'link:../a', version: '0.0.0' } })])
    installer.refresh(['a'])
    await flush()
    await installer.install('a')
    expect(pluginManager.installBundle).toHaveBeenCalledWith('link:../a', { enabled: true, registry: null, requestId: expect.any(String) })
  })

  it.each<readonly [string, unknown, string]>([
    ['applied at once', { application: 'applied' }, 'installed'],
    ['applied after a restart', { application: 'restart-required' }, 'restart'],
    ['overridden by a higher layer', { application: 'overridden' }, 'failed'],
    ['failed', { application: 'failed' }, 'failed'],
    ['cancelled', { application: 'cancelled' }, 'failed'],
  ])('shows a change that is %s as %s', async (_, change, expected) => {
    const { installer, state } = bench([row({ name: 'a' })], { change })
    installer.refresh(['a'])
    await flush()
    await installer.install('a')
    expect(state('a')?.state).toBe(expected)
  })

  it('shows a refused call as failed, and a call that throws as failed with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { installer, pluginManager, state } = bench([row({ name: 'a' }), row({ name: 'b' })])
    pluginManager.setBundleEnabled.mockResolvedValueOnce({ ok: false, error: { code: 'x', message: 'no' } } as never)
    pluginManager.setBundleEnabled.mockRejectedValueOnce(new Error('transport'))
    installer.refresh(['a', 'b'])
    await flush()
    await installer.install('a')
    await installer.install('b')
    expect([state('a')?.state, state('b')?.state]).toEqual(['failed', 'failed'])
    expect(warn).toHaveBeenCalledOnce()
  })

  it('adds nothing for a bundle that is not available, is unknown, or has no plugin manager to ask', async () => {
    const { installer, pluginManager } = bench([row({ name: 'a', enabled: true }), row({ name: 'u', error: { code: 'x', message: 'y' } })])
    installer.refresh(['a', 'u'])
    await flush()
    await installer.install('a')
    await installer.install('u')
    await installer.install('unread')
    expect(pluginManager.setBundleEnabled).not.toHaveBeenCalled()
    const none = bench('no-remote')
    none.installer.refresh(['a'])
    await flush()
    await none.installer.install('a')
    expect(none.state('a')?.state).toBe('failed')
  })

  it('does not add a bundle that was available when read but is gone from the next listing', async () => {
    const { installer, pluginManager, state } = bench([row({ name: 'a' })])
    installer.refresh(['a'])
    await flush()
    pluginManager.listBundles.mockResolvedValueOnce({ ok: true, value: [] })
    installer.refresh(['a'])
    await flush()
    expect(state('a')?.state).toBe('unavailable')
    await installer.install('a')
    expect(pluginManager.setBundleEnabled).not.toHaveBeenCalled()
  })

  it('does not add a bundle twice while it is being added', async () => {
    const { installer, pluginManager } = bench([row({ name: 'a' })])
    let release = (): void => {}
    pluginManager.setBundleEnabled.mockImplementationOnce(() => new Promise((resolve) => { release = () => { resolve({ ok: true, value: { application: 'applied' } }) } }))
    installer.refresh(['a'])
    await flush()
    const first = installer.install('a')
    await installer.install('a')
    release()
    await first
    expect(pluginManager.setBundleEnabled).toHaveBeenCalledOnce()
  })
})

describe('opening Plugins', () => {
  it('opens the plugin list, and does nothing where the studio has none', () => {
    const { installer, openList } = bench([])
    installer.openPlugins()
    expect(openList).toHaveBeenCalledOnce()
    const bare = createBundleInstaller(new Context())
    expect(() => { bare.openPlugins() }).not.toThrow()
  })
})
