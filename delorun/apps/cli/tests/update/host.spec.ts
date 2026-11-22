/**
 * The Host side of `delorun update` (contracts C19 and C3), over a real cordis context and a real
 * `CountingChatGate`: how running chats are counted and cancelled, how a new turn is refused while the gate is held,
 * which booted rows count as inactive, and each of C3's health criteria H1 to H5 against local HTTP servers and a
 * profile `package.json` in a temporary directory.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobEvent, JobEventListener, JobView } from '@deepseek-ai/dsh-jobs'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import * as UpdateGate from '@delorun/bundle-local/update-gate'
import { CountingChatGate, type HealthExpectations } from '@delorun/home-process'
import type { BootedRow } from '../../src/delorun-bundles.ts'
import { appliedReachConfig } from '../../src/reach/host.ts'
import { sandboxProtection, type SandboxProtection } from '../../src/sandbox-protection.ts'
import { arrivedOnLoopbackListener, bootProtectionOf, bootRowsOf, checkHealth, HEALTH_PATH, inactiveRows, serveHealth, STOP_REASON, studioHealthUrl, watchChats, withAppliedConfig, type HostHealthFacts } from '../../src/update/host.ts'

/** An agent that records the cancellations it is asked for. */
interface FakeAgent {
  readonly cancellations: unknown[]
  cancel(cause: unknown): void
}

/** @returns an agent whose `cancel` records its argument. */
function fakeAgent(): FakeAgent & Agent {
  const cancellations: unknown[] = []
  const agent: FakeAgent = { cancellations, cancel: (cause) => { cancellations.push(cause) } }
  return agent as FakeAgent & Agent
}

describe('watchChats and the update plugin\'s chat source', () => {
  /** @returns an agent with a session of the given origin. */
  function sessionAgent(id: string, origin?: 'subagent'): FakeAgent & Agent {
    return Object.assign(fakeAgent(), { session: { id, header: { id, ...origin === undefined ? {} : { origin } } } })
  }

  it('lists the top-level chats that run, once each, not a subagent\'s session, and counts the background jobs', async () => {
    const ctx = new Context()
    const gate = new CountingChatGate()
    let source: { list(): readonly string[], jobs(): number } | undefined
    ctx.provide('delorunUpdateChats', { attach: (attached: typeof source) => { source = attached; return () => undefined } })
    watchChats(ctx, gate)
    await ctx.parallel('agent/status', { agent: sessionAgent('parent'), status: 'running' })
    await ctx.parallel('agent/status', { agent: sessionAgent('child', 'subagent'), status: 'running' })
    expect(source?.list()).toEqual(['parent'])
    expect(gate.running()).toBe(2)
    expect(source?.jobs()).toBe(0)
  })
})

describe('watchChats', () => {
  /** @returns a context with the listeners installed over a fresh gate. */
  function watched(): { readonly ctx: Context, readonly gate: CountingChatGate } {
    const ctx = new Context()
    const gate = new CountingChatGate()
    watchChats(ctx, gate)
    return { ctx, gate }
  }

  it('counts an agent while it runs, once however often it reports running, and stops counting when it is idle', async () => {
    const { ctx, gate } = watched()
    const agent = fakeAgent()

    await ctx.parallel('agent/status', { agent, status: 'running' })
    await ctx.parallel('agent/status', { agent, status: 'running' })
    expect(gate.running()).toBe(1)

    await ctx.parallel('agent/status', { agent, status: 'idle' })
    expect(gate.running()).toBe(0)
  })

  it('ignores an idle report for an agent it never saw running', async () => {
    const { ctx, gate } = watched()

    await ctx.parallel('agent/status', { agent: fakeAgent(), status: 'idle' })

    expect(gate.running()).toBe(0)
  })

  it('cancels every running agent with a hook cause that says why when the gate cancels all chats', async () => {
    const { ctx, gate } = watched()
    const first = fakeAgent()
    const second = fakeAgent()
    await ctx.parallel('agent/status', { agent: first, status: 'running' })
    await ctx.parallel('agent/status', { agent: second, status: 'running' })

    await gate.cancelAll()

    expect(first.cancellations).toEqual([{ kind: 'hook', reason: 'Delorun is stopping or updating' }])
    expect(second.cancellations).toEqual([{ kind: 'hook', reason: 'Delorun is stopping or updating' }])
  })
})

/** Lets the context's pending plugin fibers start. */
const settle = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

/** A job registry that hands its listener to the spec and records the kills it is asked for. */
interface FakeJobs {
  readonly filters: unknown[]
  readonly kills: unknown[][]
  emit: (event: JobEvent) => void
  failKill: boolean
}

/** @returns a fake job registry, with its emitter. */
function fakeJobs(): FakeJobs & { readonly service: object } {
  const listeners: JobEventListener[] = []
  const state: FakeJobs = {
    filters: [],
    kills: [],
    emit: (event) => { for (const listener of listeners) listener(event) },
    failKill: false,
  }
  const service = {
    events: {
      subscribe: (filter: unknown, listener: JobEventListener) => {
        state.filters.push(filter)
        listeners.push(listener)
        return () => {}
      },
    },
    kill: (...args: unknown[]) => {
      if (state.failKill) throw new Error('the producer refused the cancellation')
      state.kills.push(args)
      return 'requested'
    },
  }
  return Object.assign(state, { service })
}

/**
 * @param id - the job's id.
 * @param owner - its owning session, or `undefined` for an unowned job.
 * @returns a running job's projection.
 */
function job(id: string, owner?: string): JobView {
  return {
    id: id as JobView['id'],
    kind: 'bash',
    label: id,
    ...owner === undefined ? {} : { owner: owner as NonNullable<JobView['owner']> },
    status: 'running',
    startedAt: 0,
    output: { total: 0, earliest: 0 },
  }
}

