// @vitest-environment jsdom
/** The agent card's sign-in line and plan limits on the onboarding Agents step. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_BUNDLES, AgentsStep } from '../src/client/steps/Agents.tsx'
import { createGuide } from '../src/client/guide.ts'
import { en } from '../src/client/locales.ts'
import type { Readiness, ReadinessAccount } from '../src/wire.ts'
import { hostFake, installerFake, READY, stepServices } from './fixtures.client.ts'

afterEach(cleanup)

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)
const HOUR = 3_600_000

const stored = (change: Partial<ReadinessAccount> = {}): ReadinessAccount => ({
  provider: 'claude-code', installed: true, signedIn: 'yes', plan: 'max', checkedAt: NOW - 60_000,
  windows: [
    { kind: 'five_hour', status: 'allowed', usedPercent: 32, resetsAt: NOW + HOUR, seenAt: NOW - 60_000, source: 'probe' },
    { kind: 'seven_day', status: 'allowed', usedPercent: 12, resetsAt: NOW + 50 * HOUR, seenAt: NOW - 60_000, source: 'probe' },
  ],
  ...change,
})

const withAccounts = (...agents: ReadinessAccount[]): Readiness => ({ ...READY, accounts: { agents, now: NOW } })

/** Render the step with Claude Code added. */
async function show(readiness: Readiness, fetch: (input: string, init?: RequestInit) => Promise<Response> = () => Promise.reject(new Error('no request expected'))) {
  const [claude] = AGENT_BUNDLES
  const fake = installerFake({ [claude.name]: { state: 'installed' } })
  const services = stepServices({ bundles: fake.installer, pin: { fetch, openSettings: () => undefined } })
  render(<AgentsStep services={services} guide={createGuide(hostFake({ readiness }).host)} />)
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  return screen.getByRole('heading', { level: 4, name: 'Claude Code' }).closest('li') as HTMLElement
}

describe('the agent card\'s sign-in line and limits', () => {
  it('says "Signed in · Max plan" from the store, with both bars, instead of the file hint', async () => {
    const card = await show(withAccounts(stored()))
    expect(within(card).getByText('Signed in · Max plan')).toBeTruthy()
    expect(within(card).queryByText(en['agents.claude.signIn.found'])).toBeNull()
    expect(within(card).getByText('5-hour limit')).toBeTruthy()
    expect(within(card).getByText('32% used')).toBeTruthy()
    expect(within(card).getByText('Weekly limit')).toBeTruthy()
  })

  it('keeps the file hint until a check has said, and shows no bars without a store', async () => {
    const card = await show(READY)
    expect(within(card).getByText(en['agents.claude.signIn.found'])).toBeTruthy()
    expect(within(card).queryByText('Check now')).toBeNull()
    cleanup()
    const unknown = await show(withAccounts(stored({ signedIn: 'unknown', plan: undefined, windows: [] })))
    expect(within(unknown).getByText(en['agents.claude.signIn.found'])).toBeTruthy()
    expect(within(unknown).getByText('No limit figures yet.')).toBeTruthy()
  })

  it('names the sign-in command when the store says the agent is not signed in, even over a found file', async () => {
    const card = await show(withAccounts(stored({ signedIn: 'no', plan: undefined, windows: [] })))
    expect(within(card).getByText('Not signed in')).toBeTruthy()
    expect(within(card).getByText('delorun agents login claude-code')).toBeTruthy()
  })

  it('shows a near window and a reached window in words', async () => {
    const card = await show(withAccounts(stored({ windows: [
      { kind: 'five_hour', status: 'near', usedPercent: 88, resetsAt: NOW + HOUR, seenAt: NOW - 60_000, source: 'probe' },
      { kind: 'seven_day', status: 'reached', usedPercent: 100, resetsAt: NOW + 5 * HOUR, seenAt: NOW - 60_000, source: 'probe' },
    ] })))
    expect(within(card).getByText(/Near the limit/)).toBeTruthy()
    expect(within(card).getByText(/Limit reached/)).toBeTruthy()
  })

  it('says "Last seen" for figures two hours old', async () => {
    const old = NOW - 2 * HOUR
    const card = await show(withAccounts(stored({ checkedAt: old, windows: [{ kind: 'five_hour', status: 'allowed', usedPercent: 40, resetsAt: NOW + HOUR, seenAt: old, source: 'probe' }] })))
    expect(within(card).getByText(/^Last seen /)).toBeTruthy()
  })

  it('shows no limits before the agent is added', async () => {
    const [claude] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state: 'available' } })
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} guide={createGuide(hostFake({ readiness: withAccounts(stored()) }).host)} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const card = screen.getByRole('heading', { level: 4, name: 'Claude Code' }).closest('li') as HTMLElement
    expect(within(card).queryByText('5-hour limit')).toBeNull()
  })

  it('checks only on Check now, and shows the new figures', async () => {
    const fetch = vi.fn((_input: string, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({
      outcome: { kind: 'checked' }, now: NOW,
      record: { ...stored({ plan: 'pro', windows: [{ kind: 'five_hour', status: 'allowed', usedPercent: 71, resetsAt: NOW + HOUR, seenAt: NOW, source: 'probe' }] }) },
    }), { status: 200 })))
    const card = await show(withAccounts(stored()), fetch)
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.click(within(card).getByRole('button', { name: 'Check now' }))
    await waitFor(() => { expect(within(card).getByText('71% used')).toBeTruthy() })
    expect(within(card).getByText('Signed in · Pro plan')).toBeTruthy()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ provider: 'claude-code' }))
  })

  // Pointing a refusal at an unlock sends the person to a dialog that no longer opens a check (F36).
  it('says the check was not confirmed after a refusal, and keeps "Check now"', async () => {
    const fetch = (): Promise<Response> => Promise.resolve(new Response(JSON.stringify({ error: 'ELEVATION_REQUIRED', message: 'Confirm first.' }), { status: 403 }))
    const card = await show(withAccounts(stored()), fetch)
    fireEvent.click(within(card).getByRole('button', { name: 'Check now' }))
    await waitFor(() => { expect(within(card).getByText(/^Not confirmed, so nothing was checked\./)).toBeTruthy() })
    expect(within(card).getByRole('button', { name: 'Check now' })).toBeTruthy()
  })
})
