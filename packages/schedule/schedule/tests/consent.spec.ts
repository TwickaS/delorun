/** The optional Schedule consent seam: a composed consent reviews each due delivery before it wakes its Session. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createRRuleScheduleRecord, ScheduleId } from '../src/domain.ts'
import type { ScheduleConsentService, ScheduleDeliveryReview, ScheduleDeliveryVerdict } from '../src/types.ts'
import { agentFor, boundTask, harness, seedTasks, taskTable, SEED_TIME, type HarnessAgent } from './harness.ts'

const ONCE = 'DTSTART:20260916T000001Z\nRRULE:FREQ=DAILY;COUNT=1'
const REFUSAL = 'the target Session moved wider than the creation preset'
const DEPLOYMENT_DEFAULT = 'workspace-write'
const CALLER_PRESET = 'auto'

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
    beforeService: async (_ctx, facility) => {
      if (options.seed !== undefined) await seedTasks(facility, options.seed)
    },
    onContext: (ctxOn) => {
      if (options.consent !== undefined) ctxOn.provide('scheduleConsent', options.consent)
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

/** The rule `@delo/plugin-schedule-consent` implements, restated because an upstream spec cannot import the fork's plugin. */
const presetConsent: ScheduleConsentService = {
  nameEffect: () => undefined,
  reviewDelivery: review => review.creationPreset === review.currentPreset
    ? { kind: 'allow' }
    : { kind: 'refuse', reason: REFUSAL },
}

/** Preset pins a case rewrites as it goes, including the default every fresh Session is pinned to. */
interface PresetBook {
  readonly book: Map<string, string>
  readonly defaultPreset: string
  current(session: { id: string }): string
}

/**
 * Build the preset reader a deployment composes.
 * @param entries - Presets of the Sessions that start with one; a Session absent here runs the deployment default.
 * @param defaultPreset - The preset `permission-presets` pins into every fresh Session.
 * @returns The reader, whose Session pins a case may rewrite.
 */
function presetBook(entries: Record<string, string> = {}, defaultPreset = DEPLOYMENT_DEFAULT): PresetBook {
  const book = new Map(Object.entries(entries))
  return { book, defaultPreset, current: session => book.get(session.id) ?? defaultPreset }
}