describe('watchChats over the job registry', () => {
  it('counts every owner\'s job from its registration until it settles, and ignores its other events', async () => {
    const ctx = new Context()
    const gate = new CountingChatGate()
    const jobs = fakeJobs()
    ctx.provide('jobs', jobs.service)
    watchChats(ctx, gate)
    await settle()

    expect(jobs.filters).toEqual([{ owners: 'all' }])
    jobs.emit({ type: 'registered', job: job('bash-1', 'chat-1') })
    jobs.emit({ type: 'registered', job: job('bash-2') })
    jobs.emit({ type: 'progress', job: job('bash-1', 'chat-1') })
    jobs.emit({ type: 'output', id: 'bash-1' as JobView['id'], total: 4 })
    expect(gate.running()).toBe(2)

    jobs.emit({ type: 'settled', job: job('bash-1', 'chat-1'), cause: 'producer', awaited: false })
    jobs.emit({ type: 'removed', job: job('bash-1', 'chat-1') })
    expect(gate.running()).toBe(1)
    await ctx.fiber.dispose()
  })

  it('kills each running job as its owner with the stop reason when the gate cancels all chats, and a kill that throws stops no other', async () => {
    const ctx = new Context()
    const gate = new CountingChatGate()
    const jobs = fakeJobs()
    const agent = fakeAgent()
    ctx.provide('jobs', jobs.service)
    watchChats(ctx, gate)
    await settle()
    jobs.emit({ type: 'registered', job: job('bash-1', 'chat-1') })
    jobs.emit({ type: 'registered', job: job('bash-2') })
    await ctx.parallel('agent/status', { agent, status: 'running' })

    await gate.cancelAll()
    expect(jobs.kills).toEqual([['bash-1', 'chat-1', STOP_REASON], ['bash-2', undefined, STOP_REASON]])

    jobs.failKill = true
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await gate.cancelAll()
    expect(warn).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[0]?.[0])).toContain('the producer refused the cancellation')
    expect(agent.cancellations).toHaveLength(2)
    warn.mockRestore()
    await ctx.fiber.dispose()
  })

  it('tells the chat gate when a job settles or is removed, and counts a job that does not run or that registers twice once', async () => {
    const ctx = new Context()
    const gate = new CountingChatGate()
    const jobs = fakeJobs()
    let ended = 0
    ctx.provide('jobs', jobs.service)
    ctx.provide('delorunChatGate', { attach: () => () => {}, chatEnded: () => { ended += 1 } })
    watchChats(ctx, gate)
    await settle()

    jobs.emit({ type: 'registered', job: { ...job('bash-1', 'chat-1'), status: 'completed' } })
    expect(gate.running()).toBe(0)
    jobs.emit({ type: 'registered', job: job('bash-2', 'chat-1') })
    jobs.emit({ type: 'registered', job: job('bash-2', 'chat-1') })
    expect(gate.running()).toBe(1)

    jobs.emit({ type: 'settled', job: job('bash-2', 'chat-1'), cause: 'producer', awaited: false })
    expect(gate.running()).toBe(0)
    expect(ended).toBe(1)
    // The removal that follows the settlement, and the settlement of a job never counted, tell nothing.
    jobs.emit({ type: 'removed', job: job('bash-2', 'chat-1') })
    jobs.emit({ type: 'settled', job: job('bash-9'), cause: 'producer', awaited: false })
    expect(ended).toBe(1)
    await ctx.fiber.dispose()
  })

  it('stops counting the jobs it still tracks when the registry goes', async () => {
    const ctx = new Context()
    const gate = new CountingChatGate()
    const jobs = fakeJobs()
    const unprovide = ctx.provide('jobs', jobs.service)
    watchChats(ctx, gate)
    await settle()
    jobs.emit({ type: 'registered', job: job('bash-1', 'chat-1') })
    expect(gate.running()).toBe(1)

    unprovide()
    await settle()

    expect(gate.running()).toBe(0)
    await ctx.fiber.dispose()
  })
})

describe('watchChats and the update gate of @delorun/bundle-local', () => {
  it('holds new turns back exactly while the chat gate is held, once the row\'s service is mounted', async () => {
    const ctx = new Context()
    const gate = new CountingChatGate()
    watchChats(ctx, gate)
    await ctx.plugin(UpdateGate, { enabled: true, holdUntilChecked: false, checkWaitSeconds: 60 })
    await settle()

    expect(ctx.delorunTurnGate.held).toBe(false)
    const release = gate.hold()
    expect(ctx.delorunTurnGate.held).toBe(true)
    release()
    expect(ctx.delorunTurnGate.held).toBe(false)
    await ctx.fiber.dispose()
  })

  it('detaches from the service when the watch goes, so a held gate no longer refuses turns', async () => {
    const ctx = new Context()
    const gate = new CountingChatGate()
    const service = new UpdateGate.UpdateTurnGateService(new Context(), { enabled: true, holdUntilChecked: false, checkWaitSeconds: 60 })
    const unprovide = ctx.provide('delorunTurnGate', service)
    watchChats(ctx, gate)
    await settle()
    gate.hold()
    expect(service.held).toBe(true)

    unprovide()
    await settle()

    expect(service.held).toBe(false)
    await ctx.fiber.dispose()
  })
})

