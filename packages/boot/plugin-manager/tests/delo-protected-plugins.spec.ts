/**
 * The plugins Delo's `@delo/bundle-local` protects through the manager's `protectedPlugins`: in full access, where the
 * `plugin_manager` tool asks nothing, the tool can neither disable one, change its settings, nor deselect or remove the
 * bundle that carries it, and the profile's files stay as they were.
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
import { describe, expect, it, onTestFinished } from 'vitest'
import PluginManager from '../src/index.ts'
import * as tool from '../src/tools.ts'

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

/**
 * Boot a live profile whose manager row has `@delo/bundle-local`'s config, beside {@link GUARD_BUNDLE}, which inserts
 * one enabled row per protected module, with the `plugin_manager` tool in `danger-full-access` and no approval
 * service: any call the tool lets through runs without asking.
 * @param config - the manager row's config.
 */
async function fixture(config: object = deloManagerConfig()) {
  const temporaryHome = mkdtempSync(join(tmpdir(), 'plugin-manager-delo-'))
  let owner: Context | undefined
  onTestFinished(async () => { await owner?.fiber.dispose(); rmSync(temporaryHome, { recursive: true, force: true }) })
  const home = await realpath(temporaryHome)
  const dir = join(home, 'profiles', 'default')
  const anchor = join(home, 'package.json')
  writeFileSync(anchor, JSON.stringify({ name: 'installation', dependencies: {} }))
  initProfile(dir, ['core', GUARD_BUNDLE])
  writePackage(dir, 'core', { dsh: { bundle: { patch: './cordis.patch.yml' } } })
  writeFileSync(join(dir, 'node_modules', 'core', 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'plugin-manager', name: 'cordis:manager', config }] }]))
  // Delo links its bundle into the profile without a dependency, as `delorun setup` does.
  writePackage(dir, GUARD_BUNDLE, { dsh: { bundle: { patch: './cordis.patch.yml' } } })
  writeFileSync(join(dir, 'node_modules', GUARD_BUNDLE, 'cordis.patch.yml'), JSON.stringify([{ insert: PROTECTED.map(name => ({ id: rowId(name), name, config: { enabled: true } })) }]))
  writePackage(dir, LOCAL_BUNDLE, {}, ['update-gate'])
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
  await ctx.plugin(Timer)
  await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
  await ctx.hmr.runExclusive(async () => {})
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access' })
  await ctx.plugin(tool, { profileHistory: true })
  const call = async (args: object): Promise<ToolExecutionResult> =>
    executeToolFixture(ctx, { name: 'plugin_manager', arguments: args, callId: ToolCallId('delo-protected'), signal: new AbortController().signal })
  const files = (): Record<string, string> => Object.fromEntries(['package.json', 'cordis.patch.yml'].map((file) => {
    let text = ''
    try { text = readFileSync(join(dir, file), 'utf8') } catch (_error) {
      // The profile patch is written only by a change; its absence is the unchanged state.
    }
    return [file, text]
  }))
  return { ctx, call, files }
}

/** A change result the tool serialized. */
function changeResult(result: ToolExecutionResult): Record<string, unknown> {
  if (typeof result.value !== 'string') throw new Error(`Expected a serialized change result, got ${JSON.stringify(result.content)}`)
  return JSON.parse(result.value) as Record<string, unknown>
}

describe('plugin_manager in danger-full-access with @delo/bundle-local\'s protection', () => {
  it('names the consent and guard plugins, the update gate and the sandbox rows', () => {
    expect([...PROTECTED].sort()).toEqual([
      '@deepseek-ai/dsh-sandbox-local', '@deepseek-ai/dsh-sandbox-policy', '@delo/bundle-local/update-gate',
      '@delo/plugin-fetch-guard', '@delo/plugin-instruction-consent', '@delo/plugin-mcp-consent',
      '@delo/plugin-permission-defaults', '@delo/plugin-schedule-consent',
    ])
  })

  it.each(PROTECTED)('refuses to disable %s and leaves the profile unchanged', async (name) => {
    const { ctx, call, files } = await fixture()
    const before = files()
    const listed = changeResult(await call({ action: 'list_plugins', limit: 100 })) as { entries: Array<{ entryId: string; moduleName: string; readOnlyReason?: string }> }
    const row = listed.entries.find(entry => entry.moduleName === name)
    expect(row).toMatchObject({ readOnlyReason: 'management-required' })
    expect(changeResult(await call({ action: 'set_plugin', target: row?.entryId, enabled: false }))).toMatchObject({
      changed: false, application: 'failed', error: { code: 'management-required' },
    })
    expect(files()).toEqual(before)
    expect([...ctx.loader.entries()].find(entry => entry.options.name === name)?.disabled).toBeFalsy()
  })

  it.each(PROTECTED)('refuses to change the settings of %s and leaves the profile unchanged', async (name) => {
    const { ctx, call, files } = await fixture()
    const before = files()
    const result = await call({ action: 'configure', target: rowId(name), config: { enabled: false } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('Plugin management protects the entry')
    expect(files()).toEqual(before)
    expect([...ctx.loader.entries()].find(entry => entry.options.name === name)?.options.config).toEqual({ enabled: true })
  })

  it('refuses to change the manager\'s own settings, so the protection cannot be configured away', async () => {
    const { call, files } = await fixture()
    const before = files()
    const result = await call({ action: 'configure', target: 'plugin-manager', config: { protectedPlugins: [] } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('Plugin management protects the entry')
    expect(files()).toEqual(before)
  })

  it('refuses to deselect or remove the bundle carrying the protected rows and leaves the profile unchanged', async () => {
    const { call, files } = await fixture()
    const before = files()
    const bundles = changeResult(await call({ action: 'list_bundles', limit: 100 })) as { entries: Array<{ name: string }> }
    expect(bundles.entries.find(bundle => bundle.name === GUARD_BUNDLE)).toMatchObject({ removable: false, readOnlyReason: 'management-required' })
    expect(changeResult(await call({ action: 'set_bundle', target: GUARD_BUNDLE, enabled: false }))).toMatchObject({
      changed: false, application: 'failed', error: { code: 'management-required' },
    })
    expect(changeResult(await call({ action: 'remove_bundle', target: GUARD_BUNDLE }))).toMatchObject({
      changed: false, application: 'failed', error: { code: 'not-removable' },
    })
    expect(files()).toEqual(before)
  })

  it('lets the same calls change the stand-in bundle without the protection', async () => {
    const { call } = await fixture({})
    const name = PROTECTED[0]
    const listed = changeResult(await call({ action: 'list_plugins', limit: 100 })) as { entries: Array<{ entryId: string; moduleName: string; readOnlyReason?: string }> }
    const row = listed.entries.find(entry => entry.moduleName === name)
    expect(row?.readOnlyReason).toBeUndefined()
    expect(changeResult(await call({ action: 'set_plugin', target: row?.entryId, enabled: false }))).toMatchObject({ changed: true, application: 'applied' })
  })
})
