/**
 * The protected home and denied sockets as profile arguments and provider configuration, without a real runner:
 * each dialect's mechanism, the protection resolved per wrap, the load-time validation and the refusal of a writable
 * root that overlaps the home. The per-runner e2e files prove the same rules against real kernels.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider, RUNNER_PROTECTION } from '@deepseek-ai/dsh-sandbox-local'
import type { Config } from '@deepseek-ai/dsh-sandbox-local'
import { NO_PROTECTION, bwrapProfileArgs, landlockProfileArgs, resolveProtection, seatbeltProfileArgs } from '../src/profiles.ts'
import type { Protection } from '../src/profiles.ts'

const BASE = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A fixture: `<root>/h` is the home with `runtimes/` and `secrets/`, `<root>/w` a workspace beside it. */
function fixture(): { root: string; home: string; workspace: string } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-protected-')))
  dirs.push(root)
  const home = join(root, 'h')
  mkdirSync(join(home, 'runtimes'), { recursive: true })
  mkdirSync(join(home, 'secrets'))
  const workspace = join(root, 'w')
  mkdirSync(workspace)
  return { root, home, workspace }
}

async function provider(config: Config, internals: LocalSandboxProvider['internals'] = { probeLandlock: () => 'unusable' }): Promise<LocalSandboxProvider> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSandboxProvider, config)
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = { probeBwrap: () => true, ...internals }
  return sandbox
}

describe('RUNNER_PROTECTION', () => {
  it('reports the socket rule as expressed only by bwrap and Seatbelt, and reads as unconfined on Windows', () => {
    expect(RUNNER_PROTECTION).toEqual({
      bwrap: { homeWrite: true, homeRead: true, socketConnect: true },
      landlock: { homeWrite: true, homeRead: true, socketConnect: false },
      seatbelt: { homeWrite: true, homeRead: true, socketConnect: true },
      'windows-acl': { homeWrite: true, homeRead: false, socketConnect: false },
    })
  })
})

describe('resolveProtection', () => {
  it('is empty without a home or sockets', () => {
    expect(resolveProtection({ home: undefined, readable: [], deniedSockets: [] })).toEqual(NO_PROTECTION)
  })

  it('keeps existing readable entries, drops missing ones and an entry that leads elsewhere inside the home', () => {
    const { root, home } = fixture()
    const outside = join(root, 'skills-store')
    mkdirSync(outside)
    symlinkSync(outside, join(home, 'skills'), 'dir')
    symlinkSync(join(home, 'secrets'), join(home, 'dsh-runtimes'), 'dir')
    const protection = resolveProtection({ home, readable: ['runtimes', 'skills', 'dsh-runtimes', 'missing'], deniedSockets: [] })
    expect(protection.readable).toEqual([
      { path: join(home, 'runtimes'), source: join(home, 'runtimes') },
      { path: join(home, 'skills'), source: outside },
    ])
  })

  it('denies every spelling of a socket and shadows only existing resolved paths outside the home', () => {
    const { root, home } = fixture()
    const real = join(root, 'real')
    mkdirSync(real)
    writeFileSync(join(real, 'docker.sock'), '')
    symlinkSync(real, join(root, 'link'), 'dir')
    const viaLink = join(root, 'link', 'docker.sock')
    const underHome = join(home, 'u.sock')
    writeFileSync(underHome, '')
    const missing = join(root, 'missing.sock')
    const protection = resolveProtection({ home, readable: [], deniedSockets: [viaLink, underHome, missing] })
    expect(protection.socketSpellings).toEqual([viaLink, join(real, 'docker.sock'), underHome, missing])
    expect(protection.shadowedSockets).toEqual([join(real, 'docker.sock')])
    expect(resolveProtection({ home: undefined, readable: [], deniedSockets: [underHome] }).shadowedSockets).toEqual([underHome])
  })
})

describe('bwrap profile', () => {
  it('shadows each denied socket path and hides the home under a read-only tmpfs with its readable entries bound', () => {
    const protection: Protection = { home: '/h', readable: [{ path: '/h/runtimes', source: '/h/runtimes' }], socketSpellings: [], shadowedSockets: ['/run/docker.sock'] }
    expect(bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/w' }, protection)).toEqual([
      ...BASE,
      '--ro-bind', '/dev/null', '/run/docker.sock',
      '--tmpfs', '/h', '--ro-bind', '/h/runtimes', '/h/runtimes', '--remount-ro', '/h',
    ])
  })

  it('is upstream\'s profile without protection', () => {
    expect(bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/w' }, NO_PROTECTION)).toEqual(BASE)
  })
})

