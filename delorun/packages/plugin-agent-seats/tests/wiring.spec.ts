/**
 * The plugin entry on a real subagent runtime, tool runtime, session store and model registry, with stand-ins for the
 * services the profile supplies: with the preview flag off nothing a model or a person meets is registered, and with it
 * on the hand-off tools, providers, model routes, presets and Host routes are.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { onTestFinished } from 'vitest'
import { describe, expect, it, vi } from 'vitest'
import type { SeatLease, SeatLeaseEnd } from '@delorun/external-agents/contract'
import * as Plugin from '../src/index.ts'
import { Config, LIVE_AGENTS, mountSeats, type SeatRelayHook } from '../src/index.ts'
import { LEASE_END_TEXT } from '../src/lease.ts'
import { CHOOSE_MODEL_PATH, MODEL_CHOICES_FILE, RESUME_PATH } from '../src/state/index.ts'
import { captureWarnings, FakeConnection, FakeFlags, FakePresets, FakeProfile } from './mount-support.ts'
import { FakeGate, FixtureWorkingDirectory } from './provider/harness.ts'

/** A consent service that tells when a lease ends. */
class FakeConsent extends Service {
  readonly listeners = new Set<(lease: SeatLease, reason: SeatLeaseEnd) => void>()

  constructor(ctx: Context) {
    super(ctx, 'delegationConsent')
  }

