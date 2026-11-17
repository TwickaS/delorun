/**
 * The mounted row: it reads the index from the profile's bundles, refuses an unknown flag when it loads, warns about a
 * flag whose row is off, provides `ctx.previewFlags` to a declaring plugin and serves the read route.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { apply, Config, inject, name, PREVIEW_FLAG_ROUTES, PREVIEW_FLAGS_ROW_ID, PreviewFlagsAnswer, previewFlagId, type PreviewFlagDeclaration } from '../src/index.ts'

const STEPS = previewFlagId('onboarding.previewSteps')
const FLAG: PreviewFlagDeclaration = { id: STEPS, owner: '@test/plugin-onboarding', kind: 'boolean', title: { en: 'Planned steps', zh: '计划中的步骤' }, description: { en: 'Shows the planned steps.', zh: '显示计划中的步骤。' } }

/** A profile directory whose `node_modules` holds one bundle that lists the onboarding flag. */
async function profile(broken = false): Promise<{ readonly dir: string; readonly installAnchor: string; readonly startedBundles: readonly string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'delorun-preview-flags-profile-'))
  onTestFinished(async () => { await rm(dir, { recursive: true, force: true }) })
  const bundle = join(dir, 'node_modules', '@test', 'bundle-studio')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'profile', private: true }))
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: '@test/bundle-studio', delorun: { previewFlags: { 'delorun-onboarding': ['onboarding.previewSteps'] } } }))
  if (broken) {
    await mkdir(join(dir, 'node_modules', '@test', 'broken'), { recursive: true })
    await writeFile(join(dir, 'node_modules', '@test', 'broken', 'package.json'), JSON.stringify({ name: '@test/broken', delorun: { previewFlags: { row: ['Not An Id'] } } }))
  }
  // A bundle that cannot be resolved is the plugin manager's to report; the row reads the others.
  return { dir, installAnchor: join(dir, 'package.json'), startedBundles: ['@test/bundle-studio', broken ? '@test/broken' : '@test/missing'] }
}

/** A tree with a Connection, the profile and a Loader holding the onboarding row. */
async function tree(options: { readonly onboardingOff?: boolean; readonly brokenBundle?: boolean } = {}) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const routes = new Map<string, { readonly methods: readonly string[]; readonly admitPeer?: unknown; readonly fetch: (request: Request) => Promise<Response> }>()
  ctx.provide('connection', { fetch: { register: (route: { path: string; methods: readonly string[]; fetch: (request: Request) => Promise<Response> }) => { routes.set(route.path, route); return () => { routes.delete(route.path) } } } } as never)
  ctx.provide('profileContext', await profile(options.brokenBundle) as never)
  ctx.provide('loader', { entries: () => [{ options: { id: 'delorun-onboarding' }, disabled: options.onboardingOff === true }, { options: { id: PREVIEW_FLAGS_ROW_ID }, disabled: false }] } as never)
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const read = async (): Promise<PreviewFlagsAnswer> => PreviewFlagsAnswer.parse(await (await routes.get(PREVIEW_FLAG_ROUTES.list)!.fetch(new Request('http://harness.test/api'))).json())
  return { ctx, routes, warn, read }
}

describe('the row', () => {
  it('is named for its row and defaults to no flags', () => {
    expect([name, PREVIEW_FLAGS_ROW_ID]).toEqual(['delorun-preview-flags', 'delorun-preview-flags'])
    expect(Config(undefined)).toEqual({ flags: {} })
    // A value that is not a boolean is refused by the schema, before any flag is looked up.
    expect(() => Config({ flags: { 'onboarding.previewSteps': 'yes' } } as never)).toThrow()
  })

  it('refuses a flag no bundle of the profile lists when it loads', async () => {
    // Pins the load-time check: without it the row loads and the mistyped flag is silently off.
    const { ctx } = await tree()
    expect(() => { apply(ctx, Config({ flags: { 'onboarding.previwSteps': true } })) })
      .toThrow('"onboarding.previwSteps" is set, but no plugin of this profile declares it. Known flags: onboarding.previewSteps.')
  })

  it('refuses any flag in a tree without a profile', () => {
    const ctx = new Context()
    ctx.provide('connection', { fetch: { register: () => () => {} } } as never)
    expect(() => { apply(ctx, Config({ flags: { 'onboarding.previewSteps': true } })) }).toThrow('there is no profile')
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

  it('logs a bundle whose flag list is malformed as an error and loads with the other bundles\' flags', async () => {
    const { ctx } = await tree({ brokenBundle: true })
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const fiber = ctx.plugin({ name, inject: [...inject], Config, apply }, { flags: { 'onboarding.previewSteps': true } })
    await fiber.await()
    expect(error.mock.calls.map(call => String(call[0]))).toEqual([expect.stringContaining('delorun-preview-flags: the preview flags of @test/broken were not read:')])
    ctx.previewFlags.declare(FLAG)
    expect(ctx.previewFlags.isOn(STEPS)).toBe(true)
  })

  it('reads a flag\'s row as off in a tree without a Loader', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    ctx.provide('connection', { fetch: { register: () => () => {} } } as never)
    ctx.provide('profileContext', await profile() as never)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const fiber = ctx.plugin({ name, inject: [...inject], Config, apply }, { flags: { 'onboarding.previewSteps': true } })
    await fiber.await()
    expect(warn.mock.calls.map(call => String(call[0]))).toContainEqual(expect.stringContaining('the row "delorun-onboarding" of @test/bundle-studio, whose plugin declares it, is off'))
  })

  it('warns that a flag is on while the row that declares it is off', async () => {
    const { ctx, warn } = await tree({ onboardingOff: true })
    const fiber = ctx.plugin({ name, inject: [...inject], Config, apply }, { flags: { 'onboarding.previewSteps': true } })
    await fiber.await()
    expect(warn.mock.calls.map(call => String(call[0]))).toContain('delorun-preview-flags: "onboarding.previewSteps" is on, but the row "delorun-onboarding" of @test/bundle-studio, whose plugin declares it, is off, so the flag changes nothing')
    expect(ctx.previewFlags.isOn(STEPS)).toBe(false)
  })
})
