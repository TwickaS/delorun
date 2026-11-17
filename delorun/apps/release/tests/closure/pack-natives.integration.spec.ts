import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimePlatform } from '@delorun/contract-release-manifest'
import { buildPackArchive } from '@delorun/release-formats/packs/archive'
import { buildPack, deployTargets, lockedFrom, PackNatives, type LockedPackage, type NativeSystem, type PackSources } from '../../src/closure/packs.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const temp = (): string => { const root = mkdtempSync(join(tmpdir(), 'delorun-pack-natives-')); roots.push(root); return root }
const put = (root: string, path: string, body: string | Buffer, executable = false): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), body)
  if (executable) chmodSync(join(root, path), 0o755)
}
const integrity = (bytes: Buffer): string => `sha512-${createHash('sha512').update(bytes).digest('base64')}`

/** The native packages of the fake registry: name to the system the lockfile lists and the program it holds. */
const NATIVES: Readonly<Record<string, { readonly system: NativeSystem, readonly program: string }>> = {
  '@vendor/tool-linux-x64': { system: { os: ['linux'], cpu: ['x64'], libc: ['glibc'] }, program: 'bin/tool' },
  '@vendor/tool-linux-arm64': { system: { os: ['linux'], cpu: ['arm64'], libc: ['glibc'] }, program: 'bin/tool' },
  '@vendor/tool-windows-x64': { system: { os: ['win32'], cpu: ['x64'] }, program: 'bin/tool.exe' },
}
const programBytes = (name: string): Buffer => Buffer.from(`native program of ${name}\n`)
const manifestOf = (name: string, version: string): string => JSON.stringify({ name, version })

/** The registry tarball of a native package, as npm packs it: its files under `package/`, the program executable. */
async function tarballOf(name: string): Promise<Buffer> {
  return (await buildPackArchive(`${name}.tgz`, [
    { path: 'package/LICENSE', mode: '0644', data: Buffer.from('MIT\n') },
    { path: `package/${NATIVES[name]!.program}`, mode: '0755', data: programBytes(name) },
    { path: 'package/package.json', mode: '0644', data: Buffer.from(manifestOf(name, '1.2.3')) },
  ], 1_800_000_000)).bytes
}
const TARBALLS = new Map(await Promise.all(Object.keys(NATIVES).map(async name => [name, await tarballOf(name)] as const)))

interface Deployed { readonly platform: RuntimePlatform, readonly also: readonly NativeSystem[] }

/**
 * A package manager that installs the launcher and the native packages whose system matches the platform or one of the
 * further systems, and a registry that serves the tarballs the lockfile pins.
 */
function sources(options: { readonly tamper?: (name: string, platform: RuntimePlatform) => { readonly program?: Buffer, readonly executable?: boolean, readonly version?: string, readonly missing?: boolean } | undefined, readonly served?: Buffer, readonly deployed?: Deployed[] } = {}): PackSources {
  const closure = temp()
  mkdirSync(join(closure, 'node_modules'), { recursive: true })
  const own: Readonly<Record<string, NativeSystem>> = {
    'linux-x64': { os: ['linux'], cpu: ['x64'] },
    'linux-arm64': { os: ['linux'], cpu: ['arm64'] },
    'win32-x64': { os: ['win32'], cpu: ['x64'] },
  }
  const installs = (system: NativeSystem, on: readonly NativeSystem[]): boolean => on.some(target => (system.os ?? []).every(os => target.os?.includes(os)) && (system.cpu ?? []).every(cpu => target.cpu?.includes(cpu)))
  return {
    closureNodeModules: () => join(closure, 'node_modules'),
    deploy: (_name, platform, directory, also) => {
      options.deployed?.push({ platform, also })
      put(directory, 'package.json', JSON.stringify({ name: '@delorun/bundle-tool', version: '1.0.0' }))
      put(directory, 'node_modules/@vendor/tool/package.json', manifestOf('@vendor/tool', '1.2.3'))
      put(directory, 'node_modules/@vendor/tool/cli.mjs', 'export {}\n')
      for (const [name, native] of Object.entries(NATIVES)) {
        if (!installs(native.system, [own[platform]!, ...also])) continue
        const tamper = options.tamper?.(name, platform)
        if (tamper?.missing === true) continue
        put(directory, `node_modules/${name}/LICENSE`, 'MIT\n')
        put(directory, `node_modules/${name}/package.json`, manifestOf(name, tamper?.version ?? '1.2.3'))
        put(directory, `node_modules/${name}/${native.program}`, tamper?.program ?? programBytes(name), tamper?.executable ?? true)
      }
      return Promise.resolve()
    },
    locked: (name): LockedPackage | undefined => {
      const native = NATIVES[name]
      return native === undefined ? undefined : { version: '1.2.3', integrity: integrity(TARBALLS.get(name)!), system: native.system }
    },
    download: (url) => {
      const name = Object.keys(NATIVES).find(each => url.includes(`/${each}/-/`))!
      return Promise.resolve(options.served ?? TARBALLS.get(name)!)
    },
    declaredPeers: () => Promise.resolve({}),
  }
}