describe('rows', () => {
  const row = (change: Partial<BootedRow>): BootedRow => ({ id: 'row-1', name: 'plugin-a', disabled: false, state: 'active', ...change })

  it('lists the rows that are disabled or did not start, and none of the active ones, marking the ids the Loader made up', () => {
    const rows = [
      row({ id: 'active', name: 'plugin-active' }),
      row({ id: 'off', disabled: true }),
      row({ id: 'broken', state: 'failed' }),
      row({ id: 'waiting', state: 'pending' }),
      row({ id: 'skipped', state: 'not-imported' }),
      row({ id: 'off-and-failed', disabled: true, state: 'failed', name: 'plugin-b' }),
      row({ id: 'b08ab057', state: 'failed' }),
    ]

    expect(inactiveRows(rows).map(({ id, generated }) => `${id}${generated ? ' (generated)' : ''}`)).toEqual(['off', 'broken', 'waiting', 'skipped', 'off-and-failed', 'b08ab057 (generated)'])
  })

  it('hashes the config of a protected plugin\'s rows, the same config the same way whatever its key order, and no other row\'s', () => {
    const manager = row({ id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager', config: { protectedPlugins: ['@delorun/plugin-fetch-guard'] } })
    const guard = (config: unknown): BootedRow => row({ id: 'delorun-fetch-guard', name: '@delorun/plugin-fetch-guard', config })
    const [, first] = bootRowsOf([manager, guard({ block: true, hosts: ['a'] })])
    const [, reordered] = bootRowsOf([manager, guard({ hosts: ['a'], block: true })])
    const [, changed] = bootRowsOf([manager, guard({ block: false, hosts: ['a'] })])
    expect(first?.configHash).toMatch(/^[0-9a-f]{64}$/u)
    expect(reordered?.configHash).toBe(first?.configHash)
    expect(changed?.configHash).not.toBe(first?.configHash)
    expect(bootRowsOf([manager, row({ id: 'other', config: { a: 1 } })])[1]).toEqual({ id: 'other', name: 'plugin-a', generated: false })
  })

  it('hashes a config as SHA-256 of its canonical JSON, as every release since 0.1.0-preview.1.1 does', () => {
    const manager = row({ id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager', config: { protectedPlugins: ['@delorun/plugin-fetch-guard'] } })
    const [, guard] = bootRowsOf([manager, row({ id: 'delorun-fetch-guard', name: '@delorun/plugin-fetch-guard', config: { hosts: ['a'], block: true } })])
    expect(guard?.configHash).toBe(createHash('sha256').update('{"block":true,"hosts":["a"]}').digest('hex'))
  })

  it('takes an applied config\'s hash for that protected row only, as a boot with that config gives it', () => {
    const manager = row({ id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager', config: { protectedPlugins: ['@delorun/reach'] } })
    const reach = (config: unknown): BootedRow => row({ id: 'delorun-reach', name: '@delorun/reach', config })
    const atBoot = bootRowsOf([manager, reach({ enabled: false }), row({ id: 'other', config: { a: 1 } })])
    expect(withAppliedConfig(atBoot, 'delorun-reach', { enabled: true })).toEqual(bootRowsOf([manager, reach({ enabled: true }), row({ id: 'other', config: { a: 1 } })]).map(booted => booted.id === 'delorun-reach' ? { ...booted, personEdited: true } : booted))
    expect(withAppliedConfig(atBoot, 'other', { a: 2 })).toEqual(atBoot)
    expect(withAppliedConfig(atBoot, 'absent', { a: 2 })).toEqual(atBoot)
  })
})

describe('serveHealth', () => {
  /**
   * The route `serveHealth` registers on a stand-in web server whose in-process read of the index answers one status.
   * @param index - the status of the studio's index, or `undefined` for a Host with no Connection service.
   * @returns the registered route and the reads the route made.
   */
  function served(index: number | undefined): { readonly route: WebRoute | undefined, readonly reads: string[] } {
    const routes = new Map<string, WebRoute>()
    const reads: string[] = []
    const root = new Context()
    const server: Pick<WebServer, 'register' | 'readResource' | 'getOrigin'> = {
      register: (route) => {
        routes.set(route.path, route as WebRoute)
        return () => { routes.delete(route.path) }
      },
      readResource: async (request) => {
        reads.push(request.url)
        return Promise.resolve(new Response(index === 200 ? 'index' : null, { status: index ?? 500 }))
      },
      getOrigin: () => listener.origin,
    }
    root.provide('webServer', server as WebServer)
    if (index !== undefined) root.provide('connection', { browserPeer: {} } as Context['connection'])
    serveHealth(root)
    return { route: routes.get(HEALTH_PATH), reads }
  }

  /** The origin of the listener {@link answer} serves on, which the stand-in web server reports as its own. */
  const listener = { origin: 'http://127.0.0.1:0' }

  /**
   * Answer one request with a registered route through a real loopback listener, which the stand-in web server reports
   * as its loopback listener unless `elsewhere` says the route sits behind another one.
   * @param route - the route.
   * @param method - the request's method.
   * @param request - the `Host` header to send, whether the web server's loopback listener is another port, and the
   *   address the listener binds.
   * @param request.host - the `Host` header; the listener's own address by default.
   * @param request.elsewhere - true to report a loopback listener on another port, as a reach listener's request sees it.
   * @param request.bind - the address the listener binds, which its origin names; `127.0.0.1` by default.
   * @returns the status, the cache header and the body.
   */
  async function answer(route: WebRoute, method: string, request: { readonly host?: string, readonly elsewhere?: boolean, readonly bind?: string } = {}): Promise<{ readonly status: number, readonly cache: string | null, readonly body: string }> {
    const server = createServer((incoming, response) => { void route.handler(incoming, response) })
    const bind = request.bind ?? '127.0.0.1'
    await new Promise<void>((resolve) => { server.listen(0, bind, resolve) })
    const port = (server.address() as AddressInfo).port
    listener.origin = `http://${bind}:${String(request.elsewhere === true ? port + 1 : port)}`
    try {
      const reply = await new Promise<{ status: number, cache: string | null, body: string }>((resolve, reject) => {
        const outgoing = httpRequest({ host: '127.0.0.1', port, path: HEALTH_PATH, method, headers: { host: request.host ?? `127.0.0.1:${String(port)}` } }, (incoming) => {
          let body = ''
          incoming.setEncoding('utf8')
          incoming.on('data', (chunk: string) => { body += chunk })
          incoming.on('end', () => { resolve({ status: incoming.statusCode ?? 0, cache: (incoming.headers['cache-control'] as string | undefined) ?? null, body }) })
        })
        outgoing.on('error', reject)
        outgoing.end()
      })
      return reply
    } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  }

  it('answers 204 with no body and no-store when the studio\'s index reads in-process, for GET and HEAD', async () => {
    const { route, reads } = served(200)
    expect(route).toMatchObject({ kind: 'exact', path: HEALTH_PATH })
    expect(await answer(route!, 'GET')).toEqual({ status: 204, cache: 'no-store', body: '' })
    expect(await answer(route!, 'HEAD')).toEqual({ status: 204, cache: 'no-store', body: '' })
    expect(reads).toHaveLength(2)
    expect(reads.every(read => read.endsWith('/') && read.startsWith('http://127.0.0.1:'))).toBe(true)
  })

  it('answers 503 when the studio\'s index does not read, or the Host has no Connection to read it as', async () => {
    expect(await answer(served(404).route!, 'GET')).toEqual({ status: 503, cache: 'no-store', body: '' })
    const unconnected = served(undefined)
    expect((await answer(unconnected.route!, 'GET')).status).toBe(503)
    expect(unconnected.reads).toEqual([])
  })

  it('answers 421 and reads nothing for a request that did not arrive on the loopback listener under a loopback name', async () => {
    const { route, reads } = served(200)
    expect(await answer(route!, 'GET', { elsewhere: true })).toEqual({ status: 421, cache: 'no-store', body: '' })
    expect(await answer(route!, 'GET', { host: 'reach.example:3080' })).toEqual({ status: 421, cache: 'no-store', body: '' })
    expect(await answer(route!, 'GET', { host: 'localhost:3080' })).toMatchObject({ status: 204 })
    expect(reads).toHaveLength(1)
  })

  it('answers a loopback request on a listener bound to every address, which the origin names', async () => {
    const { route } = served(200)
    expect(await answer(route!, 'GET', { bind: '0.0.0.0' })).toMatchObject({ status: 204 })
    expect(await answer(route!, 'GET', { bind: '0.0.0.0', host: '0.0.0.0:3080' })).toMatchObject({ status: 421 })
  })

  it('compares the listener\'s port with its scheme\'s default when its origin names none', () => {
    const request = (localPort: number): Parameters<typeof arrivedOnLoopbackListener>[0] => ({ socket: { remoteAddress: '127.0.0.1', localPort } as Socket, headers: { host: 'localhost' } })
    expect(arrivedOnLoopbackListener(request(80), 'http://localhost')).toBe(true)
    expect(arrivedOnLoopbackListener(request(443), 'https://localhost')).toBe(true)
    expect(arrivedOnLoopbackListener(request(3080), 'http://localhost')).toBe(false)
  })

  it('refuses a request from another computer on a listener bound to every address', () => {
    const request = { socket: { remoteAddress: '192.0.2.7', localPort: 3080 } as Socket, headers: { host: '127.0.0.1:3080' } }
    expect(arrivedOnLoopbackListener(request, 'http://0.0.0.0:3080')).toBe(false)
    expect(arrivedOnLoopbackListener({ ...request, socket: { remoteAddress: '::ffff:127.0.0.1', localPort: 3080 } as Socket }, 'http://0.0.0.0:3080')).toBe(true)
  })

  it('refuses a method other than GET and HEAD without reading anything', async () => {
    const { route, reads } = served(200)
    expect((await answer(route!, 'POST')).status).toBe(405)
    expect(reads).toEqual([])
  })

  it('registers nothing on a Host without a web server', () => {
    expect(() => { serveHealth(new Context()) }).not.toThrow()
  })
})

describe('checkHealth', () => {
  const servers: Server[] = []
  const directories: string[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(servers.splice(0).map(async server => new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  /**
   * Start a loopback HTTP server that answers the health route with one status and every other path with 401.
   * @param status - the status.
   * @param host - the address to bind.
   * @returns the port.
   */
  async function studioAnswering(status: number, host = '127.0.0.1'): Promise<number> {
    // Like the studio: the health route answers without a cookie, every other path asks the browser to sign in.
    const server = createServer((request, response) => { response.writeHead(request.url === HEALTH_PATH ? status : 401).end() })
    servers.push(server)
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve) })
    return (server.address() as AddressInfo).port
  }

  /** @returns a port nothing listens on. */
  async function closedPort(): Promise<number> {
    const port = await studioAnswering(204)
    await new Promise<void>((resolve) => { servers.pop()?.close(() => { resolve() }) })
    return port
  }

  /**
   * A profile directory whose `package.json` states a bundle list.
   * @param bundles - the list.
   * @returns the directory.
   */
  function profileWith(bundles: readonly string[]): string {
    const directory = mkdtempSync(join(tmpdir(), 'dhh-'))
    directories.push(directory)
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'profile', dsh: { profile: { bundles } } }))
    return directory
  }

  /**
   * Health facts over a studio port, rows and a profile.
   * @param port - the studio's port.
   * @param change - facts to replace.
   * @returns the facts.
   */
  function facts(port: number, change: Partial<HostHealthFacts> = {}): HostHealthFacts {
    return { rows: () => [], studio: () => ({ host: '127.0.0.1', port }), profileDir: '/nowhere', verifyRuntime: async () => Promise.resolve(), ...change }
  }

  const NOTHING_NAMED = { namedRows: [], previousFailures: [], previousRows: [], disabledPlugins: [] }

  it('fails H1 with the verification error when the runtime files no longer match, without asking the studio', async () => {
    const studio = vi.fn(() => undefined)

    const verdict = await checkHealth(facts(0, { verifyRuntime: async () => Promise.reject(new Error('file app/x differs')), studio }), undefined)

    expect(verdict).toEqual({ passed: false, criterion: 'H1-release-verified', detail: 'file app/x differs' })
    expect(studio).not.toHaveBeenCalled()
  })

  it('fails H1 with the text of whatever else was thrown', async () => {
    const verdict = await checkHealth(facts(0, { verifyRuntime: async () => Promise.reject('disk gone') }), undefined)

    expect(verdict).toEqual({ passed: false, criterion: 'H1-release-verified', detail: 'disk gone' })
  })

  it('fails H2 when the Host has no studio listener', async () => {
    const verdict = await checkHealth(facts(0, { studio: () => undefined }), undefined)

    expect(verdict).toEqual({ passed: false, criterion: 'H2-host-ready', detail: 'the Host has no studio listener' })
  })

  it('fails H2 with the status when the health route answers anything but 204', async () => {
    const port = await studioAnswering(500)

    const verdict = await checkHealth(facts(port), undefined)

    expect(verdict).toEqual({ passed: false, criterion: 'H2-host-ready', detail: 'the studio listener\'s health route answered 500' })
  })

  it('fails H2 when the listener asks for sign-in on the health route, as it does on every studio page', async () => {
    const port = await studioAnswering(401)

    const verdict = await checkHealth(facts(port), undefined)

    expect(verdict).toMatchObject({ passed: false, criterion: 'H2-host-ready', detail: 'the studio listener\'s health route answered 401' })
  })

  it('fails H2 with the connection error when nothing listens on the studio port', async () => {
    const verdict = await checkHealth(facts(await closedPort()), undefined)

    expect(verdict).toMatchObject({ passed: false, criterion: 'H2-host-ready' })
    expect((verdict as { readonly detail: string }).detail).toMatch(/^the studio listener's health route did not answer: /u)
  })

  it('fails H2 with the text of a request failure that is not an Error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue('socket hung up')

    const verdict = await checkHealth(facts(1), undefined)

    expect(verdict).toEqual({ passed: false, criterion: 'H2-host-ready', detail: 'the studio listener\'s health route did not answer: socket hung up' })
  })

  it('asks an IPv6 studio listener at its bracketed address', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    const verdict = await checkHealth(facts(0, { studio: () => ({ host: '::1', port: 4000 }) }), undefined)

    expect(verdict).toEqual({ passed: true })
    expect(String(fetched.mock.calls[0]?.[0])).toBe(`http://[::1]:4000${HEALTH_PATH}`)
  })

  it('asks a studio listener bound to every address at 127.0.0.1, so the route sees a loopback request', async () => {
    expect(studioHealthUrl({ host: '0.0.0.0', port: 4000 })).toBe(`http://127.0.0.1:4000${HEALTH_PATH}`)
    expect(studioHealthUrl({ host: '::', port: 4000 })).toBe(`http://127.0.0.1:4000${HEALTH_PATH}`)
    expect(studioHealthUrl({ host: 'localhost', port: 4000 })).toBe(`http://localhost:4000${HEALTH_PATH}`)
    const port = await studioAnswering(204, '0.0.0.0')

    expect(await checkHealth(facts(port, { studio: () => ({ host: '0.0.0.0', port }) }), undefined)).toEqual({ passed: true })
  })

  it('passes H1 and H2 alone when the report predicted nothing', async () => {
    const port = await studioAnswering(204)
    const rows: BootedRow[] = [{ id: 'unnamed', name: 'broken', disabled: true, state: 'failed' }]

    expect(await checkHealth(facts(port, { rows: () => rows }), undefined)).toEqual({ passed: true })
  })

  it('asks a studio on an IPv6 loopback address by its bracketed host', async () => {
    let port: number
    try {
      port = await studioAnswering(204, '::1')
    } catch (_noIpv6) {
      // This machine has no IPv6 loopback address, so the bracketed form cannot be exercised.
      return
    }

    const verdict = await checkHealth(facts(port, { studio: () => ({ host: '::1', port }) }), undefined)

    expect(verdict).toEqual({ passed: true })
  })

  it('fails H3 for a disabled row the report did not name, and H4 for a row that did not load', async () => {
    const port = await studioAnswering(204)
    const disabled: BootedRow = { id: 'row-off', name: 'plugin-off', disabled: true, state: 'active' }
    const failed: BootedRow = { id: 'row-bad', name: 'plugin-bad', disabled: false, state: 'failed' }

    expect(await checkHealth(facts(port, { rows: () => [disabled] }), NOTHING_NAMED)).toEqual({
      passed: false, criterion: 'H3-only-named-disabled', detail: 'row row-off is disabled and the report did not name it',
    })
    expect(await checkHealth(facts(port, { rows: () => [failed] }), NOTHING_NAMED)).toEqual({
      passed: false, criterion: 'H4-unnamed-rows-load', detail: 'row row-bad did not load (failed) and the report did not name it',
    })
  })

  it('accepts a bundle-disabled row once the report names it by id, and still fails it when the report does not', async () => {
    const port = await studioAnswering(204)
    const off: BootedRow = { id: 'llm-deepseek-account', name: 'plugin-llm-deepseek-account', disabled: true, state: 'active' }

    expect(await checkHealth(facts(port, { rows: () => [off] }), { ...NOTHING_NAMED, namedRows: ['some-other-row'] })).toEqual({
      passed: false, criterion: 'H3-only-named-disabled', detail: 'row llm-deepseek-account is disabled and the report did not name it',
    })
    expect(await checkHealth(facts(port, { rows: () => [off] }), { ...NOTHING_NAMED, namedRows: ['llm-deepseek-account'] })).toEqual({ passed: true })
  })

  it('does not let a bundle-disabled id that equals a plugin name excuse another disabled row of that plugin', async () => {
    const port = await studioAnswering(204)
    const named: BootedRow = { id: 'plugin-shared', name: 'plugin-shared', disabled: true, state: 'active' }
    const other: BootedRow = { id: 'other-row', name: 'plugin-shared', disabled: true, state: 'active' }

    expect(await checkHealth(facts(port, { rows: () => [named, other] }), { ...NOTHING_NAMED, bundleRows: ['plugin-shared'] })).toEqual({
      passed: false, criterion: 'H3-only-named-disabled', detail: 'row other-row is disabled and the report did not name it',
    })
    expect(await checkHealth(facts(port, { rows: () => [named] }), { ...NOTHING_NAMED, bundleRows: ['plugin-shared'] })).toEqual({ passed: true })
  })

  /** A row as the previous release's Host handed it over. */
  const before = (id: string, name: string, generated = false): { id: string, name: string, generated: boolean } => ({ id, name, generated })

  it('accepts an inactive row the report named by id, one that failed before under the same id and one of a disabled plugin', async () => {
    const port = await studioAnswering(204)
    const rows: BootedRow[] = [
      { id: 'named', name: 'plugin-1', disabled: true, state: 'active' },
      { id: 'failed-before', name: 'plugin-2', disabled: false, state: 'failed' },
      { id: 'of-a-disabled-plugin', name: 'plugin-3', disabled: false, state: 'not-imported' },
      { id: 'fine', name: 'plugin-4', disabled: false, state: 'active' },
      { id: 'loader-id', name: 'plugin-5', disabled: true, state: 'active' },
    ]
    const expectations = {
      namedRows: ['named', 'plugin-5', 'dropped-but-named'],
      previousFailures: [before('failed-before', 'plugin-2')],
      previousRows: [before('named', 'plugin-n'), before('fine', 'plugin-f'), before('dropped-but-named', 'plugin-d'), before('row-of-a-disabled-plugin', 'plugin-3')],
      disabledPlugins: ['plugin-3'],
    }

    expect(await checkHealth(facts(port, { rows: () => rows }), expectations)).toEqual({ passed: true })
  })

  it('fails H4 for an active row of a plugin that had another row disabled before: a previous failure covers only its own row', async () => {
    const port = await studioAnswering(204)
    const rows: BootedRow[] = [{ id: 'guard-main', name: 'plugin-guard', disabled: false, state: 'failed' }]

    expect(await checkHealth(facts(port, { rows: () => rows }), { ...NOTHING_NAMED, previousFailures: [before('guard-spare', 'plugin-guard')], previousRows: [before('guard-main', 'plugin-guard'), before('guard-spare', 'plugin-guard')] })).toEqual({
      passed: false, criterion: 'H4-unnamed-rows-load', detail: 'row guard-main did not load (failed) and the report did not name it',
    })
  })

  it('fails H3 when a plugin\'s active row is gone and only its disabled spare row was a previous failure', async () => {
    const port = await studioAnswering(204)
    const rows: BootedRow[] = [{ id: 'guard-spare', name: 'plugin-guard', disabled: true, state: 'active' }]

    expect(await checkHealth(facts(port, { rows: () => rows }), { ...NOTHING_NAMED, previousFailures: [before('guard-spare', 'plugin-guard')], previousRows: [before('guard-main', 'plugin-guard'), before('guard-spare', 'plugin-guard')] })).toEqual({
      passed: false, criterion: 'H3-only-named-disabled', detail: 'row guard-main was in the profile before the update, is gone, and the report did not name it or disable its plugin',
    })
  })

  it('fails H3 when a row the profile had before the update is gone and the report did not name it', async () => {
    const port = await studioAnswering(204)
    const rows: BootedRow[] = [{ id: 'kept', name: 'plugin-1', disabled: false, state: 'active' }]

    expect(await checkHealth(facts(port, { rows: () => rows }), { ...NOTHING_NAMED, previousRows: [before('kept', 'plugin-k'), before('dropped', 'plugin-x')] })).toEqual({
      passed: false, criterion: 'H3-only-named-disabled', detail: 'row dropped was in the profile before the update, is gone, and the report did not name it or disable its plugin',
    })
  })

  it('matches a row whose id the Loader generated by its plugin, and still fails when one of a plugin\'s rows is gone', async () => {
    const port = await studioAnswering(204)
    const target: BootedRow[] = [{ id: 'c19d0a77', name: 'plugin-picker', disabled: false, state: 'active' }]
    const generated = [before('b08ab057', 'plugin-picker', true)]

    expect(await checkHealth(facts(port, { rows: () => target }), { ...NOTHING_NAMED, previousRows: generated })).toEqual({ passed: true })
    expect(await checkHealth(facts(port, { rows: () => target }), { ...NOTHING_NAMED, previousRows: [...generated, before('5e7a11d0', 'plugin-picker', true)] })).toEqual({
      passed: false, criterion: 'H3-only-named-disabled', detail: 'row 5e7a11d0 was in the profile before the update, is gone, and the report did not name it or disable its plugin',
    })
  })

  it('does not match a gone row with a stable id against another row of its plugin', async () => {
    const port = await studioAnswering(204)
    const target: BootedRow[] = [{ id: 'c19d0a77', name: 'plugin-guard', disabled: false, state: 'active' }]

    expect(await checkHealth(facts(port, { rows: () => target }), { ...NOTHING_NAMED, previousRows: [before('guard-main', 'plugin-guard')] })).toEqual({
      passed: false, criterion: 'H3-only-named-disabled', detail: 'row guard-main was in the profile before the update, is gone, and the report did not name it or disable its plugin',
    })
  })

  it('accepts a row disabled before the update under a generated id that the target disables under another', async () => {
    const port = await studioAnswering(204)
    const target: BootedRow[] = [{ id: 'c19d0a77', name: 'plugin-off', disabled: true, state: 'active' }]
    const previous: BootedRow[] = [{ id: 'b08ab057', name: 'plugin-off', disabled: true, state: 'active' }]

    expect(await checkHealth(facts(port, { rows: () => target }), { ...NOTHING_NAMED, previousFailures: inactiveRows(previous), previousRows: bootRowsOf(previous) })).toEqual({ passed: true })
  })

  it('fails H3 when a protected row\'s settings changed and the report did not name it, and passes when it did', async () => {
    const port = await studioAnswering(204)
    const manager: BootedRow = { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager', disabled: false, state: 'active', config: { protectedPlugins: ['@delorun/plugin-fetch-guard'] } }
    const guard = (block: boolean): BootedRow => ({ id: 'delorun-fetch-guard', name: '@delorun/plugin-fetch-guard', disabled: false, state: 'active', config: { block } })
    const previous = bootRowsOf([manager, guard(true)])

    expect(await checkHealth(facts(port, { rows: () => [manager, guard(true)] }), { ...NOTHING_NAMED, previousRows: previous })).toEqual({ passed: true })
    expect(await checkHealth(facts(port, { rows: () => [manager, guard(false)] }), { ...NOTHING_NAMED, previousRows: previous })).toEqual({
      passed: false, criterion: 'H3-only-named-disabled', detail: 'the settings of protected row delorun-fetch-guard changed and the report did not name it',
    })
    expect(await checkHealth(facts(port, { rows: () => [manager, guard(false)] }), { ...NOTHING_NAMED, namedRows: ['delorun-fetch-guard'], previousRows: previous })).toEqual({ passed: true })
  })

  describe('a reach row the predecessor applied while it ran', () => {
    const manager: BootedRow = { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager', disabled: false, state: 'active', config: { protectedPlugins: ['@delorun/reach'] } }
    const reach = (config: unknown): BootedRow => ({ id: 'delorun-reach', name: '@delorun/reach', disabled: false, state: 'active', config })
    // The owner's timeline: the predecessor booted with @delorun/bundle-local's row, then `delorun reach on` wrote the
    // profile's own row, which restates the switch and the whole option, and the running Host applied the option.
    const boot = { enabled: true, tailscalePrivate: { enabled: false, address: '', servePort: 443 } }
    const option = { enabled: true, address: 'https://home.example.ts.net', servePort: 443, listenerPort: 31318, serveCheckIntervalMs: 60000, elevationMinutes: 15 }
    const written = { enabled: true, tailscalePrivate: option }
    const handed = withAppliedConfig(bootRowsOf([manager, reach(boot)]), 'delorun-reach', appliedReachConfig(boot, option))
    // The successor's release adds rows elsewhere and changes nothing of the reach row.
    const added: BootedRow[] = [{ id: 'delorun-packs', name: '@delorun/plugin-packs', disabled: false, state: 'active', config: { concurrency: 2 } }, { id: 'delorun-requirements', name: '@delorun/bundle-local/requirements', disabled: false, state: 'active' }]
    const changed = { passed: false, criterion: 'H3-only-named-disabled', detail: 'the settings of protected row delorun-reach changed and the report did not name it' }

    it('fails H3 against the boot config alone, which the successor no longer boots with', async () => {
      const port = await studioAnswering(204)
      expect(await checkHealth(facts(port, { rows: () => [manager, reach(written), ...added] }), { ...NOTHING_NAMED, previousRows: bootRowsOf([manager, reach(boot)]) })).toEqual(changed)
    })

    it('passes H3 for the option the predecessor applied, whatever other rows the successor adds', async () => {
      const port = await studioAnswering(204)
      expect(await checkHealth(facts(port, { rows: () => [manager, reach(written), ...added] }), { ...NOTHING_NAMED, previousRows: handed })).toEqual({ passed: true })
    })

    it('still fails H3 when the file also changed a key the apply did not apply', async () => {
      const port = await studioAnswering(204)
      const switchedOff = reach({ ...written, enabled: false })
      const extra = reach({ ...written, tailscalePrivate: { ...option, funnel: true } })
      const another = reach({ ...written, other: 1 })
      for (const target of [switchedOff, extra, another]) {
        expect(await checkHealth(facts(port, { rows: () => [manager, target, ...added] }), { ...NOTHING_NAMED, previousRows: handed })).toEqual(changed)
      }
    })

    it('still fails H3 when the successor boots another option than the one applied, unless the report names the row', async () => {
      const port = await studioAnswering(204)
      const longer = reach({ ...written, tailscalePrivate: { ...option, elevationMinutes: 60 } })
      expect(await checkHealth(facts(port, { rows: () => [manager, longer, ...added] }), { ...NOTHING_NAMED, previousRows: handed })).toEqual(changed)
      expect(await checkHealth(facts(port, { rows: () => [manager, reach(boot), ...added] }), { ...NOTHING_NAMED, previousRows: handed })).toEqual(changed)
      expect(await checkHealth(facts(port, { rows: () => [manager, longer, ...added] }), { ...NOTHING_NAMED, namedRows: ['delorun-reach'], previousRows: handed })).toEqual({ passed: true })
    })
  })


  describe('the sandbox row\'s protection', () => {
    const manager: BootedRow = { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager', disabled: false, state: 'active', config: { protectedPlugins: ['@deepseek-ai/dsh-sandbox-local'] } }
    /**
     * A booted sandbox row whose config the start's overlay wrote: the layers' sockets, then the start's own.
     * @param protection - the start's protection.
     * @param layerSockets - the sockets a profile layer lists.
     * @param change - settings to replace.
     * @returns the row.
     */
    const sandbox = (protection: SandboxProtection, layerSockets: readonly string[] = [], change: Record<string, unknown> = {}): BootedRow => ({
      id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local', disabled: false, state: 'active',
      config: { networkAccess: false, protectedHome: protection.protectedHome, protectedHomeReadable: [...protection.protectedHomeReadable], deniedSockets: [...new Set([...layerSockets, ...protection.deniedSockets])], escapeSocketDirectories: [...protection.escapeSocketDirectories], privateTmp: protection.privateTmp, ...change },
    })
    /**
     * The expectations a Host booted with a sandbox row hands its successor.
     * @param rows - its rows.
     * @param protection - its start's protection.
     * @param layerSockets - the sockets a profile layer lists, which stay in what the successor is held to.
     * @returns the expectations.
     */
    const handedOver = (rows: readonly BootedRow[], protection: SandboxProtection, layerSockets: readonly string[] = []): HealthExpectations => {
      const previousProtection = bootProtectionOf(rows, protection.observedSockets.filter(socket => !layerSockets.includes(socket)))
      return { ...NOTHING_NAMED, previousRows: bootRowsOf(rows), ...previousProtection === undefined ? {} : { previousProtection } }
    }
    /**
     * A start's protection over a home whose Docker socket lies under a linked directory, as `/var/run/docker.sock`
     * does under `/run`, so its real path is a second spelling once the socket exists.
     * @returns the computer, and the protection before and after the socket appears.
     */
    async function dockerAppears(): Promise<{ readonly machine: string, readonly before: SandboxProtection, readonly after: SandboxProtection }> {
      const machine = mkdtempSync(join(tmpdir(), 'dhh-docker-'))
      directories.push(machine)
      mkdirSync(join(machine, 'run'))
      symlinkSync(join(machine, 'run'), join(machine, 'var-run'))
      const env = { DOCKER_HOST: `unix://${join(machine, 'var-run', 'docker.sock')}`, DOCKER_CONFIG: join(machine, 'no-config') }
      const before = await sandboxProtection(machine, 'default', env, machine, 4242)
      writeFileSync(join(machine, 'run', 'docker.sock'), '')
      const after = await sandboxProtection(machine, 'default', env, machine, 4242)
      expect(after.observedSockets).toEqual([join(machine, 'var-run', 'docker.sock'), join(machine, 'run', 'docker.sock')])
      return { machine, before, after }
    }

    it('passes H3 when a Docker socket appeared between the two starts', async () => {
      const port = await studioAnswering(204)
      const { before, after } = await dockerAppears()
      expect(await checkHealth(facts(port, { rows: () => [manager, sandbox(after)] }), handedOver([manager, sandbox(before)], before))).toEqual({ passed: true })
    })

    it('passes H3 when a layer lists the Docker socket\'s real path and the socket appeared between the two starts', async () => {
      const port = await studioAnswering(204)
      const { machine, before, after } = await dockerAppears()
      const listed = [join(machine, 'run', 'docker.sock')]
      expect(await checkHealth(facts(port, { rows: () => [manager, sandbox(after, listed)] }), handedOver([manager, sandbox(before, listed)], before, listed))).toEqual({ passed: true })
    })

    it('passes H3 for a stricter protection: more denied sockets and escape directories, fewer read exemptions', async () => {
      const port = await studioAnswering(204)
      const { before } = await dockerAppears()
      const stricter = sandbox(before, ['/srv/more.sock'], { protectedHomeReadable: before.protectedHomeReadable.slice(1), escapeSocketDirectories: [...before.escapeSocketDirectories, '/srv/escape'] })
      expect(await checkHealth(facts(port, { rows: () => [manager, stricter] }), handedOver([manager, sandbox(before)], before))).toEqual({ passed: true })
    })

    it.each([
      ['a dropped supervisor socket', (protection: SandboxProtection) => ({ deniedSockets: protection.deniedSockets.filter(socket => !socket.endsWith('supervisor.sock')) }), 'no longer denies'],
      ['a dropped escape directory', () => ({ escapeSocketDirectories: [] }), 'no longer hides /run/WSL, /run/user/4242'],
      ['the host\'s /tmp shown again', () => ({ privateTmp: false }), 'shows confined commands the host\'s /tmp'],
      ['a wider read exemption', (protection: SandboxProtection) => ({ protectedHomeReadable: [...protection.protectedHomeReadable, 'secrets'] }), 'lets confined commands read secrets'],
      ['another protected home', () => ({ protectedHome: '/elsewhere' }), 'protects /elsewhere instead of'],
      ['no protected home', () => ({ protectedHome: undefined }), 'sets no protected home'],
    ])('fails H3 for a weaker protection, %s, even when the report names the row', async (_case, weaken, detail) => {
      const port = await studioAnswering(204)
      const { before } = await dockerAppears()
      const verdict = await checkHealth(facts(port, { rows: () => [manager, sandbox(before, [], weaken(before))] }), { ...handedOver([manager, sandbox(before)], before), namedRows: ['sandbox'] })
      expect(verdict).toMatchObject({ passed: false, criterion: 'H3-only-named-disabled' })
      expect(verdict.passed ? '' : verdict.detail).toContain(detail)
    })

    it('fails H3 when an update drops a layer\'s Docker socket and the Docker context changed, so no start denies it', async () => {
      const port = await studioAnswering(204)
      const { machine, before } = await dockerAppears()
      const listed = [join(machine, 'var-run', 'docker.sock')]
      const switched = await sandboxProtection(machine, 'default', { DOCKER_HOST: 'tcp://127.0.0.1:2375', DOCKER_CONFIG: join(machine, 'no-config') }, machine, 4242)
      expect(switched.observedSockets).toEqual([])
      const verdict = await checkHealth(facts(port, { rows: () => [manager, sandbox(switched)] }), handedOver([manager, sandbox(before, listed)], before, listed))
      expect(verdict).toEqual({ passed: false, criterion: 'H3-only-named-disabled', detail: `the sandbox row's protection is weaker than before the update: it no longer denies ${listed.join(', ')}` })
    })

    it('fails H3 when a socket a profile layer lists is no longer denied', async () => {
      const port = await studioAnswering(204)
      const { before } = await dockerAppears()
      const verdict = await checkHealth(facts(port, { rows: () => [manager, sandbox(before)] }), handedOver([manager, sandbox(before, ['/srv/listed.sock'])], before))
      expect(verdict).toEqual({ passed: false, criterion: 'H3-only-named-disabled', detail: "the sandbox row's protection is weaker than before the update: it no longer denies /srv/listed.sock" })
    })

    it('still hashes the row\'s other settings', async () => {
      const port = await studioAnswering(204)
      const { before } = await dockerAppears()
      expect(await checkHealth(facts(port, { rows: () => [manager, sandbox(before, [], { networkAccess: true })] }), handedOver([manager, sandbox(before)], before))).toEqual({
        passed: false, criterion: 'H3-only-named-disabled', detail: 'the settings of protected row sandbox changed and the report did not name it',
      })
    })
  })

  it('passes with no bundle prediction without reading the profile', async () => {
    const port = await studioAnswering(204)

    expect(await checkHealth(facts(port, { profileDir: '/does/not/exist' }), NOTHING_NAMED)).toEqual({ passed: true })
  })

  it('passes H5 when the profile\'s bundle list is the predicted one', async () => {
    const port = await studioAnswering(204)
    const profileDir = profileWith(['bundle-a', 'bundle-b'])

    expect(await checkHealth(facts(port, { profileDir }), { ...NOTHING_NAMED, bundles: ['bundle-a', 'bundle-b'] })).toEqual({ passed: true })
  })

  it('fails H5 naming both lists when the bundle list differs in length or in order', async () => {
    const port = await studioAnswering(204)
    const profileDir = profileWith(['bundle-a', 'bundle-b'])

    expect(await checkHealth(facts(port, { profileDir }), { ...NOTHING_NAMED, bundles: ['bundle-a'] })).toEqual({
      passed: false, criterion: 'H5-bundle-list-predicted', detail: 'the bundle list is bundle-a, bundle-b; the report predicted bundle-a',
    })
    expect(await checkHealth(facts(port, { profileDir }), { ...NOTHING_NAMED, bundles: ['bundle-b', 'bundle-a'] })).toMatchObject({
      passed: false, criterion: 'H5-bundle-list-predicted',
    })
  })
})
