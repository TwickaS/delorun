// @vitest-environment jsdom
/** The cards of a program's own tool calls, read from each phase of the call. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en, recordInput, SeatToolRow, type SeatToolRowProps } from '../src/client/index.ts'

afterEach(cleanup)

const t = makeTranslate(en)

interface Settled {
  readonly argsRaw: string
  readonly text?: string
  readonly isError?: boolean
  readonly callTime?: number | null
  readonly time?: number
  readonly content?: readonly { readonly type: string; readonly text?: string }[]
}

function props(toolName: string, phase: 'preparing' | 'start' | 'result', settled: Settled = { argsRaw: '{}' }, inspect?: () => void): SeatToolRowProps {
  const block = phase === 'preparing' ? {}
    : phase === 'start' ? { argsRaw: settled.argsRaw }
    : {
      call: { argsRaw: settled.argsRaw }, isError: settled.isError ?? false, callTime: settled.callTime === undefined ? 1000 : settled.callTime, time: settled.time ?? 4500,
      content: settled.content ?? [{ type: 'text', text: settled.text ?? '' }],
    }
  return { toolName, phase, block, inspect, t } as never as SeatToolRowProps
}

describe('recordInput', () => {
  it('reads each phase of the call', () => {
    expect(recordInput(props('codex.plan', 'preparing'))).toEqual({ name: 'codex.plan', argsRaw: '', result: null })
    expect(recordInput(props('codex.plan', 'start', { argsRaw: '{"a":1}' }))).toEqual({ name: 'codex.plan', argsRaw: '{"a":1}', result: null })
    expect(recordInput(props('codex.plan', 'result', { argsRaw: '{}', content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] })).result)
      .toEqual({ text: 'ab', isError: false, seconds: 3.5 })
  })

  it('has no duration without a recorded call time, and none negative', () => {
    expect(recordInput(props('codex.plan', 'result', { argsRaw: '{}', callTime: null })).result?.seconds).toBeNull()
    expect(recordInput(props('codex.plan', 'result', { argsRaw: '{}', callTime: 9000 })).result?.seconds).toBe(0)
  })

  it('takes no arguments from a result without its call', () => {
    const settled = props('codex.plan', 'result')
    const noCall = { ...settled, block: { ...(settled.block as object), call: undefined } } as never as SeatToolRowProps
    expect(recordInput(noCall).argsRaw).toBe('')
  })
})

describe('SeatToolRow', () => {
  it('shows a failed command with its exit code, time and folded output', () => {
    const inspect = vi.fn()
    const { container } = render(<SeatToolRow {...props('claude_code.Bash', 'result', { argsRaw: '{"command":"pnpm test"}', text: '1 failed\nexit 1' }, inspect)} />)
    expect(container.querySelector('[data-seat-tool="ran"]')?.getAttribute('data-state')).toBe('failed')
    expect(screen.getByText('pnpm test')).toBeTruthy()
    expect(screen.getByText('3.5s')).toBeTruthy()
    expect(screen.getByText('exit 1')).toBeTruthy()
    expect(screen.queryByText(/1 failed/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Output' }))
    expect(container.querySelector('pre')?.textContent).toBe('1 failed\nexit 1')
    fireEvent.click(screen.getByRole('button', { name: 'Output' }))
    expect(container.querySelector('pre')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Inspect this call' }))
    expect(inspect).toHaveBeenCalled()
  })

  it('shows badges for a running, passing, erroring and plainly settled call', () => {
    const running = render(<SeatToolRow {...props('claude_code.Bash', 'start', { argsRaw: '{"command":"ls"}' })} />)
    expect(running.container.querySelector('[data-state="running"]')).not.toBeNull()
    expect(running.container.textContent).toContain('running')
    running.unmount()
    const passed = render(<SeatToolRow {...props('claude_code.Bash', 'result', { argsRaw: '{"command":"ls"}', text: '' })} />)
    expect(passed.container.querySelector('button')).toBeNull()
    expect(passed.container.textContent).toContain('passed')
    passed.unmount()
    const failed = render(<SeatToolRow {...props('codex.mcpToolCall', 'result', { argsRaw: '{}', isError: true, text: 'boom' })} />)
    expect(failed.container.textContent).toContain('failed')
    failed.unmount()
    const generic = render(<SeatToolRow {...props('claude_code.Task', 'preparing')} />)
    expect(generic.container.querySelector('[data-seat-tool="generic"]')).not.toBeNull()
    expect(generic.container.textContent).toContain('Task')
  })

  it('shows a search with where it looked and the count of matches', () => {
    const many = render(<SeatToolRow {...props('claude_code.Grep', 'result', { argsRaw: '{"pattern":"x","path":"src"}', text: 'a\nb', callTime: null })} />)
    expect(many.container.textContent).toContain('src')
    expect(many.container.textContent).toContain('2 matches')
    expect(screen.queryByText(/^\d+\.\ds$/)).toBeNull()
    many.unmount()
    const one = render(<SeatToolRow {...props('claude_code.Grep', 'result', { argsRaw: '{"pattern":"x"}', text: 'a' })} />)
    expect(one.container.textContent).toContain('1 match')
  })

  it('shows an edit with its added and removed lines, or without them', () => {
    const edit = render(<SeatToolRow {...props('claude_code.Edit', 'result', { argsRaw: '{"file_path":"a.ts","old_string":"x","new_string":"a\\nb"}' })} />)
    expect(edit.container.querySelector('[data-seat-tool="edited"]')?.textContent).toContain('a.ts')
    expect(edit.container.textContent).toContain('+2')
    expect(edit.container.textContent).toContain('−1')
  })
})
