// @vitest-environment jsdom
/** The Plans pill beside the cost pill and its popover, over a fake home. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_ROUTES, type AccountView } from '@delorun/external-agents/accounts/wire'
import { PlansPill } from '../src/client/PlansPill.tsx'
import { t } from './fixtures.client.ts'

afterEach(() => { cleanup() })

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)
const HOUR = 3_600_000

const account = (change: Partial<AccountView> = {}, ...used: number[]): AccountView => ({
  provider: 'claude-code', installed: true, signedIn: 'yes', plan: 'max', checkedAt: NOW - 60_000,
  windows: used.map((percent, index) => ({
    kind: index === 0 ? 'five_hour' : 'seven_day', status: percent >= 100 ? 'reached' : percent >= 80 ? 'near' : 'allowed', usedPercent: percent,
    resetsAt: NOW + (index + 1) * HOUR, seenAt: NOW - 60_000, source: 'probe',
  })),
  ...change,
})

/** A fake home that answers the accounts route with the given figures and records every request. */
function home(accounts: readonly AccountView[]) {
  const requests: string[] = []
  const fetch = vi.fn((input: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${input}`)
    return Promise.resolve(new Response(JSON.stringify({ accounts, now: NOW }), { status: input === ACCOUNT_ROUTES.accounts ? 200 : 404 }))
  })
  return { fetch, requests }
}

describe('the Plans pill', () => {
  it('shows the highest used share across agents and windows', async () => {
    const h = home([account({}, 32, 12), account({ provider: 'codex' }, 41)])
    render(<PlansPill fetch={h.fetch} t={t} />)
    const pill = await screen.findByRole('button', { name: 'Plan limits: 41% of the closest limit used' })
    expect(pill.textContent).toBe('Plans 41%')
    expect(pill.getAttribute('data-standing')).toBe('ok')
  })

  it('turns amber from 80% and red at a reached limit, with the word "reached"', async () => {
    render(<PlansPill fetch={home([account({}, 82, 10)]).fetch} t={t} />)
    expect((await screen.findByRole('button')).getAttribute('data-standing')).toBe('near')
    cleanup()
    render(<PlansPill fetch={home([account({}, 100, 10)]).fetch} t={t} />)
    const pill = await screen.findByRole('button')
    expect(pill.getAttribute('data-standing')).toBe('reached')
    expect(pill.textContent).toBe('Plans Limit reached')
  })

  it('shows no number when no window carries a figure', async () => {
    render(<PlansPill fetch={home([account({ windows: [] })]).fetch} t={t} />)
    const pill = await screen.findByRole('button', { name: 'Plan limits' })
    expect(pill.textContent).toBe('Plans')
  })

  it('is hidden while no agent pack is added, or when the figures cannot be read', async () => {
    const h = home([account({ installed: false }, 50), account({ provider: 'codex', installed: false }, 60)])
    const view = render(<PlansPill fetch={h.fetch} t={t} />)
    await waitFor(() => { expect(h.fetch).toHaveBeenCalled() })
    expect(view.container.innerHTML).toBe('')
    cleanup()
    const broken = render(<PlansPill fetch={() => Promise.reject(new TypeError('Failed to fetch'))} t={t} />)
    await Promise.resolve()
    expect(broken.container.innerHTML).toBe('')
  })

  it('opens a popover with every added agent\'s bars, reads again on opening and starts no check', async () => {
    const h = home([account({}, 32, 12), account({ provider: 'codex', signedIn: 'no', plan: undefined, windows: [] })])
    render(<PlansPill fetch={h.fetch} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Plan limits/ }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Claude Code')).toBeTruthy()
    expect(within(dialog).getByText('Codex')).toBeTruthy()
    expect(within(dialog).getByText('Signed in · Max plan')).toBeTruthy()
    expect(within(dialog).getByText('Not signed in')).toBeTruthy()
    expect(within(dialog).getByText('5-hour limit')).toBeTruthy()
    expect(within(dialog).getAllByRole('button', { name: 'Check now' })).toHaveLength(2)
    expect(h.requests).toEqual(['GET /api/delorunExternalAgents.accounts', 'GET /api/delorunExternalAgents.accounts'])
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Plan limits/ }))
  })
})
