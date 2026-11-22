// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { currentDownloadsSource } from '@delorun/plugin-downloads/row'
import { createBundleInstaller, stateOf } from '../src/client/bundles.ts'

// The Host's packs routes publish no pack, so the bundles read as the plugin manager lists them.
beforeEach(() => { vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ supported: true, release: '0.1.0', packs: [], queue: [] }))) })
/** Make the Host's packs routes answer that it has no plugin packs, with a reason. */
const noPacks = (): void => { vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ supported: false, reason: 'no packs here', packs: [], queue: [] }))) }
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const item of currentDownloadsSource().snapshot()) currentDownloadsSource().remove(item.key)
})
/** The downloads panel's row of a key, as every downloads surface reads it. */
const panelRow = (key: string) => currentDownloadsSource().snapshot().find(item => item.key === key)

interface Row {
  name: string
  availability: 'installation' | 'profile' | 'missing'
  enabled: boolean
  installTarget?: { spec: string; version: string }
  error?: { code: string; message?: string; diagnostic?: string }
  readOnlyReason?: string
  installed?: boolean
  meta?: { title?: string | { en: string }; description?: string }
}

const row = (change: Partial<Row> & { name: string }): Row => ({ availability: 'installation', enabled: false, ...change })
const flush = async () => { for (let tick = 0; tick < 12; tick += 1) await Promise.resolve() }

/** A context with a scripted plugin manager. */
function bench(rows: readonly Row[] | 'refused' | 'rejects' | 'no-remote', options: { readonly change?: unknown; readonly addWaitMs?: number } = {}) {
  const ctx = new Context()
  const pluginManager = {
    listBundles: vi.fn(async () => {
      if (rows === 'rejects') throw new Error('transport')
      return rows === 'refused' ? { ok: false as const, error: { code: 'x', message: 'refused' } } : { ok: true as const, value: rows }
    }),
    setBundleEnabled: vi.fn(async () => ({ ok: true as const, value: options.change ?? { application: 'applied' } })),
    installBundle: vi.fn(async () => ({ ok: true as const, value: options.change ?? { application: 'applied' } })),
  }
  if (rows !== 'no-remote') ctx.provide('remote.pluginManager', pluginManager as never)
  const openList = vi.fn()
  ctx.provide('pluginNavigation', { openList } as never)
  const installer = createBundleInstaller(ctx, { addWaitMs: () => options.addWaitMs ?? 60_000, pollMs: 1000 })
  return { ctx, installer, pluginManager, openList, state: (name: string) => installer.views.getSnapshot()[name] }
}

describe('the plugin manager', () => {
  it('is read from the remote.pluginManager service upstream provides, not from a property of remote', async () => {
    const { ctx, installer, pluginManager, state } = bench([{ name: '@deepseek-ai/dsh-subagent-codex', availability: 'missing', installed: false, enabled: false, installTarget: { spec: 'link:/x' } } as never])
    // A `remote` service whose namespaces a plugin did not inject has no pluginManager property.
    ctx.provide('remote', {} as never)
    installer.refresh(['@deepseek-ai/dsh-subagent-codex'])
    await flush()
    expect(pluginManager.listBundles).toHaveBeenCalledOnce()
    expect(state('@deepseek-ai/dsh-subagent-codex')?.state).toBe('available')
  })
})

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
    ['ships with the installation, is switched off, and cannot run on this platform', row({ name: 'a', error: { code: 'unsupported-platform', message: 'x' } }), 'unavailable'],
  ])('says a bundle that %s is %s', (_, bundle, state) => {
    expect(stateOf(bundle as never)).toBe(state)
  })
})