/** Harness carrying a consent and the preset reader, for the cases that read a preset baseline. */
async function presetHarness(consent: ScheduleConsentService, presets: PresetBook) {
  const test = await harness({ onContext: (ctxOn) => {
    ctxOn.provide('scheduleConsent', consent)
    ctxOn.provide('permissionPresets', presets)
  } })
  active.push(test)
  return test
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
  expect(await test.service.view({ id: created.id })).toMatchObject({
    status: 'paused', consentRefusal: { reason: REFUSAL },
  })
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
  expect(reviews[0]?.targetSessionId).toBe(target.session.id)
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
  expect(reviews[0]?.targetSessionId).toBe(target.session.id)
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

it('captures the deployment default, not the caller preset, for a target that opens its chat', async () => {
  const presets = presetBook({ caller: CALLER_PRESET })
  const reviews: ScheduleDeliveryReview[] = []
  const test = await presetHarness({
    ...presetConsent,
    reviewDelivery: (review) => {
      reviews.push(review)
      return presetConsent.reviewDelivery(review)
    },
  }, presets)
  const caller = agentFor(test.ctx, 'caller')
  await test.ctx.agents.register(caller)
  const opened: HarnessAgent[] = []
  test.resolve.mockImplementation(async (sessionId) => {
    const agent = agentFor(test.ctx, sessionId)
    opened.push(agent)
    return { agent }
  })

  const created = await test.service.create({
    title: 'Report', prompt: 'Write the report', timing: { kind: 'rrule', rrule: ONCE }, target: { kind: 'new', create: {} },
  }, caller.session.id)
  // A created Session is pinned to the deployment default whatever the caller runs, so that is the baseline.
  expect(taskTable(test.ctx).get(created.id)).toMatchObject({ creationPreset: DEPLOYMENT_DEFAULT })

  await vi.advanceTimersByTimeAsync(1000)

  expect(reviews).toHaveLength(1)
  expect(reviews[0]).toMatchObject({ creationPreset: DEPLOYMENT_DEFAULT, currentPreset: DEPLOYMENT_DEFAULT })
  expect(await test.service.view({ id: created.id })).toMatchObject({ status: 'ended' })
  expect(opened.at(0)?.followup).toHaveBeenCalledOnce()
})

it('captures the deployment default for a Remote-created task, which carries no caller preset', async () => {
  const test = await presetHarness(presetConsent, presetBook())
  test.resolve.mockImplementation(async sessionId => ({ agent: agentFor(test.ctx, sessionId) }))

  const created = await test.service.remoteCreate({
    title: 'Report', prompt: 'Write the report', timing: { kind: 'rrule', rrule: ONCE }, target: { kind: 'new', create: {} },
  })
  expect(taskTable(test.ctx).get(created.id)).toMatchObject({ creationPreset: DEPLOYMENT_DEFAULT })

  await vi.advanceTimersByTimeAsync(1000)

  expect(await test.service.view({ id: created.id })).toMatchObject({ status: 'ended' })
})

it('re-captures the creation preset from the target chat on an approved edit, so a later move is refused again', async () => {
  const presets = presetBook({ chat: 'wide' })
  const test = await presetHarness(presetConsent, presets)
  const chat = agentFor(test.ctx, 'chat')
  await test.ctx.agents.register(chat)
  test.resolve.mockResolvedValue({ agent: chat })
  const created = await test.service.create({
    title: 'Queue check', prompt: 'Check the queue', timing: { kind: 'rrule', rrule: ONCE },
    target: { kind: 'session', sessionId: chat.session.id },
  }, chat.session.id)
  expect(taskTable(test.ctx).get(created.id)).toMatchObject({ creationPreset: 'wide' })

  // The person narrows the chat and re-approves the task with an edit: that approval names "narrow".
  presets.book.set('chat', 'narrow')
  await test.service.edit({
    id: created.id, action: 'update', patch: { title: 'Queue check renamed' }, consentApproval: 'allowed-once',
  }, chat.session.id)
  expect(taskTable(test.ctx).get(created.id)).toMatchObject({ creationPreset: 'narrow' })

  // The chat widens again before the occurrence falls due, so no approval covers the delivery.
  presets.book.set('chat', 'wide')
  await vi.advanceTimersByTimeAsync(1000)

  expect(await test.service.view({ id: created.id })).toMatchObject({
    status: 'paused', consentRefusal: { reason: REFUSAL },
  })
  expect(chat.followup).not.toHaveBeenCalled()
})

it('keeps the refused baseline and the recorded refusal on an edit nobody approved', async () => {
  const presets = presetBook({ chat: 'wide' })
  const test = await presetHarness(presetConsent, presets)
  const chat = agentFor(test.ctx, 'chat')
  await test.ctx.agents.register(chat)
  test.resolve.mockResolvedValue({ agent: chat })
  const created = await test.service.create({
    title: 'Queue check', prompt: 'Check the queue', timing: { kind: 'rrule', rrule: ONCE },
    target: { kind: 'session', sessionId: chat.session.id },
  }, chat.session.id)
  expect(taskTable(test.ctx).get(created.id)).toMatchObject({ creationPreset: 'wide' })

  // The chat moves off the approved preset, so the due delivery is refused and the task pauses.
  presets.book.set('chat', 'narrow')
  await vi.advanceTimersByTimeAsync(1000)
  const refused = { reason: REFUSAL, refusedAt: '2026-09-16T00:00:01.000Z' }
  expect(taskTable(test.ctx).get(created.id)).toMatchObject({ creationPreset: 'wide', consentRefusal: refused })

  // An edit that carries no approval changes only what it names: it settles no refusal and re-captures no preset,
  // so the delivery the consent stopped stays stopped and stays measured against the preset it was stopped under.
  await test.service.edit({ id: created.id, action: 'update', patch: { title: 'Queue check renamed' } }, chat.session.id)
  expect(taskTable(test.ctx).get(created.id)).toMatchObject({
    creationPreset: 'wide', consentRefusal: refused, record: { title: 'Queue check renamed' },
  })
})

it('settles the refusal only on the edit the person approved, and re-captures that edit\'s preset', async () => {
  const presets = presetBook({ chat: 'wide' })
  const test = await presetHarness(presetConsent, presets)
  const chat = agentFor(test.ctx, 'chat')
  await test.ctx.agents.register(chat)
  test.resolve.mockResolvedValue({ agent: chat })
  const created = await test.service.create({
    title: 'Queue check', prompt: 'Check the queue', timing: { kind: 'rrule', rrule: ONCE },
    target: { kind: 'session', sessionId: chat.session.id },
  }, chat.session.id)
  presets.book.set('chat', 'narrow')
  await vi.advanceTimersByTimeAsync(1000)
  expect(taskTable(test.ctx).get(created.id)).toHaveProperty('consentRefusal')

  await test.service.edit({
    id: created.id, action: 'update', patch: { title: 'Queue check renamed' }, consentApproval: 'allowed-once',
  }, chat.session.id)
  const stored = taskTable(test.ctx).get(created.id)
  expect(stored).not.toHaveProperty('consentRefusal')
  expect(stored).toMatchObject({ creationPreset: 'narrow' })
})

it('leaves a Remote edit\'s baseline alone, because a form submission is no consent answer', async () => {
  const presets = presetBook({ chat: 'wide' })
  const test = await presetHarness(presetConsent, presets)
  const chat = agentFor(test.ctx, 'chat')
  await test.ctx.agents.register(chat)
  test.resolve.mockResolvedValue({ agent: chat })
  const created = await test.service.create({
    title: 'Queue check', prompt: 'Check the queue', timing: { kind: 'rrule', rrule: ONCE },
    target: { kind: 'session', sessionId: chat.session.id },
  }, chat.session.id)
  presets.book.set('chat', 'narrow')
  await test.service.remoteEdit({ id: created.id, action: 'update', patch: { title: 'Renamed from the UI' } })
  expect(taskTable(test.ctx).get(created.id)).toMatchObject({ creationPreset: 'wide' })
})

it('records the reason of a scheduled refusal on the task and projects it into the catalog entry', async () => {
  const test = await setup({ consent: {
    nameEffect: () => undefined,
    reviewDelivery: () => ({ kind: 'refuse', reason: REFUSAL }),
  } })
  const target = agentFor(test.ctx, 'target')
  const created = await dueTask(test, target)
  await vi.advanceTimersByTimeAsync(1000)

  // The pause carries the consent's reason, at the instant the refusal happened.
  const expected = { reason: REFUSAL, refusedAt: '2026-09-16T00:00:01.000Z' }
  expect(await test.service.view({ id: created.id })).toMatchObject({ status: 'paused', consentRefusal: expected })
  const entry = (await test.service.catalog()).find(candidate => candidate.id === created.id)
  expect(entry).toMatchObject({ status: 'paused', consentRefusal: expected })
})

it('gates a manual run through the consent, delivers when it allows, and settles the refusal it recorded', async () => {
  const reviews: ScheduleDeliveryReview[] = []
  let refuse = true
  const test = await presetHarness({
    nameEffect: () => undefined,
    reviewDelivery: (review) => {
      reviews.push(review)
      return refuse ? { kind: 'refuse', reason: REFUSAL } : { kind: 'allow' }
    },
  }, presetBook({ chat: 'wide' }))
  const chat = agentFor(test.ctx, 'chat')
  await test.ctx.agents.register(chat)
  test.resolve.mockResolvedValue({ agent: chat })
  const created = await test.service.create({
    title: 'Queue check', prompt: 'Check the queue', timing: { kind: 'rrule', rrule: ONCE },
    target: { kind: 'session', sessionId: chat.session.id },
  }, chat.session.id)

  // The refusal pauses the task and states why, and the run reports the typed error.
  await expect(test.service.run({ id: created.id })).rejects.toMatchObject({ code: 'schedule/consent-refused' })
  expect(reviews).toHaveLength(1)
  expect(reviews[0]).toMatchObject({ creationPreset: 'wide', currentPreset: 'wide', targetSessionId: chat.session.id })
  expect(chat.followup).not.toHaveBeenCalled()
  expect(await test.service.view({ id: created.id })).toMatchObject({
    status: 'paused', consentRefusal: { reason: REFUSAL },
  })

  // The next manual run is allowed, so it delivers and the recorded refusal no longer stands.
  refuse = false
  expect(await test.service.run({ id: created.id })).toMatchObject({
    id: created.id, lastDelivery: { targetSessionId: chat.session.id },
  })
  expect(chat.followup).toHaveBeenCalledOnce()
  expect(await test.service.view({ id: created.id })).not.toHaveProperty('consentRefusal')
})
