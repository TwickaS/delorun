/**
 * A Delorun home whose profile boots through upstream's real profile preparation, Loader and runtime resolution, with
 * plugins linked from folders, for the specs of what the Host evaluates at a start and at every recomposition. Each
 * linked plugin is a bundle whose module, when evaluated, appends its content tag to a marker file outside the home, so
 * a spec reads what code upstream ran.
 *
 * @module @delorun/plugin-changes/tests/reload-fixture
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  boot, createRuntimeResolution, initProfile, loadProfileDirectory, PluginPackages, readProfileManifest, readProfilePatches,
  type ProfileContext,
} from '@deepseek-ai/dsh-app-boot'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { activeDirectory, enforceApprovedContent, type StartChanges } from '@delorun/changes'
import { onTestFinished } from 'vitest'
import * as plugin from '../src/index.ts'

/** The fixture's profile. */
export const PROFILE = 'default'

/** A Delorun home with one profile and a marker file outside the home. */
export interface ProfileHome {
  /** The temporary directory holding the home, the plugin folders and the marker. */
  readonly root: string
  readonly home: string
  readonly dir: string
  readonly installAnchor: string
  /** The file each linked plugin's module appends its tag to when it is evaluated. */
  readonly marker: string
}

/**
 * A Delorun home whose profile selects no bundle and depends on nothing; removed after the test.
 * @returns the home.
 */
export function profileHome(): ProfileHome {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-reload-check-')))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const home = join(root, '.delorun')
  mkdirSync(home, { mode: 0o700 })
  const installAnchor = join(home, 'package.json')
  writeFileSync(installAnchor, '{"name":"installation","dependencies":{}}\n')
  const dir = join(home, 'profiles', PROFILE)
  initProfile(dir, [])
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  return { root, home, dir, installAnchor, marker: join(root, 'evaluated.log') }
}

/**
 * Write a plugin folder outside the home: a bundle whose patch inserts the bundle's own module as a row, and whose
 * module appends `tag` to the marker file when evaluated.
 * @param fx - the home.
 * @param name - the package name, unique per test.
 * @param tag - the content tag the module appends.
 * @returns the folder.
 */
export function bundleFolder(fx: ProfileHome, name: string, tag: string): string {
  const folder = join(fx.root, 'folders', name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'package.json'), JSON.stringify({
    name, version: '1.0.0', type: 'module', exports: './index.mjs', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(folder, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: name, name }] }]))
  writeModule(folder, fx.marker, tag)
  return folder
}

/**
 * Write a plugin module that appends its tag to the marker when evaluated, replacing the file rather than writing
 * through it, so a copy that shares its inode is left alone.
 * @param directory - the plugin's directory.
 * @param marker - the marker file.
 * @param tag - the tag.
 */
export function writeModule(directory: string, marker: string, tag: string): void {
  const path = join(directory, 'index.mjs')
  rmSync(path, { force: true })
  writeFileSync(path, `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${tag}\n`)})
export function apply() {}
`)
}

/**
 * The tags the marker holds.
 * @param fx - the home.
 * @returns one tag per evaluation, in order; empty when nothing was evaluated.
 */
export function evaluated(fx: ProfileHome): string[] {
  return existsSync(fx.marker) ? readFileSync(fx.marker, 'utf8').split('\n').filter(line => line !== '') : []
}

/**
 * Link a plugin from a folder as `pnpm add link:<folder>` leaves it and select its bundle: the manifest's spec and
 * bundle list, and `node_modules/<name>` naming the folder.
 * @param fx - the home.
 * @param name - the package name.
 * @param folder - the folder.
 */
export function linkFolder(fx: ProfileHome, name: string, folder: string): void {
  const manifest = readProfileManifest('test', fx.dir)
  manifest.dependencies = { ...manifest.dependencies, [name]: `link:${folder}` }
  manifest.dsh = { profile: { bundles: [...manifest.dsh?.profile?.bundles ?? [], name] } }
  writeFileSync(join(fx.dir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  pointModules(fx, name, folder)
}

/**
 * Make `node_modules/<name>` a symbolic link to a directory, replacing what is there.
 * @param fx - the home.
 * @param name - the package name.
 * @param target - the directory.
 */
export function pointModules(fx: ProfileHome, name: string, target: string): void {
  const link = join(fx.dir, 'node_modules', name)
  mkdirSync(dirname(link), { recursive: true })
  rmSync(link, { recursive: true, force: true })
  symlinkSync(target, link, 'dir')
}

/**
 * Run a start's enforcement for the profile.
 * @param fx - the home.
 * @returns what the start reports.
 */
export function start(fx: ProfileHome): Promise<StartChanges> {
  return enforceApprovedContent({ home: fx.home, profile: PROFILE, profileDir: fx.dir })
}

/**
 * @param fx - the home.
 * @param name - a package name.
 * @returns the plugin's active directory, as a real path.
 */
export function active(fx: ProfileHome, name: string): string {
  return realpathSync(activeDirectory(fx.home, PROFILE, name))
}

/** A booted profile. */
export interface Booted {
  readonly ctx: Context
  readonly profile: ProfileContext
}

/**
 * Boot the profile as a launch does: upstream loads the profile directory, builds its runtime resolution, and boots the
 * Loader with the profile's patches and `PluginPackages`. The Host is disposed after the test.
 * @param fx - the home.
 * @param prepare - more services to provide in the boot callback.
 * @returns the booted context, after the Loader settled.
 */
export async function bootProfile(fx: ProfileHome, prepare?: (host: Context) => void): Promise<Booted> {
  const loaded = loadProfileDirectory('test', fx.dir, fx.installAnchor)
  const profile: ProfileContext = {
    name: PROFILE, dir: fx.dir, patchPath: join(fx.dir, 'cordis.patch.yml'), installAnchor: fx.installAnchor, cwd: fx.root,
    home: fx.home, startedBundles: loaded.layers.map(layer => layer.packageName), overlays: [], telemetryDisabledEnv: undefined,
  }
  const resolution = await createRuntimeResolution({ installAnchor: fx.installAnchor, profile: loaded, home: fx.home })
  let owner: Context | undefined
  onTestFinished(async () => { await owner?.fiber.dispose() })
  const ctx = await boot('test', join(fx.dir, 'cordis.yml'), readProfilePatches('test', profile), async (host) => {
    owner = host
    host.provide('profileContext', profile)
    host.provide('appReady', { onReady(listener: () => void) { listener(); return () => {} } })
    prepare?.(host)
    await host.plugin(PluginPackages, { resolution })
  })
  await ctx.loader.await()
  return { ctx, profile }
}

/**
 * Mount upstream's tool registry, which `@delorun/plugin-changes` injects, on a booted Host.
 * @param ctx - the booted context.
 */
export async function mountTools(ctx: Context): Promise<void> {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
}

/**
 * Mount `@delorun/plugin-changes` on a booted Host with its switch on, after the tool registry it injects.
 * @param ctx - the booted context.
 */
export async function mountChanges(ctx: Context): Promise<void> {
  await mountTools(ctx)
  await ctx.plugin(plugin, { enabled: true, installationBundles: [] })
}