describe('landlock profile', () => {
  it('grants reads beside the way to the home, its readable entries, and writes that leave the home out', () => {
    const { root, home, workspace } = fixture()
    writeFileSync(join(root, 'file'), '')
    symlinkSync(join(root, 'gone'), join(root, 'dangling'))
    symlinkSync(home, join(root, 'home-alias'), 'dir')
    symlinkSync(root, join(root, 'parent-alias'), 'dir')
    const protection = resolveProtection({ home, readable: ['runtimes'], deniedSockets: [] })
    const args = landlockProfileArgs({ mode: 'workspace-write', workspaceRoot: workspace }, protection)
    const readOnly = args.flatMap((arg, index) => arg === '--ro' ? [args[index + 1]] : [])
    const readWrite = args.flatMap((arg, index) => arg === '--rw' ? [args[index + 1]] : [])
    expect(readOnly).not.toContain('/')
    expect(readOnly).toEqual(expect.arrayContaining([join(root, 'file'), workspace, join(home, 'runtimes')]))
    for (const excluded of [home, root, join(root, 'dangling'), join(root, 'home-alias'), join(root, 'parent-alias')]) expect(readOnly).not.toContain(excluded)
    // The home lies inside the temp area here, so the /tmp grant is layered the same way.
    expect(readWrite[0]).toBe('/dev/null')
    expect(readWrite).toContain(workspace)
    expect(readWrite).not.toContain(realpathSync.native('/tmp'))
    expect(readWrite.some(path => path === home || path?.startsWith(`${home}/`))).toBe(false)
  })

  it('grants nothing for a write root that equals the home, and fails closed when a directory on the way cannot be listed', () => {
    const { root, home } = fixture()
    const protection = resolveProtection({ home, readable: [], deniedSockets: [] })
    chmodSync(root, 0o100)
    expect(() => landlockProfileArgs({ mode: 'read-only', workspaceRoot: '/w' }, protection)).toThrow(/cannot list/)
    chmodSync(root, 0o700)
    const atHome: Protection = { ...protection, home: realpathSync.native('/tmp') }
    expect(landlockProfileArgs({ mode: 'workspace-write', workspaceRoot: home }, atHome)).not.toContain(realpathSync.native('/tmp'))
  })

  it('is upstream\'s profile without protection', () => {
    expect(landlockProfileArgs({ mode: 'read-only', workspaceRoot: '/w' }, NO_PROTECTION)).toEqual(['--ro', '/', '--rw', '/dev/null'])
  })
})

describe('seatbelt profile', () => {
  it('denies writes and reads under the home after the write allows, allows its readable entries, and denies each socket literal', () => {
    const protection: Protection = { home: '/h', readable: [{ path: '/h/runtimes', source: '/h/runtimes' }], socketSpellings: ['/var/run/docker.sock', '/private/var/run/docker.sock'], shadowedSockets: [] }
    const profile = seatbeltProfileArgs({ mode: 'read-only', workspaceRoot: '/w' }, protection)[1]
    expect(profile).toBe([
      '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))',
      '(deny file-write* (subpath "/h")) (deny file-read* (subpath "/h"))',
      '(allow file-read-metadata (literal "/h"))',
      '(allow file-read* (subpath "/h/runtimes"))',
      '(deny network-outbound (remote unix-socket (path-literal "/var/run/docker.sock")))',
      '(deny network-outbound (remote unix-socket (path-literal "/private/var/run/docker.sock")))',
    ].join(' '))
  })

  it('omits the readable allow when the home has no readable entry', () => {
    const profile = seatbeltProfileArgs({ mode: 'read-only', workspaceRoot: '/w' }, { ...NO_PROTECTION, home: '/h' })[1]
    expect(profile).not.toContain('(allow file-read*')
    expect(profile).toContain('(deny file-read* (subpath "/h"))')
  })
})

