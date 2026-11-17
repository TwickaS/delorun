// @vitest-environment jsdom
/** The agents list parts (look C), the trigger addition and the hand-off line's JSON reading. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  en, monogramOf, outsideCount, parseHandOffInput, parseHandOffResult, RowMonogram, RowTrail, RowWords, ringOf,
  shortDuration, TriggerOutside, wordsOf, type AgentSeatView, type RowPartProps,
} from '../src/client/lists/index.ts'

afterEach(cleanup)

const t = makeTranslate(en)
const clock = (ms: number): string => `T${String(ms)}`
const seat: AgentSeatView = { agent: 'claude-code', ownSettings: 'accept edits', sandbox: 'off', state: 'working', fiveHourPercent: 82 }

function row(values: RowPartProps['values'], open = vi.fn()): RowPartProps {
  return {
    sessionId: 'c1' as SessionId, mode: 'continuable', label: 'Fix export file date', running: true, summary: undefined,
    values, awaitingApproval: false, tokens: undefined, durationMs: undefined, open, t, clock,
  }
}

describe('monogram', () => {
  it('gives an ordinary subagent its first letter in blue, and an outside agent its program letters with the arrow', () => {
    expect(monogramOf(undefined, 'wording check')).toEqual({ letters: 'W', colour: 'blue', outside: false })
    expect(monogramOf(seat, 'x')).toEqual({ letters: 'CC', colour: 'violet', outside: true })
    expect(monogramOf({ ...seat, agent: 'codex' }, 'x')).toEqual({ letters: 'CX', colour: 'teal', outside: true })
    expect(monogramOf(undefined, '').letters).toBe('·')
  })

  it('marks only outside agents', () => {
    const { container, rerender } = render(<RowMonogram {...row({})} />)
    expect(container.querySelector('[data-outside]')).toBeNull()
    expect(container.querySelector('[aria-hidden]')).not.toBeNull()
    rerender(<RowMonogram {...row({ agentSeat: seat })} />)
    expect(screen.getByRole('img', { name: 'Claude Code, runs outside Delorun' })).toBeTruthy()
  })
})

describe('ring and words', () => {
  it('rings the 5-hour figure, marks near and reached, and says nothing without a figure', () => {
    expect(ringOf(seat)).toEqual({ percent: 82, reached: false, near: true })
    expect(ringOf({ ...seat, fiveHourPercent: 40 })?.near).toBe(false)
    expect(ringOf({ ...seat, state: 'limit', fiveHourPercent: undefined })).toEqual({ percent: 100, reached: true, near: true })
    expect(ringOf({ ...seat, fiveHourPercent: undefined })).toBeUndefined()
  })

  it('gives the ring an accessible name and the figure as text', () => {
    render(<RowTrail {...row({ agentSeat: seat })} />)
    expect(screen.getByRole('img', { name: 'Claude Code 5-hour limit 82% used' })).toBeTruthy()
    expect(screen.getByText('82%')).toBeTruthy()
  })

  it('says "Waiting for you" in words and offers Answer, which opens the chat', () => {
    const open = vi.fn()
    const values = { agentSeat: seat }
    render(<RowWords {...row(values)} awaitingApproval />)
    expect(screen.getByText('Claude Code · Waiting for you')).toBeTruthy()
    render(<RowTrail {...row(values, open)} awaitingApproval />)
    fireEvent.click(screen.getByRole('button', { name: 'Answer Fix export file date, Claude Code' }))
    expect(open).toHaveBeenCalledOnce()
  })

  it('names every state', () => {
    expect(wordsOf({ ...seat, state: 'limit', resetAt: 5 }, false, clock)).toEqual({ key: 'row.limit', time: 'T5' })
    expect(wordsOf({ ...seat, state: 'limit' }, false, clock)).toEqual({ key: 'row.limit', time: undefined })
    for (const [state, key] of [['starting', 'row.starting'], ['working', 'row.working'], ['idle', 'row.idle'], ['not-signed-in', 'row.notSignedIn'], ['model-needed', 'row.modelNeeded'], ['ended', 'row.ended']] as const) {
      expect(wordsOf({ ...seat, state }, false, clock)).toEqual({ key })
    }
    expect(wordsOf({ ...seat, state: 'limit' }, true, clock)).toEqual({ key: 'row.waiting' })
  })

  it('renders nothing for an ordinary subagent', () => {
    expect(render(<RowWords {...row({})} />).container.innerHTML).toBe('')
    expect(render(<RowTrail {...row({})} />).container.innerHTML).toBe('')
  })
})

describe('trigger', () => {
  it('counts the outside rows', () => {
    expect(outsideCount([undefined, seat, seat])).toBe(2)
    const rows = [row({}), row({ agentSeat: seat }), row({ agentSeat: seat })]
    render(<TriggerOutside rows={rows} t={t} />)
    expect(screen.getByText(/2 outside/)).toBeTruthy()
  })

  it('adds nothing while no agent runs outside', () => {
    expect(render(<TriggerOutside rows={[row({})]} t={t} />).container.innerHTML).toBe('')
  })
})

describe('hand-off tool JSON', () => {
  it('reads the description and ignores partial or foreign arguments', () => {
    expect(parseHandOffInput('{"description":" Fix export date ","prompt":"p"}').task).toBe('Fix export date')
    expect(parseHandOffInput('{"descr').task).toBe('')
    expect(parseHandOffInput('[1]').task).toBe('')
    expect(parseHandOffInput('{"description":3}').task).toBe('')
  })

  it('reads the activation name and the without-asking reason', () => {
    expect(parseHandOffResult({ kind: 'activation', name: 'fixer', reason: 'Full access' })).toEqual({ name: 'fixer', withoutAsking: true })
    expect(parseHandOffResult({ kind: 'activation', name: 'fixer' })).toEqual({ name: 'fixer', withoutAsking: false })
    expect(parseHandOffResult(undefined)).toEqual({ name: undefined, withoutAsking: false })
    expect(parseHandOffResult([])).toEqual({ name: undefined, withoutAsking: false })
  })

  it('formats short durations', () => {
    expect(shortDuration(14_000)).toBe('14s')
    expect(shortDuration(134_000)).toBe('2m 14s')
    expect(shortDuration(3_900_000)).toBe('1h 5m')
  })
})
