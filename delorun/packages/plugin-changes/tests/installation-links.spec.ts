/**
 * The installation's own packages as links of a profile. The check before a reload takes a link to the installation's own
 * folder for the harness's and never scans it, even when the package failed to import and the Host's published resolution
 * does not list it; a link to any other folder goes through Changes as before.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { readChangeLog } from '@delorun/changes'
import { expect, it, onTestFinished, vi } from 'vitest'
import { fixture, folder, linkAs, PROFILE } from '../../changes/tests/profile-fixture.ts'
import * as plugin from '../src/index.ts'
import { installationLinks, installationPackagesDirectory } from '../src/installation-links.ts'

vi.setConfig({ testTimeout: 30_000 })

/**
 * A directory of packages as an installation keeps them.
 * @returns the directory, with `alpha` (`@x/alpha`) and `plain` inside.
 */
function packagesDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-installation-links-')))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  for (const [folderName, name] of [['alpha', '@x/alpha'], ['plain', 'plain']] as const) {
    mkdirSync(join(directory, folderName), { recursive: true })
    writeFileSync(join(directory, folderName, 'package.json'), `${JSON.stringify({ name })}\n`)
  }
  return directory
}

it('counts a link as the installation\'s only when its real target is the directory the installation keeps that package in', () => {
  const packages = packagesDirectory()
  const own = installationLinks(packages)
  expect(own('@x/alpha', join(packages, 'alpha'))).toBe(true)
  expect(own('plain', join(packages, 'plain'))).toBe(true)
  // A symlinked spelling of the same directory is the same directory.
  const alias = join(packagesDirectory(), 'alias')
  symlinkSync(join(packages, 'alpha'), alias)
  expect(own('@x/alpha', alias)).toBe(true)
})

it('refuses a copy elsewhere, a path that only looks like the installation\'s, another name, and a missing folder', () => {
  const packages = packagesDirectory()
  const own = installationLinks(packages)
  const elsewhere = packagesDirectory()
  // The same names and the same layout under another root, and a path with the installation's path as a substring.
  expect(own('@x/alpha', join(elsewhere, 'alpha'))).toBe(false)
  expect(own('@x/alpha', `${join(packages, 'alpha')}-copy`)).toBe(false)
  mkdirSync(join(packages, 'alpha', 'nested'), { recursive: true })
  expect(own('@x/alpha', join(packages, 'alpha', 'nested'))).toBe(false)
  // A name that is not the folder's manifest name, and one with no folder.
  expect(own('@x/plain', join(packages, 'plain'))).toBe(false)
  expect(own('@x/beta', join(packages, 'beta'))).toBe(false)
  expect(own('@x/alpha', join(packages, 'missing'))).toBe(false)
})

it('names the directory next to this package as the installation\'s packages', () => {
  expect(installationPackagesDirectory()).toBe(realpathSync(join(import.meta.dirname, '..', '..')))
})

/**
 * A Host context whose published resolution lists no link, as after a bundle failed to import.
 * @returns the context.
 */
function hostWithoutLinks(): Context {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('tools', { guard: () => () => {} } as never)
  ctx.provide('pluginPackages', {} as never)
  plugin.apply(ctx, { enabled: false, installationBundles: [], restartWaitSeconds: 600 })
  return ctx
}

it('checks a reload without reading the installation\'s own bundle when its import failed, so a refused Host stops in time', async () => {
  const fx = fixture()
  // The real folder of @delorun/bundle-local, as a source checkout's profile links it.
  const own = join(installationPackagesDirectory(), 'bundle-local')
  linkAs(fx, '@delorun/bundle-local', own)
  const check = hostWithoutLinks().get('profileReconcileCheck')!.check({ name: PROFILE, dir: fx.profileDir, home: fx.home } as never)
  const outcome = await Promise.race([check.then(() => 'checked'), new Promise<string>(resolve => setTimeout(() => { resolve('still scanning') }, 8000))])
  expect(outcome).toBe('checked')
  expect((await readChangeLog(fx.home, PROFILE)).entries).toEqual([])
})

it('still brings a plugin link to a folder outside the installation under Changes in the same state', async () => {
  const fx = fixture()
  linkAs(fx, '@delorun/bundle-local', join(installationPackagesDirectory(), 'bundle-local'))
  const plug = folder(fx, 'plug')
  linkAs(fx, 'plug', plug)
  // A folder that carries the installation's package name is no more the installation's than any other.
  const fork = folder(fx, 'fork/bundle-other')
  linkAs(fx, '@delorun/bundle-other', fork)
  await hostWithoutLinks().get('profileReconcileCheck')!.check({ name: PROFILE, dir: fx.profileDir, home: fx.home } as never)
  const entries = (await readChangeLog(fx.home, PROFILE)).entries
  expect(entries.map(entry => entry.subject.plugin).sort()).toEqual(['@delorun/bundle-other', 'plug'])
  expect(entries.every(entry => entry.state === 'pending')).toBe(true)
})
