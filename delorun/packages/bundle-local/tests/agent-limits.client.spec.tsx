// @vitest-environment jsdom
/** The sign-in line, the limit bars and "Check now" on the Settings card, over a fake home. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { DelegationConsentSettings } from '@delorun/plugin-delegation-consent/wire'
import { ACCOUNT_ROUTES, type AccountsAnswer, type RefreshAnswer, type RefreshOutcome } from '@delorun/external-agents/accounts/wire'
import { en } from '../src/client/consents-locales.ts'
import { ExternalAgentsSection, type ExternalAgentsSectionProps } from '../src/client/ExternalAgentsSection.tsx'
import { fakeHost, type Answer } from './fake-host.ts'
import { account, HOUR, MINUTE, NOW, window } from './agent-limits.fixture.ts'

afterEach(() => { cleanup() })

const t = makeTranslate(en)
const READ = `GET ${ACCOUNT_ROUTES.accounts}` as const
const CHECK = `POST ${ACCOUNT_ROUTES.refresh}` as const
const GRANTS = `GET /api/delorunDelegationConsent.grants` as const

const answer = (...accounts: AccountsAnswer['accounts'][number][]): Answer => ({ status: 200, body: { accounts, now: NOW } satisfies AccountsAnswer })
const checked = (outcome: RefreshOutcome, record = account()): Answer => ({ status: 200, body: { outcome, record, now: NOW } satisfies RefreshAnswer })

/** Render the External agents section over a fake home; the consent row is not served, so only the limits card shows. */
function show(script: Parameters<typeof fakeHost>[0]) {
  const host = fakeHost({ [GRANTS]: { status: 404, body: { error: 'NOT_FOUND', message: 'none' } }, ...script })
  const form = createSnapshotStore<ConfigFormSnapshot<DelegationConsentSettings>>({ status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: 0, writable: true })
  const mutation = createSnapshotStore({ busy: false, failed: false })
  const props = {
    t, close: () => {}, fetch: host.fetch,
    useAgentSettings: bindSnapshotSelector(form), useAgentSettingsMutation: bindSnapshotSelector(mutation),
    setAgentSetting: async () => {},
  } as ExternalAgentsSectionProps
  render(<ExternalAgentsSection {...props} />)
  return host
}

const row = async (agent: string): Promise<HTMLElement> => {
  const found = await waitFor(() => {
    const element = document.querySelector<HTMLElement>(`[data-agent="${agent}"]`)
    if (element === null) throw new Error('no row yet')
    return element
  })
  return found
}

