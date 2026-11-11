/**
 * Denial tests of a workspace's network under a real bwrap, end to end: the policy `ctx.sandboxPolicy` resolves for a
 * chat carries the workspace's network, `ctx.sandbox` wraps a real Node command with it, and the command runs.
 *
 * - `network-off-denied`: a command of an `off` workspace reaches neither a listener on this machine nor any proxy.
 * - `network-allowlist-proxy`: a command of an `allowlist` workspace fetches a listed host through the proxy, by its
 *   proxy environment and by `CONNECT`, and is refused an unlisted one, which the proxy never looks up.
 * - `network-dns-closed`: the command itself cannot resolve a name, so DNS carries nothing out, and cannot connect to a
 *   daemon that resolves names or sends traffic for it: systemd-resolved's varlink socket, the system D-Bus, nscd,
 *   avahi and tailscaled. Each socket this machine lacks is skipped; the others are connected to only to be refused.
 * - `network-private-refused`: a listed name that resolves to a private address is refused.
 * - `network-lists-separate`: a command sees only its own list's proxy socket.
 *
 * The proxy's resolver and dialer map documentation addresses to a local listener, so nothing leaves the machine.
 * Skips when bwrap or user namespaces are unavailable.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import LocalSandboxProvider, { SANDBOX_PROXY_PORT } from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { CommandNetwork } from '../src/command-network.ts'

const bwrapUsable = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--unshare-net', '--', 'true'], { timeout: 5_000, stdio: 'ignore' }).status === 0

const originalHome = process.env['DELO_HOME']
let root = ''
let ctx: Context | undefined
let server: Server | undefined
let lookups: string[] = []

beforeEach(() => {
  // A short prefix: the proxy's socket path under the home must stay within 107 bytes under the check runner's TMPDIR.
  root = mkdtempSync(join(tmpdir(), 'deg-'))
  lookups = []
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (server !== undefined) await new Promise(resolve => server?.close(resolve))
  server = undefined
  rmSync(root, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env['DELO_HOME']
  else process.env['DELO_HOME'] = originalHome
})

interface Composition {
  readonly network: CommandNetwork
  readonly policyFor: (cwd: string) => SandboxPolicy
  readonly sandbox: LocalSandboxProvider
  readonly work: string
  readonly other: string
  readonly port: number
}

/**
 * The confinement of Delo's CLI profile in small: a protected home, the sandbox policy, the local sandbox provider and
 * the network service, with a local listener standing in for every public host.
 */
async function composition(): Promise<Composition> {
  const home = join(root, 'home')
  const work = join(root, 'work')
  const other = join(root, 'other')
  for (const directory of [home, work, other]) mkdirSync(directory, { recursive: true, mode: 0o700 })
  process.env['DELO_HOME'] = home
  server = createServer((request, response) => { response.end(`reached ${request.headers.host ?? ''}`) })
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: work })
  await ctx.plugin(LocalSandboxProvider, { protectedHome: home })
  await ctx.plugin(CommandNetwork, { defaultNetwork: { access: 'open', hosts: [] }, proxyConnectTimeoutMs: 2_000, proxyMaxConnections: 16, proxyIdleTimeoutMs: 60_000 })
  const network = ctx.deloCommandNetwork
  const names: Record<string, string> = { 'allowed.example': '203.0.113.10', 'private.example': '10.0.0.1', 'other.example': '203.0.113.20' }
  network.internals = {
    resolve: (host) => {
      lookups.push(host)
      const address = names[host]
      return address === undefined ? Promise.reject(new Error('no answer')) : Promise.resolve([{ address, family: 4 }])
    },
    dial: address => connect({ host: '127.0.0.1', port: address.startsWith('203.0.113.') ? port : 1 }),
  }
  const sessions = ctx
  const policyFor = (cwd: string): SandboxPolicy => {
    const id = SessionId(`s-${cwd.length}-${cwd.at(-1) ?? ''}`)
    const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, cwd })
    const policy = sessions.sandboxPolicy.resolve({ session })
    return { ...policy, mode: 'read-only' }
  }
  return { network, policyFor, sandbox: ctx.sandbox as LocalSandboxProvider, work, other, port }
}

