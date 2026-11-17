/**
 * Specs of the route registration over the production LLM runtime and Session store: the route is registered, lists no
 * model, and the adapter reads a seat child's facts from real Sessions.
 */
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { afterEach, describe, expect, it } from 'vitest'
import { SEAT_ROUTE_REFUSED } from '../../src/adapter/failure.ts'
import { registerSeatRoutes, type SeatRouteRegistration } from '../../src/adapter/register.ts'
import { CHILD, collect, finishOf, MemoryModels, MemoryStates, request, ROUTE, ScriptedGate, user } from './support.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** A context with the real runtime and store, a scripted gate, and the route registered. */
async function mounted(): Promise<{ ctx: Context, gate: ScriptedGate, routes: SeatRouteRegistration, states: MemoryStates }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  const gate = new ScriptedGate()
  ctx.provide('externalAgents', gate as never)
  const states = new MemoryStates()
  let routes: SeatRouteRegistration | undefined
  await ctx.plugin({
    name: 'seat-routes-under-test',
    inject: ['llm', 'sessions', 'externalAgents'],
    apply: (inner: Context) => {
      routes = registerSeatRoutes(inner, [
        { route: ROUTE, provider: 'claude-code', descriptorProvider: 'claude-code', displayName: 'Claude Code', contextWindow: 200_000 },
      ], {
        states, models: new MemoryModels(), workspaceOf: () => 'workspace-1', approve: () => Promise.resolve('reject'),
      })
    },
  })
  if (routes === undefined) throw new Error('the routes were not registered')
  return { ctx, gate, routes, states }
}

/**
 * @param ctx - the context.
 * @param id - the child id.
 * @param provider - the descriptor's provider.
 */
function seatChild(ctx: Context, id: SessionId, provider: string): void {
  const session = ctx.sessions.create(id, { meta: { cwd: '/work', parentSession: SessionId('root'), origin: 'subagent', delegationDepth: 1 } })
  session.append('subagent/descriptor', snapshotSubagentDescriptor({ mode: 'continuable', provider, label: 'task' }))
}

describe('registering the seat routes', () => {
  it('registers the route on ctx.llm with no listed model', async () => {
    const { ctx } = await mounted()
    expect(await ctx.llm.listModels(ROUTE)).toEqual([])
    const resolved = await ctx.llm.resolveModelInfo(ROUTE, 'default')
    expect(resolved).toMatchObject({ provider: ROUTE, inputModalities: ['text'], context: { contextWindow: 200_000 } })
  })

  it('serves a seat child read from real Sessions: the descriptor, the creator and the folder', async () => {
    const { ctx, gate } = await mounted()
    seatChild(ctx, CHILD, 'claude-code')
    gate.seats.set(CHILD, { child: CHILD, root: SessionId('root'), provider: 'claude-code' })
    const running = collect(ctx.llm.stream(request([user('task')])))
    await new Promise(resolve => setTimeout(resolve, 0))
    gate.latest.emit({ kind: 'turn-end', outcome: 'completed' })
    expect(finishOf(await running)).toEqual({ kind: 'stop' })
    expect(gate.starts[0]).toMatchObject({ creator: 'root', cwd: '/work', child: CHILD })
  })

  it('refuses a fork that copied the descriptor, since the gate holds no seat for it', async () => {
    const { ctx, gate } = await mounted()
    seatChild(ctx, CHILD, 'claude-code')
    gate.seats.set(CHILD, { child: CHILD, root: SessionId('root'), provider: 'claude-code' })
    const fork = SessionId('fork-1')
    seatChild(ctx, fork, 'claude-code')
    const chunks = await collect(ctx.llm.stream(request([user('task')], { sessionId: fork })))
    expect(finishOf(chunks)).toMatchObject({ kind: 'error', failure: { code: SEAT_ROUTE_REFUSED } })
    expect(gate.starts).toEqual([])
  })

  it('refuses a seat whose descriptor names a one-shot provider', async () => {
    const { ctx, gate } = await mounted()
    seatChild(ctx, CHILD, 'some-other-provider')
    gate.seats.set(CHILD, { child: CHILD, root: SessionId('root'), provider: 'claude-code' })
    const chunks = await collect(ctx.llm.stream(request([user('task')])))
    expect(finishOf(chunks)).toMatchObject({ kind: 'error', failure: { code: SEAT_ROUTE_REFUSED } })
  })
})