const PLATFORMS: RuntimePlatform[] = ['linux-x64', 'linux-arm64']
/** As Use my browser declares it: the linux-x64 variant also carries the Windows copy that WSL runs on the Windows side. */
const DECLARED: PackNatives = {
  'linux-x64': ['@vendor/tool-linux-x64', '@vendor/tool-windows-x64'],
  'linux-arm64': ['@vendor/tool-linux-arm64'],
}
const build = (pack: PackSources, natives: PackNatives = DECLARED, platforms: RuntimePlatform[] = PLATFORMS) =>
  buildPack('@delorun/bundle-tool', '1.0.0', true, '0.1.0', platforms, 1_800_000_000, [], pack, temp(), natives)

describe('building a pack that carries native programs', () => {
  it('builds one variant per platform, each carrying its listed native packages with the program executable, and deploys the further systems the lockfile names', async () => {
    const deployed: Deployed[] = []
    const built = await build(sources({ deployed }))
    expect(Object.keys(built.entry.variants).sort()).toEqual(['linux-arm64', 'linux-x64'])
    const x64 = built.entry.variants['linux-x64']!.files
    expect(x64.filter(file => file.path.includes('/bin/')).map(file => [file.path, file.mode])).toEqual([
      ['node_modules/@vendor/tool-linux-x64/bin/tool', '0755'],
      ['node_modules/@vendor/tool-windows-x64/bin/tool.exe', '0755'],
    ])
    expect(built.entry.variants['linux-arm64']!.files.filter(file => file.path.includes('/bin/')).map(file => file.path)).toEqual(['node_modules/@vendor/tool-linux-arm64/bin/tool'])
    expect(built.entry.variants['linux-x64']!.external).toEqual([])
    expect(deployed).toEqual([
      { platform: 'linux-x64', also: [NATIVES['@vendor/tool-linux-x64']!.system, NATIVES['@vendor/tool-windows-x64']!.system] },
      { platform: 'linux-arm64', also: [NATIVES['@vendor/tool-linux-arm64']!.system] },
    ])
  })

  it('refuses a variant the deploy left without a listed native package', async () => {
    const pack = sources({ tamper: (name, platform) => (platform === 'linux-arm64' && name === '@vendor/tool-linux-arm64' ? { missing: true } : undefined) })
    await expect(build(pack)).rejects.toThrow('@delorun/bundle-tool for linux-arm64 does not carry @vendor/tool-linux-arm64, which packNatives lists; the deploy did not install it')
  })

  it('refuses a native program whose bytes differ from the tarball the lockfile pins', async () => {
    const pack = sources({ tamper: name => (name === '@vendor/tool-windows-x64' ? { program: Buffer.from('another program\n') } : undefined) })
    await expect(build(pack)).rejects.toThrow(/carries @vendor\/tool-windows-x64 files that differ from the registry tarball the lockfile pins .*: bin\/tool\.exe$/u)
  })

  it('refuses a native program that lost its executable bit', async () => {
    const pack = sources({ tamper: name => (name === '@vendor/tool-linux-x64' ? { executable: false } : undefined) })
    await expect(build(pack)).rejects.toThrow(/carries @vendor\/tool-linux-x64 files that differ .*: bin\/tool$/u)
  })

  it('refuses a native package at another version than the lockfile pins', async () => {
    const pack = sources({ tamper: name => (name === '@vendor/tool-linux-x64' ? { version: '1.2.4' } : undefined) })
    await expect(build(pack)).rejects.toThrow('carries @vendor/tool-linux-x64@1.2.4, but the lockfile pins 1.2.3')
  })

  it('refuses a registry that serves other bytes than the lockfile pins for a native package', async () => {
    await expect(build(sources({ served: Buffer.from('other') }))).rejects.toThrow(/does not match the lockfile's integrity/u)
  })

  it('refuses a declaration that lists no native packages for a release platform', async () => {
    await expect(build(sources(), { 'linux-x64': ['@vendor/tool-linux-x64'] })).rejects.toThrow('@delorun/bundle-tool lists packNatives but none for linux-arm64')
  })

  it('refuses a listed package the lockfile does not pin', async () => {
    await expect(build(sources(), { ...DECLARED, 'linux-arm64': ['@vendor/absent'] })).rejects.toThrow('the lockfile does not pin @vendor/absent, which packNatives lists for linux-arm64')
  })
})

describe('the deploy selection and the lockfile systems', () => {
  it('adds each further system\'s flags once, after the platform\'s own', () => {
    expect(deployTargets(['--os=linux', '--cpu=x64', '--libc=glibc'], [{ os: ['linux'], cpu: ['x64'], libc: ['glibc'] }, { os: ['win32'], cpu: ['x64'] }]))
      .toEqual(['--os=linux', '--cpu=x64', '--libc=glibc', '--os=win32'])
  })

  it('reads the systems a lockfile package installs on, and none for a package for any system', () => {
    const lock = "packages:\n  '@vendor/tool-windows-x64@1.2.3':\n    resolution: {integrity: sha512-AAAA}\n    cpu: [x64]\n    os: [win32]\n  '@vendor/tool@1.2.3':\n    resolution: {integrity: sha512-BBBB}\n"
    expect(lockedFrom(lock, '@vendor/tool-windows-x64')).toEqual({ version: '1.2.3', integrity: 'sha512-AAAA', system: { os: ['win32'], cpu: ['x64'] } })
    expect(lockedFrom(lock, '@vendor/tool')).toEqual({ version: '1.2.3', integrity: 'sha512-BBBB' })
  })

  it('validates a declaration: release platforms only, and package names', () => {
    expect(PackNatives.safeParse({ 'linux-x64': ['@vendor/tool-linux-x64'] }).success).toBe(true)
    expect(PackNatives.safeParse({ 'win32-arm64': ['@vendor/tool'] }).success).toBe(false)
    expect(PackNatives.safeParse({ 'linux-x64': ['../escape'] }).success).toBe(false)
    expect(PackNatives.safeParse({ 'linux-x64': [] }).success).toBe(false)
  })
})

describe('the Your own browser pack in the workspace', () => {
  const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
  const json = (path: string): { [key: string]: unknown } => JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as { [key: string]: unknown }
  const bundle = json('delorun/packages/bundle-real-browser/package.json') as { delorun: { packNatives: unknown } }
  const driver = json('delorun/packages/browser-use-browse/package.json') as { dependencies: Record<string, string> }
  const platforms = (json('delorun/apps/release/closure.json') as { platforms: RuntimePlatform[] }).platforms
  const lockfile = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')
  const OWN: Readonly<Record<RuntimePlatform, { readonly os: string, readonly cpu: string }>> = {
    'linux-x64': { os: 'linux', cpu: 'x64' }, 'linux-arm64': { os: 'linux', cpu: 'arm64' },
    'darwin-x64': { os: 'darwin', cpu: 'x64' }, 'darwin-arm64': { os: 'darwin', cpu: 'arm64' }, 'win32-x64': { os: 'win32', cpu: 'x64' },
  }

  it('carries browse\'s program for each release platform\'s own system, pinned with its integrity at the driver\'s browse version', () => {
    const natives = PackNatives.parse(bundle.delorun.packNatives)
    const version = driver.dependencies['@opencode/browse']
    expect(version).toMatch(/^\d+\.\d+\.\d+$/u)
    for (const platform of platforms) {
      const listed = natives[platform] ?? []
      const locked = listed.map(name => [name, lockedFrom(lockfile, name)] as const)
      for (const [name, pin] of locked) {
        expect(pin, `${platform}: ${name} is pinned in the lockfile`).toMatchObject({ version, integrity: expect.stringMatching(/^sha512-/u) })
      }
      const own = locked.filter(([, pin]) => pin?.system?.os?.includes(OWN[platform].os) === true && pin.system.cpu?.includes(OWN[platform].cpu) === true && pin.system.libc?.includes('musl') !== true)
      expect(own.map(([name]) => name), platform).toHaveLength(1)
    }
  })

  it('also carries the Windows program in the linux-x64 variant, for WSL with Chrome on Windows', () => {
    expect(PackNatives.parse(bundle.delorun.packNatives)['linux-x64']).toContain('@opencode/browse-windows-x64')
  })
})
