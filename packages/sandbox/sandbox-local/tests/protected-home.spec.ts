/**
 * The protected home and denied sockets as profile arguments and provider configuration, without a real runner:
 * each dialect's mechanism, the protection resolved per wrap, the load-time validation and the refusal of a writable
 * root that overlaps the home. The per-runner e2e files prove the same rules against real kernels.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider, RUNNER_PROTECTION, pathAliasCoverage } from '@deepseek-ai/dsh-sandbox-local'
import type { Config } from '@deepseek-ai/dsh-sandbox-local'
import { ALIAS_UNRELIABLE_FILESYSTEMS, DATA_VOLUME, aliasCoverage, deviceName, firmlinkAliases, mountAliases, parseMountInfo, readMountTable } from '../src/mounts.ts'
import type { MountEntry } from '../src/mounts.ts'
import { NO_PROTECTION, bwrapProfileArgs, landlockProfileArgs, resolveProtection, seatbeltProfileArgs } from '../src/profiles.ts'
import type { Protection, ProtectionSettings } from '../src/profiles.ts'

/** Protection settings with every field empty except those given. */
function settingsOf(fields: Partial<ProtectionSettings>): ProtectionSettings {
  return { home: undefined, readable: [], deniedSockets: [], deniedSocketDirectories: [], privateTmp: false, ...fields }
}

/** No mount and no Data volume: resolution sees only the paths it is given. */
const NO_MOUNTS: readonly MountEntry[] = []
const NO_DATA_VOLUME = '/nonexistent-data-volume'

function resolveIsolated(settings: ProtectionSettings, mounts: readonly MountEntry[] = NO_MOUNTS): Protection {
  return resolveProtection(settings, mounts, NO_DATA_VOLUME)
}

/**
 * A mount table in which `alias` is a second mount of the filesystem holding `target`'s parent: the entry's mount
 * point is a symbolic link to that parent, so device and inode match as they do for a real second mount.
 */
function aliasMount(target: string, alias: string): MountEntry[] {
  const device = deviceName(statSync(target, { bigint: true }).dev)
  return [{ device, root: '/', mountPoint: '/', fsType: 'ext4' }, { device, root: dirname(target), mountPoint: alias, fsType: 'ext4' }]
}

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
  sandbox.internals = { probeBwrap: () => true, vsockOffered: () => false, ...internals }
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
    expect(resolveProtection(settingsOf({}))).toEqual(NO_PROTECTION)
  })

  it('keeps existing readable entries, drops missing ones and an entry that leads elsewhere inside the home', () => {
    const { root, home } = fixture()
    const outside = join(root, 'skills-store')
    mkdirSync(outside)
    symlinkSync(outside, join(home, 'skills'), 'dir')
    symlinkSync(join(home, 'secrets'), join(home, 'dsh-runtimes'), 'dir')
    const protection = resolveIsolated({ home, readable: ['runtimes', 'skills', 'dsh-runtimes', 'missing'], deniedSockets: [], deniedSocketDirectories: [], privateTmp: false })
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
    const protection = resolveIsolated(settingsOf({ home, deniedSockets: [viaLink, underHome, missing] }))
    expect(protection.socketSpellings).toEqual([viaLink, join(real, 'docker.sock'), underHome, missing])
    expect(protection.shadowedSockets).toEqual([join(real, 'docker.sock')])
    expect(resolveIsolated(settingsOf({ deniedSockets: [underHome] })).shadowedSockets).toEqual([underHome])
  })
})

