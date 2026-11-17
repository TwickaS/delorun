// @vitest-environment jsdom
/** The banner, composer line and approval card read what the Host's `agentSeat` projection says. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import { allowedForRunDecision, createSeatClient, SEAT_ROUTES, Banner, ComposerNote, en, SeatApproval, selectSeatApproval, type AgentSeatView, type SeatClient } from '../src/client/index.ts'

afterEach(cleanup)

const t = makeTranslate(en)
const clock = (ms: number): string => `T${String(ms)}`

function hooks(seat: AgentSeatView | undefined) {
  const store = createSnapshotStore<Partial<SessionProjectionMap>>(seat === undefined ? {} : { agentSeat: seat })
  const use = bindSnapshotSelector(store)
  return ((key: keyof SessionProjectionMap) => use(current => current[key])) as UseProjection
}

const base: AgentSeatView = { agent: 'claude-code', version: '2.3.14', ownSettings: 'accept edits', sandbox: 'off', state: 'working', plan: 'Max', fiveHourPercent: 82, fiveHourResetAt: 1410, weeklyPercent: 46 }
const copy = vi.fn(() => Promise.resolve())
const client = (): SeatClient => ({
  resume: vi.fn(() => Promise.resolve()), chooseModel: vi.fn(() => Promise.resolve()),
})

function banner(seat: AgentSeatView | undefined, ...given: [] | [SeatClient | undefined]) {
  const seatClient = given.length === 0 ? client() : given[0]
  return render(<Banner sessionId="s1" useProjection={hooks(seat)} t={t} client={seatClient} copy={copy} clock={clock} />)
}

describe('the opening card', () => {
  it('shows the facts as chips, with the rule, in the agent\'s chat', () => {
    const { container } = banner(base)
    for (const text of ['Claude Code 2.3.14', 'Own settings: accept edits', 'Delorun sandbox: off', 'Plan: Max', '5-hour limit 82% · resets T1410', 'Weekly 46%']) {
      expect(screen.getByText(text)).toBeTruthy()
    }
    expect(container.querySelector('[data-seat-rule]')).not.toBeNull()
    expect(screen.getByText('This agent is Claude Code, running outside Delorun')).toBeTruthy()
  })

  it('collapses to one line after the first turn and expands again on a click', () => {
    const { container } = banner({ ...base, turns: 1 })
    expect(container.querySelector('[data-seat-line]')).not.toBeNull()
    expect(screen.getByText('Claude Code · outside Delorun')).toBeTruthy()
    expect(screen.getByText('Sandbox off')).toBeTruthy()
    expect(screen.queryByText('Own settings: accept edits')).toBeNull()
    fireEvent.click(screen.getByLabelText('Show what this agent is'))
    expect(screen.getByText('Own settings: accept edits')).toBeTruthy()
    fireEvent.click(screen.getByText('Hide the card'))
    expect(container.querySelector('[data-seat-line]')).not.toBeNull()
  })

  it('renders nothing in a chat that is not a live agent\'s', () => {
    const { container } = banner(undefined)
    expect(container.innerHTML).toBe('')
    expect(render(<ComposerNote useProjection={hooks(undefined)} t={t} />).container.innerHTML).toBe('')
  })

  it('names the program in the line above the message box', () => {
    render(<ComposerNote useProjection={hooks({ ...base, agent: 'codex' })} t={t} />)
    expect(screen.getByText('Messages go to Codex at its next step. Stop interrupts its turn.')).toBeTruthy()
  })
})

describe('states', () => {
  it('shows the start in words', () => {
    banner({ ...base, state: 'starting' })
    expect(screen.getByText('Starting Claude Code…')).toBeTruthy()
  })

  it('shows a reached limit with its reset time and a Resume that sends nothing until pressed', () => {
    const c = client()
    banner({ ...base, state: 'limit', resetAt: 1700 }, c)
    expect(screen.getByText('Claude Code has reached its plan limit. It can go on at T1700.')).toBeTruthy()
    expect(c.resume).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Resume'))
    expect(c.resume).toHaveBeenCalledWith('s1')
  })

  it('disables Resume when the studio supplies no actions', () => {
    banner({ ...base, state: 'limit' }, undefined)
    expect((screen.getByText('Resume').closest('button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the sign-in command with a copy button', async () => {
    banner({ ...base, state: 'not-signed-in' })
    expect(screen.getByText('delorun agents login claude-code')).toBeTruthy()
    fireEvent.click(screen.getByText('Copy command'))
    expect(copy).toHaveBeenCalledWith('delorun agents login claude-code')
    expect(await screen.findByText('Copied')).toBeTruthy()
  })

  it('offers the plan\'s models once, marking the plan default', () => {
    const c = client()
    banner({ ...base, agent: 'codex', state: 'model-needed', modelPicker: { offered: [{ id: 'a', label: 'Model A' }, { id: 'b', label: 'Model B' }], planDefault: 'b' } }, c)
    expect(screen.getByText('plan default')).toBeTruthy()
    fireEvent.click(screen.getByText('Use Model A'))
    expect(c.chooseModel).toHaveBeenCalledWith('s1', 'a')
  })

  it('shows the parting notice with its reason', () => {
    banner({ ...base, state: 'ended', endedReason: 'The chat was archived.' })
    expect(screen.getByText('Claude Code has left this chat')).toBeTruthy()
    expect(screen.getByText('The chat was archived.')).toBeTruthy()
  })
})

describe('the approval card', () => {
  const pending = (answer = vi.fn(() => Promise.resolve())) => ({ kind: 'approval', grants: 'external-agent', toolName: 'claude_code.Bash', runScope: 'external-agent-run', reason: 'git push origin fix', answerable: true, answer }) as never
  const reach = (kind: 'computer' | 'locked-phone' | 'unlocked-phone') => {
    const standing = kind === 'unlocked-phone' ? { kind, until: 1402 } as const : { kind } as const
    return {
    get: () => standing, subscribe: () => () => undefined, openUnlock: vi.fn(),
    }
  }

  it('elects only a seat child\'s external-agent approval', () => {
    const owner = (pendingInteraction: unknown, subagent: unknown) => ({ sessionId: undefined, session: { subagent }, pendingInteraction }) as never
    expect(selectSeatApproval(owner(pending(), {}))).not.toBeNull()
    expect(selectSeatApproval(owner(pending(), undefined))).toBeNull()
    expect(selectSeatApproval(owner({ kind: 'approval', grants: undefined }, {}))).toBeNull()
    expect(selectSeatApproval(owner(undefined, {}))).toBeNull()
  })

  it('answers Allow for this run with the run answer through the approval\'s own answer', () => {
    const answer = vi.fn(() => Promise.resolve())
    render(<SeatApproval matched={pending(answer)} t={t} reach={reach('computer')} clock={clock} />)
    fireEvent.click(screen.getByText('Allow for this run'))
    expect(answer).toHaveBeenCalledWith(allowedForRunDecision())
    expect(answer).toHaveBeenCalledWith('allowed-for-run')
  })

  it('hides Allow for this run when the request declared no run scope', () => {
    render(<SeatApproval matched={{ ...(pending() as object), runScope: undefined } as never} t={t} reach={reach('computer')} clock={clock} />)
    expect(screen.queryByText('Allow for this run')).toBeNull()
    expect(screen.getByText('Allow once')).toBeTruthy()
  })

  it('answers Allow once with allowed-once', () => {
    const answer = vi.fn(() => Promise.resolve())
    render(<SeatApproval matched={pending(answer)} t={t} reach={reach('computer')} clock={clock} />)
    fireEvent.click(screen.getByText('Allow once'))
    expect(answer).toHaveBeenCalledWith('allowed-once')
  })

  it('answers once per card', () => {
    const answer = vi.fn(() => Promise.resolve())
    render(<SeatApproval matched={pending(answer)} t={t} reach={reach('computer')} clock={clock} />)
    fireEvent.click(screen.getByText('Reject'))
    fireEvent.click(screen.getByText('Allow once'))
    expect(answer).toHaveBeenCalledTimes(1)
    expect(answer).toHaveBeenCalledWith('rejected')
  })

  it('offers a locked phone Reject and an unlock, never an allow', () => {
    const source = reach('locked-phone')
    render(<SeatApproval matched={pending()} t={t} reach={source} clock={clock} />)
    expect(screen.queryByText('Allow once')).toBeNull()
    expect(screen.queryByText('Allow for this run')).toBeNull()
    expect(screen.getByText('Reject')).toBeTruthy()
    fireEvent.click(screen.getByText('Unlock to answer'))
    expect(source.openUnlock).toHaveBeenCalled()
  })

  it('tells an unlocked phone when its unlock ends and offers every answer', () => {
    render(<SeatApproval matched={pending()} t={t} reach={reach('unlocked-phone')} clock={clock} />)
    expect(screen.getByText('This phone is unlocked until T1402.')).toBeTruthy()
    expect(screen.getByText('Allow for this run')).toBeTruthy()
  })
})

describe('the host routes', () => {
  it('posts Resume and the model choice to the Host\'s agentSeat methods', async () => {
    const fetch = vi.fn((_path: string, _init?: RequestInit) => Promise.resolve(new Response('{}', { status: 200 })))
    const seat = createSeatClient(fetch)
    await seat.resume('s1')
    await seat.chooseModel('s1', 'm')
    expect(fetch.mock.calls.map(([path, init]) => [path, init?.body])).toEqual([
      [SEAT_ROUTES.resume, '{"sessionId":"s1"}'], [SEAT_ROUTES.chooseModel, '{"sessionId":"s1","modelId":"m"}'],
    ])
  })

  it('rejects when the Host refuses', async () => {
    await expect(createSeatClient(() => Promise.resolve(new Response('{}', { status: 403 }))).resume('s1')).rejects.toThrow('403')
  })
})
