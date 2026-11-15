/**
 * The abstract Unix socket check against the real kernel table and a real bwrap: a listener this test owns makes an
 * open-network wrap refuse and name it, the same listener is reachable from a command that was allowed to run with the
 * risk accepted, and an `off` command cannot reach it. Linux only; on a Linux CI host without a usable bwrap the
 * suite fails instead of skipping.
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { bwrapProfileArgs } from '../src/profiles.ts'

const linux = process.platform === 'linux'
const probe = linux
  ? spawnSync('bwrap', [...bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/', network: { mode: 'off' } }), '--', 'true'], { timeout: 5_000, stdio: 'ignore' })
  : undefined
const bwrapUsable = probe?.status === 0
/** CI hosts run Linux with bubblewrap, so a missing one is a failure there. */
const required = linux && process.env['CI'] !== undefined

let ctx: Context | undefined
let server: Server | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await new Promise((resolve) => { if (server === undefined) resolve(undefined); else server.close(resolve) })
  server = undefined
})

async function listenAbstract(): Promise<string> {
  const name = `@dsh-abstract-check-${randomBytes(8).toString('hex')}`
  server = createServer(socket => socket.end('reached\n'))
  // A leading NUL byte makes the kernel bind an abstract name.
  await new Promise<void>(resolve => server?.listen(`\0${name.slice(1)}`, resolve))
  return name
}

async function sandbox(): Promise<LocalSandboxProvider> {
  ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, {})
  return ctx.sandbox as LocalSandboxProvider
}

async function run(policy: SandboxPolicy, program: string): Promise<string> {
  const confined = await (await sandbox()).confine([process.execPath, '-e', program], policy)
  return await new Promise((resolve) => {
    const child = spawn(confined.argv[0] as string, confined.argv.slice(1), { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.on('close', () => { resolve(out) })
  })
}

const connect = (name: string): string => `const s = require('node:net').connect('\\0' + ${JSON.stringify(name.slice(1))}); let out = ''; s.on('data', d => { out += d }); s.on('end', () => { process.stdout.write(out) }); s.on('error', e => { process.stdout.write('error ' + e.code + '\\n') })`

describe.runIf(required)('sandbox-local: the platform must support bwrap', () => {
  it('has a usable bwrap', () => {
    expect(bwrapUsable).toBe(true)
  })
})

describe.skipIf(!bwrapUsable)('sandbox-local: the abstract socket check under real bwrap', () => {
  const open: SandboxPolicy = { mode: 'read-only', workspaceRoot: '/' }

  it('refuses an open-network wrap while a listener this test owns exists, and names it', async () => {
    const name = await listenAbstract()
    await expect((await sandbox()).confine(['true'], open)).rejects.toMatchObject({
      code: 'SANDBOX_UNSUPPORTED_POLICY',
      message: expect.stringContaining(name) as string,
    })
  })

  it('runs the command with the risk accepted, and the command reaches the listener', async () => {
    const name = await listenAbstract()
    const policy: SandboxPolicy = { ...open, network: { mode: 'host', abstractSockets: 'accepted' } }
    expect(await run(policy, connect(name))).toBe('reached\n')
  })

  it('does not refuse an `off` wrap, whose network namespace cannot reach the listener', async () => {
    const name = await listenAbstract()
    const out = await run({ ...open, network: { mode: 'off' } }, connect(name))
    expect(out).toBe('error ECONNREFUSED\n')
  })
})
