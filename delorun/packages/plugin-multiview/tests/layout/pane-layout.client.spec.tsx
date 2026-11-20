// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPreset, layoutOf, leafOf, splitOf } from '../../src/layout/index.ts'
import { A, B, MAIN, show } from './helpers.ts'
import { LayoutHarness, type Harness } from './harness.tsx'

afterEach(cleanup)

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
