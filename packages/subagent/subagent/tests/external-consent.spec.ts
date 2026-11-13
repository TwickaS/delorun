/** The optional external-delegation consent: no allow, no start; a set time limit ends the run. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime, { DELEGATION_CONSENT_PROVIDER_EXPORT, limitExternalRunTime } from '../src/index.ts'
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

describe('a Loader row that declares the external-delegation consent', () => {
  /**
   * Mount the runtime under a Loader and create one row from a module.
   * @param module - the row's plugin module, or its pending import.
   * @param disabled - the row's `disabled` value, or its getter.
   * @returns the fixture and the row's creation.
   */
  async function withRow(module: object | Promise<object>, disabled?: () => boolean) {
    const fixture = await setup()
    await fixture.ctx.plugin(Loader)
    fixture.ctx.loader.builtins['row'] = module
    const options = { name: 'cordis:row' }
    if (disabled !== undefined) Object.defineProperty(options, 'disabled', { get: disabled, enumerable: true })
    const created = fixture.ctx.loader.create(options)
    return { ...fixture, created }
  }

  const allow: DelegationConsentService = { review: () => Promise.resolve({ kind: 'allow' }) }

  it('starts nothing while the declaring row is not running', async () => {
    const fixture = await withRow({ name: 'consent', [DELEGATION_CONSENT_PROVIDER_EXPORT]: true, apply() { throw new Error('the consent crashed') } })
    await fixture.created
    await expect(fixture.startRun()).rejects.toMatchObject({ code: 'DELEGATION_CONSENT_UNAVAILABLE' })
    expect(fixture.start).not.toHaveBeenCalled()
  })

  it('waits for a declaring row whose module is still importing, then asks the consent it provides', async () => {
    const module = Promise.withResolvers<object>()
    const review = vi.fn(allow.review)
    const fixture = await withRow(module.promise)
    const activation = fixture.startRun()
    module.resolve({ name: 'consent', [DELEGATION_CONSENT_PROVIDER_EXPORT]: true, apply(ctx: Context) { ctx.provide('delegationConsent', { review }) } })
    await activation
    expect(review).toHaveBeenCalledOnce()
    expect(fixture.start).toHaveBeenCalledOnce()
  })

  it('starts unreviewed, as upstream does, when the declaring row runs without providing a consent', async () => {
    const fixture = await withRow({ name: 'consent', [DELEGATION_CONSENT_PROVIDER_EXPORT]: true, apply() {} })
    await fixture.created
    await fixture.startRun()
    expect(fixture.start).toHaveBeenCalledOnce()
  })

  it.each([
    ['a row that declares nothing and fails', { name: 'other', apply() { throw new Error('unrelated failure') } }, undefined],
    ['a function plugin row', (): void => undefined, undefined],
    ['a disabled declaring row', { name: 'consent', [DELEGATION_CONSENT_PROVIDER_EXPORT]: true, apply() { throw new Error('never starts') } }, () => true],
    ['a declaring row whose disabled expression throws', { name: 'consent', [DELEGATION_CONSENT_PROVIDER_EXPORT]: true, apply() { throw new Error('never starts') } }, () => { throw new Error('the expression failed') }],
  ])('starts unreviewed, as upstream does, beside %s', async (_name, module, disabled) => {
    const fixture = await withRow(module, disabled)
    await fixture.created.catch((error: unknown) => error)
    await fixture.startRun()
    expect(fixture.start).toHaveBeenCalledOnce()
  })

  it('starts unreviewed when the only row\'s module fails to import', async () => {
    const fixture = await withRow(Promise.reject(new Error('the module could not be imported')))
    await fixture.created.catch((error: unknown) => error)
    await fixture.startRun()
    expect(fixture.start).toHaveBeenCalledOnce()
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

  it('passes on a capture failure before the limit and clears the timer', async () => {
    vi.useFakeTimers()
    const backend = execution()
    const limited = limitExternalRunTime(backend.run, 1_000, 'codex')
    backend.result.reject(new Error('capture failed'))
    await expect(limited.result).rejects.toThrow('capture failed')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(backend.dispose).not.toHaveBeenCalled()
  })

  it('reports the limit when the stopped run\'s capture fails', async () => {
    vi.useFakeTimers()
    const result = Promise.withResolvers<SubagentResult>()
    const dispose = vi.fn(() => {
      result.reject(new Error('capture failed'))
      return Promise.resolve()
    })
    const limited = limitExternalRunTime({ id: SessionId('r'), result: result.promise, dispose }, 60_000, 'codex')
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(limited.result).resolves.toEqual({ output: [], stopReason: 'error', diagnostic: expect.stringContaining('after 1 minute,') })
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