describe('resolveProtection with aliases', () => {
  it('finds the home through a second mount of its filesystem and through the Data volume, and protects both', () => {
    const { root, home } = fixture()
    const alias = join(root, 'second-mount')
    symlinkSync(dirname(home), alias, 'dir')
    const data = join(root, 'data')
    mkdirSync(join(data, dirname(home)), { recursive: true })
    symlinkSync(home, join(data, home), 'dir')
    const protection = resolveProtection(settingsOf({ home }), aliasMount(home, alias), data)
    expect(protection.homeAliases).toEqual([join(alias, basename(home)), join(data, home)])
    // Landlock leaves out the whole second mount, and the firmlink spelling itself.
    expect(protection.homeAliasMounts).toEqual([alias, join(data, home)])
  })

  it('shadows a denied socket at each of its mount aliases outside the home', () => {
    const { root, home } = fixture()
    const runtime = join(root, 'run')
    mkdirSync(runtime)
    const socket = join(runtime, 'docker.sock')
    writeFileSync(socket, '')
    const bind = join(root, 'bind')
    symlinkSync(runtime, bind, 'dir')
    const protection = resolveIsolated(settingsOf({ home, deniedSockets: [socket] }), aliasMount(socket, bind))
    expect(protection.shadowedSockets).toEqual([socket, join(bind, 'docker.sock')])
    expect(protection.socketSpellings).toContain(join(bind, 'docker.sock'))
  })

  it('drops a readable entry that leads above the home, which would expose all of it', () => {
    const { root, home } = fixture()
    symlinkSync(root, join(home, 'skills'), 'dir')
    symlinkSync(home, join(home, 'dsh-runtimes'), 'dir')
    expect(resolveIsolated({ home, readable: ['skills', 'dsh-runtimes', 'runtimes'], deniedSockets: [], deniedSocketDirectories: [], privateTmp: false }).readable.map(entry => entry.path)).toEqual([join(home, 'runtimes')])
  })

  it('reads the mount table only when something is protected', () => {
    expect(resolveProtection(settingsOf({}), undefined)).toBe(NO_PROTECTION)
    const { home } = fixture()
    expect(resolveProtection({ home, readable: [], deniedSockets: [], deniedSocketDirectories: [], privateTmp: false }).home).toBe(home)
  })
})

describe('mount aliases', () => {
  it('parses mountinfo, decoding escapes and leaving out deleted mounts', () => {
    const text = [
      '22 1 8:48 / / rw,relatime shared:1 - ext4 /dev/sdd rw',
      '82 81 8:48 /a\\040b /mnt/with\\040space ro shared:3 - ext4 /dev/sdd rw',
      '704 76 8:48 /gone//deleted /mnt/gone rw - ext4 /dev/sdd rw',
      '705 76 8:48 / /mnt/no-separator rw',
      '',
    ].join('\n')
    expect(parseMountInfo(text)).toEqual([
      { device: '8:48', root: '/', mountPoint: '/', fsType: 'ext4' },
      { device: '8:48', root: '/a b', mountPoint: '/mnt/with space', fsType: 'ext4' },
    ])
  })

  it('reads the mount table on Linux only, and fails closed when it cannot', () => {
    expect(readMountTable('darwin')).toEqual([])
    expect(readMountTable('linux', () => '22 1 8:48 / / rw - ext4 /dev/sdd rw')).toEqual([{ device: '8:48', root: '/', mountPoint: '/', fsType: 'ext4' }])
    expect(() => readMountTable('linux', () => { throw new Error('no /proc') })).toThrow(/cannot read \/proc\/self\/mountinfo/)
    if (process.platform === 'linux') expect(readMountTable().length).toBeGreaterThan(0)
  })

  it('spells Linux device numbers as mountinfo does', () => {
    expect(deviceName(0x830n)).toBe('8:48')
    expect(deviceName((259n << 8n) | 1n)).toBe('259:1')
    // glibc's makedev for a major and minor wider than the old 8-bit fields.
    const major = 0x12345n
    const minor = 0x6789an
    const dev = ((major & 0xfffff000n) << 32n) | ((major & 0xfffn) << 8n) | ((minor & 0xffffff00n) << 12n) | (minor & 0xffn)
    expect(deviceName(dev)).toBe(`${String(major)}:${String(minor)}`)
  })

  it('confirms each candidate by device and inode, and finds none for a missing path or an unmounted device', () => {
    const { root, home } = fixture()
    const alias = join(root, 'second-mount')
    symlinkSync(dirname(home), alias, 'dir')
    const table = aliasMount(home, alias)
    expect(mountAliases(home, table)).toEqual([{ path: join(alias, basename(home)), mountPoint: alias }])
    // A mount whose candidate is another directory is stale or overmounted: left out.
    const other = join(root, 'other')
    mkdirSync(join(other, basename(home)), { recursive: true })
    const stale: MountEntry = { device: table[0]!.device, root: dirname(home), mountPoint: other, fsType: 'ext4' }
    expect(mountAliases(home, [...table, stale]).map(entry => entry.path)).toEqual([join(alias, basename(home))])
    expect(mountAliases(join(root, 'missing'), table)).toEqual([])
    expect(mountAliases(home, [{ device: '0:0', root: '/', mountPoint: '/', fsType: 'ext4' }])).toEqual([])
    // A bind mount of a directory inside the path reaches that part of it; one mounted inside the path itself, or of
    // a missing directory, is not an alias.
    const secretsBind = join(root, 'secrets-bind')
    symlinkSync(join(home, 'secrets'), secretsBind, 'dir')
    expect(mountAliases(home, [table[0]!, { device: table[0]!.device, root: join(home, 'secrets'), mountPoint: secretsBind, fsType: 'ext4' }])).toEqual([{ path: secretsBind, mountPoint: secretsBind }])
    expect(mountAliases(home, [table[0]!, { device: table[0]!.device, root: join(home, 'secrets'), mountPoint: join(home, 'runtimes'), fsType: 'ext4' }])).toEqual([])
    expect(mountAliases(home, [table[0]!, { device: table[0]!.device, root: join(home, 'missing'), mountPoint: secretsBind, fsType: 'ext4' }])).toEqual([])
    // The deepest mount containing the path decides its path inside the filesystem, whatever the table's order.
    const device = table[0]!.device
    expect(mountAliases(home, [{ device, root: root, mountPoint: root, fsType: 'ext4' }, { device, root: '/', mountPoint: '/', fsType: 'ext4' }])).toEqual([])
  })

  it('finds a Data-volume spelling only where it reaches the same file', () => {
    const { root, home } = fixture()
    expect(firmlinkAliases(home, join(root, 'no-data'))).toEqual([])
    const data = join(root, 'data')
    mkdirSync(join(data, home), { recursive: true })
    expect(firmlinkAliases(home, data)).toEqual([])
    expect(firmlinkAliases(join(data, 'x'), data)).toEqual([])
    expect(DATA_VOLUME).toBe('/System/Volumes/Data')
  })
})

