/**
 * The harness's own links as the running Host knows them, only a link to the directory the Host loads that package from;
 * the check before a reload of a profile with nothing to move; and which `plugin_manager` calls the person makes.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-hmr'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import { loadedLinks } from '../src/index.ts'

it('counts a link as the harness\'s only when it names the directory the Host loads that package from', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-loaded-links-')))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  const harness = loadedLinks([{ name: 'loaded', realPath: directory }])
  expect(harness('loaded', directory)).toBe(true)
  expect(harness('other', directory)).toBe(false)
  expect(harness('loaded', join(directory, 'missing'))).toBe(false)
})

it('checks a profile with no links before a reload, with or without a published resolution, and logs nothing', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-reload-check-')))
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  const dir = join(home, 'profiles', 'default')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"dsh-profile-default","dependencies":{}}\n')
  for (const packages of [undefined, {}]) {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    ctx.provide('tools', { guard: () => () => {} } as never)
    if (packages !== undefined) ctx.provide('pluginPackages', packages as never)
    const info = vi.spyOn(ctx.logger, 'info')
    plugin.apply(ctx, { enabled: false, installationBundles: [] })
    await ctx.get('profileReconcileCheck')!.check({ name: 'default', dir, home } as never)
    expect(info).not.toHaveBeenCalled()
  }
})

it('takes only plugin_manager calls with an action for actions the person makes', () => {
  expect(plugin.atComputerAction({ name: 'plugin_manager', arguments: undefined as never })).toBe(false)
  expect(plugin.atComputerAction({ name: 'plugin_manager', arguments: { action: 7 } })).toBe(false)
  expect(plugin.atComputerAction({ name: 'other', arguments: { action: 'restore' } })).toBe(false)
  expect(plugin.atComputerAction({ name: 'plugin_manager', arguments: { action: 'restore' } })).toBe(true)
})
