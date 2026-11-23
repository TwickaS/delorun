/**
 * The plugin lines of `delorun doctor` ([plugins](../../src/doctor/plugins.ts)) over a planted CLI profile and a planted
 * dsh installation in a temporary directory: the summary, each installed package's source and enabled state, version
 * ranges, shadowing by a shipped package, enabled bundles that resolve from nowhere, unreadable manifests, and safe
 * mode. No plugin code is imported.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { enterSafeMode } from '@delorun/profile-safety'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CheckResult } from '../../src/doctor/checks.ts'
import { checkPlugins, checkSafeMode, pluginSource } from '../../src/doctor/plugins.ts'
import { PLUGIN_MANIFEST_LIMIT } from '../../src/plugin-check.ts'
import { plantInstallation, POSIX, RUNNING_VERSIONS, writeJson } from './fixtures.ts'

const PROFILE = 'default'

let base: string
let home: string
let profileDir: string
let anchor: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'doctor-plugins-')))
  home = join(base, '.delorun')
  mkdirSync(home, { mode: 0o700 })
  profileDir = join(home, 'profiles', PROFILE)
  anchor = plantInstallation(join(base, 'install'))
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

/**
 * Write the profile's manifest.
 * @param dependencies - its `dependencies`.
 * @param bundles - its `dsh.profile.bundles`.
 */
function profile(dependencies: Record<string, string>, bundles: readonly string[]): void {
  writeJson(join(profileDir, 'package.json'), { name: 'dsh-profile-default', private: true, dependencies, dsh: { profile: { bundles } } })
}

/**
 * Install a package's manifest in the profile's `node_modules`.
 * @param name - the package name.
 * @param manifest - the fields besides the name.
 */
function installed(name: string, manifest: Record<string, unknown>): void {
  writeJson(join(profileDir, 'node_modules', name, 'package.json'), { name, ...manifest })
}

/**
 * Run the plugin lines over the fixture home.
 * @param versions - the running versions; the fixture's by default.
 * @returns the lines.
 */
function check(versions = (): typeof RUNNING_VERSIONS => RUNNING_VERSIONS): Promise<CheckResult[]> {
  return checkPlugins({ home, profile: PROFILE, installAnchor: () => anchor, versions })
}

/**
 * The lines about one package.
 * @param lines - every line.
 * @param subject - the package name.
 * @returns its lines.
 */
function about(lines: readonly CheckResult[], subject: string): CheckResult[] {
  return lines.filter(line => line.subject === subject)
}

describe('pluginSource', () => {
  it.each([
    ['link:../../plugins/acme', 'the folder /home/person/.delorun/plugins/acme (link:)'],
    ['file:/srv/acme', 'the folder /srv/acme (file:)'],
    ['file:/srv/acme-1.0.0.tgz', 'the tarball /srv/acme-1.0.0.tgz'],
    ['^1.2.0', 'the registry (^1.2.0)'],
    ['npm:other@^1.0.0', 'the registry (npm:other@^1.0.0)'],
    ['github:acme/tools#v1', 'git github:acme/tools#v1'],
    // secretlint-disable-next-line @secretlint/secretlint-rule-basicauth -- placeholder credentials the test checks are left out
    ['git+https://person:token-value@git.example.com/acme/tools.git', 'git git+https://git.example.com/acme/tools.git'],
    ['git@github.com:acme/tools.git', 'git git@github.com:acme/tools.git'],
    // secretlint-disable-next-line @secretlint/secretlint-rule-basicauth -- placeholder credentials the test checks are left out
    ['https://user:token-value@files.example.com/acme-1.0.0.tgz', 'the tarball https://files.example.com/acme-1.0.0.tgz'],
    ['workspace:*', 'workspace:*, as recorded'],
  ])('reads %j as %j', (spec, expected) => {
    expect(pluginSource(spec, '/home/person/.delorun/profiles/default')).toBe(expected)
  })

  it('resolves ~ in a local path to the home directory', () => {
    expect(pluginSource('link:~/plugins/acme', '/profiles/default')).toBe(`the folder ${join(homedir(), 'plugins', 'acme')} (link:)`)
  })
})

