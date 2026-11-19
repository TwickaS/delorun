/**
 * Denial specs of the seat route (EA2, D13): it serves only a seat child's own turn. Everything else gets one error
 * finish with the fixed sentence and touches no program.
 */
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { SEAT_ROUTE_REFUSED, SEAT_ROUTE_REFUSED_MESSAGE } from '../../src/adapter/failure.ts'
import { collect, request, user, world } from './support.ts'

const refused = [{
  type: 'finish',
  reason: { kind: 'error', failure: { message: SEAT_ROUTE_REFUSED_MESSAGE, code: SEAT_ROUTE_REFUSED } },
}]

describe('the seat route refuses anything that is not a seat child\'s own turn', () => {
  it('refuses an ordinary chat that selects the route', async () => {
    const w = world()
    const chunks = await collect(w.adapter.stream(request([user('hello')], { sessionId: SessionId('ordinary-chat') })))
    expect(chunks).toEqual(refused)
    expect(w.gate.starts).toEqual([])
    expect(w.states.writes).toEqual([])
    expect(w.reports.starting).toEqual([])
  })

  it('refuses a request with no session id', async () => {
    const w = world()
    const chunks = await collect(w.adapter.stream({ provider: 'delorun-seat-claude-code', model: 'default', messages: [user('hello')] }))
    expect(chunks).toEqual(refused)
    expect(w.gate.starts).toEqual([])
  })

  it('refuses a child with no creator, though its descriptor names the route\'s provider', async () => {
    const w = world({ host: { descriptorProvider: () => 'claude-code', creator: () => undefined }, seat: false })
    expect(await collect(w.adapter.stream(request([user('task')])))).toEqual(refused)
    expect(w.gate.starts).toEqual([])
  })

  it('starts the first turn of a child the gate has not registered yet, leaving the consent to the gate', async () => {
    const w = world({ seat: false })
    void collect(w.adapter.stream(request([user('task')])))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(w.gate.starts).toHaveLength(1)
  })

  it('refuses a child whose descriptor names another subagent provider, though the gate holds a seat', async () => {
    const w = world({ host: { descriptorProvider: () => 'some-other-provider' } })
    expect(await collect(w.adapter.stream(request([user('task')])))).toEqual(refused)
    expect(w.gate.starts).toEqual([])
  })

  it('refuses a child with no readable descriptor', async () => {
    const w = world({ host: { descriptorProvider: () => undefined } })
    expect(await collect(w.adapter.stream(request([user('task')])))).toEqual(refused)
  })

  it('refuses a seat of the other agent on this agent\'s route', async () => {
    const w = world()
    w.gate.seats.set(SessionId('child-1'), { child: SessionId('child-1'), root: SessionId('root'), provider: 'codex' })
    expect(await collect(w.adapter.stream(request([user('task')])))).toEqual(refused)
    expect(w.gate.starts).toEqual([])
  })

  it('refuses a request that selects another route of the same seat child', async () => {
    const w = world()
    expect(await collect(w.adapter.stream(request([user('task')], { provider: 'deepseek' })))).toEqual(refused)
  })

  it.each(['session-title', 'compaction'] as const)('refuses a %s request, even for a real seat child', async (purpose) => {
    const w = world()
    const chunks = await collect(w.adapter.stream(request([user('summarise this')], { purpose })))
    expect(chunks).toEqual(refused)
    expect(w.gate.starts).toEqual([])
    expect(w.gate.programs).toEqual([])
  })

  it('serves a seat child\'s own turn', async () => {
    const w = world()
    const run = collect(w.adapter.stream(request([user('task')])))
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    w.gate.latest.emit({ kind: 'turn-end', outcome: 'completed' })
    const chunks = await run
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(w.gate.starts).toHaveLength(1)
  })
})

describe('the seat route stays out of pickers', () => {
  it('lists no models', async () => {
    const w = world()
    expect(await w.adapter.listModels()).toEqual([])
  })

  it('names the provider as an external agent, not a chat model', () => {
    expect(world().adapter.providerInfo('delorun-seat-claude-code')).toEqual({ id: 'delorun-seat-claude-code', name: 'Claude Code (external agent, not a chat model)' })
  })

  it('reports the program\'s window and text-only input, and no reasoning', async () => {
    const info = await world().adapter.resolveModel('delorun-seat-claude-code', 'default')
    expect(info).toEqual({ provider: 'delorun-seat-claude-code', id: 'default', name: 'Claude Code', inputModalities: ['text'], context: { contextWindow: 200_000 } })
    expect(info.reasoning).toBeUndefined()
  })
})
