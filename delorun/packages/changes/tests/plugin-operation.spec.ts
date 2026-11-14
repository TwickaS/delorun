/**
 * The shared plugin operation applying an agent's plugin request runs: upstream's `runProfilePnpm` run as the plugin
 * manager's `installBundle` runs it, with the checks `installBundle` runs, its output where the caller sends it, and
 * upstream's own loader of the checks.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDshRuntimeVersion, PROFILE_COMPATIBILITY_FILENAME } from '@deepseek-ai/dsh-app-boot'
import type { PackageOperationContext, PackageOperationOptions } from '@deepseek-ai/dsh-plugin-manager/operations'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChangesContext } from '../src/actions.ts'
import { loadUpstreamChecks, upstreamPluginOperation, type PluginOperationSettings, type UpstreamOperation } from '../src/plugin-operation.ts'

// Loading upstream's plugin manager and app boot takes several seconds under a loaded host.
vi.setConfig({ testTimeout: 60_000 })

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * A Delorun home whose profile `default` has a manifest with the given dependencies.
 * @param dependencies - the profile's dependencies.
 * @returns the root and the profile's context.
 */
function profile(dependencies: Record<string, string> = {}): { readonly root: string, readonly ctx: ChangesContext } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-plugin-operation-')))
  roots.push(root)
  const home = join(root, '.delorun')
  const profileDir = join(home, 'profiles', 'default')
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-default', private: true, dependencies }, undefined, 2)}\n`)
  return { root, ctx: { home, profile: 'default', profileDir } }
}

/**
 * @param dir - a directory.
 * @param manifest - its `package.json`.
 * @returns the directory.
 */
function packageAt(dir: string, manifest: object): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  return dir
}

/**
 * Upstream with a stubbed `runProfilePnpm` that sets the profile's dependencies, and stubbed checks.
 * @param ctx - the profile.
 * @param result - what the run reports, and the dependencies it leaves.
 * @param checks - the checks' answers.
 * @returns the upstream loader and the stub.
 */
function stubbed(ctx: ChangesContext, result: { readonly exitCode?: number, readonly dependencies?: Record<string, string>, readonly incompatible?: { name: string, version: string }[] } = {}, checks: Partial<Pick<UpstreamOperation, 'bundleManifest' | 'incompatibility'>> = {}) {
  const runProfilePnpm = vi.fn(async (_context: PackageOperationContext, _args: readonly string[], options: PackageOperationOptions) => {
    options.onOutput?.('added 1\n', 'stdout')
    options.onOutput?.('warning\n', 'stderr')
    if (result.dependencies !== undefined) writeFileSync(join(ctx.profileDir, 'package.json'), JSON.stringify({ dependencies: result.dependencies }))
    return { exitCode: result.exitCode ?? 0, logPath: '/l', output: 'out', ...result.incompatible === undefined ? {} : { incompatible: result.incompatible } }
  })
  const upstream: UpstreamOperation = {
    installAnchor: '/anchor',
    runProfilePnpm,
    bundleManifest: checks.bundleManifest ?? (() => ({ dsh: { bundle: { patch: 'cordis.patch.yml' } } })),
    incompatibility: checks.incompatibility ?? (() => undefined),
  }
  return { load: async () => upstream, runProfilePnpm }
}

/**
 * @param upstream - the loader.
 * @returns settings that discard pnpm's output.
 */
function quiet(upstream: PluginOperationSettings['upstream']): PluginOperationSettings {
  return { cwd: '/work', output: () => {}, upstream }
}

