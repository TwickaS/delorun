/**
 * The supervisor's socket, framing, token check, closed schema and root refusals, through its socket, without a
 * Docker engine: C9's `supervisor-token-required`, `supervisor-schema-closed` (its refusals; the Docker spec adds
 * that no container is created) and `supervisor-roots-refused`.
 */
import { lstatSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { SUPERVISOR_ROOTS_FILE, type StartToken } from '@delo/contract-home-layout'
import { SUPERVISOR_MAX_CONNECTIONS, SUPERVISOR_REQUEST_MAX_BYTES } from '@delo/contract-runtime-supervisor'
import { writeProtectedFile } from '@delo/home'
import { afterEach, describe, expect, it } from 'vitest'
import { supervisorSocketPath } from '../src/index.ts'
import { PROFILE, send, sendRaw, startSupervisor, tempHome, writeStartToken, type RunningSupervisor, type TempHome } from './support.ts'

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

const create = (token: unknown, root: string): Record<string, unknown> => ({
  v: 1, token, op: 'workspace.create',
  args: { workspaceId: 'ws-1', root, preset: 'small', egress: 'none', allowlistAdditions: [], credentials: 'none' },
})

describe('the socket', () => {
  it('listens on run/<profile>/supervisor.sock under the Delo home, at mode 0600', async () => {
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

  it('answers BUSY to a connection beyond the 32 open ones', { timeout: 15_000 }, async () => {
    const { socket } = await start()
    const held: Socket[] = []
    try {
      for (let index = 0; index < SUPERVISOR_MAX_CONNECTIONS; index += 1) {
        const connection = connect(socket)
        await new Promise(resolve => connection.once('connect', resolve))
        held.push(connection)
      }
      // Each connection is counted once the supervisor accepts it; give the accepts a moment to run.
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(await sendRaw(socket, '{}\n')).toEqual({ ok: false, error: 'BUSY' })
    } finally {
      for (const connection of held) connection.destroy()
    }
  })
})

describe('supervisor-roots-refused', () => {
  async function withParents(): Promise<{ readonly socket: string, readonly token: StartToken, readonly home: string, readonly parent: string, readonly outside: string }> {
    temp = await tempHome()
    const parent = join(temp.outside, 'projects')
    mkdirSync(parent, { mode: 0o700 })
    await writeProtectedFile(join(temp.home, SUPERVISOR_ROOTS_FILE), JSON.stringify({ v: 1, parents: [parent] }))
    running = await startSupervisor(temp.home)
    return { socket: running.supervisor.socketPath, token: running.token, home: temp.home, parent, outside: temp.outside }
  }

  it('refuses /, the OS home directory, the Delo home, a path containing it and a path inside it with ROOT_REFUSED', async () => {
    const { socket, token, home } = await withParents()
    const cases = [
      ['/', 'is the filesystem root'],
      [homedir(), 'is the OS home directory'],
      [home, 'is the Delo home'],
      [join(home, '..'), 'contains the Delo home'],
      [join(home, 'run'), 'lies inside the Delo home'],
    ] as const
    for (const [root, reason] of cases) {
      const response = await send(socket, create(token, root))
      expect(response, root).toMatchObject({ ok: false, error: 'ROOT_REFUSED' })
      expect((response as { readonly detail?: string }).detail, root).toContain(reason)
    }
  })

  it('refuses a symbolic link resolving outside every parent and a path outside every parent with ROOT_NOT_UNDER_PARENT', async () => {
    const { socket, token, parent, outside } = await withParents()
    const elsewhere = join(outside, 'elsewhere')
    mkdirSync(elsewhere)
    const link = join(parent, 'link')
    symlinkSync(elsewhere, link)
    expect(await send(socket, create(token, link))).toMatchObject({ ok: false, error: 'ROOT_NOT_UNDER_PARENT', detail: expect.stringContaining(elsewhere) })
    expect(await send(socket, create(token, elsewhere))).toMatchObject({ ok: false, error: 'ROOT_NOT_UNDER_PARENT' })
    expect(await send(socket, create(token, parent))).toMatchObject({ ok: false, error: 'ROOT_NOT_UNDER_PARENT' })
  })

  it('refuses a symbolic link inside a parent that resolves to the Delo home', async () => {
    const { socket, token, home, parent } = await withParents()
    const link = join(parent, 'home-link')
    symlinkSync(home, link)
    expect(await send(socket, create(token, link))).toMatchObject({ ok: false, error: 'ROOT_REFUSED' })
  })

  it('refuses every root when setup chose no parent', async () => {
    const { socket, token, temp: created } = await start()
    const root = join(created.outside, 'w')
    mkdirSync(root)
    expect(await send(socket, create(token, root))).toMatchObject({ ok: false, error: 'ROOT_NOT_UNDER_PARENT' })
  })

  it('accepts a root strictly inside a parent as far as its Docker step, which needs an engine', async () => {
    const { socket, token, parent } = await withParents()
    const root = join(parent, 'w')
    mkdirSync(root)
    expect(await send(socket, create(token, root))).toMatchObject({ ok: false, error: 'DOCKER_UNAVAILABLE' })
  })
})
