// @vitest-environment jsdom
/** The banner, composer line and approval card read what the Host's `agentSeat` projection says. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import { agentOfTool, allowedForRunDecision, createSeatClient, SEAT_ROUTES, Banner, ComposerNote, en, SeatApproval, selectSeatApproval, type AgentSeatView, type SeatClient } from '../src/client/index.ts'

afterEach(cleanup)

const t = makeTranslate(en)
const clock = (ms: number): string => `T${String(ms)}`

function hooks(seat: AgentSeatView | undefined) {
  const store = createSnapshotStore<Partial<SessionProjectionMap>>(seat === undefined ? {} : { agentSeat: seat })
  const use = bindSnapshotSelector(store)
  return ((key: keyof SessionProjectionMap) => use(current => current[key])) as UseProjection
}

const base: AgentSeatView = { agent: 'claude-code', version: '2.3.14', ownSettings: 'accept edits', sandbox: 'off', state: 'working', plan: 'Max', fiveHourPercent: 82, fiveHourResetAt: 1410, weeklyPercent: 46 }
const { fiveHourResetAt: _reset, ...noReset } = base
const { fiveHourPercent: _figure, fiveHourResetAt: _resetAt, ...noFigures } = base
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
    for (const text of ['Claude Code 2.3.14', 'Your own settings: accept edits', 'No sandbox', 'Plan: Max', '5-hour limit 82% · resets T1410', 'Weekly 46%']) {
      expect(screen.getByText(text)).toBeTruthy()
    }
    expect(container.querySelector('[data-seat-rule]')).not.toBeNull()
    expect(screen.getByText('This agent is Claude Code, running outside Delorun')).toBeTruthy()
  })

  it.for([['on', 'Sandboxed', 'No sandbox'], ['off', 'No sandbox', 'Sandboxed'], ['own', 'Own sandbox settings', 'No sandbox']] as const)('says on the card and on the one line that the agent\'s own sandbox is %s', ([sandbox, shown, hidden]) => {
    const { unmount } = banner({ ...base, sandbox })
    expect(screen.getByText(shown)).toBeTruthy()
    expect(screen.queryByText(hidden)).toBeNull()
    unmount()
    banner({ ...base, sandbox, turns: 1 })
    expect(screen.getByText(shown)).toBeTruthy()
    expect(screen.queryByText(hidden)).toBeNull()
  })

  it('does not warn about a sandbox the person\'s own settings decide', () => {
    const { container } = banner({ ...base, sandbox: 'own' })
    const warned = [...container.querySelectorAll('li')].filter(item => item.className.includes('chipWarn')).map(item => item.textContent)
    expect(warned).not.toContain('Own sandbox settings')
  })

  it('shows no sandbox chip before the program has started', () => {
    const { sandbox: _unknown, ...unknown } = base
    const { unmount } = banner(unknown)
    expect(screen.queryByText('Sandboxed')).toBeNull()
    expect(screen.queryByText('No sandbox')).toBeNull()
    unmount()
    banner({ ...unknown, turns: 1 })
    expect(screen.queryByText('Sandboxed')).toBeNull()
    expect(screen.queryByText('No sandbox')).toBeNull()
  })

  it('collapses to one line after the first turn and expands again on a click', () => {
    const { container } = banner({ ...base, turns: 1 })
    expect(container.querySelector('[data-seat-line]')).not.toBeNull()
    expect(screen.getByText('Claude Code · outside Delorun')).toBeTruthy()
    expect(screen.getByText('No sandbox')).toBeTruthy()
    expect(screen.queryByText('Your own settings: accept edits')).toBeNull()
    fireEvent.click(screen.getByLabelText('Show what this agent is'))
    expect(screen.getByText('Your own settings: accept edits')).toBeTruthy()
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
    expect(screen.getByText('Applies from your next message')).toBeTruthy()
    fireEvent.click(screen.getByText('Use Model A'))
    expect(c.chooseModel).toHaveBeenCalledWith('s1', 'a')
  })

  it('shows the parting notice with its reason', () => {
    banner({ ...base, state: 'ended', endedReason: 'The chat was archived.' })
    expect(screen.getByText('Claude Code has left this chat')).toBeTruthy()
    expect(screen.getByText('The chat was archived.')).toBeTruthy()
  })
})

describe('the opening card chips', () => {
  it('leaves out the facts the program did not report', () => {
    banner({ agent: 'codex', ownSettings: 'default', sandbox: 'off', state: 'working' })
    expect(screen.queryByText(/Plan:/)).toBeNull()
    expect(screen.queryByText(/5-hour/)).toBeNull()
    expect(screen.queryByText(/Weekly/)).toBeNull()
    expect(screen.queryByText(/Codex 1/)).toBeNull()
    expect(screen.getByText('Your own settings: default')).toBeTruthy()
  })

  it('names no setting while the program\'s settings are unknown', () => {
    banner({ agent: 'codex', ownSettings: '', sandbox: 'off', state: 'working' })
    expect(screen.getByText('Your own settings')).toBeTruthy()
  })

  it('says the 5-hour figure without a reset time and warns at 80 percent and above', () => {
    const { container } = banner({ ...noReset, fiveHourPercent: 40, weeklyPercent: 90 })
    expect(screen.getByText('5-hour limit 40%')).toBeTruthy()
    const warned = [...container.querySelectorAll('li')].filter(item => item.className.includes('chipWarn')).map(item => item.textContent)
    expect(warned).toEqual(['No sandbox', 'Weekly 90%'])
  })

  it('shows the meter and the figure on the collapsed line only when a 5-hour figure exists', () => {
    const { container, unmount } = banner({ ...base, turns: 1, fiveHourPercent: 150 })
    expect(container.querySelector('[role="img"]')?.querySelector('span')?.getAttribute('style')).toContain('100%')
    unmount()
    const other = banner({ ...noFigures, turns: 2, sandbox: 'off' })
    expect(other.container.querySelector('[role="img"]')).toBeNull()
    expect(screen.getByText('No sandbox')).toBeTruthy()
  })
})

describe('state cards without actions to press', () => {
  it('shows a limit without a reset time and keeps Resume disabled while the request runs', async () => {
    let finish: () => void = () => undefined
    const c: SeatClient = { resume: vi.fn(() => new Promise<void>((resolve) => { finish = resolve })), chooseModel: vi.fn(() => Promise.resolve()) }
    banner({ ...base, state: 'limit' }, c)
    const resume = screen.getByText('Resume').closest('button') as HTMLButtonElement
    fireEvent.click(resume)
    await waitFor(() => { expect(resume.disabled).toBe(true) })
    finish()
    await waitFor(() => { expect(resume.disabled).toBe(false) })
    expect(c.resume).toHaveBeenCalledTimes(1)
  })

  it('shows no model picker without offers, and no card while the agent works', () => {
    const { container } = banner({ ...base, state: 'model-needed' })
    expect(container.querySelector('[data-state]')).toBeNull()
    cleanup()
    const working = banner({ ...base, state: 'idle' })
    expect(working.container.querySelector('[data-state]')).toBeNull()
  })

  it('disables the model buttons without actions and while a choice is sent', async () => {
    const picker = { offered: [{ id: 'a', label: 'Model A' }, { id: 'b', label: 'Model B' }], planDefault: 'a' }
    banner({ ...base, state: 'model-needed', modelPicker: picker }, undefined)
    expect((screen.getByText('Use Model A').closest('button') as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    let finish: () => void = () => undefined
    const c: SeatClient = { resume: vi.fn(() => Promise.resolve()), chooseModel: vi.fn(() => new Promise<void>((resolve) => { finish = resolve })) }
    banner({ ...base, state: 'model-needed', modelPicker: picker }, c)
    const choose = screen.getByText('Use Model B').closest('button') as HTMLButtonElement
    fireEvent.click(choose)
    await waitFor(() => { expect(choose.disabled).toBe(true) })
    finish()
    await waitFor(() => { expect(choose.disabled).toBe(false) })
  })

  it('shows the parting notice without a reason', () => {
    banner({ ...base, state: 'ended' })
    expect(screen.getByText('Claude Code has left this chat')).toBeTruthy()
  })

  it('shows Copy again when the clipboard refuses', async () => {
    const refusing = vi.fn(() => Promise.reject(new Error('denied')))
    render(<Banner sessionId="s1" useProjection={hooks({ ...base, state: 'not-signed-in' })} t={t} client={client()} copy={refusing} clock={clock} />)
    fireEvent.click(screen.getByText('Copy command'))
    await waitFor(() => { expect(refusing).toHaveBeenCalled() })
    expect(screen.getByText('Copy command')).toBeTruthy()
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
    expect(selectSeatApproval(owner({ ...(pending() as object), toolName: 'subagent_codex' }, {}))).toBeNull()
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

  it('offers Reject only without a reach source, and names Codex records', () => {
    const answer = vi.fn(() => Promise.resolve())
    const codex = { ...(pending(answer) as object), toolName: 'codex.commandExecution', reason: undefined } as never
    const { unmount } = render(<SeatApproval matched={codex} t={t} reach={undefined} clock={clock} />)
    expect(screen.getByText('Reject')).toBeTruthy()
    expect(screen.queryByText('Allow once')).toBeNull()
    expect(screen.queryByText('Allow for this run')).toBeNull()
    expect(screen.queryByText('Unlock to answer')).toBeNull()
    expect(screen.queryByText('git push origin fix')).toBeNull()
    expect(agentOfTool('codex.commandExecution')).toBe('codex')
    expect(agentOfTool('claude_code.Bash')).toBe('claude-code')
    unmount()
  })

  it('lets a person answer again when the answer fails, and sends nothing for an unanswerable card', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('gone')))
    const { unmount } = render(<SeatApproval matched={pending(failing)} t={t} reach={reach('computer')} clock={clock} />)
    fireEvent.click(screen.getByText('Allow once'))
    await waitFor(() => { expect((screen.getByText('Allow once').closest('button') as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(screen.getByText('Allow once'))
    expect(failing).toHaveBeenCalledTimes(2)
    unmount()
    const quiet = vi.fn(() => Promise.resolve())
    render(<SeatApproval matched={{ ...(pending(quiet) as object), answerable: false } as never} t={t} reach={reach('computer')} clock={clock} />)
    fireEvent.click(screen.getByText('Reject'))
    expect(quiet).not.toHaveBeenCalled()
  })

  it('says nothing about the end of an unlock that has none', () => {
    const standing = { kind: 'unlocked-phone' } as const
    const open = { get: () => standing, subscribe: () => () => undefined, openUnlock: vi.fn() }
    render(<SeatApproval matched={pending()} t={t} reach={open} clock={clock} />)
    expect(screen.queryByText(/unlocked until/)).toBeNull()
  })

  // Sending a phone's granting answer before its confirmation lets the card answer with no grant, which the home refuses (F36).
  it('confirms a granting answer through the reach before it sends it, and never a Reject', async () => {
    const answer = vi.fn(() => Promise.resolve())
    const confirm = vi.fn(() => Promise.resolve(true))
    const standing = { kind: 'unlocked-phone' } as const
    const device = { get: () => standing, subscribe: () => () => undefined, openUnlock: vi.fn(), confirm }
    const matched = { ...(pending(answer) as object), sessionId: 'child-1', callId: 'call_7' } as never
    const { unmount } = render(<SeatApproval matched={matched} t={t} reach={device} clock={clock} />)
    expect(screen.getByText('Allow for this run')).toBeTruthy()
    fireEvent.click(screen.getByText('Allow once'))
    expect(answer).not.toHaveBeenCalled()
    await waitFor(() => { expect(answer).toHaveBeenCalledWith('allowed-once') })
    expect(confirm).toHaveBeenCalledWith({ sessionId: 'child-1', callId: 'call_7', grants: 'external-agent', value: 'allowed-once' })
    unmount()
    const rejectAnswer = vi.fn(() => Promise.resolve())
    render(<SeatApproval matched={{ ...(pending(rejectAnswer) as object), sessionId: 'child-1', callId: 'call_8' } as never} t={t} reach={device} clock={clock} />)
    fireEvent.click(screen.getByText('Reject'))
    expect(rejectAnswer).toHaveBeenCalledWith('rejected')
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  // Sending after a cancelled confirmation answers with no grant; disabling the card for good strands the question.
  it('sends nothing when the confirmation is cancelled, and lets the person answer again', async () => {
    const answer = vi.fn(() => Promise.resolve())
    const confirm = vi.fn(() => Promise.resolve(false))
    const standing = { kind: 'unlocked-phone' } as const
    const device = { get: () => standing, subscribe: () => () => undefined, openUnlock: vi.fn(), confirm }
    render(<SeatApproval matched={{ ...(pending(answer) as object), sessionId: 'child-1', callId: 'call_7' } as never} t={t} reach={device} clock={clock} />)
    fireEvent.click(screen.getByText('Allow for this run'))
    await waitFor(() => { expect((screen.getByText('Allow for this run').closest('button') as HTMLButtonElement).disabled).toBe(false) })
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ value: 'allowed-for-run' }))
    expect(answer).not.toHaveBeenCalled()
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
      [SEAT_ROUTES.resume, '{"child":"s1"}'], [SEAT_ROUTES.chooseModel, '{"child":"s1","id":"m"}'],
    ])
  })

  it('rejects when the Host refuses', async () => {
    await expect(createSeatClient(() => Promise.resolve(new Response('{}', { status: 403 }))).resume('s1')).rejects.toThrow('403')
  })
})
