/**
 * Denial specs of `@delorun/plugin-changes`' check before every recomposition, through upstream's real profile boot,
 * Loader, runtime resolution, plugin manager and hot reload: no recomposition evaluates an active directory that
 * differs from its approved version, and with protection on a restore or another process's `link:<folder>` install
 * evaluates nothing from the folder, and a start evaluates nothing of a plugin with no approved content. With protection
 * off, such an install loads the folder's content, logged as an applied change decided `unreviewed`.
 */
import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Hmr from '@deepseek-ai/dsh-hmr'
import PluginManager, { type ProfileVersionId } from '@deepseek-ai/dsh-plugin-manager'
import { applyChange, attestTerminal, readChangeLog, setProtection } from '@delorun/changes'
import { expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import { active, bootProfile, bundleFolder, evaluated, linkFolder, mountChanges, mountTools, PROFILE, profileHome, start, writeModule, type ProfileHome } from './reload-fixture.ts'

// Each case writes profile histories with git, copies folders into the store and boots a Loader.
vi.setConfig({ testTimeout: 90_000 })

/** The part of a chokidar watcher the specs deliver file changes through. */
interface Watcher {
  emit(event: string, ...args: unknown[]): boolean
}

// Profile file changes reach hot reload only when a spec delivers them.
const watchers = vi.hoisted(() => [] as Watcher[])
vi.mock('chokidar', async (original) => {
  const native = await original<{ FSWatcher: new () => Watcher }>()
  return { ...native, watch: () => {
    const watcher = new native.FSWatcher()
    watchers.push(watcher)
    queueMicrotask(() => watcher.emit('ready'))
    return watcher
  } }
})

/** The part of upstream's hot reload service these specs drive. */
interface HotReload {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>
  reconcileProfile(): Promise<{ warnings: string[] }>
}

/**
 * Boot the profile with the plugin manager, this plugin and upstream's hot reload, as a Delorun Host runs them.
 * @param fx - the home.
 * @returns the context, a recomposition inside hot reload's queue, and the delivery of a profile file change to hot
 *   reload's own watch.
 */
async function live(fx: ProfileHome) {
  const first = watchers.length
  const { ctx, profile } = await bootProfile(fx)
  await ctx.plugin(PluginManager, {})
  await mountChanges(ctx)
  await ctx.plugin(Timer)
  await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
  const hmr: HotReload = ctx.hmr
  expect(watchers.length).toBeGreaterThan(first)
  await hmr.runExclusive(async () => {})
  return {
    ctx,
    reconcile: () => hmr.runExclusive(() => hmr.reconcileProfile()),
    /** Deliver a change of the profile's `package.json` to hot reload's own watch and wait for its recomposition. */
    touchManifest: async () => {
      for (const watcher of watchers.slice(first)) watcher.emit('change', join(profile.dir, 'package.json'))
      await vi.waitFor(async () => { await hmr.runExclusive(async () => {}) })
      await hmr.runExclusive(async () => {})
    },
  }
}

/**
 * Turn protection on, as `delorun changes protection on` at a terminal does.
 * @param fx - the home.
 */
async function protect(fx: ProfileHome): Promise<void> {
  await setProtection(fx.home, 'on', attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } }))
}

/**
 * @param fx - the home.
 * @returns the profile's manifest text.
 */
function manifestText(fx: ProfileHome): string {
  return readFileSync(join(fx.dir, 'package.json'), 'utf8')
}

/**
 * @param fx - the home.
 * @param name - a package name.
 * @returns the manifest's spec for it.
 */
function specOf(fx: ProfileHome, name: string): string | undefined {
  return (JSON.parse(manifestText(fx)) as { dependencies?: Record<string, string> }).dependencies?.[name]
}

/**
 * @param fx - the home.
 * @param name - a package name.
 * @returns the pending installs of the plugin the change log holds.
 */
async function pendingInstalls(fx: ProfileHome, name: string) {
  return (await readChangeLog(fx.home, PROFILE)).entries.filter(entry => entry.kind === 'plugin-install' && entry.state === 'pending' && entry.subject.plugin === name)
}

it('a reload refuses an active directory that differs from its approved version', async () => {
  const fx = profileHome()
  const name = 'delorun-reload-tampered'
  linkFolder(fx, name, bundleFolder(fx, name, 'approved'))
  // The first start under Changes of a profile the home held approves the linked plugin as it is.
  expect((await start(fx)).approvedAtUpgrade).toEqual([expect.objectContaining({ plugin: name })])
  const { reconcile } = await live(fx)
  expect(evaluated(fx)).toEqual(['approved'])

  writeModule(active(fx, name), fx.marker, 'tampered')
  await expect(reconcile()).rejects.toThrow('did not load the profile')
  expect(evaluated(fx)).toEqual(['approved'])
})

