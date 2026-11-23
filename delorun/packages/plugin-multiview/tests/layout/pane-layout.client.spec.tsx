// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState, type JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildPreset, DEFAULT_LAYOUT_LIMITS, fitLayout, layoutOf, leafOf, splitOf, type LayoutArea } from '../../src/layout/index.ts'
import { A, B, C, D, MAIN, show } from './helpers.ts'
import { LayoutHarness, type Harness } from './harness.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const record = (): Harness => ({ changes: [], mounts: new Map() })
const mountColumn = (rec: Harness) => render(<LayoutHarness initial={buildPreset('main-column', MAIN, [A, B])} main={MAIN} record={rec} />)

// jsdom does no layout, so resizing (pointer, touch and arrow keys) is checked in Chromium and WebKit by `browser/spike.mts`.
describe('PaneLayout in jsdom', () => {
  it('draws every pane with its header and body', () => {
    mountColumn(record())
    for (const pane of [MAIN, A, B]) {
      expect(screen.getByTestId(`input-${pane}`)).toBeTruthy()
      expect(document.querySelector(`[data-header="${pane}"]`)).toBeTruthy()
    }
    expect(screen.getByRole('region', { name: 'Multiview' })).toBeTruthy()
  })

  it('draws no tab strip for one-pane leaves and a strip when panes share a leaf', () => {
    mountColumn(record())
    expect([...document.querySelectorAll<HTMLElement>('[data-tab-list]')].every(list => list.style.display === 'none')).toBe(true)
    cleanup()
    render(<LayoutHarness initial={layoutOf(splitOf('horizontal', [leafOf([MAIN, A]), leafOf([B])]))} main={MAIN} record={record()} />)
    const lists = [...document.querySelectorAll<HTMLElement>('[data-tab-list]')]
    expect(lists.filter(list => list.style.display !== 'none')).toHaveLength(1)
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(expect.arrayContaining(['main', 'a']))
  })

  it('gives each divider the separator role, a name, value attributes and a place in the tab order', () => {
    mountColumn(record())
    const separators = screen.getAllByRole('separator', { name: 'Resize panes' })
    expect(separators).toHaveLength(2)
    expect(separators.map(separator => separator.getAttribute('aria-orientation'))).toEqual(['vertical', 'horizontal'])
    for (const separator of separators) {
      expect(separator.getAttribute('tabindex')).toBe('0')
      for (const name of ['aria-valuenow', 'aria-valuemin', 'aria-valuemax']) expect(separator.getAttribute(name)).not.toBeNull()
    }
  })

  it('keeps every pane body mounted once, as the same node, when panes swap places', async () => {
    const rec = record()
    mountColumn(rec)
    const before = [MAIN, A, B].map(pane => screen.getByTestId(`input-${pane}`))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Swap main' }))
    })
    expect(show(rec.changes.at(-1)!.model)).toBe('H(a:56, V(main:50, b:50):44):100')
    expect(rec.changes.at(-1)!.reason).toBe('swap')
    expect([MAIN, A, B].map(pane => screen.getByTestId(`input-${pane}`))).toEqual(before)
    expect([...rec.mounts.values()]).toEqual([1, 1, 1])
  })

  it('closes a pane through its header, and offers no Close on the main chat', async () => {
    const rec = record()
    mountColumn(rec)
    expect((screen.getByRole('button', { name: 'Close main' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close b' }))
    })
    expect(show(rec.changes.at(-1)!.model)).toBe('H(main:56, a:44):100')
    expect(screen.queryByTestId('input-b')).toBeNull()
  })

  it('shows a layout the consumer replaces, without remounting panes that stay', async () => {
    const rec = record()
    const view = render(<LayoutHarness initial={buildPreset('main-column', MAIN, [A])} main={MAIN} record={rec} />)
    const before = screen.getByTestId('input-main')
    view.rerender(<LayoutHarness initial={buildPreset('main-column', MAIN, [A])} main={MAIN} record={rec} />)
    expect(screen.getByTestId('input-main')).toBe(before)
    expect([...rec.mounts.values()]).toEqual([1, 1])
  })

  it('offers a grip on every header, named for assistive technology', () => {
    mountColumn(record())
    expect(screen.getAllByTitle('Move pane')).toHaveLength(3)
    expect(screen.getAllByLabelText('Move pane')).toHaveLength(3)
  })
})