/** Run a Node program confined under `policy`, without blocking this process's proxy. */
async function run(sandbox: LocalSandboxProvider, policy: SandboxPolicy, program: string): Promise<{ status: number | null, stdout: string, stderr: string }> {
  const confined = await sandbox.confine([process.execPath, '-e', program], policy)
  return await new Promise((resolve) => {
    const child = spawn(confined.argv[0] as string, confined.argv.slice(1), { cwd: policy.workspaceRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 30_000)
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
  })
}

/** A program that connects to one TCP address and prints what it read, or the error's code. */
const tcp = (host: string, port: number): string => `const s = require('node:net').connect(${port}, ${JSON.stringify(host)}); let out = ''; s.on('data', d => { out += d }); s.on('end', () => console.log(out)); s.on('error', e => console.log('error ' + e.code))`

/** A program that connects to one Unix socket and prints `connected` or the error's code. */
const unix = (path: string): string => `require('node:net').connect(${JSON.stringify(path)}).on('connect', function () { console.log('connected'); this.destroy() }).on('error', e => console.log('error ' + e.code))`

/** The sockets of daemons that resolve names or send traffic for a command, at their usual paths on Linux. */
const RESOLVER_SOCKETS = [
  '/run/systemd/resolve/io.systemd.Resolve',
  '/run/dbus/system_bus_socket',
  '/run/nscd/socket',
  '/run/avahi-daemon/socket',
  '/run/tailscale/tailscaled.sock',
]

/** A program that sends one request to the bridge's port, then a plain GET through the tunnel when it opens. */
const tunnel = (host: string): string => `
  const s = require('node:net').connect(${SANDBOX_PROXY_PORT}, '127.0.0.1', () => s.write('CONNECT ${host}:443 HTTP/1.1\\r\\nHost: ${host}:443\\r\\n\\r\\n'))
  let out = ''; let sent = false
  s.on('data', (d) => { out += d; if (!sent && out.startsWith('HTTP/1.1 200')) { sent = true; s.write('GET / HTTP/1.0\\r\\nHost: ${host}\\r\\n\\r\\n') } })
  s.on('end', () => console.log(JSON.stringify(out))); s.on('error', e => console.log('error ' + e.code))`

describe.skipIf(!bwrapUsable)('a workspace\'s network under a real bwrap', () => {
  it('network-off-denied: an `off` command reaches no listener on this machine and no proxy', async () => {
    const { network, policyFor, sandbox, work, other, port } = await composition()
    await network.set(other, { access: 'allowlist', hosts: ['allowed.example'] }, true)
    await network.set(work, { access: 'off', hosts: [] }, false)
    const policy = policyFor(work)
    expect(policy.network).toEqual({ mode: 'off' })
    expect((await run(sandbox, policyFor(other), tcp('127.0.0.1', port))).stdout).toBe('error ECONNREFUSED\n')
    expect((await run(sandbox, policy, tcp('127.0.0.1', port))).stdout).toBe('error ECONNREFUSED\n')
    expect((await run(sandbox, policy, tcp('127.0.0.1', SANDBOX_PROXY_PORT))).stdout).toBe('error ECONNREFUSED\n')
    const socket = policyFor(other).network
    expect(socket?.mode).toBe('proxy')
    expect((await run(sandbox, policy, unix(socket?.mode === 'proxy' ? socket.socket : ''))).stdout).toBe('error ENOENT\n')
  })

  it('network-allowlist-proxy: an allowlist command fetches a listed host through the proxy and is refused another', async () => {
    const { network, policyFor, sandbox, work } = await composition()
    await network.set(work, { access: 'allowlist', hosts: ['allowed.example'] }, true)
    const policy = policyFor(work)
    // Node's own client honours the proxy environment the wrap sets.
    const fetched = await run(sandbox, policy, 'fetch(\'http://allowed.example/\').then(r => r.text()).then(t => console.log(t), e => console.log(\'error \' + (e.cause?.code ?? e.message)))')
    expect(fetched.stdout).toBe('reached allowed.example\n')
    const tunnelled = await run(sandbox, policy, tunnel('allowed.example'))
    expect(JSON.parse(tunnelled.stdout) as string).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\nHTTP\/1\.1 200 OK[\s\S]*reached allowed\.example$/u)
    const refused = await run(sandbox, policy, tunnel('other.example'))
    expect(JSON.parse(refused.stdout) as string).toMatch(/^HTTP\/1\.1 403 Host not on this workspace's network allowlist\r\n/u)
    expect(lookups).toEqual(['allowed.example', 'allowed.example'])
  })

  it('network-dns-closed: a confined command cannot resolve a name itself, and an unlisted name is never looked up', async () => {
    const { network, policyFor, sandbox, work } = await composition()
    await network.set(work, { access: 'allowlist', hosts: ['allowed.example'] }, true)
    const resolved = await run(sandbox, policyFor(work), 'require(\'node:dns\').resolve4(\'secret-data.other.example\', (e, a) => console.log(e ? \'error\' : \'resolved \' + a))')
    expect(resolved.stdout).toBe('error\n')
    await run(sandbox, policyFor(work), tunnel('secret-data.other.example'))
    expect(lookups).toEqual([])
    const present = RESOLVER_SOCKETS.filter(path => existsSync(path))
    for (const path of present) {
      expect((await run(sandbox, policyFor(work), unix(path))).stdout, path).toMatch(/^error E[A-Z]+\n$/u)
    }
  })

  it('network-private-refused: a listed name that resolves to a private address is refused', async () => {
    const { network, policyFor, sandbox, work } = await composition()
    await network.set(work, { access: 'allowlist', hosts: ['private.example'] }, true)
    const refused = await run(sandbox, policyFor(work), tunnel('private.example'))
    expect(JSON.parse(refused.stdout) as string).toMatch(/^HTTP\/1\.1 403 Host resolves to a refused address\r\n[\s\S]*a private address/u)
    expect(lookups).toEqual(['private.example'])
  })

  it('network-lists-separate: a command reaches its own list\'s proxy socket and not another list\'s', async () => {
    const { network, policyFor, sandbox, work, other } = await composition()
    await network.set(work, { access: 'allowlist', hosts: ['allowed.example'] }, true)
    await network.set(other, { access: 'allowlist', hosts: ['other.example'] }, true)
    const own = policyFor(work).network
    const foreign = policyFor(other).network
    if (own?.mode !== 'proxy' || foreign?.mode !== 'proxy') throw new Error('both workspaces resolve to a proxy')
    expect(own.socket).not.toBe(foreign.socket)
    expect((await run(sandbox, policyFor(work), unix(own.socket))).stdout).toBe('connected\n')
    expect((await run(sandbox, policyFor(work), unix(foreign.socket))).stdout).toBe('error ENOENT\n')
  })
})
