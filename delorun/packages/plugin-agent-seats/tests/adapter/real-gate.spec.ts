/**
 * The seat adapter over the real start gate (`ExternalAgentsService`) and a consent that refuses: a child the gate has
 * not registered yet, whose descriptor names the route's provider and which has a creator, reaches the gate on its
 * first turn. The gate refuses it before any program opens, and the chat logs no `starting` state.
 */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import {
  DELEGATION_CONSENT_ROW_ID, ExternalAgentsService, type ExternalAgentDriver, type ProgramOpenRequest, type ProgramSession, type SeatConsent, type SeatReview,
} from '@delorun/external-agents'
import { afterEach, describe, expect, it } from 'vitest'
import { registerSeatRoutes } from '../../src/adapter/register.ts'
import { agentSeatProjection, SeatRecords } from '../../src/state/index.ts'
import { collect, finishOf, MemoryModels, MemoryStates, request, ROUTE, user } from './support.ts'
import { describeSeat } from '../state/support.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** A driver that records each open and would start a program. */
class CountingDriver implements ExternalAgentDriver {
  readonly provider = 'claude-code'
  readonly opens: ProgramOpenRequest[] = []

  open(openRequest: ProgramOpenRequest): Promise<ProgramSession> {
    this.opens.push(openRequest)
    return Promise.reject(new Error('the gate opened a program it should have refused'))
  }

  probe(): Promise<never> {
    return Promise.reject(new Error('no limits check in this spec'))
  }
}

/** A consent that refuses every seat review and keeps no lease. */
class RefusingConsent implements Pick<SeatConsent, 'reviewSeat' | 'leaseOf' | 'endLease' | 'onLeaseEnded' | 'runRules' | 'addRunRule'> {
  readonly reviews: SeatReview[] = []

  reviewSeat(review: SeatReview): Promise<{ readonly kind: 'refuse', readonly reason: string }> {
    this.reviews.push(review)
    return Promise.resolve({ kind: 'refuse', reason: 'The person declined.' })
  }

  leaseOf(): undefined { return undefined }

  endLease(): void {}

  onLeaseEnded(): () => void { return () => {} }

  runRules(): readonly [] { return [] }

  addRunRule(): boolean { return false }
}

describe('a first turn of an unregistered seat child on the real gate', () => {
  it('ends with the consent refusal, opens no program and logs no starting state', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await mountAgentLoopTestHarness(ctx)
    if (ctx.get('sessionProjections') === undefined) await ctx.plugin(SessionProjectionRegistry)
    const records = new SeatRecords(ctx.sessions, await ctx.sessionProjections.register(agentSeatProjection()))
    const root = (await ctx.agents.create({ sessionId: SessionId('root'), meta: { cwd: '/work' }, agentOptions: { provider: 'claude-code-seat', model: 'program' } })).agent
    const child = (await ctx.agents.create({
      sessionId: SessionId('seat-child'), meta: { cwd: '/work', parentSession: root.id, origin: 'subagent' }, agentOptions: { provider: 'claude-code-seat', model: 'program' },
    })).agent
    describeSeat(child.session, 'claude-code')
    const consent = new RefusingConsent()
    ctx.provide('delegationConsent', consent as never)
    ctx.provide('subagents', { rootOf: () => root } as never)
    ctx.provide('loader', {
      entries: () => [{ id: DELEGATION_CONSENT_ROW_ID, options: { id: DELEGATION_CONSENT_ROW_ID, config: { enabled: true } }, disabled: false }],
      unwrapExports: (exports: unknown) => exports,
    } as never)
    await ctx.plugin(ExternalAgentsService, {
      maxLivePrograms: 4, graceMs: 100, limitRefusal: false, env: { PATH: '/bin' }, now: () => 1_000_000, probeFolder: () => Promise.resolve('/tmp'),
      programRecords: undefined, processTable: undefined, programExecutables: () => [], programScripts: () => [],
    })
    const driver = new CountingDriver()
    ctx.externalAgents.registerDriver(driver)
    const starting: string[] = []
    await ctx.plugin({
      name: 'seat-routes-under-real-gate',
      inject: ['llm', 'sessions', 'externalAgents'],
      apply: (inner: Context) => {
        registerSeatRoutes(inner, [
          { route: ROUTE, provider: 'claude-code', descriptorProvider: 'claude-code', displayName: 'Claude Code', recordPrefix: 'claude_code.', contextWindow: 200_000 },
        ], {
          states: new MemoryStates(), models: new MemoryModels(), descriptorOf: id => records.providerOf(id), workspaceOf: () => 'workspace-1',
          approve: () => Promise.resolve('reject'), events: { onStarting: (id) => { starting.push(id) } },
        })
      },
    })
    expect(ctx.externalAgents.seat(child.id)).toBeUndefined()

    const chunks = await collect(ctx.llm.stream(request([user('task')], { sessionId: child.id })))

    expect(finishOf(chunks)).toMatchObject({ kind: 'error', failure: { code: 'EXTERNAL_AGENT_CONSENT' } })
    expect(consent.reviews.map(review => [review.phase, review.child.id])).toEqual([['hand-off', child.id]])
    expect(driver.opens).toEqual([])
    expect(starting).toEqual([])
    expect(ctx.externalAgents.seat(child.id)).toBeUndefined()
  })
})