describe('the shared plugin operation', () => {
  it('runs upstream\'s operation as the plugin manager runs it and sends its output where the caller asks', async () => {
    const { ctx } = profile()
    const output: string[] = []
    const { load, runProfilePnpm } = stubbed(ctx, { dependencies: { x: '1.0.0' } })
    const run = upstreamPluginOperation(ctx, { cwd: '/work', output: (text, stream) => void output.push(`${stream}: ${text}`), upstream: load })
    expect(await run(['add', 'x@1'])).toEqual({ exitCode: 0, logPath: '/l', output: 'out' })
    expect(runProfilePnpm).toHaveBeenCalledWith(
      { profile: 'default', dir: ctx.profileDir, installAnchor: '/anchor', cwd: '/work', home: ctx.home },
      ['add', 'x@1'],
      expect.objectContaining({ execution: 'service', outputBytes: 16_384, lookupTimeoutMs: 120_000 }),
    )
    expect(runProfilePnpm.mock.calls[0]![2]).not.toHaveProperty('command')
    expect(output).toEqual(['stdout: added 1\n', 'stderr: warning\n'])
  })

  it('runs the pnpm a packaged application supplies', async () => {
    const { ctx } = profile()
    const { load, runProfilePnpm } = stubbed(ctx, { dependencies: { x: '1.0.0' } })
    const packageManager = { command: '/app/node', args: ['/app/pnpm.cjs'], env: { COREPACK_ENABLE_STRICT: '0' } }
    await upstreamPluginOperation(ctx, { ...quiet(load), packageManager })(['add', 'x@1'])
    expect(runProfilePnpm.mock.calls[0]![2]).toMatchObject({ execution: 'service', ...packageManager })
  })

  it('refuses an install that is no plugin bundle, changes several dependencies or cannot be checked', async () => {
    const { ctx } = profile({ kept: '1.0.0' })
    const plain = stubbed(ctx, { dependencies: { kept: '1.0.0', plain: '1.0.0' } }, { bundleManifest: () => undefined })
    expect(await upstreamPluginOperation(ctx, quiet(plain.load))(['add', 'plain'])).toMatchObject({ exitCode: 1, failure: 'plain is no DSH plugin bundle: its package.json declares no dsh.bundle.patch, so nothing was installed' })
    const several = stubbed(ctx, { dependencies: { one: '1.0.0', two: '1.0.0' } })
    expect(await upstreamPluginOperation(ctx, quiet(several.load))(['add', 'one'])).toMatchObject({ exitCode: 1, failure: 'the operation changed one, two, not one plugin, so nothing was installed' })
    const unresolved = stubbed(ctx, { dependencies: { other: '1.0.0' } }, { bundleManifest: () => { throw new Error('not installed') } })
    expect(await upstreamPluginOperation(ctx, quiet(unresolved.load))(['add', 'other'])).toMatchObject({ exitCode: 1, failure: 'other cannot be checked: Error: not installed' })
  })

  it('reports upstream\'s refusal of an incompatible version, and leaves a failure, a removal and an unchanged install to the caller', async () => {
    const { ctx } = profile({ kept: '1.0.0' })
    const incompatible = stubbed(ctx, { exitCode: 1, incompatible: [{ name: 'old', version: '1.0.0' }] })
    expect(await upstreamPluginOperation(ctx, quiet(incompatible.load))(['add', 'old@1.0.0'])).toEqual({ exitCode: 1, logPath: '/l', output: 'out', failure: 'this Delorun cannot run old@1.0.0: its requirements are not met, so nothing was installed' })
    const failing = stubbed(ctx, { exitCode: 2 })
    expect(await upstreamPluginOperation(ctx, quiet(failing.load))(['add', 'x'])).toEqual({ exitCode: 2, logPath: '/l', output: 'out' })
    const remove = stubbed(ctx, { dependencies: {} }, { bundleManifest: () => undefined })
    expect(await upstreamPluginOperation(ctx, quiet(remove.load))(['remove', 'kept'])).toEqual({ exitCode: 0, logPath: '/l', output: 'out' })
    writeFileSync(join(ctx.profileDir, 'package.json'), '{"dependencies":"not an object"}')
    const unchanged = stubbed(ctx, {}, { bundleManifest: () => undefined })
    expect(await upstreamPluginOperation(ctx, quiet(unchanged.load))(['add', 'kept'])).toEqual({ exitCode: 0, logPath: '/l', output: 'out' })
  })

  it('checks the package in the folder a spec names, before pnpm runs', async () => {
    const { root, ctx } = profile()
    const bundle = { name: 'plug', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }
    const plain = packageAt(join(root, 'plain'), { name: 'plug', version: '1.0.0' })
    const good = packageAt(join(root, 'good'), bundle)
    const broken = join(root, 'broken')
    mkdirSync(broken)
    writeFileSync(join(broken, 'package.json'), '[]')
    const checked = stubbed(ctx, { dependencies: { plug: 'link:/active' } }, { bundleManifest: () => undefined, incompatibility: manifest => 'version' in manifest && manifest.version === '2.0.0' ? 'Requires another Delorun.' : undefined })
    const run = upstreamPluginOperation(ctx, quiet(checked.load))
    expect(await run(['add', 'plug@link:/active'], plain)).toEqual({ exitCode: 1, failure: `the package in ${plain} is no DSH plugin bundle: its package.json declares no dsh.bundle.patch` })
    expect(await run(['add', 'plug@link:/active'], broken)).toEqual({ exitCode: 1, failure: `the package in ${broken} cannot be checked: Error: ${join(broken, 'package.json')} holds no JSON object` })
    const newer = packageAt(join(root, 'newer'), { ...bundle, version: '2.0.0' })
    expect(await run(['add', 'plug@link:/active'], newer)).toEqual({ exitCode: 1, failure: 'Requires another Delorun. Nothing was installed.' })
    expect(checked.runProfilePnpm).not.toHaveBeenCalled()
    // The link names the active directory, whose content is not applied yet, so the installed package is not checked.
    expect(await run(['add', 'plug@link:/active'], good)).toEqual({ exitCode: 0, logPath: '/l', output: 'out' })
  })

  it('loads upstream\'s operation and checks, with the profile\'s exact-version exemptions', async () => {
    const { ctx } = profile()
    const upstream = await loadUpstreamChecks()
    expect(typeof upstream.runProfilePnpm).toBe('function')
    expect(typeof upstream.bundleManifest).toBe('function')
    const newer = { name: 'p', version: '1.0.0', engines: { dsh: '>=999.0.0' } }
    expect(upstream.incompatibility({ name: 'p', version: '1.0.0' }, ctx.profileDir)).toBeUndefined()
    expect(upstream.incompatibility(newer, ctx.profileDir)).toContain('p@1.0.0')
    writeFileSync(join(ctx.profileDir, PROFILE_COMPATIBILITY_FILENAME), JSON.stringify({ 'p@1.0.0': [getDshRuntimeVersion()] }))
    expect(upstream.incompatibility(newer, ctx.profileDir)).toBeUndefined()
  })
})
