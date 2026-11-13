// @vitest-environment jsdom
/** The cost pill under the composer and its breakdown dialog, with and without agents. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { CostPill } from '../src/client/CostPill.tsx'
import { agent, cost, hooks, listRow, row, sid, t } from './fixtures.client.ts'

afterEach(() => { cleanup() })

const ROOT = sid('root')

function show(values: Partial<SessionProjectionMap>, list: Partial<SessionListState> = {}) {
  const h = hooks(values, list)
  const loadCosts = vi.fn()
  const view = render(<CostPill sessionId={ROOT} useProjection={h.useProjection} useSessions={h.useSessions} t={t} loadCosts={loadCosts} />)
  return { ...h, loadCosts, view }
}

const open = (): HTMLElement => {
  fireEvent.click(screen.getByRole('button', { name: /^Estimated chat cost/ }))
  return screen.getByRole('dialog')
}

describe('the cost pill', () => {
  it('shows nothing before the chat or an agent has made a request', () => {
    expect(show({}).view.container.innerHTML).toBe('')
    cleanup()
    expect(show({ costMeter: cost() }).view.container.innerHTML).toBe('')
  })

  it('shows the chat\'s cost, and appears once the first request is priced', () => {
    const h = show({})
    act(() => { h.projections.set({ costMeter: cost(row('claude-opus-5-5', 1.234)) }) })
    const pill = screen.getByRole('button', { name: 'Estimated chat cost $1.23' })
    expect(pill.getAttribute('aria-haspopup')).toBe('dialog')
    expect(pill.textContent).toBe('$1.23')
  })

  it('opens a breakdown by model that expands to the token buckets, and closes on Escape with the focus back on the pill', () => {
    show({ costMeter: cost(row('claude-opus-5-5', 1.5, 2), row('llama', 0, 1, 1)) })
    const dialog = open()
    expect(dialog).toBe(document.activeElement)
    expect(within(dialog).getByText('Chat cost')).toBeTruthy()
    const opus = within(dialog).getByRole('button', { name: 'claude-opus-5-5: 2 requests, 2.2K tokens, $1.50' })
    expect(within(dialog).getByRole('button', { name: 'llama: 1 requests, 1.1K tokens, No price' })).toBeTruthy()
    expect(within(dialog).getByText('1 request has no price. Add its model to the cost meter\'s prices under Settings → Plugins.')).toBeTruthy()
    expect(within(dialog).queryByText('Input')).toBeNull()
    fireEvent.click(opus)
    expect(opus.getAttribute('aria-expanded')).toBe('true')
    expect(within(dialog).getByRole('group', { name: 'Input: 2,000 tokens' })).toBeTruthy()
    expect(within(dialog).getByRole('group', { name: 'Output: 200 tokens' })).toBeTruthy()
    fireEvent.click(opus)
    expect(within(dialog).queryByText('Input')).toBeNull()
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(screen.queryByRole('dialog')).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Estimated chat cost/ }))
  })

  it('closes when the pill is pressed again or the pointer goes down outside', () => {
    show({ costMeter: cost(row('m', 1)) })
    open()
    fireEvent.pointerDown(screen.getByRole('dialog'))
    expect(screen.queryByRole('dialog')).not.toBeNull()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    open()
    fireEvent.click(screen.getByRole('button', { name: /^Estimated chat cost/ }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('rolls up the agents: the pill shows both totals and the dialog one row per direct agent, costliest first', () => {
    show({ costMeter: cost(row('m', 1)), subagentCatalog: [agent('a', 'Planner'), agent('b', 'Writer'), agent('idle', 'Idle')] }, {
      byId: {
        [sid('a')]: listRow('a', { parentId: ROOT, projectionValues: { costMeter: cost(row('m', 0.5)), subagentCatalog: [agent('a1', 'Helper')] } }),
        [sid('a1')]: listRow('a1', { parentId: sid('a'), projectionValues: { costMeter: cost(row('n', 2)) } }),
        [sid('b')]: listRow('b', { parentId: ROOT, projectionValues: { costMeter: cost(row('m', 0.25)) } }),
        [sid('idle')]: listRow('idle', { parentId: ROOT, projectionValues: { costMeter: cost() } }),
      },
    })
    const pill = screen.getByRole('button', { name: 'Estimated chat cost $1.00, $3.75 including agents' })
    expect(pill.textContent).toBe('$1.00·$3.75 with agents')
    const dialog = open()
    expect(within(dialog).getByText('Chat and agents cost')).toBeTruthy()
    const names = within(dialog).getAllByRole('button').map(button => button.getAttribute('aria-label'))
    expect(names).toEqual([
      'This chat: 1 requests, 1.1K tokens, $1.00',
      'Planner: 2 requests, 2.2K tokens, $2.50',
      'Writer: 1 requests, 1.1K tokens, $0.25',
    ])
    fireEvent.click(within(dialog).getByRole('button', { name: /^Planner/ }))
    const models = within(dialog).getAllByRole('button').map(button => button.getAttribute('aria-label'))
    expect(models.slice(2, 4)).toEqual(['n: 1 requests, 1.1K tokens, $2.00', 'm: 1 requests, 1.1K tokens, $0.50'])
    fireEvent.click(within(dialog).getByRole('button', { name: /^n: / }))
    expect(within(dialog).getByRole('group', { name: 'Cache read: 0 tokens' })).toBeTruthy()
  })

  it('shows the agents\' cost alone when the chat itself has not made a request, and names an unlabelled agent by its id', () => {
    show({ subagentCatalog: [{ id: sid('agent-123456'), createdAt: 1, mode: 'one-shot' }] }, {
      projectionsBySession: { [sid('agent-123456')]: { state: 'ready', error: null, values: { costMeter: cost(row('m', 2)) } } },
    })
    expect(screen.getByRole('button', { name: 'Estimated chat cost $0.00, $2.00 including agents' })).toBeTruthy()
    const dialog = open()
    expect(within(dialog).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Agent 123456: 1 requests, 1.1K tokens, $2.00'])
  })

  it('asks for the agents whose cost is missing when it opens, says so, and counts external agents', () => {
    const h = show({ costMeter: cost(row('m', 1)), subagentCatalog: [agent('slow', 'Slow'), { id: sid('codex'), createdAt: 1, mode: 'external' }] })
    const dialog = open()
    expect(h.loadCosts).toHaveBeenCalledExactlyOnceWith([sid('slow')])
    expect(within(dialog).getByText('The cost of 1 agent is not available yet.')).toBeTruthy()
    expect(within(dialog).getByText('1 external agent runs outside this studio and is not counted.')).toBeTruthy()
    expect(within(dialog).getByText('Estimated from list prices. Your provider\'s invoice is authoritative.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Estimated chat cost/ }))
    expect(h.loadCosts).toHaveBeenCalledOnce()
  })

  it('does not ask for anything when every agent\'s cost is on the page', () => {
    const h = show({ costMeter: cost(row('m', 1)) })
    open()
    expect(h.loadCosts).not.toHaveBeenCalled()
  })
})
