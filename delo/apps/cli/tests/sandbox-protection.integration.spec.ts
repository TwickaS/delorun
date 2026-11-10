/**
 * The provider settings the home process gives the CLI profile's sandbox: the canonical home, C1's read exemptions,
 * both channels' sockets, the Docker context's socket with its real path, Docker Desktop's macOS sockets when
 * present, and WSL's interop directory as an escape directory; and the overlay that composes over every layer of the
 * row (bundle layers, the profile's patch, the home's patch, the start's other overlays), carries over the composed
 * plain settings and every layer's denied sockets and escape directories, and refuses a runner any layer sets and
 * expressions it cannot carry over.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadOptionalPatches, loadOverlayPatches, type Profile } from '@deepseek-ai/dsh-app-boot'
import { homePatchPath } from '@deepseek-ai/dsh/profile-boot'
import { READ_EXEMPTIONS } from '@delo/contract-home-layout'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { applyLaunchEnvironment } from '../src/launch-environment.ts'
import { homePatchFile } from '../src/patch-layers.ts'
import { DOCKER_DESKTOP_SOCKETS, removeSandboxOverlay, sandboxOverlayPath, sandboxProtection, WSL_INTEROP_DIRECTORIES, writeSandboxOverlay, type SandboxProtection } from '../src/sandbox-protection.ts'

let base: string | undefined
const servers: Server[] = []
const launchEnvironment = { ...process.env }
afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in launchEnvironment)) Reflect.deleteProperty(process.env, key)
  Object.assign(process.env, launchEnvironment)
  for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve))
  if (base !== undefined) rmSync(base, { recursive: true, force: true })
  base = undefined
})

async function listen(path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  const server = createServer()
  servers.push(server)
  await new Promise<void>(resolve => server.listen(path, resolve))
}

function setUp(): { readonly home: string, readonly osHome: string } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dsp-')))
  const home = join(base, 'h')
  mkdirSync(join(home, 'run', 'default'), { recursive: true })
  return { home, osHome: join(base, 'u') }
}

describe('the CLI profile\'s sandbox protection', () => {
  it('names the canonical home, C1\'s read exemptions, both channel sockets and the Docker context\'s socket with its real path', async () => {
    const { home, osHome } = setUp()
    const engine = join(base ?? '', 'engine', 'docker.sock')
    await listen(engine)
    const link = join(base ?? '', 'docker.sock')
    symlinkSync(engine, link)
    const linkedHome = join(base ?? '', 'linked-home')
    symlinkSync(home, linkedHome)
    const protection = await sandboxProtection(linkedHome, 'default', { DOCKER_HOST: `unix://${link}`, DOCKER_CONFIG: join(base ?? '', 'no-config') }, osHome)
    expect(protection).toEqual({
      protectedHome: home,
      protectedHomeReadable: [...READ_EXEMPTIONS],
      deniedSockets: [join(home, 'run', 'default', 'update.sock'), join(home, 'run', 'default', 'supervisor.sock'), link, engine],
      escapeSocketDirectories: ['/run/WSL'],
    })
  })

  it('names WSL\'s interop directory as an escape directory on every machine, for the provider to check at each wrap', async () => {
    const { home, osHome } = setUp()
    const env = { DOCKER_CONFIG: join(base ?? '', 'no-config'), DOCKER_HOST: 'tcp://127.0.0.1:2375' }
    expect(WSL_INTEROP_DIRECTORIES).toEqual(['/run/WSL'])
    expect((await sandboxProtection(home, 'default', env, osHome)).escapeSocketDirectories).toEqual(['/run/WSL'])
  })

  it('adds Docker Desktop\'s macOS sockets that exist, each with its real path, and none that do not', async () => {
    const { home, osHome } = setUp()
    const [raw, plain, run] = DOCKER_DESKTOP_SOCKETS
    await listen(join(osHome, raw))
    await listen(join(base ?? '', 'vm', 'docker.sock'))
    mkdirSync(dirname(join(osHome, run)), { recursive: true })
    symlinkSync(join(base ?? '', 'vm', 'docker.sock'), join(osHome, run))
    const { deniedSockets } = await sandboxProtection(home, 'default', { DOCKER_CONFIG: join(base ?? '', 'no-config'), DOCKER_HOST: 'tcp://127.0.0.1:2375' }, osHome)
    expect(deniedSockets).toEqual([
      join(home, 'run', 'default', 'update.sock'),
      join(home, 'run', 'default', 'supervisor.sock'),
      join(osHome, raw),
      join(osHome, run),
      join(base ?? '', 'vm', 'docker.sock'),
    ])
    expect(deniedSockets).not.toContain(join(osHome, plain))
  })

  it('denies a configured Docker socket that does not exist yet by its path, and none without a usable context', async () => {
    const { home, osHome } = setUp()
    const absent = join(base ?? '', 'absent', 'docker.sock')
    const channels = [join(home, 'run', 'default', 'update.sock'), join(home, 'run', 'default', 'supervisor.sock')]
    expect((await sandboxProtection(home, 'default', { DOCKER_HOST: `unix://${absent}` }, osHome)).deniedSockets).toEqual([...channels, absent])
    const noContext = { DOCKER_CONTEXT: 'missing', DOCKER_CONFIG: join(base ?? '', 'no-config') }
    expect((await sandboxProtection(home, 'default', noContext, osHome)).deniedSockets).toEqual(channels)
  })

  it('removes the overlay, an absent one included, and reports any other failure', async () => {
    const { home } = setUp()
    const path = sandboxOverlayPath(home, 'default')
    writeFileSync(path, '[]\n')
    await removeSandboxOverlay(home, 'default')
    expect(existsSync(path)).toBe(false)
    await expect(removeSandboxOverlay(home, 'default')).resolves.toBeUndefined()
    mkdirSync(path)
    await expect(removeSandboxOverlay(home, 'default')).rejects.toThrow(/EISDIR|EPERM/)
  })

  /** The upstream base bundle's bare row and Delo's bundle layer, whose `protectedHome` is an expression the overlay replaces. */
  const BUNDLES = [
    ['@deepseek-ai/dsh-base', "- insert:\n    - id: sandbox\n      name: '@deepseek-ai/dsh-sandbox-local'\n"],
    ['@delo/bundle-local', '- id: sandbox\n  config:\n    protectedHome: !!js dshHomePath()\n    protectedHomeReadable: [runtimes]\n'],
  ] as const

  /**
   * A profile as upstream's loader returns it: bundle layers parsed from their files, then the profile's own patch.
   * @param bundles - each bundle's name and patch text, in order.
   * @param own - the profile's `cordis.patch.yml`, or none.
   * @returns the profile.
   */
  function profileOf(bundles: ReadonlyArray<readonly [string, string]>, own?: string): Profile {
    const dir = join(base ?? '', 'h', 'profiles', 'default')
    mkdirSync(dir, { recursive: true })
    const patchPath = join(dir, 'cordis.patch.yml')
    if (own === undefined) rmSync(patchPath, { force: true })
    else writeFileSync(patchPath, own)
    const layers = bundles.map(([packageName, text], index) => {
      const file = join(base ?? '', `bundle-${String(index)}.patch.yml`)
      writeFileSync(file, text)
      return { packageName, packageDir: dirname(file), patchPaths: [file], patches: loadOverlayPatches('test', file) }
    })
    return { name: 'default', dir, layers, patchPath, patches: loadOptionalPatches('test', patchPath) ?? [], skippedBundles: [] }
  }

  async function protectionFor(home: string, osHome: string): Promise<SandboxProtection> {
    return sandboxProtection(home, 'default', { DOCKER_CONFIG: join(base ?? '', 'no-config'), DOCKER_HOST: 'tcp://127.0.0.1:2375' }, osHome)
  }

  async function overlayConfig(path: string): Promise<Record<string, unknown>> {
    const [entry] = parse(readFileSync(path, 'utf8')) as [{ id: string, config: Record<string, unknown> }]
    expect(entry.id).toBe('sandbox')
    return entry.config
  }

  it('reads the home patch where upstream reads it under the CLI\'s launch environment', () => {
    const { home } = setUp()
    applyLaunchEnvironment(home, 'default')
    expect(homePatchFile(home)).toBe(homePatchPath())
  })

  it('replaces Delo\'s keys of the bundle layers and writes only the protection when no layer configures the row further', async () => {
    const { home, osHome } = setUp()
    const protection = await protectionFor(home, osHome)
    const overlay = await writeSandboxOverlay(home, 'default', profileOf(BUNDLES), [], protection)
    expect(await overlayConfig(overlay)).toEqual({ protectedHome: home, protectedHomeReadable: [...READ_EXEMPTIONS], deniedSockets: protection.deniedSockets, escapeSocketDirectories: protection.escapeSocketDirectories })
    // The base bundle's bare row alone has no config to carry over.
    const bare = await writeSandboxOverlay(home, 'default', profileOf([BUNDLES[0]]), [], protection)
    expect(await overlayConfig(bare)).toEqual({ protectedHome: home, protectedHomeReadable: [...READ_EXEMPTIONS], deniedSockets: protection.deniedSockets, escapeSocketDirectories: protection.escapeSocketDirectories })
  })

  it('carries over the composed settings, which the last layer that sets the row\'s config gives, and keeps every layer\'s denied sockets', async () => {
    const { home, osHome } = setUp()
    const protection = await protectionFor(home, osHome)
    // The row sits in a group here, and an earlier bundle's expression and scalar configs are replaced by later layers.
    const grouped = ['@example/grouped', "- insert:\n    - id: tools\n      name: group\n      group: true\n      config:\n        - id: sandbox\n          name: '@deepseek-ai/dsh-sandbox-local'\n          config:\n            deniedSockets: [/group.sock]\n"] as const
    const replaced = ['@example/replaced', '- id: sandbox\n  config: !!js process.env.SANDBOX_CONFIG\n- id: sandbox\n  config: 5\n'] as const
    const profile = profileOf([grouped, replaced, BUNDLES[1]], '- id: sandbox\n  config:\n    deniedSockets: [/profile.sock]\n    extra: 1\n')
    writeFileSync(homePatchFile(home), '- id: sandbox\n  config:\n    deniedSockets: [/home.sock, 7]\n    probeTimeoutMs: 5000\n')
    const extra = join(base ?? '', 'extra.patch.yml')
    writeFileSync(extra, '- id: other\n  disabled: true\n')
    const overlay = await writeSandboxOverlay(home, 'default', profile, [extra], protection)
    // `extra` comes from the profile's patch, whose config the home patch replaces whole, as upstream composes it.
    expect(await overlayConfig(overlay)).toEqual({
      deniedSockets: ['/group.sock', '/profile.sock', '/home.sock', ...protection.deniedSockets],
      escapeSocketDirectories: protection.escapeSocketDirectories,
      probeTimeoutMs: 5000,
      protectedHome: home,
      protectedHomeReadable: [...READ_EXEMPTIONS],
    })
    // Without the home patch the profile's own config is the composed one.
    rmSync(homePatchFile(home))
    expect(await overlayConfig(await writeSandboxOverlay(home, 'default', profile, [], protection))).toEqual({
      deniedSockets: ['/group.sock', '/profile.sock', ...protection.deniedSockets],
      escapeSocketDirectories: protection.escapeSocketDirectories,
      extra: 1,
      protectedHome: home,
      protectedHomeReadable: [...READ_EXEMPTIONS],
    })
  })

  it('keeps every layer\'s escape directories beside WSL\'s interop directory', async () => {
    const { home, osHome } = setUp()
    const protection = await protectionFor(home, osHome)
    const profile = profileOf(BUNDLES, '- id: sandbox\n  config:\n    escapeSocketDirectories: [/elsewhere, /run/WSL]\n')
    expect((await overlayConfig(await writeSandboxOverlay(home, 'default', profile, [], protection))).escapeSocketDirectories).toEqual(['/elsewhere', '/run/WSL'])
  })

  it('refuses composed settings with expressions it cannot carry over, naming the layer', async () => {
    const { home, osHome } = setUp()
    const protection = await protectionFor(home, osHome)
    const profile = profileOf(BUNDLES, '- id: sandbox\n  config:\n    deniedSockets: !!js process.env.DENIED\n')
    await expect(writeSandboxOverlay(home, 'default', profile, [], protection)).rejects.toThrow(`delorun: the sandbox row is configured with expressions (in ${profile.patchPath}); Delo adds its home protection to that row at start and can carry over plain values only`)
    writeFileSync(homePatchFile(home), '- id: sandbox\n  config: !!js process.env.SANDBOX_CONFIG\n')
    await expect(writeSandboxOverlay(home, 'default', profileOf(BUNDLES), [], protection)).rejects.toThrow(`with expressions (in ${homePatchFile(home)})`)
    writeFileSync(homePatchFile(home), '- id: sandbox\n  config: 5\n')
    await expect(writeSandboxOverlay(home, 'default', profileOf(BUNDLES), [], protection)).rejects.toThrow(`with expressions (in ${homePatchFile(home)})`)
  })

  it('refuses a runner the profile\'s own patch sets, naming the key and the file', async () => {
    const { home, osHome } = setUp()
    const protection = await protectionFor(home, osHome)
    const profile = profileOf(BUNDLES, '- id: sandbox\n  config:\n    runnerCommand: [/my-runner, --wrap]\n')
    await expect(writeSandboxOverlay(home, 'default', profile, [], protection)).rejects.toThrow(`delorun: the sandbox row sets the runner itself (runnerCommand in ${profile.patchPath}); Delo's home protection requires the provider's built-in runner selection, so remove runnerCommand from that row in each file named`)
  })

  it('refuses a runner the home patch sets over every profile, for either runner key', async () => {
    const { home, osHome } = setUp()
    const protection = await protectionFor(home, osHome)
    applyLaunchEnvironment(home, 'default')
    writeFileSync(homePatchFile(home), '- id: sandbox\n  config:\n    runnerCommand: [/my-runner]\n')
    await expect(writeSandboxOverlay(home, 'default', profileOf(BUNDLES), [], protection)).rejects.toThrow(`(runnerCommand in ${homePatchPath()})`)
    writeFileSync(homePatchFile(home), '- id: sandbox\n  config:\n    runnerFailureSignatures: [refused]\n')
    await expect(writeSandboxOverlay(home, 'default', profileOf(BUNDLES), [], protection)).rejects.toThrow(`(runnerFailureSignatures in ${homePatchPath()})`)
  })

  it('refuses a runner a bundle layer sets, even when a later layer replaces the row\'s config', async () => {
    const { home, osHome } = setUp()
    const protection = await protectionFor(home, osHome)
    const runner = ['@example/runner', '- id: sandbox\n  config:\n    runnerCommand: [/my-runner]\n    runnerFailureSignatures: [refused]\n'] as const
    const profile = profileOf([BUNDLES[0], runner, BUNDLES[1]], '- id: sandbox\n  config:\n    probeTimeoutMs: 5000\n')
    const source = `the bundle @example/runner (${profile.layers[1]?.patchPaths[0] ?? ''})`
    await expect(writeSandboxOverlay(home, 'default', profile, [], protection)).rejects.toThrow(`(runnerCommand in ${source}; runnerFailureSignatures in ${source}); Delo's home protection requires the provider's built-in runner selection, so remove runnerCommand and runnerFailureSignatures from that row`)
  })

  it('refuses a runner an overlay the start passes before its own sets, such as safe mode\'s', async () => {
    const { home, osHome } = setUp()
    const protection = await protectionFor(home, osHome)
    const extra = join(base ?? '', 'run-extra.patch.yml')
    writeFileSync(extra, '- id: sandbox\n  config:\n    runnerCommand: [/my-runner]\n')
    await expect(writeSandboxOverlay(home, 'default', profileOf(BUNDLES), [extra], protection)).rejects.toThrow(`(runnerCommand in ${extra})`)
  })
})
