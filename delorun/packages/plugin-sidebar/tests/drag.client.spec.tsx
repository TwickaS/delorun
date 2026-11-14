// @vitest-environment jsdom
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DRAG_DISTANCE, SCROLL_EDGE, SCROLL_STEP, useListDrag } from '../src/client/drag.ts'
import type { SidebarListItem, SidebarSection } from '../src/client/sections.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  Reflect.deleteProperty(document, 'elementFromPoint')
})

const sid = (id: string) => id as SessionId

const ITEMS: SidebarListItem[] = [
  { kind: 'chat', id: sid('p1'), section: 'pinned' },
  { kind: 'marker', marker: 'pinned-divider' },
  { kind: 'chat', id: sid('a1'), section: 'active' },
  { kind: 'chat', id: sid('a2'), section: 'active' },
  { kind: 'marker', marker: 'settled-header' },
  { kind: 'chat', id: sid('s1'), section: 'settled' },
]

/** Which element the pointer is over, by horizontal position: 10 is a1, 20 is p1, 30 is the Settled header, 40 is nothing, 50 is a text node's parent. */
const under: Record<number, string | null> = { 10: 'a1', 20: 'p1', 30: 'marker:settled-header', 40: null }

function stubElementFromPoint(): void {
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: (x: number) => {
      const id = under[x]
      return id === undefined || id === null ? document.body : document.querySelector(`[data-drag-id="${id}"]`)
    },
  })
}

type Dropped = { id: SessionId; section: SidebarSection }