describe('alias coverage', () => {
  it('is unknown on a filesystem whose aliases cannot be found by device, and when the table does not hold the path\'s device', () => {
    const { home } = fixture()
    const device = deviceName(statSync(home, { bigint: true }).dev)
    const ext4: MountEntry[] = [{ device, root: '/', mountPoint: '/', fsType: 'ext4' }]
    expect(aliasCoverage(home, ext4, 'linux')).toBe('complete')
    for (const fsType of ALIAS_UNRELIABLE_FILESYSTEMS) {
      expect(aliasCoverage(home, [{ device, root: '/', mountPoint: '/', fsType }], 'linux')).toBe('unknown')
    }
    // A btrfs subvolume reports another device in stat than the table lists.
    expect(aliasCoverage(home, [{ device: '0:9999', root: '/', mountPoint: '/', fsType: 'btrfs' }], 'linux')).toBe('unknown')
    expect(aliasCoverage(home, [], 'linux')).toBe('unknown')
    expect(aliasCoverage(join(home, 'missing'), [], 'linux')).toBe('complete')
    expect(aliasCoverage(home, [], 'darwin')).toBe('complete')
  })

  it('makes a wrap\'s protection report unknown when the home or an existing denied socket is on such a filesystem', () => {
    const { root, home } = fixture()
    const socket = join(root, 'docker.sock')
    writeFileSync(socket, '')
    const device = deviceName(statSync(home, { bigint: true }).dev)
    const settings: ProtectionSettings = { home, readable: [], deniedSockets: [socket], deniedSocketDirectories: [], privateTmp: false }
    expect(resolveProtection(settings, [{ device, root: '/', mountPoint: '/', fsType: 'ext4' }], NO_DATA_VOLUME, 'linux').aliasCoverage).toBe('complete')
    expect(resolveProtection(settings, [{ device, root: '/', mountPoint: '/', fsType: 'overlay' }], NO_DATA_VOLUME, 'linux').aliasCoverage).toBe('unknown')
    expect(resolveProtection({ home: undefined, readable: [], deniedSockets: [socket], deniedSocketDirectories: [], privateTmp: false }, [], NO_DATA_VOLUME, 'linux').aliasCoverage).toBe('unknown')
  })

  it('reports protected reads: the home, its aliases and the readable entries under each', async () => {
    const { home } = fixture()
    const sandbox = await provider({ protectedHome: home, protectedHomeReadable: ['runtimes', 'missing'] })
    const reads = sandbox.protectedReads
    expect(reads?.roots[0]).toBe(home)
    expect(reads?.readable).toContain(join(home, 'runtimes'))
    expect(reads?.readable).not.toContain(join(home, 'missing'))
    expect((await provider({})).protectedReads).toBeUndefined()
    // The Service Definition's default protects nothing.
    class Plain extends SandboxProvider {
      /* v8 ignore next 3 -- never confines; only the defaults are read. */
      confine(): Promise<ConfinedArgv> {
        throw new Error('not used')
      }
    }
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Plain)
    expect(ctx.sandbox.protectedReads).toBeUndefined()
    expect(ctx.sandbox.protectedHome).toBeUndefined()
  })

  it('reports tool-readable entries to read tools and grants them to no confined command', async () => {
    const { home, workspace } = fixture()
    mkdirSync(join(home, 'spill'))
    const sandbox = await provider({ protectedHome: home, protectedHomeReadable: ['runtimes'], protectedHomeToolReadable: ['spill'] })
    expect(sandbox.protectedReads?.toolReadable).toEqual(sandbox.protectedReads?.roots.map(root => join(root, 'spill')))
    expect(sandbox.protectedReads?.readable).not.toContain(join(home, 'spill'))
    const bwrap = await sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: workspace })
    expect(bwrap.argv).toEqual(expect.arrayContaining(['--ro-bind', join(home, 'runtimes'), join(home, 'runtimes')]))
    expect(bwrap.argv.some(arg => arg.includes('spill'))).toBe(false)
    const seatbelt = await provider({ protectedHome: home, protectedHomeToolReadable: ['spill'] }, { platform: 'darwin', seatbeltExec: '/usr/bin/false' })
    expect((await seatbelt.confine(['true'], { mode: 'read-only', workspaceRoot: workspace })).argv.join(' ')).not.toContain('spill')
    await expect(provider({ protectedHomeToolReadable: ['spill'] })).rejects.toThrow('protectedHomeToolReadable requires protectedHome')
    for (const entry of ['', '/abs', '..', '../outside', '.']) {
      await expect(provider({ protectedHome: home, protectedHomeToolReadable: [entry] })).rejects.toThrow('protectedHomeToolReadable entries must be relative paths inside protectedHome')
    }
  })

  it('is reported by the provider and for any path on this host', async () => {
    const { home } = fixture()
    const sandbox = await provider({ protectedHome: home })
    expect(sandbox.aliasCoverage()).toBe(pathAliasCoverage(home))
    expect((await provider({})).aliasCoverage()).toBe('complete')
  })
})