/** A ResizeObserver that records what it watches; jsdom has none. `fire` runs the callbacks of the observers watching the element. */
function stubResizeObserver() {
  const observers: { callback: () => void; targets: Element[]; disconnected: boolean }[] = []
  vi.stubGlobal('ResizeObserver', class {
    readonly #entry: { callback: () => void; targets: Element[]; disconnected: boolean }
    constructor(callback: () => void) {
      this.#entry = { callback, targets: [], disconnected: false }
      observers.push(this.#entry)
    }
    observe(target: Element): void { this.#entry.targets.push(target) }
    unobserve(): void {}
    disconnect(): void { this.#entry.disconnected = true }
  })
  const watching = (element: Element) => observers.filter(observer => observer.targets.includes(element))
  return { observers, watching, fire: (element: Element) => { for (const observer of watching(element)) observer.callback() } }
}

describe('PaneLayout reporting its area', () => {
  it('does not re-subscribe or loop when the consumer passes a new callback on every render that sets state', () => {
    const resize = stubResizeObserver()
    const reports: LayoutArea[] = []
    function Consumer(): JSX.Element {
      const [, setArea] = useState<LayoutArea>({ width: -1, height: -1 })
      return (
        <LayoutHarness
          initial={buildPreset('main-column', MAIN, [A])}
          main={MAIN}
          record={record()}
          overrides={{ onAreaChange: area => { reports.push(area); setArea({ ...area }) } }}
        />
      )
    }
    render(<Consumer />)
    const region = screen.getByRole('region', { name: 'Multiview' })
    expect(reports).toHaveLength(1)
    expect(resize.watching(region)).toHaveLength(1)
    expect(resize.watching(region)[0]!.disconnected).toBe(false)
  })

  it('reports a new size once and an unchanged size not at all', () => {
    const resize = stubResizeObserver()
    const reports: LayoutArea[] = []
    render(<LayoutHarness initial={buildPreset('main-column', MAIN, [A])} main={MAIN} record={record()} overrides={{ onAreaChange: area => { reports.push(area) } }} />)
    const region = screen.getByRole('region', { name: 'Multiview' })
    expect(reports).toEqual([{ width: 0, height: 0 }])
    act(() => { resize.fire(region) })
    expect(reports).toHaveLength(1)
    Object.defineProperty(region, 'clientWidth', { configurable: true, value: 900 })
    act(() => { resize.fire(region) })
    act(() => { resize.fire(region) })
    expect(reports).toEqual([{ width: 0, height: 0 }, { width: 900, height: 0 }])
  })

  it('stops observing when the consumer stops asking for the area, and when it unmounts', () => {
    const resize = stubResizeObserver()
    const view = render(<LayoutHarness initial={buildPreset('main-column', MAIN, [A])} main={MAIN} record={record()} overrides={{ onAreaChange: () => {} }} />)
    const region = screen.getByRole('region', { name: 'Multiview' })
    const [watcher] = resize.watching(region)
    view.rerender(<LayoutHarness initial={buildPreset('main-column', MAIN, [A])} main={MAIN} record={record()} />)
    expect(watcher!.disconnected).toBe(true)
    view.unmount()
  })
})

describe('PaneLayout with panes hidden for lack of room', () => {
  it('reports no layout change when the window resizes, so a stored layout keeps the hidden panes', () => {
    const resize = stubResizeObserver()
    const stored = buildPreset('main-column', MAIN, [A, B, C, D])
    const fitted = fitLayout(stored, MAIN, 3)
    expect(fitted.hidden).toEqual([C, D])
    const rec = record()
    render(<LayoutHarness initial={fitted.model} main={MAIN} record={rec} overrides={{ onAreaChange: () => {} }} />)
    const region = screen.getByRole('region', { name: 'Multiview' })
    Object.defineProperty(region, 'clientWidth', { configurable: true, value: 500 })
    act(() => { resize.fire(region) })
    expect(rec.changes).toEqual([])
  })
})

describe('PaneLayout restoring after a drag', () => {
  it('schedules a restore only for a pointerup that ends a press on a grip', () => {
    const frame = vi.spyOn(window, 'requestAnimationFrame')
    mountColumn(record())
    const base = frame.mock.calls.length
    act(() => { document.dispatchEvent(new Event('pointerup', { bubbles: true })) })
    expect(frame.mock.calls.length).toBe(base)
    act(() => { fireEvent.pointerDown(screen.getAllByTitle('Move pane')[0]!) })
    act(() => { document.dispatchEvent(new Event('pointerup', { bubbles: true })) })
    expect(frame.mock.calls.length).toBeGreaterThan(base)
    const after = frame.mock.calls.length
    act(() => { document.dispatchEvent(new Event('pointerup', { bubbles: true })) })
    expect(frame.mock.calls.length).toBe(after)
  })

  it('ignores a press that is not on a grip', () => {
    const frame = vi.spyOn(window, 'requestAnimationFrame')
    mountColumn(record())
    const base = frame.mock.calls.length
    act(() => { fireEvent.pointerDown(screen.getByTestId('input-a')) })
    act(() => { document.dispatchEvent(new Event('pointerup', { bubbles: true })) })
    expect(frame.mock.calls.length).toBe(base)
  })
})

describe('the space between panes', () => {
  afterEach(() => { cleanup() })

  it('spaces the panes by the gap setting, none by default, and changes it without a remount', () => {
    const rec = record()
    const view = render(<LayoutHarness initial={buildPreset('main-column', MAIN, [A, B])} main={MAIN} record={rec} />)
    const root = screen.getByRole('region', { name: 'Multiview' })
    expect(root.style.getPropertyValue('--mv-pane-gap')).toBe('0px')
    view.rerender(<LayoutHarness initial={buildPreset('main-column', MAIN, [A, B])} main={MAIN} record={rec} overrides={{ limits: { ...DEFAULT_LAYOUT_LIMITS, paneGap: 12 } }} />)
    expect(screen.getByRole('region', { name: 'Multiview' }).style.getPropertyValue('--mv-pane-gap')).toBe('12px')
    expect([...rec.mounts.values()].every(count => count === 1)).toBe(true)
  })
})
