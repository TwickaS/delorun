/**
 * The mounted row: it reads the index from the packages of the profile's rows, refuses an unknown flag when it loads,
 * warns about a flag whose plugin is off, provides `ctx.previewFlags` to a declaring plugin and serves the read route.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { apply, Config, inject, name, PREVIEW_FLAG_ROUTES, PREVIEW_FLAGS_ROW_ID, PreviewFlagsAnswer, previewFlagId, type PreviewFlagDeclaration } from '../src/index.ts'

const STEPS = previewFlagId('onboarding.previewSteps')
const FLAG: PreviewFlagDeclaration = { id: STEPS, owner: '@test/plugin-onboarding', kind: 'boolean', title: { en: 'Planned steps', zh: '计划中的步骤' }, description: { en: 'Shows the planned steps.', zh: '显示计划中的步骤。' } }

/** Write a package's manifest under a `node_modules` directory. */
async function install(modules: string, pkg: string, manifest: object): Promise<void> {
  await mkdir(join(modules, pkg), { recursive: true })
  await writeFile(join(modules, pkg, 'package.json'), JSON.stringify({ name: pkg, ...manifest }))
}

/**
 * A profile directory whose `node_modules` holds one bundle, which brings the onboarding plugin in its own
 * `node_modules`; the plugin's manifest lists the onboarding flag.
 */
async function profile(onboardingFlags: unknown = ['onboarding.previewSteps']): Promise<{ readonly dir: string; readonly installAnchor: string; readonly startedBundles: readonly string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'delorun-preview-flags-profile-'))
  onTestFinished(async () => { await rm(dir, { recursive: true, force: true }) })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'profile', private: true }))
  await install(join(dir, 'node_modules'), '@test/bundle-studio', {})
  await install(join(dir, 'node_modules', '@test', 'bundle-studio', 'node_modules'), '@test/plugin-onboarding', { delorun: { previewFlags: onboardingFlags } })
  // A bundle that cannot be resolved is the plugin manager's to report; the row reads the others.
  return { dir, installAnchor: join(dir, 'package.json'), startedBundles: ['@test/bundle-studio', '@test/missing'] }
}

/** One Loader row: the module it loads and whether it is disabled. */
interface Row { readonly options: { readonly id: string; readonly name?: string }; readonly disabled: boolean }

/** A tree with a Connection, the profile and a Loader holding the onboarding row and this row. */
async function tree(options: { readonly onboardingOff?: boolean; readonly onboardingFlags?: unknown; readonly loader?: boolean } = {}) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const routes = new Map<string, { readonly methods: readonly string[]; readonly admitPeer?: unknown; readonly fetch: (request: Request) => Promise<Response> }>()
  ctx.provide('connection', { fetch: { register: (route: { path: string; methods: readonly string[]; fetch: (request: Request) => Promise<Response> }) => { routes.set(route.path, route); return () => { routes.delete(route.path) } } } } as never)
  const home = await profile(options.onboardingFlags)
  ctx.provide('profileContext', home as never)
  const rows: Row[] = [
    { options: { id: 'delorun-onboarding', name: '@test/plugin-onboarding' }, disabled: options.onboardingOff === true },
    // A group row names no module.
    { options: { id: 'group' }, disabled: false },
    { options: { id: PREVIEW_FLAGS_ROW_ID, name: '@delorun/preview-flags' }, disabled: false },
  ]
  if (options.loader !== false) ctx.provide('loader', { entries: () => rows } as never)
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const read = async (): Promise<PreviewFlagsAnswer> => PreviewFlagsAnswer.parse(await (await routes.get(PREVIEW_FLAG_ROUTES.list)!.fetch(new Request('http://harness.test/api'))).json())
  return { ctx, routes, rows, home, warn, read }
}

