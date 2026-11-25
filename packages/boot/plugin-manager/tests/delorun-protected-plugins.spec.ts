/**
 * The plugins Delorun's `@delorun/bundle-local` protects through the manager's `protectedPlugins`: in full access, where the
 * `plugin_manager` tool asks nothing, no tool action can disable one, change its settings, drop it, add a row of its
 * module, give its row id to another row, or deselect, remove, install or change the package that carries or provides
 * it, and the profile's files stay as they were.
 */
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import {
  boot, initProfile, loadOverlayPatches, loadProfileDirectory, readProfileManifest, readProfilePatches, type ProfileContext,
} from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Hmr from '@deepseek-ai/dsh-hmr'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import PluginManager from '../src/index.ts'
import type { PackFolderCheck, PluginInstallRequestId } from '../src/types.ts'
import { DELORUN_PROFILE_BUNDLES } from '../../../../delorun/packages/bundle-local/src/profile.ts'
import { materialize, storeFolder } from '../../../../delorun/packages/changes/src/store.ts'
import * as operations from '../src/operations.ts'
import * as tool from '../src/tools.ts'
import { isolateGitCommandLineConfig } from './git-environment.ts'

/** Delorun's bundle, whose patch configures the manager's row. */
const LOCAL_BUNDLE = '@delorun/bundle-local'
/**
 * The stand-in for the bundle that carries the protected rows. It is not named `@delorun/bundle-local`, which the
 * workspace's own copy answers when a runner puts the workspace's packages on `NODE_PATH`.
 */
const GUARD_BUNDLE = 'guard-bundle'
const LOCAL_DIR = fileURLToPath(new URL('../../../../delorun/packages/bundle-local/', import.meta.url))
const STUDIO_DIR = fileURLToPath(new URL('../../../../delorun/packages/bundle-studio/', import.meta.url))
const LOCAL_PATCH = join(LOCAL_DIR, 'cordis.patch.yml')

/** The manager row's config as `@delorun/bundle-local` writes it. */
function delorunManagerConfig(): { protectedPlugins: string[] } {
  const row = loadOverlayPatches('dsh', LOCAL_PATCH).find(patch => patch.id === 'plugin-manager')
  const config = row?.config as { protectedPlugins?: unknown } | undefined
  if (!Array.isArray(config?.protectedPlugins)) throw new Error(`${LOCAL_PATCH} configures no protectedPlugins on the plugin-manager row`)
  return { protectedPlugins: config.protectedPlugins.map(String) }
}

const PROTECTED = delorunManagerConfig().protectedPlugins

/**
 * The config `@delorun/bundle-local` gives a protected module's inserted row, or `{ enabled: true }` for a module it
 * does not insert, such as upstream's sandbox rows. The start gate of live agents has no `enabled` field.
 * @param name - the module.
 * @returns the row's config.
 */
function shippedConfig(name: string): Record<string, unknown> {
  const rows = loadOverlayPatches('dsh', LOCAL_PATCH).flatMap(patch => (Array.isArray(patch.insert) ? patch.insert : []))
  const row = rows.find(entry => entry.name === name)
  return (row?.config as Record<string, unknown> | undefined) ?? { enabled: true }
}

/** The row id a protected module name gets in {@link GUARD_BUNDLE}. */
const rowId = (name: string): string => `guard-${PROTECTED.indexOf(name)}`

/**
 * Write a package whose modules are no-op plugins, under the profile's `node_modules`.
 * @param dir - the profile directory.
 * @param name - the package name.
 * @param extra - other `package.json` fields.
 * @param subpaths - the package's subpath exports besides `.`, each a no-op plugin.
 */
function writePackage(dir: string, name: string, extra: object = {}, subpaths: readonly string[] = []): void {
  const path = join(dir, 'node_modules', name)
  mkdirSync(path, { recursive: true })
  const exports = Object.fromEntries([['.', './plugin.mjs'], ['./package.json', './package.json'], ...subpaths.map(sub => [`./${sub}`, './plugin.mjs'])])
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', exports, ...extra }))
  writeFileSync(join(path, 'plugin.mjs'), 'export function apply() {}\n')
}

/** The protected row the cases that change one row use, and its module. */
const GUARD = '@delorun/plugin-fetch-guard'
const GUARD_ROW = rowId(GUARD)

/** A bundle patch, as a package's `cordis.patch.yml` holds it. */
type Patch = Array<Record<string, unknown>>

/** How the fixture boots: the manager row's config, whether HMR runs, and other selected bundles with their patches. */
interface FixtureOptions {
  config?: object
  reload?: 'live' | 'startup'
  bundles?: Record<string, Patch>
  /**
   * Compose Delorun's default CLI profile instead: `DELORUN_PROFILE_BUNDLES` with `@delorun/bundle-local` and
   * `@delorun/bundle-studio` linked, booting only the manager's row, with a `packInstallTargets` service that names these
   * packages, by name, as packs whose `link:` spec is their workspace folder.
   */
  delorunDefault?: { packs: Record<string, string> }
}

// The undo and restore cases run real Git, so the host's command-line configuration group must not reach it.
let restoreGitCommandLineConfig: () => void
beforeAll(() => { restoreGitCommandLineConfig = isolateGitCommandLineConfig() })
afterAll(() => { restoreGitCommandLineConfig() })

/**
 * Write a bundle package, whose `./plugin.mjs` is a no-op plugin, under the profile's `node_modules`.
 * @param dir - the profile directory.
 * @param name - the package name.
 * @param patch - the bundle's patch.
 */