describe('a plugin pack the release publishes', () => {
  const item = { key: 'a', state: 'downloading', receivedBytes: 1, reloadNeeded: false } as const
  it.each([
    ['is available to add', { kind: 'available' }, 'available'],
    ['is downloading', { kind: 'working', item }, 'installing'],
    ['needs a restart', { kind: 'restart', item }, 'restart'],
    ['is installed', { kind: 'installed' }, 'installed'],
    ['could not be installed', { kind: 'failed', failure: { code: 'failed', message: 'x' } }, 'failed'],
    ['needs a connection', { kind: 'offline', message: 'Connect and try again.' }, 'offline'],
    ['is not published for this computer', { kind: 'unavailable', reason: 'Not for this computer.' }, 'unavailable'],
  ] as const)('is %s: %s', (_, pack, state) => {
    expect(stateOf(undefined, pack)).toBe(state)
    expect(stateOf(row({ name: 'a', availability: 'missing' }) as never, pack)).toBe(state)
  })

  it('leaves a bundle the profile already holds to the plugin manager, whatever the pack says', () => {
    expect(stateOf(row({ name: 'a', enabled: true }) as never, { kind: 'available' })).toBe('installed')
  })
})

describe('the agent bundles the installation ships switched off', () => {
  const agents = ['@deepseek-ai/dsh-subagent-claude-code', '@deepseek-ai/dsh-subagent-codex']

  it('are available to add from the installation, and adding switches them on without a download', async () => {
    const { installer, pluginManager, state } = bench(agents.map(name => row({ name })))
    installer.refresh(agents)
    await flush()
    expect(agents.map(name => state(name)?.state)).toEqual(['available', 'available'])
    await installer.install(agents[0]!)
    expect(pluginManager.setBundleEnabled).toHaveBeenCalledWith(agents[0], true)
    expect(pluginManager.installBundle).not.toHaveBeenCalled()
  })

  it('say why a shipped bundle is unavailable on this platform', async () => {
    const { installer, state } = bench([row({ name: agents[0]!, error: { code: 'unsupported-platform', diagnostic: 'macOS only' } })])
    installer.refresh([agents[0]!])
    await flush()
    expect(state(agents[0]!)).toMatchObject({ state: 'unavailable', reason: 'macOS only' })
  })

  it('keeps the platform reason apart from a Host that has no plugin packs, as a build from source has none', async () => {
    noPacks()
    const { installer, state } = bench([row({ name: agents[0]!, error: { code: 'unsupported-platform', diagnostic: 'macOS only' } })])
    installer.refresh([agents[0]!, 'not-listed'])
    await flush()
    expect(state(agents[0]!)).not.toHaveProperty('packsReason')
    expect(state('not-listed')).toEqual({ state: 'unavailable', packsReason: 'no packs here' })
  })
})

