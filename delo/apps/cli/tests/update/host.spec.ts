/**
 * The Host side of `delorun update` (contracts C19 and C3), over a real cordis context and a real
 * `CountingChatGate`: how running chats are counted and cancelled, how a new turn is refused while the gate is held,
 * which booted rows count as inactive, and each of C3's health criteria H1 to H5 against local HTTP servers and a
 * profile `package.json` in a temporary directory.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobEvent, JobEventListener, JobView } from '@deepseek-ai/dsh-jobs'
import * as UpdateGate from '@delo/bundle-local/update-gate'
import { CountingChatGate } from '@delo/home-process'
import type { BootedRow } from '../../src/delo-bundles.ts'
import { checkHealth, inactiveRows, STOP_REASON, watchChats, type HostHealthFacts } from '../../src/update/host.ts'

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

    expect(first.cancellations).toEqual([{ kind: 'hook', reason: 'Delo is stopping or updating' }])
    expect(second.cancellations).toEqual([{ kind: 'hook', reason: 'Delo is stopping or updating' }])
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

describe('watchChats and the update gate of @delo/bundle-local', () => {
  it('holds new turns back exactly while the chat gate is held, once the row\'s service is mounted', async () => {
    const ctx = new Context()
    const gate = new CountingChatGate()
    watchChats(ctx, gate)
    await ctx.plugin(UpdateGate, { enabled: true })
    await settle()

    expect(ctx.deloTurnGate.held).toBe(false)
    const release = gate.hold()
    expect(ctx.deloTurnGate.held).toBe(true)
    release()
    expect(ctx.deloTurnGate.held).toBe(false)
    await ctx.fiber.dispose()
  })

  it('detaches from the service when the watch goes, so a held gate no longer refuses turns', async () => {
    const ctx = new Context()
    const gate = new CountingChatGate()
    const service = new UpdateGate.UpdateTurnGateService(new Context())
    const unprovide = ctx.provide('deloTurnGate', service)
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

  it('lists the rows that are disabled or did not start, and none of the active ones', () => {
    const rows = [
      row({ id: 'active' }),
      row({ id: 'off', disabled: true }),
      row({ id: 'broken', state: 'failed' }),
      row({ id: 'waiting', state: 'pending' }),
      row({ id: 'skipped', state: 'not-imported' }),
      row({ id: 'off-and-failed', disabled: true, state: 'failed' }),
    ]

    expect(inactiveRows(rows)).toEqual(['off', 'broken', 'waiting', 'skipped', 'off-and-failed'])
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
   * Start a loopback HTTP server that answers every request with one status.
   * @param status - the status.
   * @param host - the address to bind.
   * @returns the port.
   */
  async function studioAnswering(status: number, host = '127.0.0.1'): Promise<number> {
    const server = createServer((_request, response) => { response.writeHead(status).end(status === 200 ? 'index' : undefined) })
    servers.push(server)
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve) })
    return (server.address() as AddressInfo).port
  }

  /** @returns a port nothing listens on. */
  async function closedPort(): Promise<number> {
    const port = await studioAnswering(200)
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

  it('fails H2 with the status when the studio index answers anything but 200', async () => {
    const port = await studioAnswering(500)

    const verdict = await checkHealth(facts(port), undefined)

    expect(verdict).toEqual({ passed: false, criterion: 'H2-host-ready', detail: 'the studio\'s index answered 500' })
  })

  it('fails H2 when the studio answers 204, an answer that has no body to read', async () => {
    const port = await studioAnswering(204)

    const verdict = await checkHealth(facts(port), undefined)

    expect(verdict).toMatchObject({ passed: false, criterion: 'H2-host-ready', detail: 'the studio\'s index answered 204' })
  })

  it('fails H2 with the connection error when nothing listens on the studio port', async () => {
    const verdict = await checkHealth(facts(await closedPort()), undefined)

    expect(verdict).toMatchObject({ passed: false, criterion: 'H2-host-ready' })
    expect((verdict as { readonly detail: string }).detail).toMatch(/^the studio's index did not answer: /u)
  })

  it('fails H2 with the text of a request failure that is not an Error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue('socket hung up')

    const verdict = await checkHealth(facts(1), undefined)

    expect(verdict).toEqual({ passed: false, criterion: 'H2-host-ready', detail: 'the studio\'s index did not answer: socket hung up' })
  })

  it('asks an IPv6 studio listener at its bracketed address', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))

    const verdict = await checkHealth(facts(0, { studio: () => ({ host: '::1', port: 4000 }) }), undefined)

    expect(verdict).toEqual({ passed: true })
    expect(String(fetched.mock.calls[0]?.[0])).toBe('http://[::1]:4000/')
  })

  it('passes H1 and H2 alone when the report predicted nothing', async () => {
    const port = await studioAnswering(200)
    const rows: BootedRow[] = [{ id: 'unnamed', name: 'broken', disabled: true, state: 'failed' }]

    expect(await checkHealth(facts(port, { rows: () => rows }), undefined)).toEqual({ passed: true })
  })

  it('asks a studio on an IPv6 loopback address by its bracketed host', async () => {
    let port: number
    try {
      port = await studioAnswering(200, '::1')
    } catch (_noIpv6) {
      // This machine has no IPv6 loopback address, so the bracketed form cannot be exercised.
      return
    }

    const verdict = await checkHealth(facts(port, { studio: () => ({ host: '::1', port }) }), undefined)

    expect(verdict).toEqual({ passed: true })
  })

  it('fails H3 for a disabled row the report did not name, and H4 for a row that did not load', async () => {
    const port = await studioAnswering(200)
    const disabled: BootedRow = { id: 'row-off', name: 'plugin-off', disabled: true, state: 'active' }
    const failed: BootedRow = { id: 'row-bad', name: 'plugin-bad', disabled: false, state: 'failed' }

    expect(await checkHealth(facts(port, { rows: () => [disabled] }), NOTHING_NAMED)).toEqual({
      passed: false, criterion: 'H3-only-named-disabled', detail: 'row row-off is disabled and the report did not name it',
    })
    expect(await checkHealth(facts(port, { rows: () => [failed] }), NOTHING_NAMED)).toEqual({
      passed: false, criterion: 'H4-unnamed-rows-load', detail: 'row row-bad did not load (failed) and the report did not name it',
    })
  })

  it('accepts an inactive row the report named by id, one it listed as a previous failure and one of a disabled plugin', async () => {
    const port = await studioAnswering(200)
    const rows: BootedRow[] = [
      { id: 'named', name: 'plugin-1', disabled: true, state: 'active' },
      { id: 'failed-before', name: 'plugin-2', disabled: false, state: 'failed' },
      { id: 'of-a-disabled-plugin', name: 'plugin-3', disabled: false, state: 'not-imported' },
      { id: 'fine', name: 'plugin-4', disabled: false, state: 'active' },
      { id: 'loader-id', name: 'plugin-5', disabled: true, state: 'active' },
    ]
    const expectations = { namedRows: ['named', 'plugin-5', 'dropped-but-named'], previousFailures: ['failed-before'], previousRows: ['named', 'fine', 'dropped-but-named'], disabledPlugins: ['plugin-3'] }

    expect(await checkHealth(facts(port, { rows: () => rows }), expectations)).toEqual({ passed: true })
  })

  it('fails H3 when a row the profile had before the update is gone and the report did not name it', async () => {
    const port = await studioAnswering(200)
    const rows: BootedRow[] = [{ id: 'kept', name: 'plugin-1', disabled: false, state: 'active' }]

    expect(await checkHealth(facts(port, { rows: () => rows }), { ...NOTHING_NAMED, previousRows: ['kept', 'dropped'] })).toEqual({
      passed: false, criterion: 'H3-only-named-disabled', detail: 'row dropped was in the profile before the update, is gone, and the report did not name it',
    })
  })

  it('passes with no bundle prediction without reading the profile', async () => {
    const port = await studioAnswering(200)

    expect(await checkHealth(facts(port, { profileDir: '/does/not/exist' }), NOTHING_NAMED)).toEqual({ passed: true })
  })

  it('passes H5 when the profile\'s bundle list is the predicted one', async () => {
    const port = await studioAnswering(200)
    const profileDir = profileWith(['bundle-a', 'bundle-b'])

    expect(await checkHealth(facts(port, { profileDir }), { ...NOTHING_NAMED, bundles: ['bundle-a', 'bundle-b'] })).toEqual({ passed: true })
  })

  it('fails H5 naming both lists when the bundle list differs in length or in order', async () => {
    const port = await studioAnswering(200)
    const profileDir = profileWith(['bundle-a', 'bundle-b'])

    expect(await checkHealth(facts(port, { profileDir }), { ...NOTHING_NAMED, bundles: ['bundle-a'] })).toEqual({
      passed: false, criterion: 'H5-bundle-list-predicted', detail: 'the bundle list is bundle-a, bundle-b; the report predicted bundle-a',
    })
    expect(await checkHealth(facts(port, { profileDir }), { ...NOTHING_NAMED, bundles: ['bundle-b', 'bundle-a'] })).toMatchObject({
      passed: false, criterion: 'H5-bundle-list-predicted',
    })
  })
})
