/** The optional Schedule consent seam: a composed consent reviews each due delivery before it wakes its Session. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createRRuleScheduleRecord, ScheduleId } from '../src/domain.ts'
import type { ScheduleConsentService, ScheduleDeliveryReview, ScheduleDeliveryVerdict } from '../src/types.ts'
import { agentFor, boundTask, harness, seedTasks, taskTable, SEED_TIME, type HarnessAgent } from './harness.ts'

const ONCE = 'DTSTART:20260916T000001Z\nRRULE:FREQ=DAILY;COUNT=1'
const REFUSAL = 'the target Session moved wider than the creation preset'

const active: Awaited<ReturnType<typeof harness>>[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-09-16T00:00:00Z') })
afterEach(async () => {
  await Promise.all(active.splice(0).map(test => test.ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function setup(options: {
  consent?: ScheduleConsentService
  seed?: Parameters<typeof seedTasks>[1]
} = {}) {
  const test = await harness({
    beforeService: async (ctx, facility) => {
      if (options.seed !== undefined) await seedTasks(facility, options.seed)
    },
    onContext: (ctx) => {
      if (options.consent !== undefined) ctx.provide('scheduleConsent', options.consent)
    },
  })
  active.push(test)
  return test
}

/** Deliver one due one-shot task to a live target Session and return its stored state. */
async function dueTask(test: Awaited<ReturnType<typeof setup>>, target: HarnessAgent) {
  test.resolve.mockResolvedValue({ agent: target })
  return await test.service.remoteCreate({
    title: 'Deliver', prompt: 'Deliver', timing: { kind: 'rrule', rrule: ONCE },
    target: { kind: 'session', sessionId: target.session.id },
  })
}

it('delivers a due task exactly upstream when no consent is composed', async () => {
  const test = await setup()
  const target = agentFor(test.ctx, 'target')
  const created = await dueTask(test, target)
  await vi.advanceTimersByTimeAsync(1000)
  expect(await test.service.view({ id: created.id })).toMatchObject({
    status: 'ended', lastDelivery: { targetSessionId: target.session.id },
  })
  expect(target.followup).toHaveBeenCalledOnce()
})

it('pauses a due delivery the consent refuses, wakes nobody, and reports the reason', async () => {
  const test = await setup({ consent: {
    nameEffect: () => undefined,
    reviewDelivery: () => ({ kind: 'refuse', reason: REFUSAL }),
  } })
  const warn = vi.spyOn(test.ctx.logger, 'warn')
  const target = agentFor(test.ctx, 'target')
  const created = await dueTask(test, target)
  await vi.advanceTimersByTimeAsync(1000)
  const stored = await test.service.view({ id: created.id })
  expect(stored).toMatchObject({ status: 'paused' })
  expect(stored).not.toHaveProperty('lastDelivery')
  expect(target.followup).not.toHaveBeenCalled()
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('schedule_consent_refused'))
  expect(warn).toHaveBeenCalledWith(expect.stringContaining(REFUSAL))
})

it('refuses a manual run with the typed schedule/consent-refused error', async () => {
  const test = await setup({ consent: {
    nameEffect: () => undefined,
    reviewDelivery: () => ({ kind: 'refuse', reason: REFUSAL }),
  } })
  const target = agentFor(test.ctx, 'target')
  const created = await dueTask(test, target)
  await expect(test.service.run({ id: created.id })).rejects.toMatchObject({
    code: 'schedule/consent-refused', details: { reason: REFUSAL }, message: REFUSAL,
  })
  expect(await test.service.view({ id: created.id })).toMatchObject({ status: 'paused' })
  expect(target.followup).not.toHaveBeenCalled()
})

it('delivers when the consent allows and hands it the creation and current presets', async () => {
  const reviews: ScheduleDeliveryReview[] = []
  const test = await setup({ consent: {
    nameEffect: () => undefined,
    reviewDelivery: (review) => {
      reviews.push(review)
      return { kind: 'allow' } satisfies ScheduleDeliveryVerdict
    },
  } })
  test.ctx.provide('permissionPresets', { current: () => 'wide' })
  const target = agentFor(test.ctx, 'target')
  await test.ctx.agents.register(target)
  test.resolve.mockResolvedValue({ agent: target })
  const created = await test.service.create({
    title: 'Deliver', prompt: 'Deliver', timing: { kind: 'rrule', rrule: ONCE },
    target: { kind: 'session', sessionId: target.session.id },
  }, SessionId('actor'))
  expect(taskTable(test.ctx).get(created.id)).toMatchObject({ creationPreset: 'wide' })
  await vi.advanceTimersByTimeAsync(1000)
  expect(reviews).toHaveLength(1)
  expect(reviews[0]?.creationPreset).toBe('wide')
  expect(reviews[0]?.currentPreset).toBe('wide')
  expect(reviews[0]?.targetSession).toBe(target.session)
  expect(await test.service.view({ id: created.id })).toMatchObject({
    status: 'ended', lastDelivery: { targetSessionId: target.session.id },
  })
})

it('reviews with absent presets when no preset service is composed', async () => {
  const reviews: ScheduleDeliveryReview[] = []
  const test = await setup({ consent: {
    nameEffect: () => undefined,
    reviewDelivery: (review) => {
      reviews.push(review)
      return { kind: 'allow' } satisfies ScheduleDeliveryVerdict
    },
  } })
  const target = agentFor(test.ctx, 'target')
  const created = await dueTask(test, target)
  await vi.advanceTimersByTimeAsync(1000)
  expect(reviews).toHaveLength(1)
  expect(reviews[0]?.creationPreset).toBeUndefined()
  expect(reviews[0]?.currentPreset).toBeUndefined()
  expect(reviews[0]?.targetSession).toBe(target.session)
  expect(await test.service.view({ id: created.id })).toMatchObject({ status: 'ended' })
})

it('screens a due group member by member: the refused member pauses and the others share one message', async () => {
  const sessionId = SessionId('batch-target')
  const test = await setup({
    consent: {
      nameEffect: () => undefined,
      reviewDelivery: review => review.creationPreset === 'narrow'
        ? { kind: 'refuse', reason: REFUSAL }
        : { kind: 'allow' },
    },
    seed: [
      boundTask(sessionId, createRRuleScheduleRecord(ScheduleId('allowed'), 'Allowed', 'Keep going', ONCE, Date.parse(SEED_TIME)),
        { creationPreset: 'wide' }),
      boundTask(sessionId, createRRuleScheduleRecord(ScheduleId('refused'), 'Refused', 'Pause me', ONCE, Date.parse(SEED_TIME)),
        { creationPreset: 'narrow' }),
    ],
  })
  const target = agentFor(test.ctx, sessionId)
  test.resolve.mockResolvedValue({ agent: target })
  await vi.advanceTimersByTimeAsync(1000)
  expect(await test.service.view({ id: ScheduleId('allowed') })).toMatchObject({
    status: 'ended', lastDelivery: { targetSessionId: sessionId },
  })
  const refused = await test.service.view({ id: ScheduleId('refused') })
  expect(refused).toMatchObject({ status: 'paused' })
  expect(refused).not.toHaveProperty('lastDelivery')
  expect(target.followup).toHaveBeenCalledOnce()
})