it('a restore that names a folder link loads nothing from the folder', async () => {
  const fx = profileHome()
  await protect(fx)
  // The first start under Changes, with nothing linked yet.
  await start(fx)
  const name = 'delorun-reload-restored'
  const folder = bundleFolder(fx, name, 'folder')
  const { ctx } = await live(fx)
  const before = manifestText(fx)
  // An edit outside plugin management links the folder; the history saves it as a version, then the edit is taken
  // back by hand. pnpm's link to the folder stays in node_modules: the restore below runs no pnpm, as the profile has no
  // lockfile.
  linkFolder(fx, name, folder)
  const linked = await ctx.pluginManager.history(10)
  if (!linked.available) throw new Error(linked.reason)
  const version: ProfileVersionId = linked.versions[0]!.id
  writeFileSync(join(fx.dir, 'package.json'), before)
  expect(evaluated(fx)).toEqual([])

  const restored = await ctx.pluginManager.restore(version)
  expect(restored).toMatchObject({ application: 'applied', restored: { version } })
  expect(evaluated(fx)).toEqual([])
  expect(specOf(fx, name)).toBe(`link:${active(fx, name)}`)
  expect(realpathSync(join(fx.dir, 'node_modules', name))).toBe(active(fx, name))
  expect(await pendingInstalls(fx, name)).toEqual([expect.objectContaining({ subject: { plugin: name, source: folder } })])
})

it('delorun plugin add link:<folder> while Delorun runs loads nothing from the folder', async () => {
  const fx = profileHome()
  await protect(fx)
  await start(fx)
  const name = 'delorun-reload-added'
  const folder = bundleFolder(fx, name, 'folder')
  const { reconcile, touchManifest } = await live(fx)

  // Another process's `pnpm add link:<folder>`, still holding the profile write lock.
  const lock = join(fx.dir, 'package.json.lock')
  writeFileSync(lock, '1\n')
  linkFolder(fx, name, folder)
  const added = manifestText(fx)
  await touchManifest()
  expect(evaluated(fx)).toEqual([])
  expect(manifestText(fx)).toBe(added)
  await expect(reconcile()).rejects.toThrow('did not load the profile')
  expect(evaluated(fx)).toEqual([])
  expect(manifestText(fx)).toBe(added)

  // The holder is done.
  rmSync(lock)
  await touchManifest()
  expect(specOf(fx, name)).toBe(`link:${active(fx, name)}`)
  expect(realpathSync(join(fx.dir, 'node_modules', name))).toBe(active(fx, name))
  expect(await pendingInstalls(fx, name)).toEqual([expect.objectContaining({ subject: { plugin: name, source: folder } })])
  expect(evaluated(fx)).toEqual([])
})

it('with protection off, a link:<folder> install while Delorun runs loads the folder, logged as unreviewed', async () => {
  const fx = profileHome()
  await start(fx)
  const name = 'delorun-reload-unreviewed'
  const folder = bundleFolder(fx, name, 'folder')
  const { touchManifest } = await live(fx)

  // What upstream's plugin manager writes for an install from a folder the agent asked for and upstream approved.
  linkFolder(fx, name, folder)
  await touchManifest()
  expect(specOf(fx, name)).toBe(`link:${active(fx, name)}`)
  expect(realpathSync(join(fx.dir, 'node_modules', name))).toBe(active(fx, name))
  expect(evaluated(fx)).toEqual(['folder'])
  const installs = (await readChangeLog(fx.home, PROFILE)).entries.filter(entry => entry.subject.plugin === name)
  expect(installs).toEqual([expect.objectContaining({ kind: 'plugin-install', state: 'applied', decidedFrom: 'unreviewed', subject: { plugin: name, source: folder } })])
})

it('upstream evaluates nothing of a plugin with no approved content with protection on', async () => {
  const fx = profileHome()
  await protect(fx)
  await start(fx)
  const name = 'delorun-start-pending'
  const folder = bundleFolder(fx, name, 'reviewed')
  // Linked after the first start, while Delorun was not running.
  linkFolder(fx, name, folder)
  await start(fx)
  const first = await bootProfile(fx)
  expect(evaluated(fx)).toEqual([])
  await first.ctx.fiber.dispose()
  const [pending] = await pendingInstalls(fx, name)
  expect(pending).toMatchObject({ subject: { plugin: name, source: folder } })

  const proof = attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } })
  await applyChange({ home: fx.home, profile: PROFILE, profileDir: fx.dir }, pending!.id, proof, { reload: async () => undefined })
  await start(fx)
  await bootProfile(fx)
  expect(evaluated(fx)).toEqual(['reviewed'])
})

it('with the switch off the plugin still provides the check before a reload and registers no listener', async () => {
  const fx = profileHome()
  const { ctx } = await bootProfile(fx)
  const listeners = (): number => ctx.events._hooks['tools/pre-execute']?.length ?? 0
  await mountTools(ctx)
  const upstreamListeners = listeners()
  await ctx.plugin(plugin, { enabled: false, installationBundles: [] })
  expect(listeners()).toBe(upstreamListeners)
  expect(ctx.get('profileReconcileCheck')).toEqual({ check: expect.any(Function) })
  const restore = { name: 'plugin_manager', arguments: { action: 'restore', version: 'v' } }
  const next = vi.fn(() => Promise.resolve({ kind: 'allow' as const }))
  expect(await ctx.waterfall('tools/pre-execute', restore as never, next)).toEqual({ kind: 'allow' })
  expect(next).toHaveBeenCalledOnce()
})
