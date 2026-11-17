import { describe, expect, it } from 'vitest'
import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeCodeDriver } from '../src/driver.ts'
import { eventWindow, probeObservation, signedInFrom, usageWindows } from '../src/limits.ts'
import { FakeSdk } from './fake-sdk.ts'

const usage = {
  session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 1, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: null,
    seven_day: { utilization: 46, resets_at: '2026-11-19T16:00:00.366043+00:00' },
    seven_day_opus: { utilization: 100, resets_at: null },
    seven_day_sonnet: { utilization: null, resets_at: 'not a date' },
  },
} as SDKControlGetUsageResponse

describe('Claude Code limits', () => {
  it('maps a run\'s rate-limit event: fraction to percent, seconds to milliseconds, warning to near', () => {
    expect(eventWindow({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.44, resetsAt: 1_795_104_000 }))
      .toEqual({ kind: 'seven_day', usedPercent: 44, resetsAt: 1_795_104_000_000, status: 'near' })
    expect(eventWindow({ status: 'allowed' })).toEqual({ kind: 'unknown', status: 'allowed' })
  })

  it('maps the usage answer\'s windows and skips empty ones', () => {
    expect(usageWindows(usage)).toEqual([
      { kind: 'seven_day', usedPercent: 46, resetsAt: Date.parse('2026-11-19T16:00:00.366043+00:00'), status: 'allowed' },
      { kind: 'seven_day_opus', usedPercent: 100, status: 'reached' },
      { kind: 'seven_day_sonnet', status: 'unknown' },
    ])
    expect(usageWindows({ ...usage, rate_limits_available: false })).toEqual([])
  })

  it('keeps the plan and drops the email, organisation and token sources', () => {
    const observation = probeObservation({ email: 'person@example.invalid', organization: 'Example Org', subscriptionType: 'max', tokenSource: 'claude.ai', apiProvider: 'firstParty' }, usage)
    expect(observation).toMatchObject({ provider: 'claude-code', signedIn: 'yes', plan: 'max', source: 'probe' })
    expect(JSON.stringify(observation)).not.toMatch(/example|claude\.ai|Org/)
  })

  it('reads the sign-in state from the account answer alone', () => {
    expect(signedInFrom({ subscriptionType: 'pro', tokenSource: 'claude.ai', apiProvider: 'firstParty' })).toBe('yes')
    expect(signedInFrom({ tokenSource: 'none', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' })).toBe('yes')
    expect(signedInFrom({ apiProvider: 'bedrock' })).toBe('yes')
    expect(signedInFrom({ tokenSource: 'none', apiProvider: 'firstParty' })).toBe('no')
    expect(signedInFrom({})).toBe('unknown')
  })
})

describe('a limits check', () => {
  function driver(sdk: FakeSdk): ClaudeCodeDriver {
    return new ClaudeCodeDriver({ sdk: () => Promise.resolve(sdk), harnessToolTimeoutMs: () => 1, level: () => 'standard', spawnOption: () => () => { throw new Error('no process') } })
  }
  const probe = { spawn: () => { throw new Error('no process') }, cwd: '/tmp/empty' }

  it('sends no message, reads none of the person\'s settings, and closes the program', async () => {
    const sdk = new FakeSdk((query) => { query.usage = usage })
    const observation = await driver(sdk).probe({ ...probe, signal: new AbortController().signal })
    expect(observation.windows).toHaveLength(3)
    expect(observation.plan).toBe('max')
    expect(sdk.last.options.settingSources).toEqual([])
    expect(sdk.last.options.persistSession).toBe(false)
    expect(sdk.last.sent).toEqual([])
    expect(sdk.last.closed).toBe(true)
  })

  it('gives the sign-in state and no windows when the usage call fails', async () => {
    const sdk = new FakeSdk()
    const observation = await driver(sdk).probe({ ...probe, signal: new AbortController().signal })
    expect(observation).toEqual({ provider: 'claude-code', signedIn: 'yes', plan: 'max', windows: [], source: 'probe' })
  })

  it('fails when the program cannot report its account, and closes it', async () => {
    const failing = new FakeSdk((query) => { query.account = () => { throw new Error('unreachable') } })
    await expect(driver(failing).probe({ ...probe, signal: new AbortController().signal })).rejects.toThrow('account unavailable')
    expect(failing.last.closed).toBe(true)
  })

  it('stops when the gate aborts it', async () => {
    const sdk = new FakeSdk()
    const controller = new AbortController()
    controller.abort(new Error('gate stopped the check'))
    await expect(driver(sdk).probe({ ...probe, signal: controller.signal })).rejects.toThrow('gate stopped the check')
  })
})