describe('reading the bundles', () => {
  it('shows the bundles the profile holds while the packs answer is slow, and settles the others when it arrives', async () => {
    let answer: (response: Response) => void = () => {}
    vi.stubGlobal('fetch', () => new Promise<Response>(resolve => { answer = resolve }))
    const { installer, state } = bench([row({ name: 'a', enabled: true, meta: { title: { en: 'A' } } }), row({ name: 'b', availability: 'missing', installTarget: { spec: 'b@1', version: '1' }, meta: { title: { en: 'B' } } })])
    installer.refresh(['a', 'b'])
    await flush()
    expect(state('a')).toEqual({ state: 'installed', title: { en: 'A' } })
    expect(state('b')).toEqual({ state: 'checking' })
    answer(Response.json({ supported: true, release: '0.1.0', packs: [], queue: [] }))
    await flush()
    expect(state('b')).toEqual({ state: 'available', title: { en: 'B' } })
  })

  it('marks the names as being checked, then gives each its state, title and description, and changes nothing', async () => {
    const { installer, pluginManager, state } = bench([
      row({ name: 'a', meta: { title: { en: 'A' }, description: 'About a.' } }),
      row({ name: 'b', enabled: true }),
    ])
    installer.refresh(['a', 'b', 'c'])
    expect(state('a')).toEqual({ state: 'checking' })
    await flush()
    expect(state('a')).toEqual({ state: 'available', held: true, title: { en: 'A' }, description: 'About a.' })
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

  it('takes eight quick Add presses in a row, and a re-read of the list in between does not reset any of them', async () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const { installer, pluginManager, state } = bench(names.map(name => row({ name })))
    const releases: (() => void)[] = []
    pluginManager.setBundleEnabled.mockImplementation(() => new Promise((resolve) => { releases.push(() => { resolve({ ok: true, value: { application: 'applied' } }) }) }))
    installer.refresh(names)
    await flush()
    const adds = names.map(name => installer.install(name))
    // The step reads the list again when its shown packages change, while the adds still run.
    installer.refresh(names)
    await flush()
    expect(pluginManager.setBundleEnabled).toHaveBeenCalledTimes(8)
    expect(names.map(name => state(name)?.state)).toEqual(Array(8).fill('installing'))
    for (const release of releases) release()
    await Promise.all(adds)
    expect(names.map(name => state(name)?.state)).toEqual(Array(8).fill('installed'))
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
    pluginManager.setBundleEnabled.mockResolvedValueOnce({ ok: false, error: { code: 'x', diagnostic: 'no room left' } } as never)
    pluginManager.setBundleEnabled.mockRejectedValueOnce(new Error('transport'))
    installer.refresh(['a', 'b'])
    await flush()
    await installer.install('a')
    await installer.install('b')
    expect([state('a')?.state, state('b')?.state]).toEqual(['failed', 'failed'])
    expect(state('a')?.reason).toBe('no room left')
    expect(state('b')?.reason).toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('says a long add is still working, reads its state, and ends when the plugin manager reports it added', async () => {
    vi.useFakeTimers()
    try {
      const { installer, pluginManager, state } = bench([row({ name: 'a' })], { addWaitMs: 5000 })
      pluginManager.setBundleEnabled.mockImplementationOnce(() => new Promise(() => {}))
      installer.refresh(['a'])
      await vi.advanceTimersByTimeAsync(0)
      void installer.install('a')
      expect(state('a')?.state).toBe('installing')
      await vi.advanceTimersByTimeAsync(5000)
      expect(state('a')?.state).toBe('slow')
      pluginManager.listBundles.mockResolvedValue({ ok: true, value: [row({ name: 'a', enabled: true })] } as never)
      await vi.advanceTimersByTimeAsync(1000)
      expect(state('a')?.state).toBe('installed')
    } finally { vi.useRealTimers() }
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
    const bare = createBundleInstaller(new Context(), { addWaitMs: () => 1000, pollMs: 1000 })
    expect(() => { bare.openPlugins() }).not.toThrow()
  })
})

describe('the bundled rows', () => {
  const costMeter = { rowId: 'delorun-cost-meter', moduleName: '@delorun/plugin-cost-meter', entryId: 'entry-1', meta: { title: { en: 'Cost meter' }, description: 'Estimated cost.', icon: 'data:image/png;base64,AA==' } }
  const studio = { ...row({ name: '@delorun/bundle-studio', enabled: true }), rows: [costMeter] }

  /** A bench whose plugin manager also lists live plugins and enables one. */
  function rowBench(enabled: boolean, readOnlyReason?: string, change: unknown = { application: 'applied' }) {
    const made = bench([studio as never])
    const live = { entryId: 'entry-1', enabled, ...readOnlyReason === undefined ? {} : { readOnlyReason } }
    const extra = {
      listPlugins: vi.fn(async () => ({ ok: true as const, value: [live] })),
      setPluginEnabled: vi.fn(async () => ({ ok: true as const, value: change })),
    }
    Object.assign(made.pluginManager, extra)
    return { ...made, ...extra, rowState: () => made.installer.rows.getSnapshot()['delorun-cost-meter'] }
  }

  it('reads a disabled row as available with its package title, description and icon, and changes nothing', async () => {
    const { installer, setPluginEnabled, rowState } = rowBench(false)
    installer.refreshRows(['delorun-cost-meter'])
    expect(rowState()).toEqual({ state: 'checking' })
    await flush()
    expect(rowState()).toEqual({ state: 'available', title: { en: 'Cost meter' }, description: 'Estimated cost.', icon: 'data:image/png;base64,AA==' })
    expect(setPluginEnabled).not.toHaveBeenCalled()
  })

  it('turns a row on through the plugin manager by its entry, without a restart', async () => {
    const { installer, setPluginEnabled, rowState } = rowBench(false)
    installer.refreshRows(['delorun-cost-meter'])
    await flush()
    await installer.enableRow('delorun-cost-meter')
    expect(setPluginEnabled).toHaveBeenCalledExactlyOnceWith('entry-1', true)
    expect(rowState()?.state).toBe('installed')
  })

  it.each<readonly [string, boolean, string | undefined, unknown, string]>([
    ['is already on', true, undefined, undefined, 'installed'],
    ['is protected or cannot be addressed', false, 'management-required', undefined, 'failed'],
    ['waits for a restart', false, undefined, { application: 'restart-required' }, 'restart'],
    ['is overridden', false, undefined, { application: 'overridden' }, 'failed'],
  ])('shows a row that %s as %s and turns on only an available row', async (_, enabled, readOnly, change, expected) => {
    const { installer, setPluginEnabled, rowState } = rowBench(enabled, readOnly, change)
    installer.refreshRows(['delorun-cost-meter'])
    await flush()
    if (rowState()?.state === 'available') await installer.enableRow('delorun-cost-meter')
    else {
      await installer.enableRow('delorun-cost-meter')
      expect(setPluginEnabled).not.toHaveBeenCalled()
    }
    expect(rowState()?.state).toBe(expected)
  })

  it('says a row no bundle declares is unavailable, and every row failed without a plugin manager', async () => {
    const { installer, rowState } = rowBench(false)
    installer.refreshRows(['delorun-cost-meter', 'delorun-nope'])
    await flush()
    expect(installer.rows.getSnapshot()['delorun-nope']).toEqual({ state: 'unavailable' })
    expect(rowState()?.state).toBe('available')
    const none = bench('no-remote')
    none.installer.refreshRows(['delorun-cost-meter'])
    await flush()
    expect(none.installer.rows.getSnapshot()['delorun-cost-meter']).toEqual({ state: 'failed' })
  })
})

describe('a Host that reports no plugin packs', () => {
  it('lists a bundle the profile does not hold as unavailable with the Host\'s reason, and does not install it', async () => {
    noPacks()
    const { installer, pluginManager, state } = bench([row({ name: 'a', availability: 'missing', installTarget: { spec: 'link:/x', version: '1' } }), row({ name: 'held' })])
    installer.refresh(['a', 'held'])
    await flush()
    expect(state('a')).toEqual({ state: 'unavailable', packsReason: 'no packs here' })
    // A bundle the profile holds but turned off is held: only the person does that, and the Browser page leaves it off.
    expect(state('held')).toEqual({ state: 'available', held: true })
    await installer.install('a')
    expect(pluginManager.installBundle).not.toHaveBeenCalled()
  })
})

describe('a pack the Host downloads', () => {
  const pack = { name: 'p', version: '1.0.0', experimental: false, downloadBytes: 10, availability: 'available' as const }
  const item = (state: 'downloading' | 'failed', message?: string) => ({ key: 'p', state, receivedBytes: 1, reloadNeeded: false, ...message === undefined ? {} : { failure: { code: 'failed', message } } })

  /** A Host whose packs list answers each call with the next answer, and whose enqueue answers ok. */
  function host(answers: readonly { readonly queue: readonly unknown[] }[]): string[] {
    let call = 0
    const posts: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      posts.push(String(url))
      if (String(url).endsWith('enqueue') || String(url).endsWith('retry')) return Promise.resolve(Response.json({ ok: true, value: { supported: true, release: '0.1.0', packs: [pack], queue: [] } }))
      const answer = answers[Math.min(call++, answers.length - 1)]!
      return Promise.resolve(Response.json({ supported: true, release: '0.1.0', packs: [pack], ...answer }))
    })
    return posts
  }

  it('stops following a pack when the plugin is disposed', async () => {
    vi.useFakeTimers()
    try {
      let lists = 0
      vi.stubGlobal('fetch', (url: string) => {
        if (String(url).endsWith('enqueue')) return Promise.resolve(Response.json({ ok: true, value: { supported: true, release: '0.1.0', packs: [pack], queue: [] } }))
        lists += 1
        return Promise.resolve(Response.json({ supported: true, release: '0.1.0', packs: [pack], queue: lists > 1 ? [item('downloading')] : [] }))
      })
      const { ctx, installer, state } = bench([])
      installer.refresh(['p'])
      await vi.advanceTimersByTimeAsync(0)
      await installer.install('p')
      await vi.advanceTimersByTimeAsync(1000)
      const before = lists
      await ctx.fiber.dispose()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(lists).toBe(before)
      expect(state('p')?.state).toBe('installing')
    } finally {
      vi.useRealTimers()
    }
  })

  it('still ends a pack the card was re-read in the middle of, and one it finds already working', async () => {
    vi.useFakeTimers()
    try {
      host([{ queue: [item('downloading')] }, { queue: [item('downloading')] }, { queue: [item('downloading')] }, { queue: [item('failed', 'could not be unpacked')] }])
      const { installer, state } = bench([])
      // The card opens while the Host is already installing the pack: another surface started it.
      installer.refresh(['p'])
      await vi.advanceTimersByTimeAsync(0)
      expect(state('p')?.state).toBe('installing')
      // The step re-reads its cards mid-install, which shows "checking" for a moment.
      installer.refresh(['p'])
      expect(state('p')).toEqual({ state: 'checking' })
      await vi.advanceTimersByTimeAsync(5000)
      expect(state('p')).toEqual({ state: 'failed', reason: 'could not be unpacked' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves "installing" with the Host\'s reason when the download fails, and stops asking', async () => {
    vi.useFakeTimers()
    try {
      const posts = host([{ queue: [] }, { queue: [item('downloading')] }, { queue: [item('failed', 'received no data for 60 seconds')] }])
      const { installer, state } = bench([])
      installer.refresh(['p'])
      await vi.advanceTimersByTimeAsync(0)
      expect(state('p')).toEqual({ state: 'available' })
      await installer.install('p')
      expect(state('p')?.state).toBe('installing')
      await vi.advanceTimersByTimeAsync(1000)
      expect(state('p')?.state).toBe('installing')
      await vi.advanceTimersByTimeAsync(1000)
      expect(state('p')).toEqual({ state: 'failed', reason: 'received no data for 60 seconds' })
      // Retry from the failed card queues the pack again.
      await installer.install('p')
      expect(state('p')).toEqual({ state: 'installing' })
      expect(posts.filter(url => url.endsWith('retry'))).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the downloads panel during an add the plugin manager runs', () => {
  it('lists a catalog install from the press until it ends, with the package\'s title', async () => {
    let answer: (value: { ok: true, value: { application: 'applied' } }) => void = () => undefined
    const { installer, pluginManager } = bench([row({ name: 'a', availability: 'missing', installTarget: { spec: '@scope/a@1.2.3', version: '1.2.3' }, meta: { title: 'A' } })])
    pluginManager.installBundle.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    installer.refresh(['a'])
    await flush()
    const adding = installer.install('a')
    await flush()
    expect(panelRow('a')).toMatchObject({ state: 'downloading', title: 'A', local: { retry: false } })
    answer({ ok: true, value: { application: 'applied' } })
    await adding
    expect(panelRow('a')?.state).toBe('ready')
  })

  it('lists a shipped bundle switched on, and ends a refusal as failed in the plugin manager\'s words', async () => {
    const { installer, pluginManager } = bench([row({ name: 'a' }), row({ name: 'b' })], { change: { application: 'restart-required' } })
    installer.refresh(['a', 'b'])
    await flush()
    const switching = installer.install('a')
    // A shipped bundle downloads nothing, so its row starts as installing.
    expect(panelRow('a')?.state).toBe('installing')
    await switching
    expect(panelRow('a')?.state).toBe('needs-reload')
    pluginManager.setBundleEnabled.mockResolvedValueOnce({ ok: false, error: { code: 'refused', message: 'no', diagnostic: 'Not allowed here' } } as never)
    await installer.install('b')
    expect(panelRow('b')).toMatchObject({ state: 'failed', failure: { message: 'Not allowed here' } })
  })
})
