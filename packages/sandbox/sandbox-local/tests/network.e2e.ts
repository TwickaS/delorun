/**
 * The network rules under a real bwrap: a command whose network is `off` reaches no address outside its own
 * namespace, the host's loopback included, while the same command without a rule reaches it; a command whose network
 * is `proxy` reaches the proxy's Unix socket through the bridge on its own loopback port, with its proxy environment
 * set, and nothing else; the bridge keeps the command's exit status and standard input. Only local listeners are
 * used. Skips when bwrap or user namespaces are unavailable.
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxNetwork } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider, SANDBOX_PROXY_PORT } from '@deepseek-ai/dsh-sandbox-local'
import { bwrapProfileArgs } from '../src/profiles.ts'

const probe = spawnSync('bwrap', [...bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/', network: { mode: 'off' } }), '--', 'true'], { timeout: 5_000, stdio: 'ignore' })
const bwrapUsable = probe.status === 0

/** An IPv4 address of this host outside loopback, standing in for a public address; none on a host without one. */
const outsideAddress = Object.values(networkInterfaces()).flat().find(entry => entry?.family === 'IPv4' && !entry.internal)?.address

const servers: Server[] = []
const dirs: string[] = []
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A TCP listener that answers each connection with one line. */
async function lineServer(host: string): Promise<number> {
  const server = createServer(socket => socket.end('reached\n'))
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, host, resolve))
  return (server.address() as { port: number }).port
}

/** A fake proxy on a Unix socket: it answers the first line it reads with that line, prefixed, so a client sees the request arrive. */
async function echoProxy(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-proxy-e2e-'))
  dirs.push(dir)
  const socket = join(dir, 'proxy.sock')
  const server = createServer((client) => {
    client.once('data', (data) => { client.end(`proxy saw: ${data.toString().split('\r\n')[0] ?? ''}\n`) })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(socket, resolve))
  return socket
}

async function sandbox(): Promise<LocalSandboxProvider> {
  ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, {})
  return ctx.sandbox as LocalSandboxProvider
}

/** Run a Node program confined, without blocking this process's listeners. */
async function runConfined(program: string, network: SandboxNetwork | undefined, input = ''): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const confined = await (await sandbox()).confine([process.execPath, '-e', program], { mode: 'read-only', workspaceRoot: '/', ...network === undefined ? {} : { network } })
  return await new Promise((resolve) => {
    const child = spawn(confined.argv[0] as string, confined.argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 20_000)
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
    child.stdin.end(input)
  })
}

/** A program that connects to one address and prints what it read, or the error code. */
function connectProgram(host: string, port: number): string {
  return `const s = require('node:net').connect(${port}, ${JSON.stringify(host)}); let out = ''; s.on('data', d => { out += d }); s.on('end', () => { process.stdout.write(out) }); s.on('error', e => { process.stdout.write('error ' + e.code + '\\n') }); setTimeout(() => { process.stdout.write('timeout\\n'); process.exit(0) }, 5000).unref()`
}

describe.skipIf(!bwrapUsable)('sandbox-local: real bwrap network rules', () => {
  it('an `off` command cannot reach the host\'s loopback listener, which the same command reaches without a rule', async () => {
    const port = await lineServer('127.0.0.1')
    expect((await runConfined(connectProgram('127.0.0.1', port), undefined)).stdout).toBe('reached\n')
    const off = await runConfined(connectProgram('127.0.0.1', port), { mode: 'off' })
    expect(off.stdout).toBe('error ECONNREFUSED\n')
  })

  it.skipIf(outsideAddress === undefined)('an `off` command cannot reach an address outside loopback, which the same command reaches without a rule', async () => {
    const address = outsideAddress as string
    const port = await lineServer(address)
    expect((await runConfined(connectProgram(address, port), undefined)).stdout).toBe('reached\n')
    const off = await runConfined(connectProgram(address, port), { mode: 'off' })
    expect(off.stdout).toMatch(/^error (ENETUNREACH|EHOSTUNREACH|EACCES)\n$/u)
  })

  it('a `proxy` command reaches the proxy through its own loopback port, named in its proxy environment', async () => {
    const socket = await echoProxy()
    const program = `
      const env = process.env
      if (env.HTTPS_PROXY !== 'http://127.0.0.1:${SANDBOX_PROXY_PORT}' || env.http_proxy !== env.HTTPS_PROXY || env.NODE_USE_ENV_PROXY !== '1') { console.log('environment', JSON.stringify(env)); process.exit(3) }
      const s = require('node:net').connect(${SANDBOX_PROXY_PORT}, '127.0.0.1', () => s.write('CONNECT example.com:443 HTTP/1.1\\r\\n\\r\\n'))
      let out = ''; s.on('data', d => { out += d }); s.on('end', () => { process.stdout.write(out) }); s.on('error', e => { process.stdout.write('error ' + e.code + '\\n') })`
    const result = await runConfined(program, { mode: 'proxy', socket })
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe('proxy saw: CONNECT example.com:443 HTTP/1.1\n')
  })

  it('a `proxy` command reaches nothing but the proxy', async () => {
    const socket = await echoProxy()
    const port = await lineServer('127.0.0.1')
    const result = await runConfined(connectProgram('127.0.0.1', port), { mode: 'proxy', socket })
    expect(result.stdout).toBe('error ECONNREFUSED\n')
  })

  it('the bridge keeps the command\'s exit status and standard input, and does not keep the run alive', async () => {
    const socket = await echoProxy()
    const started = Date.now()
    const result = await runConfined('process.stdin.pipe(process.stdout); process.stdin.on(\'end\', () => process.exit(7))', { mode: 'proxy', socket }, 'from stdin\n')
    expect(result).toEqual({ status: 7, stdout: 'from stdin\n', stderr: '' })
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  it('a proxy socket missing at the wrap fails the runner before the command runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-proxy-e2e-'))
    dirs.push(dir)
    const socket = join(dir, 'gone.sock')
    const listening = createServer(() => {})
    await new Promise<void>(resolve => listening.listen(socket, resolve))
    await new Promise(resolve => listening.close(resolve))
    // bwrap cannot bind a socket that does not exist at the wrap: the runner fails before the command runs.
    const result = await runConfined('console.log("ran")', { mode: 'proxy', socket })
    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('bwrap: ')
  })
})
