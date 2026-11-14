/**
 * The supervisor's socket, framing, token check, closed schema and root refusals, through its socket, without a
 * Docker engine: C9's `supervisor-token-required`, `supervisor-schema-closed` (its refusals; the Docker spec adds
 * that no container is created) and `supervisor-roots-refused`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { join, sep } from 'node:path'
import type { StartToken } from '@delorun/contract-home-layout'
import { SUPERVISOR_MAX_CONNECTIONS, SUPERVISOR_REQUEST_MAX_BYTES } from '@delorun/contract-runtime-supervisor'
import { afterEach, describe, expect, it } from 'vitest'
import { supervisorSocketPath } from '../src/index.ts'
import { PROFILE, send, sendRaw, startSupervisor, tempHome, TIMING, writeStartToken, type RunningSupervisor, type TempHome } from './support.ts'

let temp: TempHome | undefined
let running: RunningSupervisor | undefined
afterEach(async () => {
  await running?.stop()
  running = undefined
  temp?.remove()
  temp = undefined
})

async function start(): Promise<{ readonly home: string, readonly socket: string, readonly token: StartToken, readonly temp: TempHome }> {
  temp = await tempHome()
  running = await startSupervisor(temp.home)
  return { home: temp.home, socket: running.supervisor.socketPath, token: running.token, temp }
}

describe('the socket', () => {
  it('listens on run/<profile>/supervisor.sock under the Delorun home, at mode 0600', async () => {
    const { home, socket } = await start()
    expect(socket).toBe(join(home, 'run', PROFILE, 'supervisor.sock'))
    expect(socket.startsWith(home + sep)).toBe(true)
    const stats = lstatSync(socket)
    expect(stats.isSocket()).toBe(true)
    expect(stats.mode & 0o777).toBe(0o600)
    expect(supervisorSocketPath(home, PROFILE)).toBe(socket)
  })

  it('removes its socket when it stops', async () => {
    const { socket } = await start()
    await running?.stop()
    running = undefined
    expect(() => lstatSync(socket)).toThrow(/ENOENT/)
  })
})

describe('the socket\'s lifetime', () => {
  it('refuses to start over a file at the socket path that is not a socket', async () => {
    temp = await tempHome()
    writeFileSync(join(temp.home, 'run', PROFILE, 'supervisor.sock'), 'not a socket')
    await expect(startSupervisor(temp.home)).rejects.toThrow(/is not a socket/)
    // The socket bound under its temporary name is closed and removed, so nothing listens beside the refused path.
    expect(readdirSync(join(temp.home, 'run', PROFILE)).filter(name => name.startsWith('.s-'))).toEqual([])
  })

  it('removes a socket an earlier supervisor left under its temporary name', async () => {
    temp = await tempHome()
    const stale = join(temp.home, 'run', PROFILE, '.s-0123abcd')
    // A socket file that outlives its process, as a crash between bind and rename leaves one.
    execFileSync('python3', ['-I', '-c', 'import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])', stale], { timeout: 30_000 })
    expect(lstatSync(stale).isSocket()).toBe(true)
    running = await startSupervisor(temp.home)
    expect(existsSync(stale)).toBe(false)
  })

  it('leaves a newer supervisor\'s socket in place when an older one stops', async () => {
    temp = await tempHome()
    const older = await startSupervisor(temp.home)
    const newer = await startSupervisor(temp.home, { token: await writeStartToken(temp.home) })
    running = newer
    await older.stop()
    const socket = newer.supervisor.socketPath
    expect(lstatSync(socket).isSocket()).toBe(true)
    expect(await send(socket, { v: 1, token: newer.token, op: 'capabilities', args: { refresh: false } })).toMatchObject({ ok: true })
  })
})

describe('supervisor-token-required', () => {
  it('answers a request without a token, with a wrong token and with a malformed line with UNAUTHENTICATED and nothing else', async () => {
    const { socket, token } = await start()
    const capabilities = { v: 1, op: 'capabilities', args: { refresh: false } }
    expect(await send(socket, capabilities)).toEqual({ ok: false, error: 'UNAUTHENTICATED' })
    expect(await send(socket, { ...capabilities, token: `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}` })).toEqual({ ok: false, error: 'UNAUTHENTICATED' })
    expect(await send(socket, { ...capabilities, token: 42 })).toEqual({ ok: false, error: 'UNAUTHENTICATED' })
    expect(await sendRaw(socket, 'not json\n')).toEqual({ ok: false, error: 'UNAUTHENTICATED' })
    expect(await send(socket, { ...capabilities, token })).toMatchObject({ ok: true })
  })

  it('refuses the previous start\'s token after a new start', async () => {
    const { home } = await start()
    const previous = running?.token
    await running?.stop()
    running = await startSupervisor(home, { token: await writeStartToken(home) })
    const socket = running.supervisor.socketPath
    expect(previous).not.toBe(running.token)
    expect(await send(socket, { v: 1, token: previous, op: 'capabilities', args: { refresh: false } })).toEqual({ ok: false, error: 'UNAUTHENTICATED' })
    expect(await send(socket, { v: 1, token: running.token, op: 'capabilities', args: { refresh: false } })).toMatchObject({ ok: true })
  })

  it('authenticates before reading the schema: an unauthenticated request outside the schema learns nothing about it', async () => {
    const { socket } = await start()
    expect(await send(socket, { v: 2, token: 'x', op: 'docker.run', args: { image: 'alpine' } })).toEqual({ ok: false, error: 'UNAUTHENTICATED' })
  })

  it('writes no token to its log', async () => {
    const { socket, token } = await start()
    await send(socket, { v: 1, token, op: 'capabilities', args: { refresh: false } })
    await send(socket, { v: 1, token: 'wrong', op: 'capabilities', args: { refresh: false } })
    const text = readFileSync(running?.log.log.location.file ?? '', 'utf8')
    expect(text).toContain('refused a request without the current start token')
    expect(text.includes(token)).toBe(false)
  })
})

describe('supervisor-schema-closed', () => {
  const refused = [
    ['an image reference', { op: 'workspace.create', args: { workspaceId: 'w', root: '/x', preset: 'small', egress: 'none', allowlistAdditions: [], credentials: 'none', image: 'alpine:latest' } }, 'unknown field args.image'],
    ['a mount', { op: 'workspace.create', args: { workspaceId: 'w', root: '/x', preset: 'small', egress: 'none', allowlistAdditions: [], credentials: 'none', mounts: ['/:/host'] } }, 'unknown field args.mounts'],
    ['an environment variable', { op: 'workspace.start', args: { workspaceId: 'w', env: ['A=1'] } }, 'unknown field args.env'],
    ['a command', { op: 'workspace.start', args: { workspaceId: 'w', cmd: ['sh'] } }, 'unknown field args.cmd'],
    ['a capability', { op: 'workspace.start', args: { workspaceId: 'w', capAdd: ['SYS_ADMIN'] } }, 'unknown field args.capAdd'],
    ['a network name', { op: 'workspace.egress', args: { workspaceId: 'w', egress: 'open', allowlistAdditions: [], network: 'host' } }, 'unknown field args.network'],
    ['a Docker passthrough op', { op: 'docker.run', args: {} }, 'unknown op'],
    ['an unknown top-level field', { op: 'workspace.list', privileged: true }, 'unknown field privileged'],
    ['arguments on an op without them', { op: 'workspace.list', args: {} }, 'unknown field args'],
    ['a workspace id over 128 characters', { op: 'workspace.start', args: { workspaceId: 'w'.repeat(129) } }, 'args.workspaceId'],
    ['a relative root', { op: 'workspace.create', args: { workspaceId: 'w', root: 'x', preset: 'small', egress: 'none', allowlistAdditions: [], credentials: 'none' } }, 'args.root'],
    ['an IP address as an allowlist addition', { op: 'workspace.egress', args: { workspaceId: 'w', egress: 'allowlist', allowlistAdditions: ['192.0.2.1'] } }, 'args.allowlistAdditions.0'],
    ['65 allowlist additions', { op: 'workspace.egress', args: { workspaceId: 'w', egress: 'allowlist', allowlistAdditions: Array.from({ length: 65 }, (_, index) => `h${String(index)}.example`) } }, 'args.allowlistAdditions'],
    ['limits without the advanced preset', { op: 'workspace.create', args: { workspaceId: 'w', root: '/x', preset: 'small', limits: { cpus: 1, memoryBytes: 1, diskBytes: 1, pids: 1, tmpBytes: 1 }, egress: 'none', allowlistAdditions: [], credentials: 'none' } }, 'args.limits'],
    ['protocol version 2', { v: 2, op: 'workspace.list' }, 'v:'],
  ] as const

  for (const [label, request, detail] of refused) {
    it(`refuses ${label} with SCHEMA_VIOLATION`, async () => {
      const { socket, token } = await start()
      const response = await send(socket, { v: 1, token, ...request })
      expect(response).toMatchObject({ ok: false, error: 'SCHEMA_VIOLATION' })
      expect((response as { readonly detail?: string }).detail).toContain(detail)
    })
  }

  it('names no refused value in its detail', async () => {
    const { socket, token } = await start()
    const response = await send(socket, { v: 1, token, op: 'workspace.start', args: { workspaceId: 'w', env: ['SECRET=value-1234'] } })
    expect(JSON.stringify(response)).not.toContain('value-1234')
  })
})

describe('framing', () => {
  it('refuses a request line over 65,536 bytes', async () => {
    const { socket, token } = await start()
    const line = JSON.stringify({ v: 1, token, op: 'workspace.list', pad: 'x'.repeat(SUPERVISOR_REQUEST_MAX_BYTES) })
    expect(await sendRaw(socket, `${line}\n`)).toMatchObject({ ok: false, error: 'SCHEMA_VIOLATION' })
  })

  it('answers REQUEST_TIMEOUT when no line arrives within 5 seconds', { timeout: 15_000 }, async () => {
    const { socket } = await start()
    const started = Date.now()
    expect(await sendRaw(socket, '{"v":1')).toEqual({ ok: false, error: 'REQUEST_TIMEOUT' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900)
  })

  it('answers REQUEST_TIMEOUT at the first-byte deadline when nothing arrives', { timeout: 15_000 }, async () => {
    const { socket } = await start()
    const started = Date.now()
    expect(await sendRaw(socket, '')).toEqual({ ok: false, error: 'REQUEST_TIMEOUT' })
    expect(Date.now() - started).toBeLessThan(TIMING.firstByteMs + 1_500)
  })

  it('releases a connection\'s slot once its response is written, even when the caller keeps it open', { timeout: 15_000 }, async () => {
    const { socket } = await start()
    const held: Socket[] = []
    try {
      for (let index = 0; index < SUPERVISOR_MAX_CONNECTIONS; index += 1) {
        // A half-open caller keeps its side open after the supervisor ends the connection.
        const connection = connect({ path: socket, allowHalfOpen: true })
        await new Promise(resolve => connection.once('connect', resolve))
        connection.on('error', () => { /* the supervisor closes it; the spec only holds it */ })
        const answered = new Promise(resolve => connection.once('data', resolve))
        connection.write('{}\n')
        await answered
        held.push(connection)
      }
      expect(await sendRaw(socket, '{}\n')).toEqual({ ok: false, error: 'UNAUTHENTICATED' })
    } finally {
      for (const connection of held) connection.destroy()
    }
  })

  it('logs refused authentications at most once per interval, with a count', async () => {
    const { socket } = await start()
    for (let index = 0; index < 20; index += 1) await send(socket, { v: 1, token: 'wrong', op: 'workspace.list' })
    const text = readFileSync(running?.log.log.location.file ?? '', 'utf8')
    expect(text.split('refused a request without the current start token').length - 1).toBe(1)
  })

  it('answers BUSY to a connection beyond the 32 open ones', { timeout: 15_000 }, async () => {
    const { socket } = await start()
    const held: Socket[] = []
    try {
      for (let index = 0; index < SUPERVISOR_MAX_CONNECTIONS; index += 1) {
        const connection = connect(socket)
        await new Promise(resolve => connection.once('connect', resolve))
        held.push(connection)
      }
      // Each connection is counted once the supervisor accepts it, after the caller's `connect`. A probe accepted before
      // then is answered and has released its slot by the time it resolves.
      await expect.poll(async () => sendRaw(socket, '{}\n')).toEqual({ ok: false, error: 'BUSY' })
    } finally {
      for (const connection of held) connection.destroy()
    }
  })
})