describe('denied socket directories', () => {
  it('hides each existing directory and its mount aliases, and denies each entry present now by its spellings', () => {
    const { root, home } = fixture()
    const sockets = join(root, 'shared-sockets')
    mkdirSync(sockets)
    writeFileSync(join(sockets, 'backend.sock'), '')
    const bind = join(root, 'bind')
    symlinkSync(root, bind, 'dir')
    const protection = resolveIsolated(
      { home, readable: [], deniedSockets: [], deniedSocketDirectories: [sockets, join(root, 'missing')], privateTmp: false },
      aliasMount(sockets, bind),
    )
    expect(protection.hiddenDirectories).toEqual([sockets, join(bind, 'shared-sockets')])
    expect(protection.socketSpellings).toEqual([join(sockets, 'backend.sock')])
    expect(bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/w' }, protection)).toEqual(expect.arrayContaining(['--tmpfs', sockets, '--remount-ro', sockets]))
    expect(seatbeltProfileArgs({ mode: 'read-only', workspaceRoot: '/w' }, protection)[1]).toContain(`(path-literal "${join(sockets, 'backend.sock')}")`)
  })

  it('leaves a directory inside the home to the home\'s tmpfs, and fails closed on one it cannot list', () => {
    const { root, home } = fixture()
    const inside = join(home, 'run')
    mkdirSync(inside)
    expect(resolveIsolated(settingsOf({ home, deniedSocketDirectories: [inside] })).hiddenDirectories).toEqual([])
    const locked = join(root, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o100)
    expect(() => resolveIsolated(settingsOf({ deniedSocketDirectories: [locked] }))).toThrow(/cannot list the denied socket directory/)
    chmodSync(locked, 0o700)
  })
})

describe('bwrap profile', () => {
  it('shadows each denied socket path and hides the home under a read-only tmpfs with its readable entries bound', () => {
    const protection: Protection = { home: '/h', homeAliases: ['/mnt/distro/h'], homeAliasMounts: ['/mnt/distro'], aliasCoverage: 'complete', readable: [{ path: '/h/runtimes', source: '/h/runtimes' }], socketSpellings: [], shadowedSockets: ['/run/docker.sock'], hiddenDirectories: [], privateTmp: false, tmpAliases: [] }
    expect(bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/w' }, protection)).toEqual([
      ...BASE,
      '--ro-bind', '/dev/null', '/run/docker.sock',
      '--tmpfs', '/h', '--ro-bind', '/h/runtimes', '/h/runtimes', '--remount-ro', '/h',
      '--tmpfs', '/mnt/distro/h', '--remount-ro', '/mnt/distro/h',
    ])
  })

  it('is upstream\'s profile without protection', () => {
    expect(bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/w' }, NO_PROTECTION)).toEqual(BASE)
  })

  it('gives a read-only command an empty read-only /tmp with its workspace under /tmp bound back, and hides the other mounts of /tmp', () => {
    const protection: Protection = { ...NO_PROTECTION, privateTmp: true, tmpAliases: ['/mnt/root/tmp'], hiddenDirectories: ['/tmp/tmux-7'] }
    expect(bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/tmp/w' }, protection)).toEqual([
      ...BASE,
      '--tmpfs', '/tmp', '--ro-bind', '/tmp/w', '/tmp/w',
      '--tmpfs', '/tmp/tmux-7', '--remount-ro', '/tmp/tmux-7',
      '--tmpfs', '/mnt/root/tmp', '--remount-ro', '/mnt/root/tmp',
      '--remount-ro', '/tmp',
    ])
    expect(bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/w' }, { ...protection, hiddenDirectories: [] })).toEqual([
      ...BASE, '--tmpfs', '/tmp', '--tmpfs', '/mnt/root/tmp', '--remount-ro', '/mnt/root/tmp', '--remount-ro', '/tmp',
    ])
    expect(bwrapProfileArgs({ mode: 'workspace-write', workspaceRoot: '/w' }, { ...protection, hiddenDirectories: [] })).toEqual([
      ...BASE, '--tmpfs', '/tmp', '--bind', '/w', '/w', '--tmpfs', '/mnt/root/tmp', '--remount-ro', '/mnt/root/tmp',
    ])
  })

  it('mounts nothing inside a hidden directory, whose read-only tmpfs could not hold the mount point', () => {
    const protection: Protection = {
      ...NO_PROTECTION,
      home: '/h',
      homeAliases: ['/mnt/wslg/distro/h', '/mnt/root/h'],
      shadowedSockets: ['/mnt/wslg/distro/run/docker.sock', '/run/docker.sock'],
      hiddenDirectories: ['/mnt/wslg/distro/tmp/tmux-7', '/mnt/wslg', '/run/user/7', '/run/user/7/gnupg'],
      privateTmp: true,
      tmpAliases: ['/mnt/wslg/distro/tmp', '/mnt/root/tmp'],
    }
    expect(bwrapProfileArgs({ mode: 'workspace-write', workspaceRoot: '/w' }, protection)).toEqual([
      ...BASE,
      '--tmpfs', '/tmp', '--bind', '/w', '/w',
      '--ro-bind', '/dev/null', '/run/docker.sock',
      '--tmpfs', '/mnt/wslg', '--remount-ro', '/mnt/wslg',
      '--tmpfs', '/run/user/7', '--remount-ro', '/run/user/7',
      '--tmpfs', '/h', '--remount-ro', '/h',
      '--tmpfs', '/mnt/root/h', '--remount-ro', '/mnt/root/h',
      '--tmpfs', '/mnt/root/tmp', '--remount-ro', '/mnt/root/tmp',
    ])
  })
})