  onLeaseEnded(listener: (lease: SeatLease, reason: SeatLeaseEnd) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

interface World {
  readonly ctx: Context
  readonly flags: FakeFlags
  readonly connection: FakeConnection
  readonly presets: FakePresets
  readonly dir: string
}

/**
 * The services the profile supplies, without the plugin.
 * @param on - whether the preview flag is on.
 * @returns the context and the stand-ins.
 */
async function world(on: boolean): Promise<World> {
  FakeFlags.on = on
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const dir = await mkdtemp(join(tmpdir(), 'ea2-seat-wiring-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(FixtureWorkingDirectory)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(FakeGate)
  await ctx.plugin(FakeFlags)
  await ctx.plugin(FakePresets)
  await ctx.plugin(FakeProfile, dir)
  await ctx.plugin(FakeConnection)
  // The question relay needs these services; the surface under test never asks a question.
  for (const service of ['approval', 'agents'] as const) if (ctx.get(service) === undefined) ctx.provide(service, {} as never)
  return { ctx, flags: ctx.previewFlags as FakeFlags, connection: ctx.connection as unknown as FakeConnection, presets: ctx.agentPresets as unknown as FakePresets, dir }
}

/** What a chat's model and a person can meet: tool names, subagent providers and model providers. */
function surface(ctx: Context): { readonly tools: (string | undefined)[], readonly providers: (string | undefined)[], readonly models: string[] } {
  return {
    tools: ['claude_code', 'codex'].map(name => ctx.tools.get(name)?.name),
    providers: ['claude-code-seat', 'codex-seat'].map(name => ctx.subagents.getProvider(name)?.name),
    models: ctx.llm.listProviders().map(provider => provider.id).sort(),
  }
}

describe('the plugin with the preview flag off', () => {
  it('declares the flag and registers nothing else', async () => {
    const { ctx, flags, connection, presets } = await world(false)
    const baseline = surface(ctx)
    await ctx.plugin(Plugin, Config(null))
    expect(flags.declared.map(flag => flag.id)).toEqual([LIVE_AGENTS.id])
    expect(surface(ctx)).toEqual(baseline)
    expect(baseline.tools).toEqual([undefined, undefined])
    expect(baseline.providers).toEqual([undefined, undefined])
    expect(presets.definitions).toEqual([])
    expect(connection.routes).toEqual([])
    expect(ctx.get('seatPrograms')).toBeUndefined()
  })
})

describe('the plugin with the preview flag on', () => {
  it('registers the hand-off tools, providers, model routes, presets and Host routes', async () => {
    const { ctx, connection, presets } = await world(true)
    const baseline = surface(ctx)
    await ctx.plugin(Plugin, Config(null))
    expect(surface(ctx).tools).toEqual(['claude_code', 'codex'])
    expect(surface(ctx).providers).toEqual(['claude-code-seat', 'codex-seat'])
    expect(surface(ctx).models).toEqual([...baseline.models, 'claude-code-seat', 'codex-seat'].sort())
    expect(presets.definitions.map(definition => definition.id)).toEqual(['claude-code-seat', 'codex-seat'])
    expect(connection.routes.map(route => [route.path, route.methods])).toEqual([[RESUME_PATH, ['POST']], [CHOOSE_MODEL_PATH, ['POST']]])
    expect(ctx.get('seatPrograms')).toBeDefined()
  })

  it('lists no model for a seat route, so no picker shows it', async () => {
    const { ctx } = await world(true)
    await ctx.plugin(Plugin, Config(null))
    await expect(ctx.llm.listModels('claude-code-seat')).resolves.toEqual([])
    await expect(ctx.llm.listModels('codex-seat')).resolves.toEqual([])
  })

  it('admits no reach device to a Host route while the home is not mounted', async () => {
    const { ctx, connection } = await world(true)
    await ctx.plugin(Plugin, Config(null))
        const route = connection.routes.find(candidate => candidate.path === RESUME_PATH)!
    // No home-auth service is mounted, so no device is admitted; the owner's Peer never reaches admitPeer.
    const peer = { principal: { kind: 'reach-device' } } as Parameters<NonNullable<typeof route.admitPeer>>[1]
    expect(route.admitPeer?.(new Request('http://127.0.0.1/api/agentSeat.resume', { method: 'POST' }), peer)).toBe(false)
  })

  it('withdraws everything when the plugin stops', async () => {
    const { ctx, connection, presets } = await world(true)
    const fiber = ctx.plugin(Plugin, Config(null))
    await fiber.await()
    await fiber.dispose()
    expect(surface(ctx).tools).toEqual([undefined, undefined])
    expect(surface(ctx).providers).toEqual([undefined, undefined])
    expect(presets.definitions).toEqual([])
    expect(connection.routes).toEqual([])
  })

  it('fails loud on a seat list the provider side cannot serve, before registering a route', async () => {
    const { ctx, connection } = await world(true)
    const [first] = Config(null).seats
    await expect(mountSeats(ctx, { seats: [{ ...first!, provider: 'gemini' }] })).rejects.toThrow(/not an external agent/)
    expect(connection.routes).toEqual([])
  })
})

describe('a profile with no folder', () => {
  it('refuses to mount, naming the missing folder, before registering anything', async () => {
    FakeFlags.on = true
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await expect(mountSeats(ctx, Config(null))).rejects.toThrow('this profile has none')
  })
})

describe('the relay seam', () => {
  it('rejects a program\'s question while no relay is supplied', async () => {
    const { ctx } = await world(true)
    const mounted = await mountSeats(ctx, Config(null))
    expect(mounted.routes.map(route => route.path)).toEqual([RESUME_PATH, CHOOSE_MODEL_PATH])
  })

  it('builds the relay from the mounted state and the exact seat provider names', async () => {
    const { ctx } = await world(true)
    const seen: { providers?: ReadonlySet<string>, state?: object } = {}
    const relay: SeatRelayHook = (wiring) => {
      seen.providers = wiring.seatProviders
      seen.state = wiring.state
      return () => () => Promise.resolve('reject')
    }
    const mounted = await mountSeats(ctx, Config(null), { relay })
    expect([...seen.providers ?? []]).toEqual(['claude-code-seat', 'codex-seat'])
    expect(seen.state).toBe(mounted)
  })
})

describe('the end of a lease', () => {
  it('tells the seat\'s chat why its agent stopped', async () => {
    const { ctx } = await world(true)
    await ctx.plugin(FakeConsent)
    const mounted = await mountSeats(ctx, Config(null))
    const session = ctx.sessions.create()
    session.append('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'claude-code-seat', label: 'task' })
    const child = session.header.id
    mounted.events.onStarting?.(child, 'claude-code')
    const consent = ctx.get('delegationConsent') as unknown as FakeConsent
    const lease: SeatLease = { child, root: child, workspace: 'w', cwd: '/work', provider: 'claude-code', workspaceListed: false, grantedAt: 0, why: 'asked' }
    for (const listener of consent.listeners) listener(lease, 'archived')
    expect(mounted.store.viewOf(child)).toMatchObject({ state: 'ended', endedReason: LEASE_END_TEXT.archived })
  })

  it('mounts beside a consent service that cannot tell when a lease ends', async () => {
    const { ctx } = await world(true)
    ctx.provide('delegationConsent', {} as never)
    const mounted = await mountSeats(ctx, Config(null))
    expect(mounted.routes).toHaveLength(2)
  })

  it('says nothing about a lease whose child never ran as a seat', async () => {
    const { ctx } = await world(true)
    await ctx.plugin(FakeConsent)
    const mounted = await mountSeats(ctx, Config(null))
    const consent = ctx.get('delegationConsent') as unknown as FakeConsent
    const session = ctx.sessions.create()
    const lease: SeatLease = { child: session.header.id, root: session.header.id, workspace: 'w', cwd: '/work', provider: 'codex', workspaceListed: false, grantedAt: 0, why: 'asked' }
    for (const listener of consent.listeners) listener(lease, 'revoked')
    expect(mounted.store.viewOf(session.header.id)).toBeNull()
  })

  it('does not touch a chat whose Session is not loaded', async () => {
    const { ctx } = await world(true)
    await ctx.plugin(FakeConsent)
    await mountSeats(ctx, Config(null))
    const consent = ctx.get('delegationConsent') as unknown as FakeConsent
    const gone = SessionId('archived-away')
    const lease: SeatLease = { child: gone, root: gone, workspace: 'w', cwd: '/work', provider: 'codex', workspaceListed: false, grantedAt: 0, why: 'asked' }
    expect(() => { for (const listener of consent.listeners) listener(lease, 'archived') }).not.toThrow()
  })
})

/** A request as the Connection's `connection/request` waterfall receives it, and the response it is answered with. */
function arrival(url: string) {
  const request = new IncomingMessage(new Socket())
  request.url = url
  request.headers.host = 'localhost:3080'
  const response = new ServerResponse(request)
  const writeHead = vi.spyOn(response, 'writeHead').mockReturnValue(response)
  const end = vi.spyOn(response, 'end').mockReturnValue(response)
  return { request, response, writeHead, end }
}

describe('who may reach the Host routes', () => {
  it('refuses a request for a seat route while the home is not mounted, before the route reads it', async () => {
    const { ctx } = await world(true)
    await mountSeats(ctx, Config(null))
    const { request, response, writeHead } = arrival(RESUME_PATH)
    const next = vi.fn(async () => {})
    await ctx.waterfall('connection/request', request, response, next)
    expect([next.mock.calls.length, writeHead.mock.calls[0]?.[0]]).toEqual([0, 403])
  })

  it('leaves every other path to the rest of the Connection', async () => {
    const { ctx } = await world(true)
    await mountSeats(ctx, Config(null))
    const { request, response, writeHead } = arrival('/api/somethingElse')
    const next = vi.fn(async () => {})
    await ctx.waterfall('connection/request', request, response, next)
    expect([next.mock.calls.length, writeHead.mock.calls.length]).toEqual([1, 0])
  })
})

describe('a mounted seat with no open program', () => {
  it('has nothing to stop and offers no live program to the executor', async () => {
    const { ctx } = await world(true)
    const mounted = await mountSeats(ctx, Config(null))
    const child = SessionId('no-program')
    await expect(mounted.stop(child)).resolves.toBe('none')
    expect(mounted.programs.program(child)).toBeUndefined()
  })

  it('tells the log when a model pick cannot be saved, and keeps the pick for the run', async () => {
    const { ctx, dir } = await world(true)
    const warnings = captureWarnings(ctx)
    const mounted = await mountSeats(ctx, Config(null))
    // A directory where the pick's temporary file goes makes the write fail.
    await mkdir(join(dir, `${MODEL_CHOICES_FILE}.${String(process.pid)}.tmp`))
    mounted.choices.set('w', 'model-a')
    await mounted.settled()
    expect(mounted.choices.get('w')).toBe('model-a')
    expect(warnings.join('\n')).toContain('the model pick could not be saved')
  })
})