describe('provider protection config', () => {
  it('applies the protection to every wrap, the runnerCommand override included', async () => {
    const { home, workspace } = fixture()
    const sandbox = await provider({ protectedHome: home, protectedHomeReadable: ['runtimes'] })
    const confined = await sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: workspace })
    expect(confined.argv).toEqual(expect.arrayContaining(['--tmpfs', home, '--remount-ro', home]))
    const custom = await provider({ runnerCommand: ['my-bwrap'], runnerFailureSignatures: ['my-bwrap: '], protectedHome: home })
    expect((await custom.confine(['true'], { mode: 'read-only', workspaceRoot: workspace })).argv).toEqual(expect.arrayContaining(['--tmpfs', home]))
    const seatbelt = await provider({ protectedHome: home, deniedSockets: ['/var/run/docker.sock'] }, { platform: 'darwin', seatbeltExec: '/usr/bin/false' })
    expect((await seatbelt.confine(['true'], { mode: 'read-only', workspaceRoot: workspace })).argv[2]).toContain('(path-literal "/var/run/docker.sock")')
  })

  it('canonicalizes the home at load', async () => {
    const { root, home, workspace } = fixture()
    symlinkSync(home, join(root, 'home-link'), 'dir')
    const sandbox = await provider({ protectedHome: join(root, 'home-link') })
    expect((await sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: workspace })).argv).toEqual(expect.arrayContaining(['--tmpfs', home]))
  })

  it('refuses a writable root that equals, lies inside or contains the home with HOME_IN_WRITABLE_ROOT', async () => {
    const { root, home, workspace } = fixture()
    const sandbox = await provider({ protectedHome: home })
    const refused: SandboxPolicy[] = [
      { mode: 'workspace-write', workspaceRoot: home },
      { mode: 'workspace-write', workspaceRoot: join(home, 'runtimes') },
      { mode: 'workspace-write', workspaceRoot: root },
      { mode: 'workspace-write', workspaceRoot: workspace, additionalWritableRoots: [root] },
    ]
    for (const policy of refused) await expect(sandbox.confine(['true'], policy)).rejects.toMatchObject({ code: 'HOME_IN_WRITABLE_ROOT', name: 'SandboxProtectedRootError' })
    await expect(sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: root })).resolves.toBeDefined()
    // Without a protected home the same roots are upstream's.
    await expect((await provider({})).confine(['true'], { mode: 'workspace-write', workspaceRoot: root })).resolves.toBeDefined()
  })

  it.each<[string, () => Config, RegExp]>([
    ['readable entries without a home', () => ({ protectedHomeReadable: ['runtimes'] }), /requires protectedHome/],
    ['a relative socket path', () => ({ deniedSockets: ['docker.sock'] }), /deniedSockets entries must be absolute/],
    ['a relative home', () => ({ protectedHome: 'home' }), /must be an absolute path/],
    ['a missing home', () => ({ protectedHome: join(tmpdir(), 'dsh-protected-missing-xyz') }), /must be an existing directory/],
    ['a file as the home', () => {
      const { root } = fixture()
      writeFileSync(join(root, 'file'), '')
      return { protectedHome: join(root, 'file') }
    }, /must be an existing directory/],
    ['the filesystem root', () => ({ protectedHome: '/' }), /cannot be the filesystem root/],
    ['an empty readable entry', () => ({ protectedHome: fixture().home, protectedHomeReadable: [''] }), /relative paths inside protectedHome/],
    ['an absolute readable entry', () => ({ protectedHome: fixture().home, protectedHomeReadable: ['/etc'] }), /relative paths inside protectedHome/],
    ['the home itself as a readable entry', () => ({ protectedHome: fixture().home, protectedHomeReadable: ['.'] }), /relative paths inside protectedHome/],
    ['a readable entry outside the home', () => ({ protectedHome: fixture().home, protectedHomeReadable: ['../w'] }), /relative paths inside protectedHome/],
    ['the parent as a readable entry', () => ({ protectedHome: fixture().home, protectedHomeReadable: ['runtimes/../..'] }), /relative paths inside protectedHome/],
  ])('rejects %s at load', async (_name, config, message) => {
    await expect(provider(config())).rejects.toThrow(message)
  })
})

describe.skipIf(process.platform !== 'win32')('home-write-denied under the real Windows ACL runner', () => {
  it('a confined command cannot create or change a file under the home, from a read-only or writable workspace beside it', async () => {
    const root = realpathSync.native(mkdtempSync(join(homedir(), 'dsh-protected-')))
    dirs.push(root)
    const home = join(root, 'h')
    const workspace = join(root, 'w')
    mkdirSync(join(home, 'secrets'), { recursive: true })
    mkdirSync(workspace)
    const existing = join(home, 'secrets', 'device.key')
    writeFileSync(existing, 'fixture-key')
    const sandbox = await provider({ protectedHome: home }, {})
    for (const mode of ['read-only', 'workspace-write'] as const) {
      for (const script of [`require('node:fs').writeFileSync(${JSON.stringify(join(home, 'planted'))}, 'x')`, `require('node:fs').appendFileSync(${JSON.stringify(existing)}, 'x')`]) {
        const confined = await sandbox.confine([process.execPath, '-e', script], { mode, workspaceRoot: workspace })
        const result = spawnSync(confined.argv[0] ?? '', confined.argv.slice(1), { encoding: 'utf8', timeout: 60_000 })
        expect(result.status).not.toBe(0)
      }
    }
    expect(existsSync(join(home, 'planted'))).toBe(false)
    expect(readFileSync(existing, 'utf8')).toBe('fixture-key')
  })
})