describe.skipIf(process.platform !== 'linux')('private /tmp', () => {
  it('is resolved on its own, with the other mounts of the host\'s /tmp, whose coverage it reports', (test) => {
    // The empty mount table does not list /tmp's device, so its other mounts cannot be known.
    expect(resolveIsolated(settingsOf({ privateTmp: true }))).toEqual({ ...NO_PROTECTION, privateTmp: true, aliasCoverage: 'unknown' })
    const { root } = fixture()
    if (dirname(root) !== realpathSync.native('/tmp')) return test.skip('the temporary directory is not /tmp here')
    // The second mount lies outside /tmp, as WSLg's /mnt/wslg/distro/tmp does.
    const outside = realpathSync.native(mkdtempSync(join('/var/tmp', 'dsh-protected-')))
    dirs.push(outside)
    const alias = join(outside, 'distro-tmp')
    symlinkSync(dirname(root), alias, 'dir')
    expect(resolveIsolated(settingsOf({ privateTmp: true }), aliasMount(root, alias)).tmpAliases).toEqual([alias])
    expect(resolveIsolated(settingsOf({ deniedSocketDirectories: [root] }), aliasMount(root, alias)).tmpAliases).toEqual([])
  })

  it('is off unless configured, and reaches the wrap when it is', async () => {
    const { workspace } = fixture()
    const policy: SandboxPolicy = { mode: 'read-only', workspaceRoot: workspace }
    expect((await (await provider({})).confine(['true'], policy)).argv).not.toContain('--tmpfs')
    const argv = (await (await provider({ privateTmp: true })).confine(['true'], policy)).argv
    expect(argv.slice(argv.indexOf('--tmpfs'), argv.indexOf('--tmpfs') + 2)).toEqual(['--tmpfs', '/tmp'])
    expect(argv.slice(argv.lastIndexOf('--remount-ro'), argv.lastIndexOf('--remount-ro') + 2)).toEqual(['--remount-ro', '/tmp'])
  })
})

