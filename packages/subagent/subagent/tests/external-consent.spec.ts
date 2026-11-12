/** The optional external-delegation consent: no allow, no start; a set time limit ends the run. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime, { limitExternalRunTime } from '../src/index.ts'
import type { DelegationConsentService, ExternalDelegationReview, ExternalDelegationVerdict } from '../src/index.ts'
import type { SubagentCapabilities, SubagentResult, SubagentRun } from '../src/types.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { externalTestParent } from './external-activation-helpers.ts'
import { TestSessionQuery } from './test-session-query.ts'

const capabilities: SubagentCapabilities = {
  agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false,
}

const completed: SubagentResult = { output: [{ type: 'text', text: 'Done.' }], stopReason: 'completed' }

/** One controllable external run. */
function execution() {
  const result = Promise.withResolvers<SubagentResult>()
  const dispose = vi.fn(() => {
    result.resolve({ output: [{ type: 'text', text: 'partial' }], stopReason: 'aborted' })
    return Promise.resolve()
  })
  const run: SubagentRun = { id: SessionId('external-run'), result: result.promise, dispose }
  return { result, dispose, run }
}

/**
 * Mount the runtime with an external and a local provider and, optionally, a consent service.
 * @param consent - the consent service to provide, when any.
 */
async function setup(consent?: DelegationConsentService) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  if (consent !== undefined) ctx.provide('delegationConsent', consent)
  const parent = await externalTestParent(ctx)
  await ctx.plugin(TestSessionQuery)
  const backend = execution()
  const start = vi.fn(() => Promise.resolve(backend.run))
  ctx.subagents.registerProvider({ name: 'claude-code', capabilities, inheritsParentContext: false, start })
  return {
    ctx, parent, backend, start,
    startRun: (signal: AbortSignal = new AbortController().signal) => ctx.subagents.startActivation({
      provider: 'claude-code', label: 'Review the diff', signal, delivery: 'caller',
      request: { parent, prompt: [{ type: 'text', text: 'Review the diff' }] },
    }),
  }
}

afterEach(() => { vi.useRealTimers() })

describe('external delegation consent', () => {
  it('starts every external provider unreviewed when no consent is composed', async () => {
    const fixture = await setup()
    const activation = await fixture.startRun()
    expect(fixture.start).toHaveBeenCalledOnce()
    fixture.backend.result.resolve(completed)
    await expect(activation.result).resolves.toEqual(completed)
  })

  it('reviews the provider, the parent, the resolved directory and the label before the provider runs', async () => {
    const reviews: ExternalDelegationReview[] = []
    const fixture = await setup({ review: (review) => { reviews.push(review); return Promise.resolve({ kind: 'allow' }) } })
    await fixture.startRun()
    expect(reviews).toHaveLength(1)
    expect(reviews[0]?.provider).toBe('claude-code')
    expect(reviews[0]?.parent).toBe(fixture.parent)
    expect(reviews[0]?.label).toBe('Review the diff')
    expect(reviews[0]?.cwd).toMatch(/^\//)
    expect(fixture.start).toHaveBeenCalledOnce()
  })

  it('starts nothing and names the reason when the consent refuses', async () => {
    const fixture = await setup({ review: () => Promise.resolve({ kind: 'refuse', reason: 'the person declined Claude Code' }) })
    await expect(fixture.startRun()).rejects.toMatchObject({ code: 'DELEGATION_CONSENT_REFUSED', message: 'the person declined Claude Code' })
    expect(fixture.start).not.toHaveBeenCalled()
  })

  it.each([
    ['a refusal without a reason', { kind: 'refuse', reason: '' }],
    ['an unknown verdict', { kind: 'maybe' }],
  ])('starts nothing for %s', async (_name, verdict) => {
    const fixture = await setup({ review: () => Promise.resolve(verdict as ExternalDelegationVerdict) })
    await expect(fixture.startRun()).rejects.toMatchObject({ code: 'DELEGATION_CONSENT_REFUSED' })
    expect(fixture.start).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, Number.NaN, 2_147_483_648])('starts nothing when the consent sets the invalid time limit %s', async (timeoutMs) => {
    const fixture = await setup({ review: () => Promise.resolve({ kind: 'allow', timeoutMs }) })
    await expect(fixture.startRun()).rejects.toMatchObject({ code: 'DELEGATION_CONSENT_FAILED' })
    expect(fixture.start).not.toHaveBeenCalled()
  })

  it('starts nothing when the review throws', async () => {
    const fixture = await setup({ review: () => Promise.reject(new Error('store unreadable')) })
    await expect(fixture.startRun()).rejects.toMatchObject({ code: 'DELEGATION_CONSENT_FAILED' })
    expect(fixture.start).not.toHaveBeenCalled()
  })

  it('starts nothing when the start is cancelled while the review waits', async () => {
    const answer = Promise.withResolvers<ExternalDelegationVerdict>()
    const fixture = await setup({ review: () => answer.promise })
    const controller = new AbortController()
    const starting = fixture.startRun(controller.signal)
    controller.abort(new Error('turn cancelled'))
    answer.resolve({ kind: 'allow' })
    await expect(starting).rejects.toThrow()
    expect(fixture.start).not.toHaveBeenCalled()
  })

  it('ends a run at the time limit the consent set and tells the parent why', async () => {
    const fixture = await setup({ review: () => Promise.resolve({ kind: 'allow', timeoutMs: 30 * 60_000 }) })
    vi.useFakeTimers()
    const activation = await fixture.startRun()
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    vi.useRealTimers()
    const result = await activation.result
    expect(fixture.backend.dispose).toHaveBeenCalled()
    expect(result.stopReason).toBe('error')
    expect(result.output).toEqual([{ type: 'text', text: 'partial' }])
    expect(result.diagnostic).toContain('stopped after 30 minutes')
  })
})

describe('limitExternalRunTime', () => {
  it('keeps a result that settles before the limit and clears the timer', async () => {
    vi.useFakeTimers()
    const backend = execution()
    const limited = limitExternalRunTime(backend.run, 1_000, 'codex')
    backend.result.resolve(completed)
    await expect(limited.result).resolves.toEqual(completed)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(backend.dispose).not.toHaveBeenCalled()
  })

  it('names a limit under a minute in milliseconds and tolerates a failing teardown', async () => {
    vi.useFakeTimers()
    const result = Promise.withResolvers<SubagentResult>()
    const dispose = vi.fn(() => {
      result.resolve({ output: [], stopReason: 'aborted' })
      return Promise.reject(new Error('teardown failed'))
    })
    const limited = limitExternalRunTime({ id: SessionId('r'), result: result.promise, dispose }, 500, 'codex')
    await vi.advanceTimersByTimeAsync(500)
    await expect(limited.result).resolves.toMatchObject({ stopReason: 'error', diagnostic: expect.stringContaining('after 500 ms') })
  })

  it('names one minute in the singular', async () => {
    vi.useFakeTimers()
    const backend = execution()
    const limited = limitExternalRunTime(backend.run, 60_000, 'codex')
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(limited.result).resolves.toMatchObject({ diagnostic: expect.stringContaining('after 1 minute,') })
  })

  it('clears the timer when the run is disposed first', async () => {
    vi.useFakeTimers()
    const backend = execution()
    const limited = limitExternalRunTime(backend.run, 1_000, 'codex')
    await limited.dispose()
    await expect(limited.result).resolves.toMatchObject({ stopReason: 'aborted' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(backend.dispose).toHaveBeenCalledOnce()
  })
})
