/**
 * The plugins Delo's `@delo/bundle-local` protects through the manager's `protectedPlugins`: in full access, where the
 * `plugin_manager` tool asks nothing, no tool action can disable one, change its settings, drop it, add a row of its
 * module, give its row id to another row, or deselect, remove, install or change the package that carries or provides
 * it, and the profile's files stay as they were.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import {
  boot, initProfile, loadOverlayPatches, loadProfileDirectory, readProfilePatches, type ProfileContext,
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
import * as operations from '../src/operations.ts'
import * as tool from '../src/tools.ts'
import { isolateGitCommandLineConfig } from './git-environment.ts'

/** Delo's bundle, whose patch configures the manager's row. */
const LOCAL_BUNDLE = '@delo/bundle-local'
/**
 * The stand-in for the bundle that carries the protected rows. It is not named `@delo/bundle-local`, which the
 * workspace's own copy answers when a runner puts the workspace's packages on `NODE_PATH`.
 */
const GUARD_BUNDLE = 'guard-bundle'
const LOCAL_PATCH = fileURLToPath(new URL('../../../../delo/packages/bundle-local/cordis.patch.yml', import.meta.url))

/** The manager row's config as `@delo/bundle-local` writes it. */
function deloManagerConfig(): { protectedPlugins: string[] } {
  const row = loadOverlayPatches('dsh', LOCAL_PATCH).find(patch => patch.id === 'plugin-manager')
  const config = row?.config as { protectedPlugins?: unknown } | undefined
  if (!Array.isArray(config?.protectedPlugins)) throw new Error(`${LOCAL_PATCH} configures no protectedPlugins on the plugin-manager row`)
  return { protectedPlugins: config.protectedPlugins.map(String) }
}

const PROTECTED = deloManagerConfig().protectedPlugins

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
const GUARD = '@delo/plugin-fetch-guard'
const GUARD_ROW = rowId(GUARD)

/** A bundle patch, as a package's `cordis.patch.yml` holds it. */
type Patch = Array<Record<string, unknown>>

/** How the fixture boots: the manager row's config, whether HMR runs, and other selected bundles with their patches. */
interface FixtureOptions {
  config?: object
  reload?: 'live' | 'startup'
  bundles?: Record<string, Patch>
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
 * Boot a profile whose manager row has `@delo/bundle-local`'s config, beside {@link GUARD_BUNDLE}, which inserts one
 * enabled row per protected module, with the `plugin_manager` tool in `danger-full-access` and no approval service:
 * any call the tool lets through runs without asking.
 * @param options - see {@link FixtureOptions}; live HMR and Delo's config by default.
 */
async function fixture(options: FixtureOptions = {}) {
  const { config = deloManagerConfig(), reload = 'live', bundles = {} } = options
  const temporaryHome = mkdtempSync(join(tmpdir(), 'plugin-manager-delo-'))
  let owner: Context | undefined
  onTestFinished(async () => { await owner?.fiber.dispose(); rmSync(temporaryHome, { recursive: true, force: true }) })
  const home = await realpath(temporaryHome)
  const dir = join(home, 'profiles', 'default')
  const anchor = join(home, 'package.json')
  writeFileSync(anchor, JSON.stringify({ name: 'installation', dependencies: {} }))
  initProfile(dir, ['core', GUARD_BUNDLE, ...Object.keys(bundles)])
  writeBundle(dir, 'core', [{ insert: [{ id: 'plugin-manager', name: 'cordis:manager', config }] }])
  // Delo links its bundle into the profile, and the fixture's bundles are not dependencies, so no pnpm run is real.
  writeBundle(dir, GUARD_BUNDLE, [{ insert: PROTECTED.map(name => ({ id: rowId(name), name, config: { enabled: true } })) }])
  for (const [name, patch] of Object.entries(bundles)) writeBundle(dir, name, patch)
  writePackage(dir, LOCAL_BUNDLE, {}, ['update-check', 'update-gate'])
  for (const name of PROTECTED.filter(name => !name.startsWith(`${LOCAL_BUNDLE}/`))) writePackage(dir, name)
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'default', startedBundles: loadProfileDirectory('dsh', dir, anchor).layers.map(layer => layer.packageName),
    dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: anchor, cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('dsh', join(dir, 'cordis.yml'), readProfilePatches('dsh', profile), (ctx) => {
    owner = ctx
    ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    ctx.provide('profileContext', profile)
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
    executeToolFixture(ctx, { name: 'plugin_manager', arguments: args, callId: ToolCallId('delo-protected'), signal: new AbortController().signal })
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

describe('plugin_manager in danger-full-access with @delo/bundle-local\'s protection', () => {
  it('names the consent and guard plugins, the update gate, the update check, the trust bill, the install check, sign-in and reach, and the sandbox rows', () => {
    expect([...PROTECTED].sort()).toEqual([
      '@deepseek-ai/dsh-sandbox-local', '@deepseek-ai/dsh-sandbox-policy', '@delo/bundle-local/trust', '@delo/bundle-local/update-check', '@delo/bundle-local/update-gate',
      '@delo/home-auth', '@delo/plugin-changes', '@delo/plugin-delegation-consent', '@delo/plugin-fetch-guard', '@delo/plugin-install-check', '@delo/plugin-instruction-consent', '@delo/plugin-mcp-consent',
      '@delo/plugin-permission-defaults', '@delo/plugin-schedule-consent', '@delo/reach',
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
    expect([...ctx.loader.entries()].find(entry => entry.options.name === name)?.options.config).toEqual({ enabled: true })
  })

  it('refuses to set the permission row\'s fullAccessEverywhere, so no chat turns dangerous mode on', async () => {
    const { ctx, call, files } = await fixture()
    const before = files()
    const result = await call({ action: 'configure', target: rowId('@delo/plugin-permission-defaults'), config: { enabled: true, fullAccessEverywhere: true } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('cannot be changed (management-required): plugin management protects this entry')
    expect(files()).toEqual(before)
    expect([...ctx.loader.entries()].find(entry => entry.options.name === '@delo/plugin-permission-defaults')?.options.config).toEqual({ enabled: true })
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

describe('plugin_manager undo and restore in danger-full-access with @delo/bundle-local\'s protection', () => {
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
      const consent = '@delo/plugin-delegation-consent'
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
