// @vitest-environment jsdom
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPreset } from '../../src/layout/index.ts'
import { en, PANES_NS } from '../../src/panes/locales.ts'
import { PaneHeader, type PaneHeaderProps } from '../../src/panes/PaneHeader.tsx'
import type { SeatLimits } from '../../src/panes/status.ts'
import { controlsFor, sid } from './fixtures.tsx'

afterEach(cleanup)
beforeEach(() => { vi.useFakeTimers({ now: 1_000_000 }) })
afterEach(() => { vi.useRealTimers() })

const t = makeTranslate(en)
void PANES_NS

interface Setup {
  readonly isMain?: boolean
  readonly running?: boolean
  readonly waiting?: boolean
  readonly seat?: SeatLimits | null
  readonly title?: string
  readonly label?: string
  readonly createdAt?: number
  readonly updatedAt?: number
  readonly mode?: 'continuable' | 'one-shot'
  readonly cancelDenied?: boolean
  readonly page?: boolean
  readonly canClose?: boolean
}

const CHAT = sid('claude')
const MAIN = sid('main')
const CODEX = sid('codex')

function setup(options: Setup = {}) {
  const session = createSnapshotStore({ running: options.running ?? false, subagent: options.isMain === true ? null : { address: { mode: options.mode ?? 'continuable' } } })
  const statuses = createSnapshotStore(new Map(options.waiting === true ? [[CHAT, { pendingInteraction: { kind: 'approval' } }]] : []))
  const list = createSnapshotStore({
    byId: {
      [CHAT]: { displayTitle: options.title ?? 'Run npm tests and report', createdAt: options.createdAt, updatedAt: options.updatedAt, projectionValues: options.label === undefined ? undefined : { subagent: { label: options.label } } },
      [MAIN]: { displayTitle: 'Port the garden planner to Vite' },
      [CODEX]: { displayTitle: 'List project files', projectionValues: { subagent: { label: 'Codex' } } },
    } as Record<string, { displayTitle: string; createdAt?: number | undefined; updatedAt?: number | undefined; projectionValues?: { subagent: { label: string } } | undefined }>,
  })
  const model = buildPreset('main-column', MAIN, [CHAT, CODEX])
  const controls = controlsFor(CHAT, [MAIN, CODEX], model, { canClose: options.canClose ?? options.isMain !== true })
  const onOpen = vi.fn()
  const onStop = vi.fn()
  const onClose = vi.fn()
  const props = {
    sessionId: CHAT,
    useSession: <S,>(selector: (state: ReturnType<typeof session.getSnapshot>) => S): S => useSyncExternalStore(session.subscribe, () => selector(session.getSnapshot())),
    useSessions: <S,>(selector: (state: ReturnType<typeof list.getSnapshot>) => S): S => selector(list.getSnapshot()),
    useSessionStatus: <S,>(selector: (state: ReturnType<typeof statuses.getSnapshot>) => S): S => selector(statuses.getSnapshot()),
    useProjection: (key: string) => (key === 'agentSeat' ? options.seat : undefined),
    useAccess: () => !(options.cancelDenied ?? false),
    isMain: options.isMain ?? false, focused: false, page: options.page ?? false, controls, onOpen, onStop, onClose,
    clock: (epochMs: number) => `at ${String(epochMs)}`,
    t,
  }
  const view = render(<PaneHeader {...(props as never as PaneHeaderProps)} />)
  return { view, session, controls, onOpen, onStop, onClose }
}

const SEAT: SeatLimits = { agent: 'claude-code', version: '2.1.263', plan: 'Max', fiveHourPercent: 41, fiveHourResetAt: 1234, weeklyPercent: 12 }

describe('the pane header status badge', () => {
  it('shows Working with the time since the run began, ticking each second', () => {
    setup({ running: true, createdAt: 1_000_000 - 242_000 })
    expect(screen.getByRole('status').textContent).toBe('Working 4m 02s')
    act(() => { vi.advanceTimersByTime(3000) })
    expect(screen.getByRole('status').textContent).toBe('Working 4m 05s')
  })

  it('shows Needs approval while the chat waits for the person', () => {
    setup({ running: true, waiting: true })
    expect(screen.getByRole('status').textContent).toBe('Needs approval')
    expect(document.querySelector('[data-pane-header]')!.getAttribute('data-status')).toBe('needs-approval')
  })

  it('keeps Done with the run duration for a finished agent', () => {
    setup({ running: false, createdAt: 1000, updatedAt: 1000 + 83_000 })
    expect(screen.getByRole('status').textContent).toBe('Done 1m 23s')
    expect(document.querySelector('[data-pane-header]')!.getAttribute('data-status')).toBe('done')
  })

  it('turns Working into Done with the measured duration when the run ends', () => {
    const { session } = setup({ running: true })
    act(() => { vi.advanceTimersByTime(48_000) })
    act(() => { session.set({ ...session.getSnapshot(), running: false }) })
    expect(screen.getByRole('status').textContent).toBe('Done 48s')
  })

  it('shows Ready, not Done, for the main chat at rest', () => {
    setup({ isMain: true })
    expect(screen.getByRole('status').textContent).toBe('Ready')
  })
})

describe('the pane header content', () => {
  it('names the agent by its program, with the chat title as its task, and draws the limits line', () => {
    setup({ seat: SEAT })
    expect(document.querySelector('[data-pane-header]')!.textContent).toContain('Claude Code')
    expect(screen.getByText('Run npm tests and report')).toBeTruthy()
    const chips = [...screen.getByRole('group', { name: 'Plan and usage' }).children].map(chip => chip.textContent)
    expect(chips).toEqual(['Claude Code 2.1.263', 'Plan: Max', '5-hour limit 41% · resets at 1234', 'Weekly 12%'])
    expect(document.querySelector('[class*="monogram"]')!.textContent).toBe('CC')
  })

  it('draws no limits line for a plain subagent or when the projection is not there', () => {
    setup({ seat: null, label: 'Explorer' })
    expect(screen.queryByRole('group', { name: 'Plan and usage' })).toBeNull()
    expect(document.querySelector('[data-pane-header]')!.textContent).toContain('Explorer')
  })

  it('offers Open full chat, Stop (while running) and Close, and the main chat only Stop', () => {
    const agent = setup({ running: true })
    fireEvent.click(screen.getByRole('button', { name: 'Open full chat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close pane' }))
    expect([agent.onOpen, agent.onStop, agent.onClose].map(fn => fn.mock.calls.length)).toEqual([1, 1, 1])
    cleanup()
    setup({ isMain: true, running: true, canClose: false })
    expect(screen.queryByRole('button', { name: 'Open full chat' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Close pane' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
  })

  it('offers no Stop when the chat is not running, cannot be stopped, or the page may not cancel', () => {
    setup({ running: false })
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    cleanup()
    setup({ running: true, mode: 'one-shot' })
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    cleanup()
    setup({ running: true, cancelDenied: true })
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('moves a pane through its Move to… menu, with the neighbour named by its title', () => {
    const { controls } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Move to…' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Right of Codex' }))
    expect(controls.actions.move).toHaveBeenCalledWith(CHAT, { kind: 'pane', pane: CODEX, region: 'right' })
  })

  it('swaps places with another pane from the same menu', () => {
    const { controls } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Move to…' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Swap places · Codex' }))
    expect(controls.actions.swap).toHaveBeenCalledWith(CHAT, CODEX)
  })

  it('draws a phone page header with no grip, menu or buttons', () => {
    setup({ page: true, running: true })
    expect(document.querySelector('[data-grip]')).toBeNull()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByRole('status')).toBeTruthy()
  })
})