describe('landlock profile', () => {
  it('grants reads beside the way to the home, its readable entries, and writes that leave the home out', () => {
    const { root, home, workspace } = fixture()
    writeFileSync(join(root, 'file'), '')
    symlinkSync(join(root, 'gone'), join(root, 'dangling'))
    symlinkSync(home, join(root, 'home-alias'), 'dir')
    symlinkSync(root, join(root, 'parent-alias'), 'dir')
    const protection = resolveIsolated({ home, readable: ['runtimes'], deniedSockets: [], deniedSocketDirectories: [], privateTmp: false })
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
    const protection = resolveIsolated({ home, readable: [], deniedSockets: [], deniedSocketDirectories: [], privateTmp: false })
    chmodSync(root, 0o100)
    expect(() => landlockProfileArgs({ mode: 'read-only', workspaceRoot: '/w' }, protection)).toThrow(/cannot list/)
    chmodSync(root, 0o700)
    const atHome: Protection = { ...protection, home: realpathSync.native('/tmp') }
    expect(landlockProfileArgs({ mode: 'workspace-write', workspaceRoot: home }, atHome)).not.toContain(realpathSync.native('/tmp'))
  })

  it('is upstream\'s profile without protection', () => {
    expect(landlockProfileArgs({ mode: 'read-only', workspaceRoot: '/w' }, NO_PROTECTION)).toEqual(['--ro', '/', '--rw', '/dev/null'])
  })

  it('grants resolved paths only, leaves out links into the home, and leaves out each alias of the home like the home', () => {
    const { root, home, workspace } = fixture()
    const target = join(root, 'target')
    mkdirSync(target)
    symlinkSync(target, join(root, 'to-target'), 'dir')
    symlinkSync(join(home, 'secrets'), join(root, 'to-secrets'), 'dir')
    const mirror = join(root, 'mirror')
    mkdirSync(join(mirror, 'inner'), { recursive: true })
    symlinkSync(home, join(mirror, 'inner', 'h'), 'dir')
    mkdirSync(join(mirror, 'inner', 'beside'))
    const protection: Protection = { ...resolveIsolated({ home, readable: [], deniedSockets: [], deniedSocketDirectories: [], privateTmp: false }), homeAliasMounts: [join(mirror, 'inner', 'h')] }
    const args = landlockProfileArgs({ mode: 'workspace-write', workspaceRoot: workspace }, protection)
    const grants = args.filter((_arg, index) => index % 2 === 1)
    const readOnly = args.flatMap((arg, index) => arg === '--ro' ? [args[index + 1]] : [])
    expect(grants).toContain(target)
    expect(grants).toContain(join(mirror, 'inner', 'beside'))
    for (const excluded of [join(root, 'to-target'), join(root, 'to-secrets'), join(home, 'secrets'), mirror, join(mirror, 'inner'), join(mirror, 'inner', 'h')]) expect(grants).not.toContain(excluded)
    expect(new Set(readOnly).size).toBe(readOnly.length)
    // A write root inside an alias of the home is granted nothing.
    expect(landlockProfileArgs({ mode: 'workspace-write', workspaceRoot: join(mirror, 'inner', 'h', 'runtimes') }, protection).filter(arg => arg.startsWith(home))).toEqual([])
  })
})