describe('checkPlugins', () => {
  it('warns when the CLI profile is not set up', async () => {
    expect(await check()).toEqual([{ name: 'plugins', status: 'warn', message: `the CLI profile default is not set up in ${home}, so it has no plugin; delorun setup creates it.` }])
  })

  it('passes one line when no plugin is installed, and says nothing about shipped bundles', async () => {
    profile({ '@delorun/bundle-local': 'link:/srv/delorun/bundle-local' }, ['@deepseek-ai/dsh-base', '@delorun/bundle-local'])
    installed('@delorun/bundle-local', { version: '0.4.0', engines: { delorun: '^0.4.0' }, dsh: { bundle: { patch: 'cordis.patch.yml' } } })
    const lines = await check()
    expect(lines).toEqual([{ name: 'plugins', status: 'pass', message: 'no plugin is installed in the profile default; it enables 2 bundles, loaded in this order: @deepseek-ai/dsh-base, @delorun/bundle-local.' }])
  })

  it('lists each installed package with its source and enabled state', async () => {
    profile({
      'acme-tools': 'link:../../../plugins/acme-tools',
      'acme-lib': '^2.0.0',
      // secretlint-disable-next-line @secretlint/secretlint-rule-basicauth -- placeholder credentials the test checks are left out
      'acme-off': 'git+https://person:token-value@git.example.com/acme/off.git',
    }, ['@deepseek-ai/dsh-base', 'acme-tools'])
    installed('acme-tools', { version: '1.2.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } })
    installed('acme-lib', { version: '2.1.0' })
    installed('acme-off', { version: '0.3.0', dsh: { bundle: {} } })
    const lines = await check()
    expect(lines).toEqual([
      { name: 'plugins', status: 'pass', message: 'the profile default has 3 installed packages; it enables 2 bundles, loaded in this order: @deepseek-ai/dsh-base, acme-tools.' },
      { name: 'plugin', subject: 'acme-tools', status: 'pass', message: `acme-tools@1.2.0 from the folder ${join(base, 'plugins', 'acme-tools')} (link:): enabled, and it declares dsh.bundle.` },
      { name: 'plugin', subject: 'acme-lib', status: 'pass', message: 'acme-lib@2.1.0 from the registry (^2.0.0): installed but not enabled; it declares no dsh.bundle, so it is a library other plugins import.' },
      { name: 'plugin', subject: 'acme-off', status: 'pass', message: 'acme-off@0.3.0 from git git+https://git.example.com/acme/off.git: installed but not enabled; it declares dsh.bundle, so it is a bundle that is switched off.' },
    ])
    expect(JSON.stringify(lines)).not.toContain('token-value')
  })

  it('fails an enabled package that declares no dsh.bundle', async () => {
    profile({ 'acme-lib': '^2.0.0' }, ['acme-lib'])
    installed('acme-lib', { version: '2.1.0' })
    expect(about(await check(), 'acme-lib')).toEqual([{ name: 'plugin', subject: 'acme-lib', status: 'fail', message: 'acme-lib@2.1.0 from the registry (^2.0.0) is enabled in dsh.profile.bundles but declares no dsh.bundle, so a start skips it; install a version that declares one, or take it off the bundle list.' }])
  })

  it('fails an enabled dependency that is not installed, and warns for one that is not enabled', async () => {
    profile({ 'acme-tools': '^1.0.0', 'acme-lib': '^2.0.0' }, ['acme-tools'])
    const lines = await check()
    expect(about(lines, 'acme-tools')).toEqual([{ name: 'plugin', subject: 'acme-tools', status: 'fail', message: `acme-tools from the registry (^1.0.0) is not installed: ${join(profileDir, 'node_modules', 'acme-tools', 'package.json')} does not exist; run delorun plugin --profile default install.` }])
    expect(about(lines, 'acme-lib')).toMatchObject([{ status: 'warn' }])
  })

  it('fails an installed manifest that is too large, not JSON, not an object, or a link, naming the file', async () => {
    profile({ big: '^1.0.0', text: '^1.0.0', list: '^1.0.0', linked: '^1.0.0' }, [])
    mkdirSync(join(profileDir, 'node_modules', 'big'), { recursive: true })
    writeFileSync(join(profileDir, 'node_modules', 'big', 'package.json'), `{"name":"big","pad":"${'x'.repeat(PLUGIN_MANIFEST_LIMIT)}"}`)
    mkdirSync(join(profileDir, 'node_modules', 'text'), { recursive: true })
    writeFileSync(join(profileDir, 'node_modules', 'text', 'package.json'), 'not json')
    writeJson(join(profileDir, 'node_modules', 'list', 'package.json'), [])
    installed('real', { version: '1.0.0' })
    mkdirSync(join(profileDir, 'node_modules', 'linked'), { recursive: true })
    if (POSIX) symlinkSync(join(profileDir, 'node_modules', 'real', 'package.json'), join(profileDir, 'node_modules', 'linked', 'package.json'))
    const lines = await check()
    const manifest = (name: string): string => join(profileDir, 'node_modules', name, 'package.json')
    expect(about(lines, 'big')).toEqual([{ name: 'plugin', subject: 'big', status: 'fail', message: `${manifest('big')} cannot be read: it has more than ${String(PLUGIN_MANIFEST_LIMIT)} bytes, the limit` }])
    expect(about(lines, 'text')[0]!.message).toMatch(new RegExp(`^${manifest('text').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is not JSON: `))
    expect(about(lines, 'list')).toEqual([{ name: 'plugin', subject: 'list', status: 'fail', message: `${manifest('list')} is not a package manifest object` }])
    if (POSIX) expect(about(lines, 'linked')).toMatchObject([{ status: 'fail', message: expect.stringContaining(`${manifest('linked')} cannot be read: `) }])
  })

  it('fails a DSH range the running DSH does not meet, with the exemption command', async () => {
    profile({ 'acme-tools': '^1.0.0' }, ['acme-tools'])
    installed('acme-tools', { version: '1.2.0', engines: { dsh: '^0.1.0' }, dsh: { bundle: {} } })
    expect(about(await check(), 'acme-tools')[1]).toEqual({ name: 'plugin', subject: 'acme-tools', status: 'fail', message: 'acme-tools@1.2.0 requires DSH "^0.1.0" (engines.dsh), and this is DSH 0.2.2, so the installer and the start\'s version check refuse it; update or remove the plugin, or accept the risk with: delorun plugin --profile default allow-version acme-tools@1.2.0 --dsh-version 0.2.2 --accept-risk' })
  })

  it('fails a plugin decided on engines.delorun by that range alone, whatever its DSH peers say, offering no exemption', async () => {
    profile({ 'acme-tools': '^1.0.0' }, ['acme-tools'])
    installed('acme-tools', { version: '1.2.0', engines: { delorun: '^0.3.0' }, peerDependencies: { '@deepseek-ai/dsh-agent': '^0.1.0' }, dsh: { bundle: {} } })
    expect(about(await check(), 'acme-tools')[1]!.message).toBe('acme-tools@1.2.0 requires Delorun "^0.3.0" (engines.delorun), and this is Delorun 0.4.0; its DSH ranges are not checked on Delorun, so the installer and the start\'s version check refuse it; update or remove the plugin.')
  })

  it('passes a plugin whose engines.delorun is met although its engines.dsh and DSH peers are not', async () => {
    profile({ 'acme-tools': '^1.0.0' }, ['acme-tools'])
    installed('acme-tools', { version: '1.2.0', engines: { dsh: '^0.1.0', delorun: '^0.4.0' }, peerDependencies: { '@deepseek-ai/dsh-agent': '^0.1.0' }, dsh: { bundle: {} } })
    expect(about(await check(), 'acme-tools').filter(line => line.status !== 'pass')).toEqual([])
  })

  it('fails an engines.delorun that is not a string, and a version field the installer refuses', async () => {
    profile({ unreadable: '^1.0.0', malformed: '^1.0.0' }, [])
    installed('unreadable', { version: '1.0.0', engines: { delorun: 3 } })
    installed('malformed', { version: '1.0.0', engines: { dsh: 3 } })
    const lines = await check()
    expect(about(lines, 'unreadable')[1]!.message).toBe('unreadable@1.0.0 declares engines.delorun in a form Delorun cannot read; its DSH ranges are not checked on Delorun, so the installer and the start\'s version check refuse it; update or remove the plugin.')
    expect(about(lines, 'malformed')[1]).toMatchObject({ status: 'fail', message: expect.stringMatching(/^malformed@1\.0\.0 declares its version ranges in a form the installer refuses \(.*engines\.dsh must be a string.*\); update or remove the plugin\.$/) })
  })

  it('warns for a DSH mismatch the profile exempts, and warns about a damaged exemption file', async () => {
    profile({ 'acme-tools': '^1.0.0' }, ['acme-tools'])
    installed('acme-tools', { version: '1.2.0', engines: { dsh: '^0.1.0' }, dsh: { bundle: {} } })
    writeJson(join(profileDir, 'compatibility.json'), { 'acme-tools@1.2.0': ['0.2.2'], 'broken key': ['0.2.2'] })
    const lines = await check()
    expect(about(lines, 'acme-tools')[1]).toEqual({ name: 'plugin', subject: 'acme-tools', status: 'warn', message: 'acme-tools@1.2.0 requires DSH "^0.1.0" (engines.dsh), and this is DSH 0.2.2; it loads under the exact-version exemption in compatibility.json, which accepts the risk of crashes or data loss.' })
    expect(lines.at(-1)).toEqual({ name: 'plugins', status: 'warn', message: `${join(profileDir, 'compatibility.json')}: "broken key" is not an exact package-name@version key; the record is ignored` })
  })

  it('warns when a shipped package of the same name hides an installed one', async () => {
    profile({ '@deepseek-ai/dsh-base': 'link:/srv/fork-of-base' }, ['@deepseek-ai/dsh-base'])
    expect(about(await check(), '@deepseek-ai/dsh-base')).toEqual([{ name: 'plugin', subject: '@deepseek-ai/dsh-base', status: 'warn', message: '@deepseek-ai/dsh-base is also a package this Delorun ships, so a start loads the shipped one and not this install from the folder /srv/fork-of-base (link:); a fork of a shipped package needs a new package name.' }])
  })

  it('fails an enabled bundle that is neither installed nor shipped, once however often it is listed, without reading the versions', async () => {
    profile({}, ['@deepseek-ai/dsh-base', 'acme-gone', 'acme-gone'])
    expect(await check(() => { throw new Error('the versions were read') })).toEqual([
      { name: 'plugins', status: 'pass', message: 'no plugin is installed in the profile default; it enables 3 bundles, loaded in this order: @deepseek-ai/dsh-base, acme-gone, acme-gone.' },
      { name: 'plugin', subject: 'acme-gone', status: 'fail', message: 'the profile enables acme-gone in dsh.profile.bundles, but it is neither installed in the profile nor shipped with this Delorun, so a start skips it; install it with delorun plugin --profile default add, or take it off the bundle list.' },
    ])
  })

  it('reports a Delorun package only when something is wrong with it', async () => {
    profile({ '@delorun/bundle-local': 'link:/srv/delorun/bundle-local' }, ['@delorun/bundle-local'])
    expect(about(await check(), '@delorun/bundle-local')).toMatchObject([{ status: 'fail', message: expect.stringContaining('@delorun/bundle-local from the folder /srv/delorun/bundle-local (link:) is not installed: ') }])
  })

  it.each([
    ['is not JSON', '{', 'is not JSON: '],
    ['lists bundles that are not names', JSON.stringify({ dsh: { profile: { bundles: [1] } } }), ': dsh.profile.bundles is not a list of package names; the profile\'s plugins are not checked.'],
    ['maps a dependency to a number', JSON.stringify({ dependencies: { acme: 1 } }), ': dependencies is not a map of package names to strings; the profile\'s plugins are not checked.'],
  ])('fails one line for a profile manifest that %s', async (_label, text, expected) => {
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), text)
    const lines = await check()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ name: 'plugins', status: 'fail' })
    expect(lines[0]!.message.startsWith(join(profileDir, 'package.json'))).toBe(true)
    expect(lines[0]!.message).toContain(expected)
  })
})

describe('checkSafeMode', () => {
  it('says nothing outside safe mode, and warns with the exit command inside it', async () => {
    expect(checkSafeMode(home, PROFILE)).toBeUndefined()
    await enterSafeMode({ homeDir: home, profile: PROFILE, reason: 'the last start failed', skipped: ['acme-tools'], now: new Date('2026-11-10T12:00:00Z') })
    expect(checkSafeMode(home, PROFILE)).toEqual({ name: 'plugins', status: 'warn', message: 'the profile default is in safe mode since 2026-11-10T12:00:00.000Z (the last start failed): third-party plugins are left out until delorun recover exit-safe-mode.' })
  })

  it('throws for a marker Delorun did not write', () => {
    mkdirSync(join(home, 'run', PROFILE), { recursive: true })
    writeFileSync(join(home, 'run', PROFILE, 'safe-mode.json'), 'not json')
    expect(() => checkSafeMode(home, PROFILE)).toThrow(/safe-mode/)
  })
})
