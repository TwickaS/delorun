/**
 * The network rules of a confined execution through the real `confine()` path: bwrap's own network namespace for
 * `off` and `proxy`, the proxy environment and the socket's bind, the bridge in front of the caller's argv, and the
 * refusal on every runner that cannot express a network rule. Real bwrap runs in `network.e2e.ts`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { BRIDGE_DIAGNOSTIC, LocalSandboxProvider, NETWORK_DENIED_SOCKET_DIRECTORIES, NETWORK_DENIED_SOCKETS, PROXY_ENVIRONMENT, RUNNER_NETWORK, SANDBOX_PROXY_PORT } from '@deepseek-ai/dsh-sandbox-local'
import type { Config } from '@deepseek-ai/dsh-sandbox-local'
import { bridgedArgv, networkRefusal } from '../src/network.ts'
import { bwrapProfileArgs, NO_PROTECTION } from '../src/profiles.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fresh directory standing in for a protected home. */
function homeDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-network-home-'))
  dirs.push(dir)
  return dir
}

async function provider(config: Config = {}, internals: LocalSandboxProvider['internals'] = {}): Promise<LocalSandboxProvider> {
  const ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, config)
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = { vsockOffered: () => false, ...internals }
  return sandbox
}

const OFF: SandboxPolicy = { mode: 'read-only', workspaceRoot: '/ws', network: { mode: 'off' } }

describe('the runners that can confine a network', () => {
  it('is bwrap alone', () => {
    expect(RUNNER_NETWORK).toEqual({ bwrap: true, landlock: false, seatbelt: false, 'windows-acl': false })
  })
})

