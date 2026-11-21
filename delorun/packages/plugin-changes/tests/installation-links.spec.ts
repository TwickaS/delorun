/**
 * The installation's own packages as links of a profile. The check before a reload takes a link to the installation's own
 * folder for the harness's and never scans it, even when the package failed to import and the Host's published resolution
 * does not list it; a link to any other folder goes through Changes as before.
 */
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readChangeLog } from '@delorun/changes'
import { expect, it, onTestFinished, vi } from 'vitest'
import { fixture, folder, linkAs, PROFILE } from '../../changes/tests/profile-fixture.ts'
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

const SHIPPED = ['@x/alpha', 'plain']

it('counts a link as the installation\'s only when its real target is the directory the installation keeps that package in', () => {
  const packages = packagesDirectory()
  const own = installationLinks(SHIPPED, packages)
  expect(own('@x/alpha', join(packages, 'alpha'))).toBe(true)
  expect(own('plain', join(packages, 'plain'))).toBe(true)
  // A symlinked spelling of the same directory is the same directory.
  const alias = join(packagesDirectory(), 'alias')
  symlinkSync(join(packages, 'alpha'), alias)
  expect(own('@x/alpha', alias)).toBe(true)
})

it('refuses a copy elsewhere, a path that only looks like the installation\'s, another name, and a missing folder', () => {
  const packages = packagesDirectory()
  const own = installationLinks(SHIPPED, packages)
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

it('refuses a package folder here that the installation does not ship, even with a matching manifest name', () => {
  const packages = packagesDirectory()
  mkdirSync(join(packages, 'gamma'), { recursive: true })
  writeFileSync(join(packages, 'gamma', 'package.json'), `${JSON.stringify({ name: '@x/gamma' })}\n`)
  const own = installationLinks(SHIPPED, packages)
  expect(own('@x/gamma', join(packages, 'gamma'))).toBe(false)
  expect(installationLinks([...SHIPPED, '@x/gamma'], packages)('@x/gamma', join(packages, 'gamma'))).toBe(true)
})

it('treats a looping link and an unsearchable folder as not the installation\'s instead of throwing', () => {
  const packages = packagesDirectory()
  const own = installationLinks(SHIPPED, packages)
  const loop = join(packagesDirectory(), 'loop')
  symlinkSync(loop, loop)
  expect(own('@x/alpha', loop)).toBe(false)
  expect(own('@x/alpha', join(loop, 'inside'))).toBe(false)
  if (process.getuid?.() !== 0) {
    const sealed = join(packagesDirectory(), 'sealed')
    mkdirSync(join(sealed, 'inner'), { recursive: true })
    chmodSync(sealed, 0o000)
    onTestFinished(() => { chmodSync(sealed, 0o700) })
    expect(own('@x/alpha', join(sealed, 'inner'))).toBe(false)
  }
})

it('names the directory next to this package as the installation\'s packages', () => {
  expect(installationPackagesDirectory()).toBe(realpathSync(join(import.meta.dirname, '..', '..')))
})

const TSX_LOADER = import.meta.resolve('tsx/esm')
const CHECK = join(import.meta.dirname, 'fixtures', 'reload-check.ts')

/**
 * Run the check before a reload in a process of its own, and end that process when it has not returned in time.
 * @param fx - the fixture whose profile is checked.
 * @param waitMs - how long to wait.
 * @returns `checked` when the check returned, otherwise `still scanning`.
 */
async function checkInChild(fx: { readonly home: string, readonly profileDir: string }, waitMs: number): Promise<string> {
  const child = spawn(process.execPath, ['--import', TSX_LOADER, CHECK, fx.home, fx.profileDir], { stdio: ['ignore', 'pipe', 'inherit'] })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  const exited = new Promise<void>(resolve => { child.on('exit', () => { resolve() }) })
  const timer = setTimeout(() => { child.kill('SIGKILL') }, waitMs)
  await exited
  clearTimeout(timer)
  return output.includes('checked') ? 'checked' : 'still scanning'
}

it('checks a reload without reading the installation\'s own bundle when its import failed, so a refused Host stops in time', async () => {
  const fx = fixture()
  // The real folder of @delorun/bundle-local, as a source checkout's profile links it.
  linkAs(fx, '@delorun/bundle-local', join(installationPackagesDirectory(), 'bundle-local'))
  // The scan of that folder follows the workspace's linked node_modules and does not finish; the process is ended when it
  // has not returned in time, so no scan outlives the spec.
  expect(await checkInChild(fx, 15_000)).toBe('checked')
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
  expect(await checkInChild(fx, 20_000)).toBe('checked')
  const entries = (await readChangeLog(fx.home, PROFILE)).entries
  expect(entries.map(entry => entry.subject.plugin).sort()).toEqual(['@delorun/bundle-other', 'plug'])
  expect(entries.every(entry => entry.state === 'pending')).toBe(true)
})
