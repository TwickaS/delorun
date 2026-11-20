// @vitest-environment jsdom
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPhoneDots, DotsDock, type DotsDockProps, type PhoneDotsState } from '../../src/panel/dots.tsx'
import { en } from '../../src/panes/locales.ts'
import { A, B, CHAT } from '../entry/fixtures.ts'

afterEach(cleanup)

function state(overrides: Partial<PhoneDotsState> = {}): PhoneDotsState {
  return { ids: [CHAT, A, B], active: A, main: CHAT, select: vi.fn(), open: vi.fn(), stop: vi.fn(), ...overrides }
}

function renderDock(chat: string, running: boolean, value: PhoneDotsState | undefined) {
  const dots = createPhoneDots()
  dots.set(value)
  const props = { sessionId: chat, dots, useSession: (select: (session: { running: boolean; subagent: null }) => unknown) => select({ running, subagent: null }), t: makeTranslate(en) }
  const view = render(<DotsDock {...(props as never as DotsDockProps)} />)
  return { view, dots }
}

describe('the phone dots above the reply box', () => {
  it('draw nothing while no pager shows the chat', () => {
    expect(renderDock(A, true, undefined).view.container.innerHTML).toBe('')
    cleanup()
    expect(renderDock('other', true, state()).view.container.innerHTML).toBe('')
  })

  it('draw one dot per page with the shown page marked, and a dot jumps to its page', () => {
    const value = state()
    renderDock(A, false, value)
    const dots = [...document.querySelectorAll('[data-page-dot]')]
    expect(dots).toHaveLength(3)
    expect(dots.map(dot => dot.hasAttribute('data-active'))).toEqual([false, true, false])
    fireEvent.click(dots[2]!)
    expect(value.select).toHaveBeenCalledWith(B)
  })

  it('offer Open full chat on an agent page, and Stop only while it runs', () => {
    const value = state()
    renderDock(A, true, value)
    fireEvent.click(screen.getByRole('button', { name: 'Open full chat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(value.open).toHaveBeenCalledWith(A)
    expect(value.stop).toHaveBeenCalledWith(A)
    cleanup()
    renderDock(A, false, state())
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('leave the main chat page with the dots alone', () => {
    renderDock(CHAT, true, state({ active: CHAT }))
    expect(screen.queryByRole('button', { name: 'Open full chat' })).toBeNull()
    expect(document.querySelectorAll('[data-page-dot]')).toHaveLength(3)
  })

  it('follow the pager when it moves', () => {
    const { dots } = renderDock(A, false, state())
    act(() => { dots.set(state({ active: B })) })
    expect([...document.querySelectorAll('[data-page-dot]')].map(dot => dot.hasAttribute('data-active'))).toEqual([false, false, true])
  })
})
