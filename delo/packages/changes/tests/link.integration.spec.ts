import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LINK_PREFIX, pointLinkAt, readLinks } from '../src/link.ts'
import { modeOf, rejection, temporaryDirectory, writeFiles } from './support.ts'

const renames = vi.hoisted(() => ({ fail: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string): Promise<void> => {
      if (renames.fail && to.includes('node_modules')) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
      await actual.rename(from, to)
    },
  }
})

afterEach(() => {
  renames.fail = false
})

/** A lockfile as pnpm writes one for a profile that links `@x/plug` from `../plug` and installs `left-pad`. */
const LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: false
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@x/plug':
        specifier: link:../plug
        version: link:../plug
      left-pad:
        specifier: ^1.3.0
        version: 1.3.0

packages:

  left-pad@1.3.0:
    resolution: {integrity: sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQEB3GgV9ZFD9n9KUYEDLOFBdmHE2Ln1LMNi5qpzIkDKMTmEcp+aw2Ds7c1uTwvr8RkRBaA==}
    deprecated: use String.prototype.padStart()

snapshots:

  left-pad@1.3.0: {}
`

/**
 * A profile directory with a manifest, and a plugin folder beside it.
 * @param manifest - the manifest's fields.
 * @returns the profile directory and the folder.
 */
function profileWith(manifest: Record<string, unknown>): { profileDir: string, folder: string, root: string } {
  const root = temporaryDirectory()
  const profileDir = join(root, 'profile')
  const folder = join(root, 'plug')
  writeFiles(folder, { 'package.json': '{"name":"@x/plug","version":"1.0.0"}\n' })
  writeFiles(profileDir, { 'package.json': `${JSON.stringify(manifest, undefined, 2)}\n` })
  return { profileDir, folder, root }
}

describe('readLinks', () => {
  it('reads the link: dependencies of every section, resolving each folder to an absolute path', async () => {
    const { profileDir, root } = profileWith({
      name: 'p',
      dependencies: { '@x/plug': 'link:../plug', 'left-pad': '^1.3.0', local: 'file:../local', odd: 3 },
      optionalDependencies: { abs: 'link:/abs/plugin', '@x/plug': 'link:/elsewhere' },
      devDependencies: { home: 'link:~/plugins/home', bare: 'link:~' },
    })
    expect(await readLinks(profileDir)).toEqual([
      { name: '@x/plug', section: 'dependencies', spec: 'link:../plug', target: join(root, 'plug') },
      { name: 'abs', section: 'optionalDependencies', spec: 'link:/abs/plugin', target: '/abs/plugin' },
      { name: 'home', section: 'devDependencies', spec: 'link:~/plugins/home', target: join(homedir(), 'plugins', 'home') },
      { name: 'bare', section: 'devDependencies', spec: 'link:~', target: homedir() },
    ])
  })

  it('reads no links from a manifest without dependency sections, or with a section that is not an object', async () => {
    expect(await readLinks(profileWith({ name: 'p' }).profileDir)).toEqual([])
    expect(await readLinks(profileWith({ name: 'p', dependencies: ['link:../plug'] }).profileDir)).toEqual([])
  })

  it('refuses a manifest that is missing, not JSON, or not a JSON object', async () => {
    const root = temporaryDirectory()
    expect((await rejection(readLinks(root), 'RECORD_UNREADABLE')).detail).toContain('ENOENT')
    writeFileSync(join(root, 'package.json'), '{"name":')
    expect((await rejection(readLinks(root), 'RECORD_UNREADABLE')).detail).toContain('SyntaxError')
    writeFileSync(join(root, 'package.json'), '[]\n')
    expect((await rejection(readLinks(root), 'RECORD_UNREADABLE')).detail).toBe('The profile\'s package.json is not a JSON object.')
  })
})

describe('pointLinkAt', () => {
  it('rewrites the spec in the manifest, the lockfile entry and the link, keeping everything else', async () => {
    const { profileDir, root } = profileWith({ name: 'p', private: true, dependencies: { '@x/plug': 'link:../plug', 'left-pad': '^1.3.0' }, dsh: { profile: { bundles: ['a'] } } })
    chmodSync(join(profileDir, 'package.json'), 0o640)
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), LOCKFILE, { mode: 0o600 })
    mkdirSync(join(profileDir, 'node_modules', '@x'), { recursive: true })
    symlinkSync('../../../plug', join(profileDir, 'node_modules', '@x', 'plug'))
    const active = join(root, 'home', 'changes', 'profiles', 'default', 'active', '@x+plug')
    mkdirSync(active, { recursive: true })

    await pointLinkAt(profileDir, '@x/plug', active)

    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe(`${JSON.stringify({ name: 'p', private: true, dependencies: { '@x/plug': `link:${active}`, 'left-pad': '^1.3.0' }, dsh: { profile: { bundles: ['a'] } } }, undefined, 2)}\n`)
    expect(modeOf(join(profileDir, 'package.json'))).toBe(0o640)
    expect(readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')).toBe(LOCKFILE
      .replace('specifier: link:../plug', `specifier: link:${active}`)
      .replace('version: link:../plug', 'version: link:../home/changes/profiles/default/active/@x+plug'))
    expect(modeOf(join(profileDir, 'pnpm-lock.yaml'))).toBe(0o600)
    expect(readlinkSync(join(profileDir, 'node_modules', '@x', 'plug'))).toBe('../../../home/changes/profiles/default/active/@x+plug')
    expect(readdirSync(join(profileDir, 'node_modules', '@x'))).toEqual(['plug'])
  })

  it('rewrites every section that links the package, and the lockfile entry in the section that holds it', async () => {
    const { profileDir, root } = profileWith({ name: 'p', optionalDependencies: { plug: 'link:../plug' }, devDependencies: { plug: 'link:../plug', other: 'link:../other' } })
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      plug:\n        specifier: link:../plug\n        version: link:../plug\n")
    const target = join(root, 'active')
    await pointLinkAt(profileDir, 'plug', target)
    expect(JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))).toEqual({ name: 'p', optionalDependencies: { plug: `link:${target}` }, devDependencies: { plug: `link:${target}`, other: 'link:../other' } })
    expect(readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')).toBe(`lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      plug:\n        specifier: link:${target}\n        version: link:../active\n`)
    // The scope-less link is created with its node_modules directory.
    expect(readlinkSync(join(profileDir, 'node_modules', 'plug'))).toBe('../../active')
  })

  it('leaves a lockfile without the entry byte-identical, and works without a lockfile', async () => {
    const { profileDir, root } = profileWith({ name: 'p', dependencies: { plug: 'link:../plug' } })
    const lockfile = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      left-pad:\n        specifier: ^1.3.0\n        version: 1.3.0\n"
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), lockfile)
    await pointLinkAt(profileDir, 'plug', join(root, 'a'))
    expect(readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')).toBe(lockfile)
    const bare = profileWith({ name: 'p', dependencies: { plug: 'link:../plug' } })
    await pointLinkAt(bare.profileDir, 'plug', join(bare.root, 'a'))
    expect(existsSync(join(bare.profileDir, 'pnpm-lock.yaml'))).toBe(false)
    await expect(readLinks(bare.profileDir)).resolves.toEqual([{ name: 'plug', section: 'dependencies', spec: `link:${join(bare.root, 'a')}`, target: join(bare.root, 'a') }])
  })

  it('replaces a directory standing where the link goes', async () => {
    const { profileDir, root } = profileWith({ name: 'p', dependencies: { plug: 'link:../plug' } })
    writeFiles(join(profileDir, 'node_modules', 'plug'), { 'index.js': 'copied\n' })
    await pointLinkAt(profileDir, 'plug', join(root, 'a'))
    expect(lstatSync(join(profileDir, 'node_modules', 'plug')).isSymbolicLink()).toBe(true)
  })

  it('refuses a package the manifest does not link from a folder, writing nothing', async () => {
    const { profileDir, root } = profileWith({ name: 'p', dependencies: { 'left-pad': '^1.3.0' } })
    const before = readFileSync(join(profileDir, 'package.json'), 'utf8')
    expect((await rejection(pointLinkAt(profileDir, 'left-pad', join(root, 'a')), 'NOT_LINKED')).subject).toBe('left-pad')
    await rejection(pointLinkAt(profileDir, 'absent', join(root, 'a')), 'NOT_LINKED')
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe(before)
    expect(existsSync(join(profileDir, 'node_modules'))).toBe(false)
  })

  it('refuses a lockfile that is not YAML', async () => {
    const { profileDir, root } = profileWith({ name: 'p', dependencies: { plug: 'link:../plug' } })
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'importers: [\n')
    expect((await rejection(pointLinkAt(profileDir, 'plug', join(root, 'a')), 'RECORD_UNREADABLE')).detail).toContain('The profile\'s pnpm-lock.yaml is not YAML')
  })

  it('removes its temporary link when the rename fails, and leaves the old link in place', async () => {
    const { profileDir, root } = profileWith({ name: 'p', dependencies: { plug: 'link:../plug' } })
    mkdirSync(join(profileDir, 'node_modules'))
    symlinkSync('../../plug', join(profileDir, 'node_modules', 'plug'))
    renames.fail = true
    await expect(pointLinkAt(profileDir, 'plug', join(root, 'a'))).rejects.toThrow('EXDEV')
    expect(readdirSync(join(profileDir, 'node_modules'))).toEqual(['plug'])
    expect(readlinkSync(join(profileDir, 'node_modules', 'plug'))).toBe('../../plug')
  })

  it('rethrows a failure to inspect the old link', async () => {
    const { profileDir, root } = profileWith({ name: 'p', dependencies: { plug: 'link:../plug' } })
    mkdirSync(join(profileDir, 'node_modules'))
    chmodSync(join(profileDir, 'node_modules'), 0o000)
    await expect(pointLinkAt(profileDir, 'plug', join(root, 'a'))).rejects.toMatchObject({ code: 'EACCES' })
  })
})

const pnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8', timeout: 30_000 })

describe('pnpm and a moved link', () => {
  it.skipIf(pnpm.status !== 0)('keeps the active directory through pnpm install --frozen-lockfile', { timeout: 120_000 }, () => {
    const root = temporaryDirectory()
    const profileDir = join(root, 'profile')
    writeFiles(join(root, 'plug'), { 'package.json': '{"name":"@x/plug","version":"1.0.0"}\n', 'index.js': 'export const from = "folder"\n' })
    const active = join(root, 'home', 'active', '@x+plug')
    writeFiles(active, { 'package.json': '{"name":"@x/plug","version":"1.0.0"}\n', 'index.js': 'export const from = "active"\n' })
    writeFiles(profileDir, {
      'package.json': '{"name":"dsh-profile-default","private":true,"dependencies":{"@x/plug":"link:../plug"}}\n',
      // The profile's pnpm settings, as upstream's initProfile writes them.
      'pnpm-workspace.yaml': 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
    })
    const env = { ...process.env, npm_config_store_dir: join(root, 'store'), CI: 'true' }
    const install = (...args: string[]): void => {
      execFileSync('pnpm', ['install', '--offline', ...args], { cwd: profileDir, env, stdio: 'pipe', timeout: 100_000 })
    }
    install()
    expect(realpathSync(join(profileDir, 'node_modules', '@x', 'plug'))).toBe(join(root, 'plug'))
    return pointLinkAt(profileDir, '@x/plug', active).then(() => {
      install('--frozen-lockfile')
      expect(realpathSync(join(profileDir, 'node_modules', '@x', 'plug'))).toBe(active)
      expect(JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))).toMatchObject({ dependencies: { '@x/plug': `${LINK_PREFIX}${active}` } })
      expect(readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')).toContain(`specifier: link:${active}`)
    })
  })
})