describe('bwrap network arguments', () => {
  it('adds nothing for a policy without a network, so the stock profile is unchanged', () => {
    expect(bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/ws' })).not.toContain('--unshare-net')
  })

  it('gives an `off` command a network namespace of its own and no proxy environment', () => {
    const args = bwrapProfileArgs(OFF)
    expect(args).toContain('--unshare-net')
    expect(args).not.toContain('--setenv')
  })

  it('gives a `proxy` command its own namespace, the proxy environment and a bind of the socket after every other mount', () => {
    const socket = '/run/proxy/list.sock'
    const args = bwrapProfileArgs({ mode: 'workspace-write', workspaceRoot: '/ws', network: { mode: 'proxy', socket } }, NO_PROTECTION)
    expect(args).toContain('--unshare-net')
    for (const [name, value] of Object.entries(PROXY_ENVIRONMENT)) {
      expect(args.join('\0')).toContain(['--setenv', name, value].join('\0'))
    }
    expect(PROXY_ENVIRONMENT['HTTPS_PROXY']).toBe(`http://127.0.0.1:${SANDBOX_PROXY_PORT}`)
    expect(args.slice(-3)).toEqual(['--bind', socket, socket])
  })

  it('binds a socket under the protected home inside the home\'s tmpfs, before it turns read-only', () => {
    const home = homeDirectory()
    const socket = join(home, 'secrets', 'proxy', 'list.sock')
    const args = bwrapProfileArgs(
      { mode: 'read-only', workspaceRoot: '/ws', network: { mode: 'proxy', socket } },
      { ...NO_PROTECTION, home },
    )
    const tmpfs = args.join('\0').indexOf(['--tmpfs', home].join('\0'))
    const bind = args.join('\0').indexOf(['--bind', socket, socket].join('\0'))
    const remount = args.join('\0').indexOf(['--remount-ro', home].join('\0'))
    expect(tmpfs).toBeGreaterThan(-1)
    expect(bind).toBeGreaterThan(tmpfs)
    expect(remount).toBeGreaterThan(bind)
    expect(args.filter(arg => arg === '--bind')).toHaveLength(1)
  })

  it('binds a socket outside the protected home after the home\'s mounts', () => {
    const home = homeDirectory()
    const socket = '/run/proxy/list.sock'
    const args = bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/ws', network: { mode: 'proxy', socket } }, { ...NO_PROTECTION, home })
    expect(args.slice(-3)).toEqual(['--bind', socket, socket])
  })
})

describe('the bridge in front of a `proxy` command', () => {
  it('starts the bridge with the given Node executable, then replaces the shell with the caller\'s argv', () => {
    const argv = bridgedArgv('/s.sock', ['bash', '-c', 'curl https://example.com'], '/opt/node')
    expect(argv.slice(0, 2)).toEqual(['/bin/sh', '-c'])
    expect(argv[2]).toContain('exec "$@"')
    expect(argv.slice(3, 5)).toEqual(['sh', '/opt/node'])
    expect(argv.slice(6)).toEqual(['/s.sock', String(SANDBOX_PROXY_PORT), 'bash', '-c', 'curl https://example.com'])
  })

  it('runs under the host\'s own Node executable by default', () => {
    expect(bridgedArgv('/s.sock', ['true'])[4]).toBe(process.execPath)
  })
})

describe('confine() with a network', () => {
  it('wraps a `proxy` command behind the bridge under bwrap and classifies the bridge\'s failure as the runner\'s', async () => {
    const sandbox = await provider({}, { chain: ['bwrap'] })
    const policy: SandboxPolicy = { mode: 'read-only', workspaceRoot: '/', network: { mode: 'proxy', socket: '/run/p.sock' } }
    const confined = await sandbox.confine(['bash', '-c', 'true'], policy)
    const separator = confined.argv.indexOf('--')
    expect(confined.argv.slice(0, separator)).toContain('--unshare-net')
    expect(confined.argv.slice(separator + 1)).toEqual(bridgedArgv('/run/p.sock', ['bash', '-c', 'true']))
    expect(confined.runnerFailureRules).toEqual([{ fatalSignatures: ['bwrap: '] }, { fatalSignatures: [BRIDGE_DIAGNOSTIC] }])
  })

  it('wraps an `off` command with no bridge and bwrap\'s own failure rule only', async () => {
    const sandbox = await provider({}, { chain: ['bwrap'] })
    const confined = await sandbox.confine(['true'], { ...OFF, workspaceRoot: '/' })
    expect(confined.argv).toContain('--unshare-net')
    expect(confined.argv.slice(confined.argv.indexOf('--') + 1)).toEqual(['true'])
    expect(confined.runnerFailureRules).toEqual([{ fatalSignatures: ['bwrap: '] }])
  })

  it('appends the same arguments and bridge to a configured runner, with the bridge\'s failure rule after the operator\'s', async () => {
    const sandbox = await provider({ runnerCommand: ['my-runner'], runnerFailureSignatures: ['my-runner: '] })
    const confined = await sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: '/', network: { mode: 'proxy', socket: '/run/p.sock' } })
    expect(confined.argv[0]).toBe('my-runner')
    expect(confined.argv).toContain('--unshare-net')
    expect(confined.argv.slice(confined.argv.indexOf('--') + 1)).toEqual(bridgedArgv('/run/p.sock', ['true']))
    expect(confined.runnerFailureRules).toEqual([{ fatalSignatures: ['my-runner: '] }, { fatalSignatures: [BRIDGE_DIAGNOSTIC] }])
  })

  const refusingRunners: readonly (readonly [string, LocalSandboxProvider['internals'], string])[] = [
    ['landlock', { chain: ['landlock'], landlockLauncher: '/nonexistent/landlock-run' }, 'install bubblewrap'],
    ['seatbelt', { chain: ['seatbelt'], probeSeatbelt: () => true }, 'not built for the macOS sandbox'],
    ['windows-acl', { platform: 'win32', windowsAclRunnerArgs: ['acl-runner'] }, 'no per-command network rule'],
  ]
  it.each(refusingRunners)('refuses an `off` or `proxy` policy on %s instead of running with the host\'s network', async (runner, internals, fix) => {
    const sandbox = await provider({}, internals)
    for (const network of [{ mode: 'off' as const }, { mode: 'proxy' as const, socket: '/run/p.sock' }]) {
      const policy: SandboxPolicy = { mode: 'read-only', workspaceRoot: '/', network }
      await expect(sandbox.confine(['true'], policy)).rejects.toMatchObject({ code: 'SANDBOX_UNSUPPORTED_POLICY', message: expect.stringContaining(fix) as string })
      await expect(sandbox.confine(['true'], policy)).rejects.toThrow(`the ${runner} sandbox cannot enforce`)
    }
    // Without a network rule the same runner wraps as before.
    await expect(sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: '/' })).resolves.toBeDefined()
  })

  it('hides the network-denied sockets and directories from a restricted command only', async () => {
    const dir = homeDirectory()
    const socket = join(dir, 'system_bus_socket')
    writeFileSync(socket, '')
    const resolver = join(dir, 'resolve')
    mkdirSync(resolver)
    const absent = join(dir, 'absent.sock')
    const config: Config = { networkDeniedSockets: [socket, absent], networkDeniedSocketDirectories: [resolver, join(dir, 'absent')] }
    for (const sandbox of [await provider(config, { chain: ['bwrap'] }), await provider({ ...config, runnerCommand: ['my-runner'], runnerFailureSignatures: ['my-runner: '] })]) {
      for (const network of [{ mode: 'off' as const }, { mode: 'proxy' as const, socket: '/run/p.sock' }]) {
        const argv = (await sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: '/', network })).argv.join(' ')
        expect(argv).toContain(`--ro-bind /dev/null ${socket}`)
        expect(argv).toContain(`--tmpfs ${resolver} --remount-ro ${resolver}`)
        expect(argv).not.toContain('absent')
      }
      const open = (await sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: '/' })).argv
      expect(open).not.toContain(socket)
      expect(open).not.toContain(resolver)
    }
  })

  it('denies systemd-resolved, nscd, avahi, the system D-Bus and tailscaled by default, and rejects a relative entry', async () => {
    expect(LocalSandboxProvider.Config({}).networkDeniedSockets).toEqual([...NETWORK_DENIED_SOCKETS])
    expect(LocalSandboxProvider.Config({}).networkDeniedSocketDirectories).toEqual([...NETWORK_DENIED_SOCKET_DIRECTORIES])
    expect(NETWORK_DENIED_SOCKETS).toEqual(['/run/dbus/system_bus_socket', '/run/tailscale/tailscaled.sock'])
    expect(NETWORK_DENIED_SOCKET_DIRECTORIES).toEqual(['/run/systemd/resolve', '/run/nscd', '/run/avahi-daemon'])
    await expect(provider({ networkDeniedSockets: ['run/x.sock'] })).rejects.toThrow('networkDeniedSockets entries must be absolute paths')
    await expect(provider({ networkDeniedSocketDirectories: ['run/nscd'] })).rejects.toThrow('networkDeniedSocketDirectories entries must be absolute paths')
    await expect(provider({ networkDeniedSocketDirectories: ['/'] })).rejects.toThrow('networkDeniedSocketDirectories entries must be absolute paths other than the filesystem root')
  })

  it('names what the policy asked for in the refusal', () => {
    expect(networkRefusal('landlock', { mode: 'off' })).toContain('asks for no network')
    expect(networkRefusal('landlock', { mode: 'proxy', socket: '/s' })).toContain('asks for network through a proxy only')
  })
})