function writeBundle(dir: string, name: string, patch: Patch): void {
  writePackage(dir, name, { dsh: { bundle: { patch: './cordis.patch.yml' } } })
  writeFileSync(join(dir, 'node_modules', name, 'cordis.patch.yml'), JSON.stringify(patch))
}

/**
 * Boot a profile whose manager row has `@delorun/bundle-local`'s config, beside {@link GUARD_BUNDLE}, which inserts one
 * enabled row per protected module, with the `plugin_manager` tool in `danger-full-access` and no approval service:
 * any call the tool lets through runs without asking.
 * @param options - see {@link FixtureOptions}; live HMR and Delorun's config by default.
 */
async function fixture(options: FixtureOptions = {}) {
  const { config = delorunManagerConfig(), reload = 'live', bundles = {}, delorunDefault } = options
  const temporaryHome = mkdtempSync(join(tmpdir(), 'plugin-manager-delorun-'))
  let owner: Context | undefined
  onTestFinished(async () => { await owner?.fiber.dispose(); rmSync(temporaryHome, { recursive: true, force: true }) })
  const home = await realpath(temporaryHome)
  const dir = join(home, 'profiles', 'default')
  const managerRow: Patch = [{ insert: [{ id: 'plugin-manager', name: 'cordis:manager', config }] }]
  let anchor = join(home, 'package.json')
  if (delorunDefault === undefined) {
    writeFileSync(anchor, JSON.stringify({ name: 'installation', dependencies: {} }))
    initProfile(dir, ['core', GUARD_BUNDLE, ...Object.keys(bundles)])
    writeBundle(dir, 'core', managerRow)
    // Delorun links its bundle into the profile, and the fixture's bundles are not dependencies, so no pnpm run is real.
    writeBundle(dir, GUARD_BUNDLE, [{ insert: PROTECTED.map(name => ({ id: rowId(name), name, config: shippedConfig(name) })) }])
    for (const [name, patch] of Object.entries(bundles)) writeBundle(dir, name, patch)
    writePackage(dir, LOCAL_BUNDLE, {}, ['trust', 'update-check', 'update-gate'])
    for (const name of PROTECTED.filter(name => !name.startsWith(`${LOCAL_BUNDLE}/`))) writePackage(dir, name)
  } else {
    // Upstream's bundles resolve through the CLI's package, as a source checkout's Delorun profile does.
    anchor = fileURLToPath(new URL('../../../../apps/cli/package.json', import.meta.url))
    initProfile(dir, DELORUN_PROFILE_BUNDLES)
    for (const [name, target] of [[LOCAL_BUNDLE, LOCAL_DIR], ['@delorun/bundle-studio', STUDIO_DIR]] as const) {
      mkdirSync(dirname(join(dir, 'node_modules', name)), { recursive: true })
      symlinkSync(target, join(dir, 'node_modules', name), 'junction')
    }
  }
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'default', startedBundles: loadProfileDirectory('dsh', dir, anchor).layers.map(layer => layer.packageName),
    dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: anchor, cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  // Delorun's default profile composes rows of modules a unit test does not run, so only the manager's row boots.
  const ctx = await boot('dsh', join(dir, 'cordis.yml'), delorunDefault === undefined ? readProfilePatches('dsh', profile) : managerRow, (ctx) => {
    owner = ctx
    ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    ctx.provide('profileContext', profile)
    if (delorunDefault !== undefined) {
      const packs = delorunDefault.packs
      ctx.provide('packInstallTargets', {
        isPack: name => Promise.resolve(Object.hasOwn(packs, name)), linkSpec: name => (Object.hasOwn(packs, name) ? `link:${packs[name]}` : undefined), runsCurrentRelease: () => Promise.resolve(true),
      } satisfies PackFolderCheck)
    }
    ctx.loader.builtins.manager = PluginManager
  })
  if (reload === 'live') {
    await ctx.plugin(Timer)
    await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    await ctx.hmr.runExclusive(async () => {})
  }
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access' })
  await ctx.plugin(tool, { profileHistory: true })
  const registry = vi.spyOn(operations, 'readProfileRegistry').mockResolvedValue('https://registry.npmjs.org/')
  onTestFinished(() => { registry.mockRestore() })
  const call = async (args: object): Promise<ToolExecutionResult> =>
    executeToolFixture(ctx, { name: 'plugin_manager', arguments: args, callId: ToolCallId('delorun-protected'), signal: new AbortController().signal })
  const files = (): Record<string, string> => Object.fromEntries(['package.json', 'cordis.patch.yml'].map((file) => {
    let text = ''
    try { text = readFileSync(join(dir, file), 'utf8') } catch (_error) {
      // The profile patch is written only by a change; its absence is the unchanged state.
    }
    return [file, text]
  }))
  /** The guard row as the Loader runs it. */
  const guard = () => [...ctx.loader.entries()].find(entry => entry.options.id === GUARD_ROW)
  return { ctx, dir, call, files, guard }
}

/**
 * Answer every pnpm run with success; an `add` of a spec `packages` names installs that package as a profile
 * dependency, as pnpm would.
 * @param dir - the profile directory.
 * @param packages - by spec, the package name and bundle patch the spec installs.
 * @returns the spy, whose calls are the pnpm runs.
 */
