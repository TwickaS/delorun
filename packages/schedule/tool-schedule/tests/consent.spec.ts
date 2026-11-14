/** The optional Schedule consent seam: a composed consent names what an approved management call creates. */
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-user-approval'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ScheduleId } from '@deepseek-ai/dsh-schedule'
import type {
  ScheduleConsentService, ScheduleDeliveryReview, ScheduleDeliveryVerdict, ScheduleEffect, ScheduleTiming,
} from '@deepseek-ai/dsh-schedule'
import { agentFor, harness, mountToolSchedule } from './harness.ts'
import { taskTable, type HarnessAgent } from '../../schedule/tests/harness.ts'

const NOW = '2026-09-16T00:00:00.000Z'
const ONCE = 'DTSTART:20260916T000001Z\nRRULE:FREQ=DAILY;COUNT=1'
const DAILY = 'DTSTART:20260916T010000Z\nRRULE:FREQ=DAILY'
const TASK = { title: 'Queue check', prompt: 'Check the queue', rrule: DAILY, target: 'this_session' }
const ASK_REASON = 'ask policy'
const NAMED = 'The recurring prompt would deliver to this session under its current preset.'
const REFUSAL = 'the target Session moved wider than the creation preset'
const DEPLOYMENT_DEFAULT = 'workspace-write'
const CALLER_PRESET = 'auto'

