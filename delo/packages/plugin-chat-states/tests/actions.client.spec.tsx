// @vitest-environment jsdom
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatStateFailure, SettleRowButton, type ChatStateRowProps, type ChatStatesInjected } from '../src/client/ChatStateActions.tsx'
import { CustomSnoozeDialog, type CustomSnoozeInjected } from '../src/client/CustomSnooze.tsx'
import { en } from '../src/client/locales.ts'
import { DEFAULT_SNOOZE_PRESETS } from '../src/snooze.ts'
import type { ChatState, ChatStateRequest } from '../src/wire.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const sid = (id: string) => SessionId(id)

function face(states: Record<string, ChatState>, failed = false) {
  const change = vi.fn<(request: ChatStateRequest) => void>()
  const dismiss = vi.fn()
  const injected: ChatStatesInjected = {
    states: { getSnapshot: () => states, subscribe: () => () => {} },
    failed: { getSnapshot: () => failed, subscribe: () => () => {} },
    change, dismiss,
  }
  return { injected, change, dismiss }
}

const rowProps = (sessionId: string, injected: ChatStatesInjected, archived = false): ChatStateRowProps => ({
  ...injected,
  sessionId: sid(sessionId), t: makeTranslate(en),
  useWorkspaces: select => select({
    items: [], archivedSessionIds: archived ? [sid(sessionId)] : [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  }),
})

describe('the settle hover button', () => {
  it('settles a chat that is not settled and returns one that is, each from its own label', () => {
    const { injected, change } = face({ s: { settledAt: 1 } })
    render(<><SettleRowButton {...rowProps('a', injected)} /><SettleRowButton {...rowProps('s', injected)} /></>)
    fireEvent.click(screen.getByRole('button', { name: en.settle }))
    fireEvent.click(screen.getByRole('button', { name: en['settle.undo'] }))
    expect(change.mock.calls.map(([request]) => request)).toEqual([{ action: 'settle', session: 'a' }, { action: 'unsettle', session: 's' }])
  })

  it('offers nothing on an archived chat', () => {
    const { injected } = face({})
    const { container } = render(<SettleRowButton {...rowProps('x', injected, true)} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('the failure notice', () => {
  it('shows while the last change failed and reports done when its time ends', () => {
    vi.useFakeTimers()
    const { injected, dismiss } = face({}, true)
    render(<ChatStateFailure t={makeTranslate(en)} {...injected} />)
    expect(screen.getByText(en.failed)).toBeTruthy()
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(dismiss).toHaveBeenCalled()
  })

  it('shows nothing otherwise', () => {
    const { container } = render(<ChatStateFailure t={makeTranslate(en)} {...face({}).injected} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('the snooze dialog', () => {
  const opened = new Date(2026, 10, 3, 10, 0).getTime()
  function dialog(session: string | null = 'a', presets = DEFAULT_SNOOZE_PRESETS) {
    const change = vi.fn<(request: ChatStateRequest) => void>()
    const closeCustom = vi.fn()
    const injected: CustomSnoozeInjected = {
      custom: { getSnapshot: () => (session === null ? null : sid(session)), subscribe: () => () => {} },
      closeCustom, change, locale: () => 'en', now: () => opened, presets: () => presets,
    }
    render(<CustomSnoozeDialog {...injected} t={makeTranslate(en)} />)
    return { change, closeCustom }
  }
  const submit = () => fireEvent.click(screen.getByRole('button', { name: en['custom.submit'] }))

  it('shows nothing while no chat waits for it', () => {
    dialog(null)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('names the chat\'s choices as quick picks of the person\'s presets, each with when the chat comes back', () => {
    dialog('a', [{ kind: 'after', minutes: 30 }, { kind: 'at', day: 'tomorrow', time: '07:00' }])
    const picks = within(screen.getByLabelText(en['custom.quick'])).getAllByRole('button')
    expect(picks.map(pick => pick.textContent)).toEqual([
      `In 30 minutes${new Date(opened + 30 * 60_000).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' })}`,
      `${en['snooze.tomorrow']}${new Date(2026, 10, 4, 7).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' })}`,
    ])
  })

  it('snoozes from a quick pick and closes', () => {
    const { change, closeCustom } = dialog()
    fireEvent.click(screen.getByRole('button', { name: /In 1 hour/ }))
    expect(change).toHaveBeenCalledWith({ action: 'snooze', session: 'a', until: opened + 3_600_000 })
    expect(closeCustom).toHaveBeenCalled()
  })

  it('starts an hour ahead, shows when the chat comes back, and snoozes until it', () => {
    const { change } = dialog()
    expect((screen.getByLabelText(en['custom.time']) as HTMLInputElement).value).toBe('11:00')
    expect(screen.getByText(/^Back /)).toBeTruthy()
    submit()
    expect(change).toHaveBeenCalledWith({ action: 'snooze', session: 'a', until: opened + 3_600_000 })
  })

  it('snoozes until a date and time, and refuses one in the past, clearing the refusal when a field changes', () => {
    const { change } = dialog()
    fireEvent.change(screen.getByLabelText(en['custom.date']), { target: { value: '2026-11-04' } })
    fireEvent.change(screen.getByLabelText(en['custom.time']), { target: { value: '08:30' } })
    submit()
    expect(change).toHaveBeenCalledWith({ action: 'snooze', session: 'a', until: new Date(2026, 10, 4, 8, 30).getTime() })
    change.mockClear()
    fireEvent.change(screen.getByLabelText(en['custom.date']), { target: { value: '2026-11-02' } })
    submit()
    expect(change).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(en['custom.invalid.date'])
    fireEvent.change(screen.getByLabelText(en['custom.date']), { target: { value: '2026-11-05' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('snoozes for a duration in the chosen unit, and refuses one of zero', () => {
    const { change } = dialog()
    fireEvent.click(screen.getByRole('radio', { name: en['custom.mode.duration'] }))
    expect(screen.getByRole('radio', { name: en['custom.mode.duration'] }).getAttribute('aria-checked')).toBe('true')
    fireEvent.change(screen.getByLabelText(en['custom.amount']), { target: { value: '0' } })
    submit()
    expect(screen.getByRole('alert').textContent).toBe(en['custom.invalid.duration'])
    expect(change).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText(en['custom.amount']), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('radio', { name: en['custom.unit.days'] }))
    submit()
    expect(change).toHaveBeenCalledWith({ action: 'snooze', session: 'a', until: opened + 3 * 86_400_000 })
  })

  it('offers the way to pick the end and the unit as radio groups that arrow keys move', () => {
    dialog()
    const date = screen.getByRole('radio', { name: en['custom.mode.date'] })
    expect(screen.getByRole('radiogroup', { name: en['custom.mode'] }).contains(date)).toBe(true)
    fireEvent.keyDown(date, { key: 'ArrowRight' })
    expect(screen.getByRole('radio', { name: en['custom.mode.duration'] }).getAttribute('aria-checked')).toBe('true')
    const units = within(screen.getByRole('radiogroup', { name: en['custom.unit'] })).getAllByRole('radio')
    const chosen = units.findIndex(unit => unit.getAttribute('aria-checked') === 'true')
    fireEvent.keyDown(units[chosen]!, { key: 'ArrowLeft' })
    expect(within(screen.getByRole('radiogroup', { name: en['custom.unit'] })).getAllByRole('radio')[(chosen + units.length - 1) % units.length]!.getAttribute('aria-checked')).toBe('true')
    expect(screen.queryAllByRole('tab')).toEqual([])
  })

  it('submits from the keyboard through a field, and closes without a change from Cancel', () => {
    const { change, closeCustom } = dialog()
    fireEvent.submit(screen.getByLabelText(en['custom.time']).closest('form') as HTMLFormElement)
    expect(change).toHaveBeenCalledOnce()
    change.mockClear()
    fireEvent.click(screen.getByRole('button', { name: en['custom.cancel'] }))
    expect(change).not.toHaveBeenCalled()
    expect(closeCustom).toHaveBeenCalled()
  })

  it('resolves the end again when it is submitted, since the clock moves while the dialog is open', () => {
    const change = vi.fn<(request: ChatStateRequest) => void>()
    let now = opened
    const injected: CustomSnoozeInjected = {
      custom: { getSnapshot: () => sid('a'), subscribe: () => () => {} },
      closeCustom: vi.fn(), change, locale: () => 'en', now: () => now, presets: () => DEFAULT_SNOOZE_PRESETS,
    }
    render(<CustomSnoozeDialog {...injected} t={makeTranslate(en)} />)
    now = opened + 2 * 3_600_000
    submit()
    expect(change).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(en['custom.invalid.date'])
  })
})
