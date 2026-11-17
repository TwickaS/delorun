// @vitest-environment jsdom
/** The hand-off line reads the agent's state from its own chat, found through the parent's subagent catalog. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en, HandOffLine, type HandOffProps } from '../src/client/lists/index.ts'
import type { AgentSeatView } from '../src/client/view.ts'

afterEach(cleanup)

const t = makeTranslate(en)
const seat: AgentSeatView = { agent: 'claude-code', ownSettings: 'accept edits', sandbox: 'off', state: 'idle', lastAnswer: 'The date now uses local time.' }

interface Child { readonly running: boolean; readonly seat?: AgentSeatView; readonly settledMs?: number; readonly active?: { readonly since: number; readonly through: number } }

function line(overrides: { toolName?: string; phase?: 'start' | 'result' | 'preparing'; child?: Child; resultMeta?: unknown; isError?: boolean; catalog?: boolean | 'missing'; withoutCall?: boolean } = {}) {
  const openChild = vi.fn()
  const state = {
    byId: { c1: { running: overrides.child?.running ?? false, projectionValues: { subagentTiming: { settledMs: overrides.child?.settledMs ?? 134_000, active: overrides.child?.active } } } },
    projectionsBySession: {
      ...overrides.catalog === 'missing' ? {} : { lead: { values: { subagentCatalog: overrides.catalog === false ? [] : [{ id: 'c1', mode: 'continuable', name: 'fixer', label: 'Fix export date', createdAt: 1 }] } } },
      c1: { values: overrides.child?.seat === undefined ? {} : { agentSeat: overrides.child.seat } },
    },
  }
  const phase = overrides.phase ?? 'result'
  const block = phase === 'preparing' ? {}
    : phase === 'start' ? { argsRaw: '{"description":"Fix export date","prompt":"p"}' }
    : { call: overrides.withoutCall === true ? undefined : { argsRaw: '{"description":"Fix export date","prompt":"p"}' }, isError: overrides.isError ?? false, meta: overrides.resultMeta ?? { kind: 'activation', name: 'fixer' }, content: [] }
  const props = {
    toolName: overrides.toolName ?? 'claude_code', phase, block, sessionId: 'lead', openChild, t,
    useSessions: (select: (s: typeof state) => unknown) => select(state),
  } as never as HandOffProps
  return { openChild, ...render(<HandOffLine {...props} />) }
}

describe('the hand-off line', () => {
  it('shows the task, the finished time and the answer as a quoted block, and opens the chat', () => {
    const { openChild, container } = line({ child: { running: false, seat } })
    expect(screen.getByText('Handed to Claude Code · Fix export date')).toBeTruthy()
    expect(screen.getByText('Finished in 2m 14s')).toBeTruthy()
    expect(container.querySelector('[data-handoff-answer]')?.textContent).toContain('The date now uses local time.')
    fireEvent.click(screen.getByRole('button', { name: 'Open Fix export date, Claude Code' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open its chat' }))
    expect(openChild).toHaveBeenCalledTimes(2)
    expect(openChild).toHaveBeenCalledWith('lead', 'c1')
  })

  it('shows working time and no answer while the agent runs', () => {
    const { container } = line({ child: { running: true, seat } })
    expect(screen.getByText('Working · 2m 14s')).toBeTruthy()
    expect(container.querySelector('[data-handoff-answer]')).toBeNull()
  })

  it('says it started without asking when the activation carries a reason', () => {
    line({ resultMeta: { kind: 'activation', name: 'fixer', reason: 'Full access' }, child: { running: true } })
    expect(screen.getByText('Started without asking · Full access')).toBeTruthy()
  })

  it('finds the chat by the task while the call has no result yet, and names Codex', () => {
    line({ toolName: 'codex', phase: 'start', child: { running: true } })
    expect(screen.getByText('Handed to Codex · Fix export date')).toBeTruthy()
    expect(screen.getByText('Working · 2m 14s')).toBeTruthy()
  })

  it('shows a stopped call without an Open button when no chat exists', () => {
    line({ isError: true, catalog: false })
    expect(screen.getByText('Stopped · 0s')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('names no task while the arguments are still being written', () => {
    line({ phase: 'preparing', catalog: false })
    expect(screen.getByText('Handed to Claude Code')).toBeTruthy()
  })

  it('adds the running stretch of the current turn to the settled time', () => {
    line({ child: { running: true, active: { since: 1_000, through: 31_000 } } })
    expect(screen.getByText('Working · 2m 44s')).toBeTruthy()
  })

  it('finds no chat for a result without its call or in a session with no catalog', () => {
    line({ withoutCall: true, resultMeta: {}, catalog: 'missing' })
    expect(screen.getByText('Handed to Claude Code')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('falls back to the task when the result names no chat', () => {
    line({ resultMeta: {}, child: { running: false } })
    expect(screen.getByText('Finished in 2m 14s')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Fix export date, Claude Code' })).toBeTruthy()
  })

  it('renders nothing for another tool', () => {
    expect(line({ toolName: 'subagent' }).container.innerHTML).toBe('')
  })
})