const tests: Awaited<ReturnType<typeof harness>>[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)) })
afterEach(async () => {
  await Promise.all(tests.splice(0).map(test => test.ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** The preset reader a deployment composes: a Session's preset pin plus the default a fresh Session runs. */
interface Presets {
  readonly defaultPreset: string
  current(session: { id: string }): string
}

/**
 * Build the preset reader a case provides.
 * @param current - Preset each live Session runs.
 * @param defaultPreset - Preset `permission-presets` pins into every fresh Session.
 * @returns The reader a case provides as `permissionPresets`.
 */
function presetsOf(current: (session: { id: string }) => string = () => CALLER_PRESET, defaultPreset = DEPLOYMENT_DEFAULT): Presets {
  return { defaultPreset, current }
}

/**
 * Build the preset reader a deployment composes: each named Session keeps its pinned preset, and a
 * Session the entries do not name — a chat a delivery just opened — runs the deployment default.
 * @param entries - Presets of the Sessions that start with one, keyed by Session identity.
 * @param defaultPreset - The preset `permission-presets` pins into every fresh Session.
 * @returns The reader a case provides as `permissionPresets`.
 */
function presetBook(entries: Record<string, string> = {}, defaultPreset = DEPLOYMENT_DEFAULT): Presets {
  const pins = new Map(Object.entries(entries))
  return { defaultPreset, current: session => pins.get(session.id) ?? defaultPreset }
}

/**
 * The delivery rule `@delorun/plugin-schedule-consent` implements, restated for the same reason as the
 * naming rule: a delivery may proceed only while the chat it reaches still runs the preset its
 * approval captured.
 * @param review - The captured preset and the preset the target chat runs now.
 * @returns The verdict.
 */
function presetReview(review: ScheduleDeliveryReview): ScheduleDeliveryVerdict {
  return review.creationPreset === review.currentPreset ? { kind: 'allow' } : { kind: 'refuse', reason: REFUSAL }
}

async function setup(options: {
  consent?: ScheduleConsentService
  presets?: Presets
  titles?: { get(session: { id: string }): { title: string } | undefined }
} = {}) {
  const test = await harness({ onContext: (ctx) => {
    if (options.consent !== undefined) ctx.provide('scheduleConsent', options.consent)
    if (options.presets !== undefined) ctx.provide('permissionPresets', options.presets)
    if (options.titles !== undefined) ctx.provide('sessionTitle', options.titles as never)
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
  // The answer type is the union a case may later rewrite with `mockImplementation`, so a rejection is type-safe.
  const request = vi.fn(async (_ask: { readonly toolName: string; readonly reason: string }): Promise<'allowed-once' | 'rejected'> => 'allowed-once')
  test.ctx.provide('approval', { request })
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

/**
 * The naming rule `@delorun/plugin-schedule-consent` implements, restated because an upstream spec cannot
 * import the fork's plugin: the recurrence, the chat the deliveries reach, and that chat's preset.
 * @param schedule - The effect the approved call would create.
 * @returns The sentence the approval states, or undefined when the effect names no recurrence.
 */
function nameConsentEffect(schedule: ScheduleEffect): string | undefined {
  if (schedule.recurrence === '') return undefined
  const target = schedule.targetSessionId === undefined
    ? 'a new chat that its first delivery opens'
    : `the chat ${schedule.targetSessionId}`
  const preset = schedule.targetPreset === undefined ? '' : `, which runs the ${schedule.targetPreset} permission preset`
  return `The task delivers on "${schedule.recurrence}" into ${target}${preset}.`
}

describe('Schedule consent approval naming', () => {
  it('keeps an ask approval unnamed without a composed consent', async () => {
    const test = await setup()
    const request = approving(test)
    askPolicy(test)
    await call(test, 'schedule_create', TASK)
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls.at(0)?.at(0)).toMatchObject({ toolName: 'schedule_create', reason: ASK_REASON })
  })

  it('names the created effect on a schedule_create approval', async () => {
    const nameEffect = vi.fn(() => NAMED)
    const test = await setup({ consent: { nameEffect, reviewDelivery: () => ({ kind: 'allow' }) } })
    const request = approving(test)
    askPolicy(test)
    await call(test, 'schedule_create', TASK)
    expect(request).toHaveBeenCalledOnce()
    expect(nameEffect).toHaveBeenCalledOnce()
    expect(nameEffect.mock.calls.at(0)?.at(0)).toMatchObject({
      tool: 'schedule_create', recurrence: DAILY, targetSessionId: test.agent.session.id, targetPreset: undefined,
    } satisfies Partial<ScheduleEffect>)
    expect(request.mock.calls.at(0)?.at(0)?.reason).toBe(`${ASK_REASON} ${NAMED}`)
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
    expect(nameEffect.mock.calls.at(0)?.at(0)).toMatchObject({
      tool: 'schedule_edit', recurrence: DAILY, targetSessionId: test.agent.session.id, targetPreset: undefined,
    } satisfies Partial<ScheduleEffect>)
  })

  it('keeps the approval unnamed when the consent names no effect', async () => {
    const test = await setup({ consent: { nameEffect: () => undefined, reviewDelivery: () => ({ kind: 'allow' }) } })
    const request = approving(test)
    askPolicy(test)
    await call(test, 'schedule_create', TASK)
    expect(request.mock.calls.at(0)?.at(0)?.reason).toBe(ASK_REASON)
  })

  it('consults the consent only at approval time', async () => {
    const nameEffect = vi.fn(() => NAMED)
    const test = await setup({ consent: { nameEffect, reviewDelivery: () => ({ kind: 'allow' }) } })
    approving(test)
    await call(test, 'schedule_create', TASK)
    nameEffect.mockClear()
    await call(test, 'schedule_list', {})
    expect(nameEffect).not.toHaveBeenCalled()
  })

  it('names the deployment default for a stored target that opens its own chat', async () => {
    const nameEffect = vi.fn(() => NAMED)
    const test = await setup({
      consent: { nameEffect, reviewDelivery: () => ({ kind: 'allow' }) },
      presets: presetsOf(),
    })
    approving(test)
    const created = await test.service.create({
      title: 'Queue check', prompt: 'Check the queue', timing: { kind: 'rrule', rrule: DAILY },
      target: { kind: 'new_once' },
    }, test.agent.session.id)
    askPolicy(test)
    await call(test, 'schedule_edit', { id: created.id, action: 'update', title: 'Renamed' })
    expect(nameEffect.mock.calls.at(0)?.at(0)).toMatchObject({
      tool: 'schedule_edit', recurrence: DAILY, targetSessionId: undefined, targetPreset: DEPLOYMENT_DEFAULT,
    } satisfies Partial<ScheduleEffect>)
  })

  it('names no preset for a stored target chat that holds no live Agent', async () => {
    const nameEffect = vi.fn(() => NAMED)
    const test = await setup({
      consent: { nameEffect, reviewDelivery: () => ({ kind: 'allow' }) },
      presets: presetsOf(() => CALLER_PRESET),
    })
    approving(test)
    const created = await test.service.create({
      title: 'Queue check', prompt: 'Check the queue', timing: { kind: 'rrule', rrule: DAILY },
      target: { kind: 'session', sessionId: SessionId('other') },
    }, test.agent.session.id)
    askPolicy(test)
    await call(test, 'schedule_edit', { id: created.id, action: 'update', title: 'Renamed' })
    // The caller's preset belongs to another chat, so the approval states no preset at all.
    expect(nameEffect.mock.calls.at(0)?.at(0)).toMatchObject({
      tool: 'schedule_edit', recurrence: DAILY, targetSessionId: 'other', targetPreset: undefined,
    } satisfies Partial<ScheduleEffect>)
  })

  it('leaves a delete approval unnamed, so it states no delivery', async () => {
    const nameEffect = vi.fn(() => NAMED)
    const test = await setup({ consent: { nameEffect, reviewDelivery: () => ({ kind: 'allow' }) } })
    const request = approving(test)
    const created = await call(test, 'schedule_create', TASK) as { id: string }
    nameEffect.mockClear()
    askPolicy(test)
    await call(test, 'schedule_edit', { id: created.id, action: 'delete' })
    // A delete arms nothing, so nothing is named and the ask keeps the policy's own reason.
    expect(nameEffect).not.toHaveBeenCalled()
    expect(request.mock.calls.at(-1)?.at(0)?.reason).toBe(ASK_REASON)
  })

  it('names the real effect sentence at the tool call site', async () => {
    const test = await setup({
      consent: { nameEffect: nameConsentEffect, reviewDelivery: () => ({ kind: 'allow' }) },
      presets: presetsOf(),
    })
    const request = approving(test)
    askPolicy(test)

    await call(test, 'schedule_create', { ...TASK, target: 'new' })
    expect(request.mock.calls.at(0)?.at(0)?.reason).toBe(`${ASK_REASON} The task delivers on "${DAILY}" `
      + `into a new chat that its first delivery opens, which runs the ${DEPLOYMENT_DEFAULT} permission preset.`)

    await call(test, 'schedule_create', TASK)
    expect(request.mock.calls.at(1)?.at(0)?.reason).toBe(`${ASK_REASON} The task delivers on "${DAILY}" `
      + `into the chat ${test.agent.session.id}, which runs the ${CALLER_PRESET} permission preset.`)
  })
})

describe('Schedule consent creation baseline', () => {
  it('captures the deployment default for a chat the call opens, in the approval and the stored task, and allows its first delivery', async () => {
    const reviews: ScheduleDeliveryReview[] = []
    const nameEffect = vi.fn(nameConsentEffect)
    const test = await setup({
      consent: {
        nameEffect,
        reviewDelivery: (review) => {
          reviews.push(review)
          return presetReview(review)
        },
      },
      // The caller runs `auto`; every chat a delivery opens is pinned to `workspace-write`.
      presets: presetBook({ original: CALLER_PRESET }),
    })
    const request = approving(test)
    askPolicy(test)
    const opened: HarnessAgent[] = []
    test.resolve.mockImplementation(async (sessionId) => {
      const agent = agentFor(test.ctx, sessionId)
      opened.push(agent)
      return { agent }
    })

    const created = await call(test, 'schedule_create', { ...TASK, rrule: ONCE, target: 'new' }) as { id: string }

    // The approval names the preset the chat this call opens will run, not the caller's.
    expect(nameEffect.mock.calls.at(0)?.at(0)).toMatchObject({
      tool: 'schedule_create', recurrence: ONCE, targetSessionId: undefined, targetPreset: DEPLOYMENT_DEFAULT,
    } satisfies Partial<ScheduleEffect>)
    expect(request.mock.calls.at(0)?.at(0)?.reason).toContain(`which runs the ${DEPLOYMENT_DEFAULT} permission preset`)
    // The task stores that same default, so its baseline is the preset its deliveries will meet.
    expect(taskTable(test.ctx).get(ScheduleId(created.id))).toMatchObject({ creationPreset: DEPLOYMENT_DEFAULT })

    await vi.advanceTimersByTimeAsync(1000)

    // The first delivery reaches the opened chat, which runs the captured default, so the consent allows it.
    expect(reviews).toHaveLength(1)
    expect(reviews[0]).toMatchObject({ creationPreset: DEPLOYMENT_DEFAULT, currentPreset: DEPLOYMENT_DEFAULT })
    expect(opened.at(0)?.followup).toHaveBeenCalledOnce()
    expect(await call(test, 'schedule_view', { id: created.id })).toMatchObject({ id: created.id, status: 'ended' })
  })
})

describe('Schedule consent as the gate', () => {
  it('asks before creating a task once a consent service is mounted, without any policy ask', async () => {
    // The consent alone makes the call ask: a composition that mounts it has no other producer of asks.
    const test = await setup({ consent: { nameEffect: () => NAMED, reviewDelivery: () => ({ kind: 'allow' }) } })
    const request = approving(test)
    const created = await call(test, 'schedule_create', TASK) as { id: string }

    expect(created.id).toBeTruthy()
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls.at(0)?.at(0)).toMatchObject({ toolName: 'schedule_create', reason: NAMED })
    expect(await call(test, 'schedule_view', { id: created.id })).toMatchObject({ id: created.id, title: TASK.title })
  })

  it('asks with its own sentence while the consent names no effect, and still creates the task', async () => {
    const test = await setup({ consent: { nameEffect: () => undefined, reviewDelivery: () => ({ kind: 'allow' }) } })
    const request = approving(test)
    const created = await call(test, 'schedule_create', TASK) as { id: string }
    expect(request.mock.calls.at(0)?.at(0)).toMatchObject({ toolName: 'schedule_create' })
    expect(request.mock.calls.at(0)?.at(0)?.reason).toBeTruthy()
    expect(await call(test, 'schedule_view', { id: created.id })).toMatchObject({ id: created.id })
  })

  it('leaves schedule_create unasked without a consent service, as upstream runs it', async () => {
    const test = await setup()
    const request = approving(test)
    await call(test, 'schedule_create', TASK)
    expect(request).not.toHaveBeenCalled()
  })

  it('asks again on an edit of a task the consent refused, and states the refusal it would settle', async () => {
    const test = await setup({ consent: { nameEffect: () => NAMED, reviewDelivery: () => ({ kind: 'refuse', reason: REFUSAL }) } })
    const request = approving(test)
    const created = await call(test, 'schedule_create', TASK) as { id: string }
    test.resolve.mockResolvedValue({ agent: test.agent })
    await expect(test.service.run({ id: ScheduleId(created.id) })).rejects.toThrow(REFUSAL)
    request.mockClear()

    await call(test, 'schedule_edit', { id: created.id, action: 'update', title: 'Renamed' })
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls.at(0)?.at(0)).toMatchObject({ toolName: 'schedule_edit' })
    // The person sees why the delivery stopped before they approve the task again.
    expect(request.mock.calls.at(0)?.at(0)?.reason).toContain(REFUSAL)
    expect(request.mock.calls.at(0)?.at(0)?.reason).toContain(NAMED)
  })

  it('keeps a refused task refused when the person does not approve its edit, and re-captures nothing', async () => {
    const reviews: ScheduleDeliveryReview[] = []
    let preset = CALLER_PRESET
    const test = await setup({
      consent: {
        nameEffect: () => undefined,
        reviewDelivery: (review) => {
          reviews.push(review)
          return presetReview(review)
        },
      },
      presets: { defaultPreset: DEPLOYMENT_DEFAULT, current: () => preset },
    })
    const request = approving(test)
    const created = await call(test, 'schedule_create', TASK) as { id: string }
    test.resolve.mockResolvedValue({ agent: test.agent })
    // The chat moves off the approved preset, so the consent refuses the due delivery and pauses the task.
    preset = 'danger-full-access'
    await expect(test.service.run({ id: ScheduleId(created.id) })).rejects.toThrow(REFUSAL)
    const refusedAt = taskTable(test.ctx).get(ScheduleId(created.id))?.consentRefusal?.refusedAt
    expect(taskTable(test.ctx).get(ScheduleId(created.id))).toMatchObject({
      consentRefusal: { reason: REFUSAL }, creationPreset: CALLER_PRESET,
    })

    // The edit asks, and the person rejects it: the task keeps the refusal and the baseline it was refused on.
    request.mockImplementation(async () => 'rejected' as const)
    const denied = await executeToolFixture(test.ctx, {
      callId: ToolCallId('consent-denied'), signal: new AbortController().signal,
      name: 'schedule_edit', arguments: { id: created.id, action: 'update', title: 'Renamed' }, agent: test.agent,
    })
    expect(denied.isError).toBe(true)
    expect(taskTable(test.ctx).get(ScheduleId(created.id))).toMatchObject({
      consentRefusal: { reason: REFUSAL, refusedAt }, creationPreset: CALLER_PRESET, record: { title: TASK.title },
    })
  })
})

describe('Schedule consent manual run', () => {
  it('refuses a manual run through the consent with the typed schedule/consent-refused error', async () => {
    const reviews: ScheduleDeliveryReview[] = []
    const test = await setup({ consent: {
      nameEffect: () => undefined,
      reviewDelivery: (review) => {
        reviews.push(review)
        return { kind: 'refuse', reason: REFUSAL }
      },
    } })
    approving(test)
    const created = await call(test, 'schedule_create', TASK) as { id: string }
    test.resolve.mockResolvedValue({ agent: test.agent })

    await expect(test.service.run({ id: ScheduleId(created.id) })).rejects.toMatchObject({
      code: 'schedule/consent-refused', details: { reason: REFUSAL }, message: REFUSAL,
    })
    // The gate runs before the message, so the chat is never woken and the task states why it stopped.
    expect(reviews).toHaveLength(1)
    expect(reviews[0]).toMatchObject({ targetSessionId: test.agent.session.id })
    expect(test.agent.followup).not.toHaveBeenCalled()
    expect(await test.service.view({ id: ScheduleId(created.id) })).toMatchObject({
      status: 'paused', consentRefusal: { reason: REFUSAL },
    })
  })

  it('keeps the recorded refusal out of the model-facing task', async () => {
    const test = await setup({ consent: {
      nameEffect: () => undefined,
      reviewDelivery: () => ({ kind: 'refuse', reason: REFUSAL }),
    } })
    approving(test)
    const created = await call(test, 'schedule_create', TASK) as { id: string }
    test.resolve.mockResolvedValue({ agent: test.agent })
    // A refused run records why the task paused on the Host task; the model-facing task carries no such field,
    // which the view result proves because the tool's output schema admits exactly the declared fields.
    await expect(test.service.run({ id: ScheduleId(created.id) })).rejects.toThrow(REFUSAL)
    expect(await call(test, 'schedule_view', { id: created.id })).toMatchObject({ id: created.id, kind: 'rrule' })
  })
})

describe('Schedule consent naming failures', () => {
  it('fails the call, asks nothing and stores nothing when the consent throws while naming', async () => {
    const test = await setup({ consent: {
      nameEffect: () => { throw new Error('naming exploded') },
      reviewDelivery: () => ({ kind: 'allow' }),
    } })
    const request = approving(test)
    const result = await executeToolFixture(test.ctx, {
      callId: ToolCallId('consent-call'), signal: new AbortController().signal,
      name: 'schedule_create', arguments: TASK, agent: test.agent,
    })
    expect(result.isError).toBe(true)
    expect(request).not.toHaveBeenCalled()
    expect(await call(test, 'schedule_list', {})).toMatchObject({ total: 0 })
  })

  it('keeps a consent that edits the effect it names out of the stored task', async () => {
    const test = await setup({ consent: {
      nameEffect: (effect) => {
        Object.assign(effect, { recurrence: '', targetSessionId: 'elsewhere' })
        return NAMED
      },
      reviewDelivery: () => ({ kind: 'allow' }),
    } })
    const request = approving(test)
    askPolicy(test)
    const created = await call(test, 'schedule_create', TASK) as { id: string }
    expect(request.mock.calls.at(0)?.at(0)?.reason).toBe(`${ASK_REASON} ${NAMED}`)
    expect(taskTable(test.ctx).get(ScheduleId(created.id))).toMatchObject({
      target: { kind: 'session', sessionId: test.agent.session.id }, record: { kind: 'rrule', rrule: DAILY },
    })
  })

  it('treats a whitespace-only naming as naming nothing', async () => {
    const test = await setup({ consent: { nameEffect: () => ' \n ', reviewDelivery: () => ({ kind: 'allow' }) } })
    const request = approving(test)
    // Without another policy's ask, the consent asks with its own sentence instead of a blank one.
    await call(test, 'schedule_create', TASK)
    const unnamed = request.mock.calls.at(0)?.at(0)?.reason
    expect(unnamed?.trim()).toBe(unnamed)
    expect(unnamed).not.toBe('')
    // Beside another policy's ask, the reason stays that policy's own, with nothing appended.
    askPolicy(test)
    await call(test, 'schedule_create', TASK)
    expect(request.mock.calls.at(1)?.at(0)?.reason).toBe(ASK_REASON)
  })
})

describe('Schedule consent naming of a stored rule', () => {
  it.each<[string, ScheduleTiming, string]>([
    ['cron', { kind: 'cron', cron: { expression: '0 9 * * 1', time_zone: 'UTC' } }, '0 9 * * 1'],
    ['daily', { kind: 'daily', daily: { time: '09:00:00', time_zone: 'UTC' } }, 'daily at 09:00:00.000 (UTC)'],
    ['weekly', { kind: 'weekly', weekly: { time: '09:00:00', time_zone: 'UTC', weekdays: [1] } }, 'weekly at 09:00:00.000 (UTC)'],
    ['every', { kind: 'every', every_seconds: 3600 }, 'every 3600 seconds'],
    ['one-shot', { kind: 'after', after_seconds: 3600 }, '2026-09-16T01:00:00.000Z'],
  ])('names the stored %s rule on an edit that restates none', async (_label, timing, recurrence) => {
    const nameEffect = vi.fn((_effect: ScheduleEffect) => NAMED)
    const test = await setup({ consent: { nameEffect, reviewDelivery: () => ({ kind: 'allow' }) } })
    approving(test)
    const created = await test.service.create({
      title: 'Queue check', prompt: 'Check the queue', timing, target: { kind: 'session', sessionId: test.agent.session.id },
    }, test.agent.session.id)
    await call(test, 'schedule_edit', { id: created.id, action: 'update', title: 'Renamed' })
    expect(nameEffect.mock.calls.at(0)?.at(0)).toMatchObject({ tool: 'schedule_edit', recurrence })
  })
})

describe('Schedule consent facts from raw call arguments', () => {
  /** Run one call whose arguments the tool's schema may refuse; the consent reads them before the schema does. */
  async function attempt(test: Setup, name: string, args: unknown): Promise<void> {
    await executeToolFixture(test.ctx, {
      callId: ToolCallId('consent-raw'), signal: new AbortController().signal, name, arguments: args, agent: test.agent,
    })
  }

  it.each([
    ['schedule_create', 'not an object'],
    ['schedule_create', { title: 'Queue check', prompt: 'Check the queue' }],
    ['schedule_edit', { action: 'update', title: 'Renamed' }],
    ['schedule_edit', { id: 'schedule-missing', action: 'update', title: 'Renamed' }],
  ] as const)('names nothing and asks nothing for a %s call whose arguments name no effect: %j', async (name, args) => {
    const nameEffect = vi.fn((_effect: ScheduleEffect) => NAMED)
    const test = await setup({ consent: { nameEffect, reviewDelivery: () => ({ kind: 'allow' }) } })
    const request = approving(test)
    await attempt(test, name, args)
    expect(nameEffect).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('names a create that states no target as a chat its first delivery opens', async () => {
    const nameEffect = vi.fn((_effect: ScheduleEffect) => NAMED)
    const test = await setup({ consent: { nameEffect, reviewDelivery: () => ({ kind: 'allow' }) }, presets: presetsOf() })
    approving(test)
    const { target: _target, ...untargeted } = TASK
    await attempt(test, 'schedule_create', untargeted)
    expect(nameEffect.mock.calls.at(0)?.at(0)).toMatchObject({
      tool: 'schedule_create', recurrence: DAILY, targetSessionId: undefined, targetPreset: DEPLOYMENT_DEFAULT,
    } satisfies Partial<ScheduleEffect>)
  })

  it('names the rule and the target an edit restates instead of the stored ones', async () => {
    const nameEffect = vi.fn((_effect: ScheduleEffect) => NAMED)
    const test = await setup({ consent: { nameEffect, reviewDelivery: () => ({ kind: 'allow' }) }, presets: presetsOf() })
    approving(test)
    const created = await call(test, 'schedule_create', TASK) as { id: string }
    nameEffect.mockClear()
    await call(test, 'schedule_edit', { id: created.id, action: 'update', rrule: ONCE, target: 'new' })
    expect(nameEffect.mock.calls.at(0)?.at(0)).toMatchObject({
      tool: 'schedule_edit', recurrence: ONCE, targetSessionId: undefined, targetPreset: DEPLOYMENT_DEFAULT,
    } satisfies Partial<ScheduleEffect>)
  })

  it('states only the naming when another policy asks without a reason', async () => {
    const test = await setup({ consent: { nameEffect: () => NAMED, reviewDelivery: () => ({ kind: 'allow' }) } })
    const request = approving(test)
    test.ctx.on('tools/pre-execute', async (_exec, next) => {
      const gate = await next()
      return gate.kind === 'allow' ? { kind: 'ask' as const } : gate
    })
    await call(test, 'schedule_create', TASK)
    expect(request.mock.calls.at(0)?.at(0)?.reason).toBe(NAMED)
  })
})

describe('Schedule consent naming of a chat opened in a Workspace with its own preset', () => {
  it('names the Workspace preset the opened chat will run and binds the task to it', async () => {
    const nameEffect = vi.fn((_effect: ScheduleEffect) => NAMED)
    const test = await setup({
      consent: { nameEffect, presetFor: () => 'workspace-project', reviewDelivery: () => ({ kind: 'allow' }) },
      presets: presetsOf(),
    })
    approving(test)
    const created = await call(test, 'schedule_create', { ...TASK, target: 'new' }) as { id: string }
    expect(nameEffect.mock.calls.at(0)?.at(0)).toMatchObject({ targetSessionId: undefined, targetPreset: 'workspace-project' })
    expect(taskTable(test.ctx).get(ScheduleId(created.id))).toMatchObject({ creationPreset: 'workspace-project' })
  })
})

describe('Schedule consent baseline bound to the approved ask', () => {
  it('stores the preset the ask named although the chat moved before the person answered', async () => {
    let preset = CALLER_PRESET
    const test = await setup({
      consent: { nameEffect: () => NAMED, reviewDelivery: () => ({ kind: 'allow' }) },
      presets: { defaultPreset: DEPLOYMENT_DEFAULT, current: () => preset },
    })
    const request = approving(test)
    request.mockImplementation(async () => {
      preset = 'danger-full-access'
      return 'allowed-once'
    })
    const created = await call(test, 'schedule_create', TASK) as { id: string }
    expect(taskTable(test.ctx).get(ScheduleId(created.id))).toMatchObject({ creationPreset: CALLER_PRESET })

    preset = 'narrow'
    request.mockImplementation(async () => {
      preset = 'danger-full-access'
      return 'allowed-once'
    })
    await call(test, 'schedule_edit', { id: created.id, action: 'update', title: 'Renamed' })
    expect(taskTable(test.ctx).get(ScheduleId(created.id))).toMatchObject({ creationPreset: 'narrow' })
  })

  it('binds the preset the ask named even when the consent edits the effect it is handed', async () => {
    const test = await setup({
      consent: {
        nameEffect: (effect) => {
          Object.assign(effect, { targetPreset: 'danger-full-access' })
          return NAMED
        },
        reviewDelivery: () => ({ kind: 'allow' }),
      },
      presets: presetsOf(),
    })
    approving(test)
    const created = await call(test, 'schedule_create', TASK) as { id: string }
    expect(taskTable(test.ctx).get(ScheduleId(created.id))).toMatchObject({ creationPreset: CALLER_PRESET })
  })
})

describe('Schedule consent facts a person reads', () => {
  it('names the title, the start of the instruction and the chat title, bounded and without control characters', async () => {
    const nameEffect = vi.fn((_effect: ScheduleEffect) => NAMED)
    const test = await setup({
      consent: { nameEffect, reviewDelivery: () => ({ kind: 'allow' }) },
      titles: { get: () => ({ title: 'Inbox\u0007 triage\u202e' }) },
    })
    approving(test)
    await call(test, 'schedule_create', { ...TASK, title: 'Queue\ncheck', prompt: `Check\tthe queue ${'x'.repeat(300)}` })
    const named = nameEffect.mock.calls.at(0)?.at(0)
    expect(named).toMatchObject({ title: 'Queue check', targetTitle: 'Inbox triage' })
    expect(named?.prompt.startsWith('Check the queue x')).toBe(true)
    expect(named?.prompt).toHaveLength(200)
    expect(named?.prompt.endsWith('…')).toBe(true)
  })

  it('names the new instruction of an edit that changes only the instruction', async () => {
    const nameEffect = vi.fn((_effect: ScheduleEffect) => NAMED)
    const test = await setup({ consent: { nameEffect, reviewDelivery: () => ({ kind: 'allow' }) } })
    approving(test)
    const created = await call(test, 'schedule_create', TASK) as { id: string }
    nameEffect.mockClear()
    await call(test, 'schedule_edit', { id: created.id, action: 'update', prompt: 'Delete the archive' })
    expect(nameEffect.mock.calls.at(0)?.at(0)).toMatchObject({ title: TASK.title, prompt: 'Delete the archive' })
  })

  it('names the directory a stored target opens its chat in', async () => {
    const nameEffect = vi.fn((_effect: ScheduleEffect) => NAMED)
    const test = await setup({ consent: { nameEffect, reviewDelivery: () => ({ kind: 'allow' }) } })
    approving(test)
    const created = await test.service.create({
      title: 'Queue check', prompt: 'Check the queue', timing: { kind: 'rrule', rrule: DAILY },
      target: { kind: 'new', create: { cwd: '/work/app' } },
    }, test.agent.session.id)
    await call(test, 'schedule_edit', { id: created.id, action: 'update', title: 'Renamed' })
    expect(nameEffect.mock.calls.at(0)?.at(0)).toMatchObject({ targetSessionId: undefined, targetCwd: '/work/app', targetTitle: undefined })
  })
})