describe('Plans and limits in Settings', () => {
  it('shows one row per added agent with the sign-in line, both bars and their reset times', async () => {
    show({ [READ]: answer(account(), account({ provider: 'codex', installed: false })) })
    const claude = await row('claude-code')
    expect(within(claude).getByText('Signed in · Max plan')).toBeTruthy()
    expect(within(claude).getByText('5-hour limit')).toBeTruthy()
    expect(within(claude).getByText('32% used')).toBeTruthy()
    expect(within(claude).getByText('Weekly limit')).toBeTruthy()
    expect(within(claude).getAllByText(/^Resets /)).toHaveLength(2)
    expect(within(claude).getByText(/^As of /)).toBeTruthy()
    expect(document.querySelector('[data-agent="codex"]')).toBeNull()
  })

  it('says "near" and "reached" in words as well as colours, and names the percentage', async () => {
    show({ [READ]: answer(account({ windows: [window({ kind: 'five_hour', usedPercent: 86, status: 'near' }), window({ kind: 'seven_day', usedPercent: 100, status: 'reached' })] })) })
    const claude = await row('claude-code')
    expect(within(claude).getByText(/Near the limit/)).toBeTruthy()
    expect(within(claude).getByText(/Limit reached/)).toBeTruthy()
    expect(claude.querySelector('[data-standing="near"]')).not.toBeNull()
    expect(claude.querySelector('[data-standing="reached"]')).not.toBeNull()
    const bars = within(claude).getAllByRole('progressbar')
    expect(bars.map(bar => bar.getAttribute('aria-label'))).toEqual(['5-hour limit: Near the limit, 86% used', 'Weekly limit: Limit reached, 100% used'])
  })

  it('says "Not signed in" for a signed-out agent and "Sign-in not checked yet" before any check', async () => {
    show({ [READ]: answer(account({ signedIn: 'no', plan: undefined, windows: [] }), account({ provider: 'codex', signedIn: 'unknown', plan: undefined, windows: [] })) })
    expect(within(await row('claude-code')).getByText('Not signed in')).toBeTruthy()
    expect(within(await row('codex')).getByText('Sign-in not checked yet')).toBeTruthy()
    expect(within(await row('codex')).getByText('No limit figures yet.')).toBeTruthy()
  })

  it('says "Last seen" for old figures and "reset … not checked since" once a reset time has passed', async () => {
    const old = NOW - 2 * HOUR
    show({ [READ]: answer(account({
      checkedAt: old,
      windows: [window({ kind: 'five_hour', seenAt: old, resetsAt: NOW - MINUTE, usedPercent: 90 }), window({ kind: 'seven_day', seenAt: old, resetsAt: NOW + 20 * HOUR })],
    })) })
    const claude = await row('claude-code')
    expect(within(claude).getByText(/^Last seen /)).toBeTruthy()
    expect(within(claude).queryByText(/^As of /)).toBeNull()
    expect(within(claude).getByText(/^Reset at .*, not checked since$/)).toBeTruthy()
    expect(claude.querySelector('[data-standing="reset"]')).not.toBeNull()
    expect(within(claude).getByText('No figure')).toBeTruthy()
  })

  it('reads the figures when shown without starting a check', async () => {
    const host = show({ [READ]: answer(account()) })
    await row('claude-code')
    expect(host.count(READ)).toBe(1)
    expect(host.count(CHECK)).toBe(0)
  })

  it('checks only when Check now is pressed, and shows the new figures and the outcome', async () => {
    const host = show({
      [READ]: answer(account()),
      [CHECK]: checked({ kind: 'checked' }, account({ windows: [window({ kind: 'five_hour', usedPercent: 61 })] })),
    })
    const claude = await row('claude-code')
    fireEvent.click(within(claude).getByRole('button', { name: 'Check now' }))
    await waitFor(() => { expect(within(claude).getByText('61% used')).toBeTruthy() })
    expect(within(claude).getByText('Checked.')).toBeTruthy()
    expect(host.received.filter(request => request.key === CHECK).map(request => request.body)).toEqual([{ provider: 'claude-code' }])
  })

  it('says what a throttled, failed or refused check did', async () => {
    const host = show({ [READ]: answer(account()), [CHECK]: checked({ kind: 'throttled', nextAt: NOW + 20 * MINUTE }) })
    const claude = await row('claude-code')
    fireEvent.click(within(claude).getByRole('button', { name: 'Check now' }))
    await waitFor(() => { expect(within(claude).getByText(/^Checked a moment ago\. The next check can run from /)).toBeTruthy() })
    host.script[CHECK] = checked({ kind: 'failed', problem: 'timed out' })
    fireEvent.click(within(claude).getByRole('button', { name: 'Check now' }))
    await waitFor(() => { expect(within(claude).getByRole('alert').textContent).toBe('The check did not answer: timed out') })
    host.script[CHECK] = checked({ kind: 'refused', problem: 'the program is busy' })
    fireEvent.click(within(claude).getByRole('button', { name: 'Check now' }))
    await waitFor(() => { expect(within(claude).getByRole('alert').textContent).toBe('The check did not start: the program is busy') })
  })

  // Pointing a refusal that reaches the card at an unlock sends the person to a dialog that no longer opens a check (F36).
  it('says the check was not confirmed when the person cancels its Face ID, and keeps "Check now"', async () => {
    show({ [READ]: answer(account()), [CHECK]: { status: 403, body: { error: 'ELEVATION_REQUIRED', message: 'Confirm with Face ID or your PIN first', action: 'external-agents/refresh' } } })
    const claude = await row('claude-code')
    fireEvent.click(within(claude).getByRole('button', { name: 'Check now' }))
    await waitFor(() => { expect(within(claude).getByRole('status').textContent).toBe(en['limits.notConfirmed']) })
    expect(within(claude).getByRole('button', { name: 'Check now' })).toBeTruthy()
    expect(within(claude).queryByText(/unlock/i)).toBeNull()
  })

  it('reports a check that cannot reach the home or is refused for another reason', async () => {
    const host = show({ [READ]: answer(account()), [CHECK]: 'unreachable' })
    const claude = await row('claude-code')
    fireEvent.click(within(claude).getByRole('button', { name: 'Check now' }))
    await waitFor(() => { expect(within(claude).getByRole('alert').textContent).toBe('Delorun could not be reached.') })
    host.script[CHECK] = { status: 403, body: { error: 'LOOPBACK_REQUIRED', message: 'Open this at the computer.' } }
    fireEvent.click(within(claude).getByRole('button', { name: 'Check now' }))
    await waitFor(() => { expect(within(claude).getByRole('alert').textContent).toBe('Open this at the computer.') })
    host.script[CHECK] = { status: 200, text: '<html>' }
    fireEvent.click(within(claude).getByRole('button', { name: 'Check now' }))
    await waitFor(() => { expect(within(claude).getByRole('alert').textContent).toBe('Delorun answered something this page cannot read.') })
  })

  it('shows no card where the home does not serve the figures, and an empty note with no agent added', async () => {
    show({})
    await waitFor(() => { expect(screen.queryByText('Plans and limits')).toBeNull() })
    cleanup()
    show({ [READ]: answer(account({ installed: false })) })
    expect(await screen.findByText('No external agent is added yet.')).toBeTruthy()
  })
})