describe('seatbelt profile', () => {
  it('denies writes and reads under the home after the write allows, allows its readable entries, and denies each socket literal', () => {
    const protection: Protection = {
      home: '/h',
      homeAliases: ['/System/Volumes/Data/h'],
      homeAliasMounts: ['/System/Volumes/Data/h'],
      aliasCoverage: 'complete',
      readable: [{ path: '/h/runtimes', source: '/h/runtimes' }],
      socketSpellings: ['/var/run/docker.sock', '/private/var/run/docker.sock'],
      shadowedSockets: [],
      hiddenDirectories: [],
      privateTmp: false,
      tmpAliases: [],
    }
    const profile = seatbeltProfileArgs({ mode: 'read-only', workspaceRoot: '/w' }, protection)[1]
    expect(profile).toBe([
      '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))',
      '(deny file-write* (subpath "/h")) (deny file-read* (subpath "/h"))',
      '(deny file-link file-clone (subpath "/h"))',
      '(allow file-read-metadata (literal "/h"))',
      '(deny file-write* (subpath "/System/Volumes/Data/h")) (deny file-read* (subpath "/System/Volumes/Data/h"))',
      '(deny file-link file-clone (subpath "/System/Volumes/Data/h"))',
      '(allow file-read-metadata (literal "/System/Volumes/Data/h"))',
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
    const socketDirectory = join(home, '..', 'shared-sockets')
    mkdirSync(socketDirectory)
    const hiding = await provider({ deniedSocketDirectories: [socketDirectory] })
    expect((await hiding.confine(['true'], { mode: 'read-only', workspaceRoot: workspace })).argv).toEqual(expect.arrayContaining(['--tmpfs', socketDirectory]))
    const custom = await provider({ runnerCommand: ['my-bwrap'], runnerFailureSignatures: ['my-bwrap: '], protectedHome: home })
    expect((await custom.confine(['true'], { mode: 'read-only', workspaceRoot: workspace })).argv).toEqual(expect.arrayContaining(['--tmpfs', home]))
    const seatbelt = await provider({ protectedHome: home, deniedSockets: ['/var/run/docker.sock'], deniedSocketDirectories: [] }, { platform: 'darwin', seatbeltExec: '/usr/bin/false' })
    expect((await seatbelt.confine(['true'], { mode: 'read-only', workspaceRoot: workspace })).argv[2]).toContain('(path-literal "/var/run/docker.sock")')
  })

  it('canonicalizes the home at load', async () => {
    const { root, home, workspace } = fixture()
    symlinkSync(home, join(root, 'home-link'), 'dir')
    const sandbox = await provider({ protectedHome: join(root, 'home-link') })
    expect(sandbox.protectedHome).toBe(home)
    expect((await provider({})).protectedHome).toBeUndefined()
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
    ['a relative socket directory', () => ({ deniedSocketDirectories: ['run'] }), /deniedSocketDirectories entries must be absolute/],
    ['the filesystem root as a socket directory', () => ({ deniedSocketDirectories: ['/'] }), /other than the filesystem root/],
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
    ['a denied socket inside a readable entry', () => {
      const { home } = fixture()
      return { protectedHome: home, protectedHomeReadable: ['runtimes'], deniedSockets: [join(home, 'runtimes', 'u.sock')], deniedSocketDirectories: [] }
    }, /lies inside the readable entry "runtimes"/],
    ['a denied socket reaching a readable entry through a link', () => {
      const { root, home } = fixture()
      symlinkSync(join(home, 'runtimes'), join(root, 'runtimes-link'), 'dir')
      return { protectedHome: home, protectedHomeReadable: ['runtimes'], deniedSockets: [join(root, 'runtimes-link', 'u.sock')], deniedSocketDirectories: [] }
    }, /lies inside the readable entry/],
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
