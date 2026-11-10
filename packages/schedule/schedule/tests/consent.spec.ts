/** The optional Schedule consent seam: a composed consent reviews each due delivery before it wakes its Session. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createRRuleScheduleRecord, ScheduleId } from '../src/domain.ts'
import type { ScheduleConsentService, ScheduleDeliveryReview, ScheduleDeliveryVerdict } from '../src/types.ts'
import { agentFor, boundTask, harness, seededTask, seedTasks, taskTable, SEED_TIME, type HarnessAgent } from './harness.ts'

const ONCE = 'DTSTART:20260916T000001Z\nRRULE:FREQ=DAILY;COUNT=1'
/** A rule whose first occurrence is not yet due, for cases that run the task by hand. */
const DAILY_LATER = 'DTSTART:20260917T000000Z\nRRULE:FREQ=DAILY'
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
async function presetHarness(consent: ScheduleConsentService, presets: Pick<PresetBook, 'defaultPreset' | 'current'>) {
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

describe('Schedule consent review of a chat a delivery opens', () => {
  it('refuses a due `new` delivery before it opens the chat, so a refusal creates nothing', async () => {
    const reviews: ScheduleDeliveryReview[] = []
    const test = await presetHarness({
      nameEffect: () => undefined,
      reviewDelivery: (review) => {
        reviews.push(review)
        return { kind: 'refuse', reason: REFUSAL }
      },
    }, presetBook())
    test.resolve.mockImplementation(async sessionId => ({ agent: agentFor(test.ctx, sessionId) }))
    const created = await test.service.remoteCreate({
      title: 'Report', prompt: 'Write the report', timing: { kind: 'rrule', rrule: ONCE }, target: { kind: 'new', create: {} },
    })

    await vi.advanceTimersByTimeAsync(1000)

    // The review reads the preset the chat would be opened under, and its refusal leaves no chat and no reservation.
    expect(reviews).toHaveLength(1)
    expect(reviews[0]).toMatchObject({ creationPreset: DEPLOYMENT_DEFAULT, currentPreset: DEPLOYMENT_DEFAULT })
    expect(test.createSession).not.toHaveBeenCalled()
    expect(test.resolve).not.toHaveBeenCalled()
    expect(taskTable(test.ctx).get(created.id)).not.toHaveProperty('pendingDelivery')
    expect(await test.service.view({ id: created.id })).toMatchObject({ status: 'paused', consentRefusal: { reason: REFUSAL } })
  })

  it('refuses a manual run of a `new` target before it opens the chat', async () => {
    const test = await presetHarness({
      nameEffect: () => undefined,
      reviewDelivery: () => ({ kind: 'refuse', reason: REFUSAL }),
    }, presetBook())
    test.resolve.mockImplementation(async sessionId => ({ agent: agentFor(test.ctx, sessionId) }))
    const created = await test.service.remoteCreate({
      title: 'Report', prompt: 'Write the report', timing: { kind: 'rrule', rrule: DAILY_LATER }, target: { kind: 'new', create: {} },
    })

    await expect(test.service.run({ id: created.id })).rejects.toMatchObject({ code: 'schedule/consent-refused' })
    expect(test.createSession).not.toHaveBeenCalled()
    expect(await test.service.view({ id: created.id })).toMatchObject({ status: 'paused' })
  })

  it('reviews the opened chat again when it runs a preset other than the default it was reviewed against', async () => {
    const reviews: ScheduleDeliveryReview[] = []
    // Every chat the delivery opens is seeded with a workspace preset instead of the deployment default.
    const presets = { defaultPreset: DEPLOYMENT_DEFAULT, current: () => 'workspace-project' }
    const test = await presetHarness({
      ...presetConsent,
      reviewDelivery: (review) => {
        reviews.push(review)
        return presetConsent.reviewDelivery(review)
      },
    }, presets)
    const opened: HarnessAgent[] = []
    test.resolve.mockImplementation(async (sessionId) => {
      const agent = agentFor(test.ctx, sessionId)
      opened.push(agent)
      return { agent }
    })
    const created = await test.service.remoteCreate({
      title: 'Report', prompt: 'Write the report', timing: { kind: 'rrule', rrule: ONCE }, target: { kind: 'new', create: {} },
    })

    await vi.advanceTimersByTimeAsync(1000)

    expect(reviews.map(review => review.currentPreset)).toEqual([DEPLOYMENT_DEFAULT, 'workspace-project'])
    expect(opened.at(0)?.followup).not.toHaveBeenCalled()
    expect(await test.service.view({ id: created.id })).toMatchObject({ status: 'paused', consentRefusal: { reason: REFUSAL } })
  })

  it('refuses a manual run whose opened chat runs a preset other than the one reviewed', async () => {
    const test = await presetHarness(presetConsent, { defaultPreset: DEPLOYMENT_DEFAULT, current: () => 'workspace-project' })
    const opened: HarnessAgent[] = []
    test.resolve.mockImplementation(async (sessionId) => {
      const agent = agentFor(test.ctx, sessionId)
      opened.push(agent)
      return { agent }
    })
    const created = await test.service.remoteCreate({
      title: 'Report', prompt: 'Write the report', timing: { kind: 'rrule', rrule: DAILY_LATER }, target: { kind: 'new', create: {} },
    })

    await expect(test.service.run({ id: created.id })).rejects.toMatchObject({ code: 'schedule/consent-refused' })
    expect(opened.at(0)?.followup).not.toHaveBeenCalled()
    expect(await test.service.view({ id: created.id })).toMatchObject({ status: 'paused' })
  })

  it('fails a manual run with schedule/consent-failed when the opened chat\'s preset cannot be read', async () => {
    const presets = { defaultPreset: DEPLOYMENT_DEFAULT, current: (): string => { throw new Error('presets are not ready') } }
    const test = await presetHarness(presetConsent, presets)
    const opened: HarnessAgent[] = []
    test.resolve.mockImplementation(async (sessionId) => {
      const agent = agentFor(test.ctx, sessionId)
      opened.push(agent)
      return { agent }
    })
    const created = await test.service.remoteCreate({
      title: 'Report', prompt: 'Write the report', timing: { kind: 'rrule', rrule: DAILY_LATER }, target: { kind: 'new', create: {} },
    })

    await expect(test.service.run({ id: created.id })).rejects.toMatchObject({ code: 'schedule/consent-failed' })
    expect(opened.at(0)?.followup).not.toHaveBeenCalled()
    expect(await test.service.view({ id: created.id })).toMatchObject({ status: 'active' })
  })

  it('reviews the live preset of a reserved chat that already exists and opens no other', async () => {
    const reviews: ScheduleDeliveryReview[] = []
    const test = await harness({
      beforeService: async (_ctx, facility) => {
        await seedTasks(facility, [seededTask(
          createRRuleScheduleRecord(ScheduleId('reserved'), 'Report', 'Write the report', ONCE, Date.parse(SEED_TIME)),
          { kind: 'new_once', sessionId: SessionId('reserved-chat'), create: {} },
          { creationPreset: 'wide' },
        )])
      },
      onContext: (ctxOn) => {
        ctxOn.provide('scheduleConsent', {
          nameEffect: () => undefined,
          reviewDelivery: (review) => {
            reviews.push(review)
            return presetConsent.reviewDelivery(review)
          },
        })
        ctxOn.provide('permissionPresets', presetBook({ 'reserved-chat': 'wide' }))
      },
    })
    active.push(test)
    const chat = agentFor(test.ctx, 'reserved-chat')
    test.resolve.mockResolvedValue({ agent: chat })

    await vi.advanceTimersByTimeAsync(1000)

    expect(reviews).toEqual([{ creationPreset: 'wide', currentPreset: 'wide', targetSessionId: 'reserved-chat' }])
    expect(test.createSession).not.toHaveBeenCalled()
    expect(chat.followup).toHaveBeenCalledOnce()
  })
})

describe('Schedule consent verdicts and failures', () => {
  /** Seed one due task bound to `chat` and compose `consent`. */
  async function seeded(consent: ScheduleConsentService) {
    const test = await setup({
      consent,
      seed: [boundTask(SessionId('chat'), createRRuleScheduleRecord(ScheduleId('due'), 'Due', 'Run', ONCE, Date.parse(SEED_TIME)),
        { creationPreset: 'wide' })],
    })
    const chat = agentFor(test.ctx, 'chat')
    test.resolve.mockResolvedValue({ agent: chat })
    return { test, chat }
  }

  // Each answer stands for a consent written against another version of the seam, outside the declared verdicts.
  it.each([
    ['an unrecognised kind', { kind: 'deny', reason: 'no' }],
    ['a refusal without a reason', { kind: 'refuse' }],
    ['a refusal with a blank reason', { kind: 'refuse', reason: '  ' }],
    ['no verdict at all', null],
  ])('refuses a due delivery whose consent answers %s', async (_label, answer) => {
    const { test, chat } = await seeded({ nameEffect: () => undefined, reviewDelivery: () => answer as never })

    await vi.advanceTimersByTimeAsync(1000)

    expect(chat.followup).not.toHaveBeenCalled()
    const stored = taskTable(test.ctx).get(ScheduleId('due'))
    expect(stored).toMatchObject({ status: 'paused' })
    expect(stored?.consentRefusal?.reason).toContain('no verdict the Schedule recognises')
  })

  it('refuses a manual run whose consent answers an unrecognised verdict with the typed refusal', async () => {
    const { test, chat } = await seeded({ nameEffect: () => undefined, reviewDelivery: () => ({ kind: 'permit' }) as never })

    await expect(test.service.run({ id: ScheduleId('due') })).rejects.toMatchObject({ code: 'schedule/consent-refused' })
    expect(chat.followup).not.toHaveBeenCalled()
  })

  it('never delivers when the consent throws, keeps the task armed and reports the failure', async () => {
    const { test, chat } = await seeded({
      nameEffect: () => undefined, reviewDelivery: () => { throw new Error('consent exploded') },
    })
    const warn = vi.spyOn(test.ctx.logger, 'warn')

    await vi.advanceTimersByTimeAsync(1000)

    expect(chat.followup).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not review the delivery of task "due".*consent exploded/))
    expect(await test.service.view({ id: ScheduleId('due') })).toMatchObject({ status: 'active' })
    expect(taskTable(test.ctx).get(ScheduleId('due'))).not.toHaveProperty('consentRefusal')
  })

  it('fails a manual run with the typed schedule/consent-failed error, not a refusal, when the consent throws', async () => {
    const failure = new Error('consent exploded')
    const { test, chat } = await seeded({ nameEffect: () => undefined, reviewDelivery: () => { throw failure } })

    await expect(test.service.run({ id: ScheduleId('due') })).rejects.toMatchObject({
      code: 'schedule/consent-failed', details: {}, cause: failure,
    })
    expect(chat.followup).not.toHaveBeenCalled()
    expect(await test.service.view({ id: ScheduleId('due') })).toMatchObject({ status: 'active' })
  })

  it('reviews every occurrence of a recurring task, not only the first', async () => {
    const reviews: ScheduleDeliveryReview[] = []
    let refuse = false
    const test = await setup({
      seed: [boundTask(SessionId('chat'), createRRuleScheduleRecord(ScheduleId('every-day'), 'Daily', 'Run',
        'DTSTART:20260916T000001Z\nRRULE:FREQ=DAILY', Date.parse(SEED_TIME)), { creationPreset: 'wide' })],
      consent: {
        nameEffect: () => undefined,
        reviewDelivery: (review) => {
          reviews.push(review)
          return refuse ? { kind: 'refuse', reason: REFUSAL } : { kind: 'allow' }
        },
      },
    })
    const chat = agentFor(test.ctx, 'chat')
    test.resolve.mockResolvedValue({ agent: chat })

    await vi.advanceTimersByTimeAsync(1000)
    expect(reviews).toHaveLength(1)
    refuse = true
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)

    expect(reviews).toHaveLength(2)
    expect(chat.followup).toHaveBeenCalledOnce()
    expect(await test.service.view({ id: ScheduleId('every-day') })).toMatchObject({ status: 'paused' })
  })

  it('keeps a delivery into a chat that no longer exists armed without consulting the consent', async () => {
    const reviewDelivery = vi.fn((): ScheduleDeliveryVerdict => ({ kind: 'allow' }))
    const { test } = await seeded({ nameEffect: () => undefined, reviewDelivery })
    test.resolve.mockRejectedValue(new Error('Session chat is not available'))

    await vi.advanceTimersByTimeAsync(1000)

    expect(reviewDelivery).not.toHaveBeenCalled()
    expect(await test.service.view({ id: ScheduleId('due') })).toMatchObject({ status: 'active' })
  })

  it('refuses the first delivery into a chat that held no live Agent at creation, whose approval named no preset', async () => {
    const test = await presetHarness(presetConsent, presetBook())
    const created = await test.service.remoteCreate({
      title: 'Reminder', prompt: 'Remind me', timing: { kind: 'rrule', rrule: ONCE },
      target: { kind: 'session', sessionId: SessionId('cold-chat') },
    })
    expect(taskTable(test.ctx).get(created.id)).not.toHaveProperty('creationPreset')
    const chat = agentFor(test.ctx, 'cold-chat')
    test.resolve.mockResolvedValue({ agent: chat })

    await vi.advanceTimersByTimeAsync(1000)

    expect(chat.followup).not.toHaveBeenCalled()
    expect(await test.service.view({ id: created.id })).toMatchObject({ status: 'paused' })
  })

  it('keeps the stored task unchanged when the consent edits the review it is handed', async () => {
    const { test, chat } = await seeded({
      nameEffect: () => undefined,
      reviewDelivery: (review) => {
        Object.assign(review, { creationPreset: 'hijacked', targetSessionId: 'elsewhere' })
        return { kind: 'allow' }
      },
    })

    await vi.advanceTimersByTimeAsync(1000)

    expect(chat.followup).toHaveBeenCalledOnce()
    expect(taskTable(test.ctx).get(ScheduleId('due'))).toMatchObject({
      creationPreset: 'wide', target: { kind: 'session', sessionId: 'chat' },
    })
  })
})
