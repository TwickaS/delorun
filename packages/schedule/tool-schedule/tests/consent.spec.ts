/** The optional Schedule consent seam: a composed consent names what an approved management call creates. */
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ScheduleConsentService, ScheduleEffect } from '@deepseek-ai/dsh-schedule'
import { agentFor, harness, mountToolSchedule } from './harness.ts'

const NOW = '2026-09-16T00:00:00.000Z'
const DAILY = 'DTSTART:20260916T010000Z\nRRULE:FREQ=DAILY'
const TASK = { title: 'Queue check', prompt: 'Check the queue', rrule: DAILY, target: 'this_session' }
const ASK_REASON = 'ask policy'
const NAMED = 'The recurring prompt would deliver to this session under its current preset.'

const tests: Awaited<ReturnType<typeof harness>>[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)) })
afterEach(async () => {
  await Promise.all(tests.splice(0).map(test => test.ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function setup(options: { consent?: ScheduleConsentService } = {}) {
  const test = await harness({ onContext: (ctx) => {
    if (options.consent !== undefined) ctx.provide('scheduleConsent', options.consent)
  } })
  tests.push(test)
  const agent = agentFor(test.ctx, 'original')
  await test.ctx.agents.register(agent)
  const scope = await mountToolSchedule(test.ctx, agent)
  return { ...test, agent, scope }
}
type Setup = Awaited<ReturnType<typeof setup>>

/** Approve every ask and record the request the pipeline audited. */
function approving(test: Setup) {
  const request = vi.fn(async () => 'allowed-once' as const)
  test.ctx.provide('approval', { request } as unknown as ApprovalService)
  return request
}

/** Turn every otherwise-allowed call into an ask, like a composed ask policy. */
function askPolicy(test: Setup): void {
  test.ctx.on('tools/pre-execute', async (_exec, next) => {
    const gate = await next()
    return gate.kind === 'allow' ? { kind: 'ask' as const, reason: ASK_REASON } : gate
  })
}

async function call(test: Setup, name: string, args: unknown) {
  const result = await executeToolFixture(test.ctx, {
    callId: ToolCallId('consent-call'), signal: new AbortController().signal, name, arguments: args, agent: test.agent,
  })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  return result.value
}

describe('Schedule consent approval naming', () => {
  it('keeps an ask approval unnamed without a composed consent', async () => {
    const test = await setup()
    const request = approving(test)
    askPolicy(test)
    await call(test, 'schedule_create', TASK)
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]?.[0]).toMatchObject({ toolName: 'schedule_create', reason: ASK_REASON })
  })

  it('names the created effect on a schedule_create approval', async () => {
    const nameEffect = vi.fn(() => NAMED)
    const test = await setup({ consent: { nameEffect, reviewDelivery: () => ({ kind: 'allow' }) } })
    const request = approving(test)
    askPolicy(test)
    await call(test, 'schedule_create', TASK)
    expect(request).toHaveBeenCalledOnce()
    expect(nameEffect).toHaveBeenCalledOnce()
    expect(nameEffect.mock.calls[0]?.[0]).toEqual({
      tool: 'schedule_create', recurrence: DAILY, targetSession: test.agent.session, targetPreset: undefined,
    } satisfies ScheduleEffect)
    expect(request.mock.calls[0]?.[0]?.reason).toBe(`${ASK_REASON} ${NAMED}`)
  })

  it('names the stored rule on a schedule_edit approval that restates none', async () => {
    const nameEffect = vi.fn(() => NAMED)
    const test = await setup({ consent: { nameEffect, reviewDelivery: () => ({ kind: 'allow' }) } })
    approving(test)
    const created = await call(test, 'schedule_create', TASK) as { id: string }
    nameEffect.mockClear()
    askPolicy(test)
    await call(test, 'schedule_edit', { id: created.id, action: 'update', title: 'Renamed' })
    expect(nameEffect).toHaveBeenCalledOnce()
    expect(nameEffect.mock.calls[0]?.[0]).toEqual({
      tool: 'schedule_edit', recurrence: DAILY, targetSession: test.agent.session, targetPreset: undefined,
    } satisfies ScheduleEffect)
  })

  it('keeps the approval unnamed when the consent names no effect', async () => {
    const test = await setup({ consent: { nameEffect: () => undefined, reviewDelivery: () => ({ kind: 'allow' }) } })
    const request = approving(test)
    askPolicy(test)
    await call(test, 'schedule_create', TASK)
    expect(request.mock.calls[0]?.[0]?.reason).toBe(ASK_REASON)
  })

  it('consults the consent only at approval time', async () => {
    const nameEffect = vi.fn(() => NAMED)
    const test = await setup({ consent: { nameEffect, reviewDelivery: () => ({ kind: 'allow' }) } })
    approving(test)
    await call(test, 'schedule_create', TASK)
    await call(test, 'schedule_list', {})
    expect(nameEffect).not.toHaveBeenCalled()
  })
})
