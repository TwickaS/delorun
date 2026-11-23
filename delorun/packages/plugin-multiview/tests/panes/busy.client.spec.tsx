// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { useRef, type JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POINTER_HOLD_MS, TYPING_HOLD_MS, isTextField, useBusy, useHeld } from '../../src/panel/busy.ts'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('what holds the layout', () => {
  function Probe(props: { onBusy: (busy: boolean) => void }): JSX.Element {
    const root = useRef<HTMLDivElement>(null)
    props.onBusy(useBusy(root))
    return <div ref={root}><input aria-label="reply" /><button type="button">Stop</button></div>
  }

  const setup = () => {
    const seen: boolean[] = []
    const view = render(<Probe onBusy={busy => { seen.push(busy) }} />)
    return { seen, view, input: view.getByLabelText('reply'), button: view.getByRole('button') }
  }

  it('is a pointer held down in the layout, until it is released anywhere', () => {
    const { seen, button } = setup()
    fireEvent.pointerDown(button)
    expect(seen.at(-1)).toBe(true)
    fireEvent.pointerUp(document.body)
    expect(seen.at(-1)).toBe(false)
  })

  it('lets go of a held pointer when the window loses focus, the capture is lost, or after ten seconds', () => {
    const { seen, button } = setup()
    fireEvent.pointerDown(button)
    fireEvent.blur(window)
    expect(seen.at(-1)).toBe(false)
    fireEvent.pointerDown(button)
    fireEvent(button, new Event('lostpointercapture', { bubbles: true }))
    expect(seen.at(-1)).toBe(false)
    fireEvent.pointerDown(button)
    act(() => { vi.advanceTimersByTime(POINTER_HOLD_MS - 1) })
    expect(seen.at(-1)).toBe(true)
    act(() => { vi.advanceTimersByTime(1) })
    expect(seen.at(-1)).toBe(false)
  })

  it('is typing in a pane until a short pause or leaving the field, but not a key chord', () => {
    const { seen, input } = setup()
    fireEvent.keyDown(input, { key: 'k', ctrlKey: true })
    expect(seen.at(-1)).toBe(false)
    fireEvent.keyDown(input, { key: 'h' })
    expect(seen.at(-1)).toBe(true)
    act(() => { vi.advanceTimersByTime(TYPING_HOLD_MS) })
    expect(seen.at(-1)).toBe(false)
    fireEvent.keyDown(input, { key: 'i' })
    fireEvent.blur(input)
    expect(seen.at(-1)).toBe(false)
  })

  it('counts text fields only', () => {
    const box = document.createElement('input')
    box.type = 'checkbox'
    expect(isTextField(box)).toBe(false)
    expect(isTextField(document.createElement('textarea'))).toBe(true)
    expect(isTextField(document.createElement('input'))).toBe(true)
  })
})

describe('the mosaic’s busy rule', () => {
  it('takes a new value only after it settles, never while busy, and the latest once busy ends', () => {
    const hook = renderHook(({ value, busy }) => useHeld(value, 700, busy), { initialProps: { value: 'a', busy: false } })
    hook.rerender({ value: 'b', busy: false })
    act(() => { vi.advanceTimersByTime(600) })
    expect(hook.result.current).toBe('a')
    act(() => { vi.advanceTimersByTime(100) })
    expect(hook.result.current).toBe('b')
    hook.rerender({ value: 'c', busy: true })
    act(() => { vi.advanceTimersByTime(5000) })
    expect(hook.result.current).toBe('b')
    hook.rerender({ value: 'd', busy: false })
    act(() => { vi.advanceTimersByTime(700) })
    expect(hook.result.current).toBe('d')
  })

  it('takes the first measured value at once', () => {
    const hook = renderHook(({ value }: { value: number | undefined }) => useHeld(value, 200, true), { initialProps: { value: undefined as number | undefined } })
    hook.rerender({ value: 1200 })
    expect(hook.result.current).toBe(1200)
  })
})