function pnpmInstalls(dir: string, packages: Record<string, { name: string; patch: Patch }>) {
  const pnpm = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async (_context, args) => {
    const installed = args[0] === 'add' ? packages[String(args[1])] : undefined
    if (installed !== undefined) {
      writeBundle(dir, installed.name, installed.patch)
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
      manifest.dependencies = { ...manifest.dependencies, [installed.name]: '1.0.0' }
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    }
    return { exitCode: 0, output: '', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { pnpm.mockRestore() })
  return pnpm
}

/** A change result the tool serialized. */
function changeResult(result: ToolExecutionResult): Record<string, unknown> {
  if (typeof result.value !== 'string') throw new Error(`Expected a serialized change result, got ${JSON.stringify(result.content)}`)
  return JSON.parse(result.value) as Record<string, unknown>
}

/** A pack bundle Delorun publishes: its package name, which the fixture installs it by, its patch and its row modules. */
interface PackBundle { name: string; spec: string; patch: Patch; modules: string[] }

/** The modules a patch's inserted rows name, in groups too; built-in and relative modules are left out. */
function patchModules(rows: readonly unknown[]): string[] {
  return rows.flatMap((row) => {
    const { insert, name, config } = row as { insert?: unknown[]; name?: unknown; config?: unknown }
    const own = typeof name === 'string' && !name.startsWith('cordis:') && !name.startsWith('./') ? [name] : []
    return [...own, ...Array.isArray(insert) ? patchModules(insert) : [], ...Array.isArray(config) ? patchModules(config) : []]
  })
}

/** Every bundle under `delorun/packages` that the release publishes as a signed pack (`delorun.pack`). */
const PACK_BUNDLES: PackBundle[] = (() => {
  const packages = fileURLToPath(new URL('../../../../delorun/packages/', import.meta.url))
  return readdirSync(packages).filter(dir => dir.startsWith('bundle-')).flatMap((dir) => {
    const manifest = JSON.parse(readFileSync(join(packages, dir, 'package.json'), 'utf8')) as { name: string; delorun?: { pack?: boolean } }
    if (manifest.delorun?.pack !== true) return []
    const patch = loadOverlayPatches('dsh', join(packages, dir, 'cordis.patch.yml')) as Patch
    return [{ name: manifest.name, spec: manifest.name, patch, modules: [...new Set(patchModules(patch))] }]
  })
})()

/** The refusal a change of a protected guard ends with: its diagnostic names the guard, and its next step says so. */
const GUARD_REFUSAL = {
  changed: false, application: 'failed',
  error: { code: 'management-required', diagnostic: expect.stringContaining(GUARD) },
  nextStep: expect.stringContaining('a guard the profile protects'),
}

/** Bundle patches that would weaken the guard row, each a different way. */
const WEAKENING: ReadonlyArray<readonly [string, Patch]> = [
  ['disables it', [{ id: GUARD_ROW, disabled: true }]],
  ['reconfigures it', [{ id: GUARD_ROW, config: { enabled: false } }]],
  ['inserts another row under its id', [{ insert: [{ id: GUARD_ROW, name: './plugin.mjs' }] }]],
  ['adds a second row of its module', [{ insert: [{ id: 'second-guard', name: GUARD, config: { enabled: false } }] }]],
]

describe('plugin_manager in danger-full-access with @delorun/bundle-local\'s protection', () => {
  it('names the consent and guard plugins, the live-agent gate and its two drivers, the update gate, the update check, the trust bill, the install check, sign-in and reach, and the sandbox rows', () => {
    expect([...PROTECTED].sort()).toEqual([
      '@deepseek-ai/dsh-sandbox-local', '@deepseek-ai/dsh-sandbox-policy', '@delorun/agent-claude-code', '@delorun/agent-codex', '@delorun/bundle-local/trust', '@delorun/bundle-local/update-check', '@delorun/bundle-local/update-gate',
      '@delorun/external-agents', '@delorun/home-auth', '@delorun/plugin-agent-seats', '@delorun/plugin-changes', '@delorun/plugin-delegation-consent', '@delorun/plugin-fetch-guard', '@delorun/plugin-install-check',
      '@delorun/plugin-instruction-consent', '@delorun/plugin-mcp-consent', '@delorun/plugin-permission-defaults', '@delorun/plugin-schedule-consent', '@delorun/plugin-tool-failure-guard', '@delorun/reach',
    ])
  })

  it.each(PROTECTED)('refuses to disable %s, says the profile protects it, and leaves the profile unchanged', async (name) => {
    const { ctx, call, files } = await fixture()
    const before = files()
    const listed = changeResult(await call({ action: 'list_plugins', limit: 100 })) as { entries: Array<{ entryId: string; moduleName: string; readOnlyReason?: string }> }
    const row = listed.entries.find(entry => entry.moduleName === name)
    expect(row).toMatchObject({ readOnlyReason: 'management-required' })
    expect(changeResult(await call({ action: 'set_plugin', target: row?.entryId, enabled: false }))).toMatchObject({
      ...GUARD_REFUSAL, error: { code: 'management-required', diagnostic: `protected by this profile: ${name}` },
    })
    expect(files()).toEqual(before)
    expect([...ctx.loader.entries()].find(entry => entry.options.name === name)?.disabled).toBeFalsy()
  })

  it('keeps upstream\'s refusal and next step for the manager\'s own entry', async () => {
    const { call } = await fixture()
    const result = changeResult(await call({ action: 'set_plugin', target: 'include:plugin-manager', enabled: false }))
    expect(result).toMatchObject({ error: { code: 'management-required' }, nextStep: 'This entry belongs to plugin management itself and cannot be changed.' })
    expect(result['error']).not.toHaveProperty('diagnostic')
  })

  it.each(PROTECTED)('refuses to change the settings of %s and leaves the profile unchanged', async (name) => {
    const { ctx, call, files } = await fixture()
    const before = files()
    const result = await call({ action: 'configure', target: rowId(name), config: { enabled: false } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('cannot be changed (management-required): plugin management protects this entry')
    expect(files()).toEqual(before)
    expect([...ctx.loader.entries()].find(entry => entry.options.name === name)?.options.config).toEqual(shippedConfig(name))
  })

  it('refuses to raise the live-agent gate\'s cap or turn its limit refusal off, a row with no enabled field', async () => {
    const { ctx, call, files } = await fixture()
    const gate = '@delorun/external-agents'
    expect(shippedConfig(gate)).not.toHaveProperty('enabled')
    const before = files()
    const result = await call({ action: 'configure', target: rowId(gate), config: { ...shippedConfig(gate), maxLivePrograms: 99, limitRefusal: false } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('cannot be changed (management-required): plugin management protects this entry')
    expect(files()).toEqual(before)
    expect([...ctx.loader.entries()].find(entry => entry.options.name === gate)?.options.config).toEqual(shippedConfig(gate))
  })

  it('refuses to set the permission row\'s fullAccessEverywhere, so no chat turns dangerous mode on', async () => {
    const { ctx, call, files } = await fixture()
    const before = files()
    const result = await call({ action: 'configure', target: rowId('@delorun/plugin-permission-defaults'), config: { enabled: true, fullAccessEverywhere: true } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('cannot be changed (management-required): plugin management protects this entry')
    expect(files()).toEqual(before)
    expect([...ctx.loader.entries()].find(entry => entry.options.name === '@delorun/plugin-permission-defaults')?.options.config).toEqual({ enabled: true })
  })

  it('refuses to change the manager\'s own settings, so the protection cannot be configured away', async () => {
    const { call, files } = await fixture()
    const before = files()
    const result = await call({ action: 'configure', target: 'plugin-manager', config: { protectedPlugins: [] } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('cannot be changed (management-required)')
    expect(files()).toEqual(before)
  })

  it('refuses configure for a row set_plugin refuses as unaddressable, with the same reason and next step', async () => {
    const twin = { id: 'twin', name: './plugin.mjs' }
    const { call, files } = await fixture({ bundles: { 'twin-bundle': [{ insert: [twin] }, { insert: [{ ...twin, config: { a: 1 } }] }] } })
    const before = files()
    const toggled = changeResult(await call({ action: 'set_plugin', target: 'include:twin', enabled: false }))
    expect(toggled).toMatchObject({ application: 'failed', error: { code: 'unaddressable' } })
    const configured = await call({ action: 'configure', target: 'twin', config: { a: 2 } })
    expect(configured.isError).toBe(true)
    expect(JSON.stringify(configured.content)).toContain(`cannot be changed (unaddressable): ${String(toggled['nextStep'])}`)
    expect(files()).toEqual(before)
  })

  it('refuses to deselect or remove the non-official bundle carrying the protected rows and leaves the profile unchanged', async () => {
    const { call, files } = await fixture()
    const before = files()
    const bundles = changeResult(await call({ action: 'list_bundles', limit: 100 })) as { entries: Array<{ name: string }> }
    expect(bundles.entries.find(bundle => bundle.name === GUARD_BUNDLE)).toMatchObject({ official: false, removable: false, readOnlyReason: 'management-required' })
    expect(changeResult(await call({ action: 'set_bundle', target: GUARD_BUNDLE, enabled: false }))).toMatchObject(GUARD_REFUSAL)
    expect(changeResult(await call({ action: 'remove_bundle', target: GUARD_BUNDLE }))).toMatchObject({
      changed: false, application: 'failed', error: { code: 'not-removable' },
    })
    expect(files()).toEqual(before)
  })

  it('refuses to deselect or remove a bundle that provides a protected module without carrying its row', async () => {
    const protectedPlugins = [...PROTECTED, 'provider-bundle/guard']
    const { call, files } = await fixture({ config: { protectedPlugins }, bundles: { 'provider-bundle': [{ insert: [{ id: 'provider-row', name: './plugin.mjs' }] }] } })
    const before = files()
    expect(changeResult(await call({ action: 'set_bundle', target: 'provider-bundle', enabled: false }))).toMatchObject({
      changed: false, application: 'failed', error: { code: 'management-required', diagnostic: 'protected by this profile: provider-bundle/guard' },
    })
    expect(changeResult(await call({ action: 'remove_bundle', target: 'provider-bundle' }))).toMatchObject({ application: 'failed', error: { code: 'not-removable' } })
    expect(files()).toEqual(before)
  })

  it('switches a third-party bundle off and on again when its patch only adds a setting to a protected row', async () => {
    // The shape of a real plugin: dsh-unlag@1.17.11 adds `base` to the hmr row's settings, which is how it reloads.
    const patch: Patch = [
      { insert: [{ id: 'setting-row', name: './plugin.mjs' }] },
      { id: GUARD_ROW, disabled: false, config: { ...shippedConfig(GUARD), base: 'file:///plugin/' } },
    ]
    const { dir, call, files, guard } = await fixture()
    writeBundle(dir, 'setting-bundle', patch)
    const manifest = readProfileManifest('dsh', dir)
    manifest.dependencies = { ...manifest.dependencies, 'setting-bundle': '1.0.0' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    expect(changeResult(await call({ action: 'set_bundle', target: 'setting-bundle', enabled: true }))).toMatchObject({
      changed: true, application: 'applied', enabled: true,
    })
    expect(changeResult(await call({ action: 'set_bundle', target: 'setting-bundle', enabled: false }))).toMatchObject({
      changed: true, application: 'applied', enabled: false,
    })
    // Switching it back on: the guard row keeps every setting the profile ships, so nothing is taken away.
    expect(changeResult(await call({ action: 'set_bundle', target: 'setting-bundle', enabled: true }))).toMatchObject({
      changed: true, application: 'applied', enabled: true,
    })
    expect(guard()).toMatchObject({ disabled: false, options: { name: GUARD, config: { ...shippedConfig(GUARD), base: 'file:///plugin/' } } })
    expect(files()['package.json']).toContain('setting-bundle')
  })

  it.each([
    ['drops', { base: 'file:///plugin/' }],
    ['changes', { ...shippedConfig(GUARD), ...Object.fromEntries(Object.keys(shippedConfig(GUARD)).map(key => [key, 'changed'])) }],
  ] as const)('refuses to switch on a bundle whose patch %s a setting the profile ships for a protected row', async (_way, config) => {
    const patch: Patch = [{ insert: [{ id: 'shrinking-row', name: './plugin.mjs' }] }, { id: GUARD_ROW, config }]
    const { dir, call, files, guard } = await fixture()
    writeBundle(dir, 'shrinking-bundle', patch)
    const manifest = readProfileManifest('dsh', dir)
    manifest.dependencies = { ...manifest.dependencies, 'shrinking-bundle': '1.0.0' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    const before = files()
    expect(changeResult(await call({ action: 'set_bundle', target: 'shrinking-bundle', enabled: true }))).toMatchObject({
      ...GUARD_REFUSAL, error: { code: 'management-required', diagnostic: `protected by this profile: ${GUARD}` },
    })
    expect(files()).toEqual(before)
    expect(guard()).toMatchObject({ disabled: false, options: { config: shippedConfig(GUARD) } })
  })

  it('refuses a bundle that carries a protected module in both directions, before and after a deselection', async () => {
    const { dir, call } = await fixture()
    const carrier = 'carrier-bundle'
    writeBundle(dir, carrier, [{ insert: [{ id: 'carrier-guard', name: GUARD }] }])
    const manifest = readProfileManifest('dsh', dir)
    manifest.dependencies = { ...manifest.dependencies, [carrier]: '1.0.0' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    type Listed = { name: string; enabled: boolean; removable: boolean; readOnlyReason?: string }
    const listed = async (): Promise<Listed> => {
      const bundles = changeResult(await call({ action: 'list_bundles', limit: 100 })) as { entries: Listed[] }
      const found = bundles.entries.find(bundle => bundle.name === carrier)
      if (found === undefined) throw new Error(`${carrier} is not listed`)
      return found
    }
    // Deselected, and listed so: a bundle carrying a guard row cannot be switched on.
    expect(await listed()).toMatchObject({ enabled: false, removable: false, readOnlyReason: 'management-required' })
    expect(changeResult(await call({ action: 'set_bundle', target: carrier, enabled: true }))).toMatchObject({
      changed: false, application: 'failed', error: { code: 'management-required', diagnostic: `protected by this profile: ${GUARD}` },
    })
    expect(await listed()).toMatchObject({ enabled: false, readOnlyReason: 'management-required' })
    expect(readProfileManifest('dsh', dir).dsh?.profile?.bundles).not.toContain(carrier)
    // On, once the profile selects it: switching it off is refused with the same code.
    const selected = readProfileManifest('dsh', dir)
    selected.dsh = { ...selected.dsh, profile: { ...selected.dsh?.profile, bundles: [...(selected.dsh?.profile?.bundles ?? []), carrier] } }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(selected))
    expect(await listed()).toMatchObject({ enabled: true, readOnlyReason: 'management-required' })
    expect(changeResult(await call({ action: 'set_bundle', target: carrier, enabled: false }))).toMatchObject(GUARD_REFUSAL)
    expect(await listed()).toMatchObject({ enabled: true, readOnlyReason: 'management-required' })
  })

  it('lets the same calls disable a row of the bundle and remove the bundle without the protection', async () => {
    const { call } = await fixture({ config: {} })
    const listed = changeResult(await call({ action: 'list_plugins', limit: 100 })) as { entries: Array<{ entryId: string; moduleName: string; readOnlyReason?: string }> }
    const row = listed.entries.find(entry => entry.moduleName === GUARD)
    expect(row?.readOnlyReason).toBeUndefined()
    expect(changeResult(await call({ action: 'set_plugin', target: row?.entryId, enabled: false }))).toMatchObject({ changed: true, application: 'applied' })
    const bundles = changeResult(await call({ action: 'list_bundles', limit: 100 })) as { entries: Array<{ name: string }> }
    expect(bundles.entries.find(bundle => bundle.name === GUARD_BUNDLE)).toMatchObject({ official: false, removable: true })
    expect(changeResult(await call({ action: 'remove_bundle', target: GUARD_BUNDLE }))).toMatchObject({ changed: true, application: 'applied' })
  })

  it.each(WEAKENING)('refuses to install a bundle whose patch %s, and puts the profile back', async (_way, patch) => {
    const { dir, call, files, guard } = await fixture()
    pnpmInstalls(dir, { 'weakening-bundle': { name: 'weakening-bundle', patch } })
    const before = files()
    expect(changeResult(await call({ action: 'install_bundle', target: 'weakening-bundle' }))).toMatchObject(GUARD_REFUSAL)
    expect(files()).toEqual(before)
    expect(guard()).toMatchObject({ disabled: false, options: { name: GUARD, config: { enabled: true } } })
  })

  it.each(WEAKENING)('refuses to select an installed bundle whose patch %s', async (_way, patch) => {
    const { dir, call, files, guard } = await fixture()
    writeBundle(dir, 'weakening-bundle', patch)
    const before = files()
    expect(changeResult(await call({ action: 'set_bundle', target: 'weakening-bundle', enabled: true }))).toMatchObject(GUARD_REFUSAL)
    expect(files()).toEqual(before)
    expect(guard()).toMatchObject({ disabled: false, options: { config: { enabled: true } } })
  })

  it.each(PACK_BUNDLES.map(bundle => [bundle.name, bundle] as const))('installs and turns on the published pack %s with its own patch, which leaves the protected rows as they are', async (_name, bundle) => {
    const { dir, call, files } = await fixture()
    pnpmInstalls(dir, { [bundle.spec]: { name: bundle.name, patch: bundle.patch } })
    for (const module of bundle.modules) {
      if (module.startsWith(`${bundle.name}/`)) continue
      writePackage(dir, module)
    }
    const result = changeResult(await call({ action: 'install_bundle', target: bundle.spec }))
    expect(result['error']).toBeUndefined()
    expect(result).toMatchObject({ changed: true, application: 'applied', bundle: bundle.name })
    expect(files()['package.json']).toContain(bundle.name)
  })

  it('refuses to install a bundle whose isolated group adds a row of upstream\'s web server module, and puts the profile back', async () => {
    const { dir, call, files } = await fixture()
    const server = '@deepseek-ai/dsh-host-webserver'
    writePackage(dir, server)
    const patch: Patch = [{ insert: [{ id: 'second-server-group', name: 'cordis:group', group: true, disabled: true, isolate: { webServer: true }, config: [{ id: 'second-server', name: server }] }] }]
    pnpmInstalls(dir, { 'server-bundle': { name: 'server-bundle', patch } })
    const before = files()
    expect(changeResult(await call({ action: 'install_bundle', target: 'server-bundle' }))).toMatchObject({ changed: false, application: 'failed', error: { code: 'management-required' } })
    expect(files()).toEqual(before)
  })

  it('installs and selects a bundle whose patch leaves the protected rows as they are', async () => {
    const { dir, call } = await fixture()
    pnpmInstalls(dir, { 'other-bundle': { name: 'other-bundle', patch: [{ insert: [{ id: 'other', name: './plugin.mjs' }] }] } })
    expect(changeResult(await call({ action: 'install_bundle', target: 'other-bundle' }))).toMatchObject({ changed: true, application: 'applied' })
  })

  it('refuses to install a package that provides a protected module, before pnpm runs when the spec names it', async () => {
    const { dir, call, files } = await fixture()
    const pnpm = pnpmInstalls(dir, { 'https://example.invalid/guard.tgz': { name: GUARD, patch: [] } })
    const before = files()
    expect(changeResult(await call({ action: 'install_bundle', target: GUARD }))).toMatchObject(GUARD_REFUSAL)
    expect(pnpm).not.toHaveBeenCalled()
    // A tarball names its package only once pnpm has installed it; the profile's files go back as they were.
    expect(changeResult(await call({ action: 'install_bundle', target: 'https://example.invalid/guard.tgz' }))).toMatchObject(GUARD_REFUSAL)
    expect(files()).toEqual(before)
  })
})

/** The packs the release publishes, by package name: Delorun's optional bundles and upstream's two agent bundles. */
const RELEASE_PACKS = [
  '@deepseek-ai/dsh-subagent-claude-code', '@deepseek-ai/dsh-subagent-codex', '@delorun/bundle-agent-hooks', '@delorun/bundle-browser',
  '@delorun/bundle-code-intelligence', '@delorun/bundle-computer-use-driver', '@delorun/bundle-external-agents', '@delorun/bundle-real-browser',
  '@delorun/bundle-webhooks',
] as const

/** Every workspace package's folder by name, under `packages/<group>/` and `delorun/packages/`. */
const WORKSPACE_DIRS: Record<string, string> = (() => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url))
  const groups = readdirSync(join(root, 'packages'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(root, 'packages', entry.name))
  const parents = [...groups, join(root, 'delorun', 'packages')]
  return Object.fromEntries(parents.flatMap(parent => readdirSync(parent).flatMap((entry) => {
    try {
      return [[(JSON.parse(readFileSync(join(parent, entry, 'package.json'), 'utf8')) as { name: string }).name, join(parent, entry)]]
    } catch (_error) {
      // A group's README or a folder without a package.json is no package.
      return []
    }
  })))
})()

/** Each release pack's workspace folder, which the fixture's `packInstallTargets` names as its `link:` spec. */
const PACK_DIRS: Record<string, string> = Object.fromEntries(RELEASE_PACKS.map(name => [name, WORKSPACE_DIRS[name]!]))

/**
 * Answer every pnpm run with success; an `add` of a `link:` spec links the folder at `node_modules/<its name>` and saves
 * the dependency, as pnpm does for a pack.
 * @param dir - the profile directory.
 * @returns the spy.
 */
function pnpmLinks(dir: string) {
  const pnpm = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async (_context, args) => {
    const spec = String(args[1])
    if (args[0] === 'add' && spec.startsWith('link:')) {
      const target = spec.slice('link:'.length)
      const { name } = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as { name: string }
      rmSync(join(dir, 'node_modules', name), { force: true })
      mkdirSync(dirname(join(dir, 'node_modules', name)), { recursive: true })
      symlinkSync(target, join(dir, 'node_modules', name), 'junction')
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
      manifest.dependencies = { ...manifest.dependencies, [name]: spec }
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    }
    return await Promise.resolve({ exitCode: 0, output: '', truncated: false, logPath: join(dir, 'pnpm.log') })
  })
  onTestFinished(() => { pnpm.mockRestore() })
  return pnpm
}

/**
 * Store a pack folder as Changes does for a linked plugin and put the copy where the profile's link was. The folder's
 * installed packages stand for the pack's peers: the fixture home's active runtime, `runtimes/0.1.0/app/node_modules`,
 * is a link to this repository, so the copy keeps every link into it as Changes keeps a pack's links into the runtime.
 * @param home - the fixture's Delorun home.
 * @param folder - the pack folder.
 * @param target - where the profile loads the package from.
 * @returns the copy's path.
 */
async function reviewCopy(home: string, folder: string, target: string): Promise<string> {
  mkdirSync(join(home, 'runtimes', '0.1.0', 'app'), { recursive: true })
  writeFileSync(join(home, 'runtimes', 'current'), '0.1.0\n')
  rmSync(join(home, 'runtimes', '0.1.0', 'app', 'node_modules'), { force: true })
  symlinkSync(fileURLToPath(new URL('../../../../', import.meta.url)), join(home, 'runtimes', '0.1.0', 'app', 'node_modules'), 'junction')
  const { version, skipped } = await storeFolder(home, folder, { dependencies: 'include' })
  expect(skipped.filter(path => !path.startsWith('node_modules/') || path.includes('/node_modules/')), 'paths the copy left out').toEqual([])
  rmSync(target, { force: true })
  await materialize(home, version, target)
  return target
}

describe('every pack the release publishes, on Delorun\'s default profile', () => {
  it('names every Delorun bundle marked as a pack', () => {
    const marked = Object.entries(WORKSPACE_DIRS).filter(([name, folder]) => name.startsWith('@delorun/bundle-')
      && (JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as { delorun?: { pack?: boolean } }).delorun?.pack === true).map(([name]) => name)
    expect(RELEASE_PACKS).toEqual(expect.arrayContaining(marked))
  })

  it.each(RELEASE_PACKS)('installs %s through its pack folder, turns it off and on again, with no refusal', async (name) => {
    const { ctx, dir } = await fixture({ reload: 'startup', delorunDefault: { packs: PACK_DIRS } })
    const pnpm = pnpmLinks(dir)
    const { version } = JSON.parse(readFileSync(join(PACK_DIRS[name]!, 'package.json'), 'utf8')) as { version: string }
    const installed = await ctx.pluginManager.installBundle(`link:${PACK_DIRS[name]!}`, { enabled: true, requestId: `pack:${name}` as PluginInstallRequestId, expected: { name, version } })
    expect(installed.error, JSON.stringify(installed.error)).toBeUndefined()
    expect(installed).toMatchObject({ changed: true, bundle: name })
    expect(['applied', 'restart-required']).toContain(installed.application)
    // The pack path resolves without running anything, then installs the lockfile: the guarded two-phase install.
    expect(pnpm.mock.calls.map(([, args]) => args[0])).toEqual(['add', 'install'])
    for (const enabled of [false, true]) {
      const switched = await ctx.pluginManager.setBundleEnabled(name, enabled)
      expect(switched.error, `${String(enabled)} ${JSON.stringify(switched.error)}`).toBeUndefined()
    }
    // Changes copies the linked pack into the profile, and every row module loads from that copy.
    const copy = await reviewCopy(dirname(dirname(dir)), PACK_DIRS[name]!, join(dir, 'node_modules', name))
    // Each package the pack depends on stays a link into the active runtime, as a pack's peers are linked.
    const { dependencies = {} } = JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    for (const dependency of Object.keys(dependencies)) expect(lstatSync(join(copy, 'node_modules', dependency)).isSymbolicLink(), dependency).toBe(true)
    const patch = loadOverlayPatches('dsh', join(copy, 'cordis.patch.yml')) as Patch
    for (const module of new Set(patchModules(patch))) {
      const resolved = createRequire(join(copy, 'package.json')).resolve(module)
      await expect(import(/* @vite-ignore */ pathToFileURL(resolved).href), module).resolves.toBeDefined()
    }
  })

  it('refuses a pack through any spec but its pack folder, before pnpm runs', async () => {
    const { ctx, dir } = await fixture({ reload: 'startup', delorunDefault: { packs: PACK_DIRS } })
    const pnpm = pnpmLinks(dir)
    const result = await ctx.pluginManager.installBundle('@delorun/bundle-browser', { enabled: true })
    expect(result).toMatchObject({ changed: false, application: 'failed', error: { code: 'operation-error' } })
    expect(pnpm).not.toHaveBeenCalled()
  })

  it.each([
    ['moves the webhook server\'s port, which only the device policy protects', 'github-webhook-server', true],
    ['moves the studio\'s own web server off loopback', 'webserver', false],
  ] as const)('a second bundle that %s is %s', async (_way, id, accepted) => {
    const { ctx, dir } = await fixture({ reload: 'startup', delorunDefault: { packs: PACK_DIRS } })
    pnpmLinks(dir)
    const webhooks = '@delorun/bundle-webhooks'
    expect((await ctx.pluginManager.installBundle(`link:${PACK_DIRS[webhooks]!}`, { enabled: true })).error).toBeUndefined()
    const mover = join(dir, 'mover')
    mkdirSync(mover)
    writeFileSync(join(mover, 'package.json'), JSON.stringify({ name: 'mover', version: '1.0.0', type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(mover, 'cordis.patch.yml'), JSON.stringify([{ id, config: { host: '0.0.0.0', port: 3091 } }]))
    const result = await ctx.pluginManager.installBundle(`link:${mover}`, { enabled: true })
    if (accepted) expect(result.error, JSON.stringify(result.error)).toBeUndefined()
    else expect(result).toMatchObject({ changed: false, application: 'failed', error: { code: 'management-required' } })
  })
})

describe('plugin_manager undo and restore in danger-full-access with @delorun/bundle-local\'s protection', () => {
  /**
   * Save a version the person made outside plugin management, then put the files back and save that too.
   * @returns the id of the outside version.
   */
  async function outsideVersion(ctx: Context, dir: string, edit: (dir: string) => void): Promise<string> {
    const original = new Map(['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml'].map(file => [file, (() => {
      try { return readFileSync(join(dir, file), 'utf8') } catch (_error) {
        // An absent file is put back absent.
        return undefined
      }
    })()]))
    await ctx.pluginManager.history(1)
    edit(dir)
    const saved = await ctx.pluginManager.history(1)
    if (!saved.available) throw new Error(saved.reason)
    for (const [file, text] of original) {
      if (text === undefined) rmSync(join(dir, file), { force: true })
      else writeFileSync(join(dir, file), text)
    }
    await ctx.pluginManager.history(1)
    return saved.versions[0]!.id
  }

  const EDITS: ReadonlyArray<readonly [string, (dir: string) => void]> = [
    ['disables the guard row', (dir) => { writeFileSync(join(dir, 'cordis.patch.yml'), JSON.stringify([{ id: GUARD_ROW, disabled: true }])) }],
    ['reconfigures the guard row', (dir) => { writeFileSync(join(dir, 'cordis.patch.yml'), JSON.stringify([{ id: GUARD_ROW, config: { enabled: false } }])) }],
    ['drops the bundle carrying the guard row', (dir) => {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== GUARD_BUNDLE)
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    }],
    ['changes the dependency set and reconfigures the guard row', (dir) => {
      writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n')
      writeFileSync(join(dir, 'cordis.patch.yml'), JSON.stringify([{ id: GUARD_ROW, config: { enabled: false } }]))
    }],
    ['adds a dependency that provides the guard module', (dir) => {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
      manifest.dependencies = { ...manifest.dependencies, [GUARD]: '1.0.0' }
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    }],
  ]

  it.each(EDITS)('refuses to restore a version that %s, and leaves the profile as it was', async (_way, edit) => {
    const { ctx, dir, call, files, guard } = await fixture({ reload: 'startup' })
    pnpmInstalls(dir, {})
    const version = await outsideVersion(ctx, dir, edit)
    const before = files()
    expect(changeResult(await call({ action: 'restore', target: version }))).toMatchObject(GUARD_REFUSAL)
    expect(files()).toEqual(before)
    expect(guard()).toMatchObject({ disabled: false, options: { config: { enabled: true } } })
  })

  it('refuses to undo back to a version that disables the guard row', async () => {
    const { ctx, dir, call, files } = await fixture({ reload: 'startup' })
    await outsideVersion(ctx, dir, EDITS[0]![1])
    const before = files()
    expect(changeResult(await call({ action: 'undo' }))).toMatchObject(GUARD_REFUSAL)
    expect(files()).toEqual(before)
  })

  describe.each(['restore', 'undo'] as const)('%s back to a version that turns the external-agent consent off', (action) => {
    it('is refused, and leaves the profile as it was', async () => {
      const consent = '@delorun/plugin-delegation-consent'
      const { ctx, dir, call, files } = await fixture({ reload: 'startup' })
      pnpmInstalls(dir, {})
      const version = await outsideVersion(ctx, dir, (edited) => {
        writeFileSync(join(edited, 'cordis.patch.yml'), JSON.stringify([{ id: rowId(consent), config: { enabled: false } }]))
      })
      const before = files()
      const result = changeResult(await call(action === 'restore' ? { action, target: version } : { action }))
      expect(result).toMatchObject({ ...GUARD_REFUSAL, error: { code: 'management-required', diagnostic: expect.stringContaining(consent) } })
      expect(files()).toEqual(before)
    })
  })

  /** A version exemption of the guard's package for a fixture runtime. */
  const EXEMPTION = { [`${GUARD}@1.0.0`]: ['0.0.1'] }

  it('refuses to revoke a version exemption of a package that provides a protected module, and keeps the exemption', async () => {
    const { dir, call } = await fixture({ reload: 'startup' })
    writeFileSync(join(dir, 'compatibility.json'), JSON.stringify(EXEMPTION))
    expect(changeResult(await call({ action: 'set_version_exemption', target: `${GUARD}@1.0.0`, runtimeVersion: '0.0.1', enabled: false })))
      .toMatchObject(GUARD_REFUSAL)
    expect(JSON.parse(readFileSync(join(dir, 'compatibility.json'), 'utf8'))).toEqual(EXEMPTION)
  })

  it('refuses to restore a version without the guard\'s exemption, and keeps it', async () => {
    const { ctx, dir, call } = await fixture({ reload: 'startup' })
    const version = await outsideVersion(ctx, dir, (dir) => { rmSync(join(dir, 'compatibility.json'), { force: true }) })
    writeFileSync(join(dir, 'compatibility.json'), JSON.stringify(EXEMPTION))
    await ctx.pluginManager.history(1)
    expect(changeResult(await call({ action: 'restore', target: version }))).toMatchObject(GUARD_REFUSAL)
    expect(JSON.parse(readFileSync(join(dir, 'compatibility.json'), 'utf8'))).toEqual(EXEMPTION)
  })

  it('revokes a version exemption of an unprotected package', async () => {
    const { dir, call } = await fixture({ reload: 'startup' })
    writeFileSync(join(dir, 'compatibility.json'), JSON.stringify({ 'unrelated-plugin@1.0.0': ['0.0.1'] }))
    expect(changeResult(await call({ action: 'set_version_exemption', target: 'unrelated-plugin@1.0.0', runtimeVersion: '0.0.1', enabled: false })))
      .toMatchObject({ changed: true })
  })

  it('restores a version that leaves the protected rows as they are', async () => {
    const { ctx, dir, call } = await fixture({ reload: 'startup' })
    const version = await outsideVersion(ctx, dir, (dir) => { writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n') })
    expect(changeResult(await call({ action: 'restore', target: version }))).toMatchObject({ changed: true })
  })
})