function Harness({ enabled = true, onDrop, scroller = true }: {
  readonly enabled?: boolean
  readonly onDrop: (dragged: Dropped, target: { section: string; pinnedOrder: readonly SessionId[] }) => void
  readonly scroller?: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const drag = useListDrag({ enabled, items: ITEMS, scroller: box, onDrop })
  return (
    <div ref={scroller ? box : null} data-testid="box">
      <div data-testid="a1" data-drag-id="a1" onPointerDown={drag.press(sid('a1'), 'active')}>
        a1 <button type="button">inner</button>
      </div>
      <div data-testid="p1" data-drag-id="p1" onPointerDown={drag.press(sid('p1'), 'pinned')}>p1</div>
      <div data-drag-id="marker:settled-header">settled</div>
      <output data-testid="view">{JSON.stringify(drag.view)}</output>
      <output data-testid="guard">{String(drag.justDropped())}</output>
    </div>
  )
}

const view = () => JSON.parse(screen.getByTestId('view').textContent ?? 'null') as { id: string; overId: string | null; verb: string | null; target: { section: string } | null } | null
const press = (testId = 'a1', init: PointerEventInit = {}) => { fireEvent.pointerDown(screen.getByTestId(testId), { button: 0, pointerType: 'mouse', clientX: 0, clientY: 0, ...init }) }
const move = (x: number, y = 0) => { act(() => { fireEvent.pointerMove(window, { clientX: x, clientY: y }) }) }

describe('dragging a row', () => {
  it('treats a press that moves less than six pixels as a click', () => {
    stubElementFromPoint()
    const onDrop = vi.fn()
    render(<Harness onDrop={onDrop} />)
    press()
    move(DRAG_DISTANCE - 1)
    expect(view()).toBeNull()
    act(() => { fireEvent.pointerUp(window) })
    expect([onDrop.mock.calls.length, screen.getByTestId('guard').textContent]).toEqual([0, 'false'])
  })

  it('follows the pointer once it has moved, and drops where it is released', () => {
    stubElementFromPoint()
    const onDrop = vi.fn()
    render(<Harness onDrop={onDrop} />)
    press('a1')
    move(20)
    expect(view()).toMatchObject({ id: 'a1', overId: 'p1', verb: 'pin', target: { section: 'pinned' } })
    move(30)
    expect(view()).toMatchObject({ overId: 'marker:settled-header', verb: 'settle' })
    act(() => { fireEvent.pointerUp(window) })
    expect(onDrop).toHaveBeenCalledWith({ id: 'a1', section: 'active' }, expect.objectContaining({ section: 'settled' }))
    expect(view()).toBeNull()
  })

  it('refuses a click for the rest of the task a drop ends in', () => {
    vi.useFakeTimers()
    stubElementFromPoint()
    let guard: (() => boolean) | undefined
    function Probe() {
      const box = useRef<HTMLDivElement>(null)
      const drag = useListDrag({ enabled: true, items: ITEMS, scroller: box, onDrop: () => {} })
      guard = drag.justDropped
      return <div ref={box} data-testid="p" data-drag-id="p1" onPointerDown={drag.press(sid('p1'), 'pinned')} />
    }
    render(<Probe />)
    fireEvent.pointerDown(screen.getByTestId('p'), { button: 0, pointerType: 'mouse' })
    move(20)
    act(() => { fireEvent.pointerUp(window) })
    expect(guard?.()).toBe(true)
    act(() => { vi.advanceTimersByTime(0) })
    expect(guard?.()).toBe(false)
  })

  it('names no verb over its own place and drops nowhere over nothing', () => {
    stubElementFromPoint()
    const onDrop = vi.fn()
    render(<Harness onDrop={onDrop} />)
    press('a1')
    move(10)
    expect(view()).toMatchObject({ overId: 'a1', verb: null })
    move(40)
    expect(view()).toMatchObject({ overId: null, verb: null, target: null })
    act(() => { fireEvent.pointerUp(window) })
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('drops over a place that exists in no section as no drop', () => {
    stubElementFromPoint()
    const onDrop = vi.fn()
    render(<Harness onDrop={onDrop} />)
    press('a1')
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => {
      const stray = document.createElement('div')
      stray.dataset.dragId = 'not-in-the-list'
      return stray
    } })
    move(10)
    expect(view()).toMatchObject({ overId: 'not-in-the-list', target: null, verb: null })
    act(() => { fireEvent.pointerUp(window) })
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('ends without a drop on Escape or when the pointer is cancelled, and ignores other keys', () => {
    stubElementFromPoint()
    const onDrop = vi.fn()
    render(<Harness onDrop={onDrop} />)
    press()
    move(20)
    act(() => { fireEvent.keyDown(window, { key: 'Enter' }) })
    expect(view()).not.toBeNull()
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }) })
    expect(view()).toBeNull()
    press()
    move(20)
    act(() => { fireEvent.pointerCancel(window) })
    expect(view()).toBeNull()
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('starts no drag from touch, a secondary button, a button inside the row, or while rows do not drag', () => {
    stubElementFromPoint()
    const onDrop = vi.fn()
    const { rerender } = render(<Harness onDrop={onDrop} />)
    press('a1', { pointerType: 'touch' })
    move(20)
    press('a1', { button: 2 })
    move(20)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'inner' }), { button: 0, pointerType: 'mouse' })
    move(20)
    expect(view()).toBeNull()
    rerender(<Harness onDrop={onDrop} enabled={false} />)
    press()
    move(20)
    expect(view()).toBeNull()
  })

  it('ends a drag in progress when rows stop dragging, when another press begins and when the list goes away', () => {
    stubElementFromPoint()
    const onDrop = vi.fn()
    const { rerender, unmount } = render(<Harness onDrop={onDrop} />)
    press('a1')
    move(20)
    rerender(<Harness onDrop={onDrop} enabled={false} />)
    expect(view()).toBeNull()
    rerender(<Harness onDrop={onDrop} />)
    press('a1')
    move(20)
    press('p1')
    expect(view()).toBeNull()
    move(10)
    expect(view()).toMatchObject({ id: 'p1' })
    const remove = vi.spyOn(window, 'removeEventListener')
    unmount()
    expect(remove).toHaveBeenCalledWith('pointermove', expect.any(Function))
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('scrolls the list while the pointer rests near its top or bottom edge, and not in the middle', () => {
    vi.useFakeTimers()
    stubElementFromPoint()
    render(<Harness onDrop={() => {}} />)
    const box = screen.getByTestId('box')
    box.getBoundingClientRect = () => ({ top: 100, bottom: 500, left: 0, right: 200, width: 200, height: 400, x: 0, y: 100, toJSON: () => ({}) })
    box.scrollTop = 200
    press('a1', { clientY: 300 })
    move(10, 300)
    act(() => { vi.advanceTimersByTime(16) })
    expect(box.scrollTop).toBe(200)
    move(10, 100)
    act(() => { vi.advanceTimersByTime(16) })
    expect(box.scrollTop).toBe(200 - SCROLL_STEP)
    move(10, 500 - SCROLL_EDGE / 2)
    act(() => { vi.advanceTimersByTime(16) })
    expect(box.scrollTop).toBe(200 - SCROLL_STEP + SCROLL_STEP / 2)
    act(() => { fireEvent.pointerUp(window) })
    act(() => { vi.advanceTimersByTime(64) })
    expect(box.scrollTop).toBe(200 - SCROLL_STEP + SCROLL_STEP / 2)
  })

  it('has nothing to scroll without a scroll box', () => {
    vi.useFakeTimers()
    stubElementFromPoint()
    render(<Harness onDrop={() => {}} scroller={false} />)
    press('a1')
    move(10)
    act(() => { vi.advanceTimersByTime(48) })
    expect(view()).not.toBeNull()
  })
})