describe('the row', () => {
  it('is named for its row and defaults to no flags', () => {
    expect([name, PREVIEW_FLAGS_ROW_ID]).toEqual(['delorun-preview-flags', 'delorun-preview-flags'])
    expect(Config(undefined)).toEqual({ flags: {} })
    // A value that is not a boolean is refused by the schema, before any flag is looked up.
    expect(() => Config({ flags: { 'onboarding.previewSteps': 'yes' } } as never)).toThrow()
  })

  it('refuses a flag no package of the profile\'s rows lists when it loads', async () => {
    // Pins the load-time check: without it the row loads and the mistyped flag is silently off.
    const { ctx } = await tree()
    expect(() => { apply(ctx, Config({ flags: { 'onboarding.previwSteps': true } })) })
      .toThrow('"onboarding.previwSteps" is set, but no plugin of this profile declares it. Known flags: onboarding.previewSteps.')
  })

  it('refuses any flag in a tree without a profile, and any flag where no Loader names the rows', async () => {
    const ctx = new Context()
    ctx.provide('connection', { fetch: { register: () => () => {} } } as never)
    expect(() => { apply(ctx, Config({ flags: { 'onboarding.previewSteps': true } })) }).toThrow('there is no profile')
    const bare = await tree({ loader: false })
    expect(() => { apply(bare.ctx, Config({ flags: { 'onboarding.previewSteps': true } })) }).toThrow('Known flags: none.')
  })

  it('serves the declared flags with their state on one GET route any approved device may read', async () => {
    const { ctx, routes, read, warn } = await tree()
    const fiber = ctx.plugin({ name, inject: [...inject], Config, apply }, { flags: { 'onboarding.previewSteps': true } })
    await fiber.await()
    expect([...routes.keys()]).toEqual(['/api/delorunPreviewFlags.list'])
    expect(routes.get(PREVIEW_FLAG_ROUTES.list)?.methods).toEqual(['GET'])
    expect(routes.get(PREVIEW_FLAG_ROUTES.list)?.admitPeer).toBeTypeOf('function')
    expect(await read()).toEqual({ flags: [] })
    const withdraw = ctx.previewFlags.declare(FLAG)
    expect(ctx.previewFlags.isOn(STEPS)).toBe(true)
    expect(await read()).toEqual({ flags: [{ ...FLAG, on: true }] })
    withdraw()
    expect(await read()).toEqual({ flags: [] })
    // The unresolvable bundle is reported once; nothing else warns.
    expect(warn.mock.calls.map(call => String(call[0]))).toEqual([expect.stringContaining('@test/missing was not read for preview flags')])
  })

  it('logs a package whose flag list is malformed as an error and still loads', async () => {
    const { ctx } = await tree({ onboardingFlags: ['Not An Id'] })
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const fiber = ctx.plugin({ name, inject: [...inject], Config, apply })
    await fiber.await()
    expect(error.mock.calls.map(call => String(call[0]))).toEqual([expect.stringContaining('delorun-preview-flags: the preview flags of @test/plugin-onboarding were not read:')])
    expect(ctx.previewFlags.list()).toEqual([])
  })

  it('takes the declaration of a plugin whose row and bundle the profile gained after the row loaded', async () => {
    // Pins the re-read: a plugin pack added while Delorun runs brings a row this row has not read.
    const { ctx, rows, home } = await tree()
    const fiber = ctx.plugin({ name, inject: [...inject], Config, apply })
    await fiber.await()
    const flag: PreviewFlagDeclaration = { ...FLAG, id: previewFlagId('browser.ownChrome'), owner: '@test/plugin-browser' }
    expect(() => ctx.previewFlags.declare(flag)).toThrow('which no package of this profile lists')
    // The plugin manager adds a bundle: it writes the profile's manifest, and the Loader gains the bundle's row.
    await install(join(home.dir, 'node_modules'), '@test/bundle-browser', {})
    await install(join(home.dir, 'node_modules', '@test', 'bundle-browser', 'node_modules'), '@test/plugin-browser', { delorun: { previewFlags: ['browser.ownChrome'] } })
    await writeFile(join(home.dir, 'package.json'), JSON.stringify({ name: 'profile', private: true, dsh: { profile: { bundles: ['@test/bundle-studio', '@test/bundle-browser'] } } }))
    rows.push({ options: { id: 'delorun-browser', name: '@test/plugin-browser' }, disabled: false })
    ctx.previewFlags.declare(flag)
    expect(ctx.previewFlags.list().map(each => each.id)).toEqual(['browser.ownChrome'])
  })

  it('warns that a flag is on while the plugin that declares it is off', async () => {
    const { ctx, warn } = await tree({ onboardingOff: true })
    const fiber = ctx.plugin({ name, inject: [...inject], Config, apply }, { flags: { 'onboarding.previewSteps': true } })
    await fiber.await()
    expect(warn.mock.calls.map(call => String(call[0]))).toContain('delorun-preview-flags: "onboarding.previewSteps" is on, but @test/plugin-onboarding, which declares it, is off in this profile, so the flag changes nothing')
    expect(ctx.previewFlags.isOn(STEPS)).toBe(false)
  })
})
