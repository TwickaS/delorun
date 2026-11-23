import { describe, expect, it } from 'vitest'
import {
  addPane, applyPreset, buildPreset, closePane, DEFAULT_LAYOUT_LIMITS, layoutOf, leafOf, movePane, panesOf, reconcileLayout,
  resetLayout, selectPane, swapPanes, type LayoutContext, type LayoutModel,
} from '../../src/layout/index.ts'
import { A, B, C, D, MAIN, pane, show, sizesSumTo100 } from './helpers.ts'

const context: LayoutContext = { main: MAIN, limits: DEFAULT_LAYOUT_LIMITS }
const columnAB = (): LayoutModel => buildPreset('main-column', MAIN, [A, B])
const ok = (result: ReturnType<typeof movePane>): LayoutModel => {
  if (!result.ok) throw new Error(`refused: ${result.reason}`)
  expect(sizesSumTo100(result.model)).toBe(true)
  return result.model
}

describe('adding a pane', () => {
  it('puts a pin beside the only pane at the default 56 / 44', () => {
    expect(show(ok(addPane(layoutOf(leafOf([MAIN])), context, A)))).toBe('H(main:56, a:44):100')
  })

  it('stacks a pin in the right column and keeps the sizes the person set', () => {
    const column = buildPreset('main-column', MAIN, [A, B]).root
    if (column.kind !== 'split') throw new Error('expected a split')
    const resized = layoutOf({ ...column, children: [{ ...column.children[0]!, size: 70 }, { ...column.children[1]!, size: 30 }] })
    expect(show(ok(addPane(resized, context, C)))).toBe('H(main:70, V(a:33.3, b:33.3, c:33.3):30):100')
  })

  it('turns the main chat and one agent into the main chat and a stack', () => {
    expect(show(ok(addPane(buildPreset('main-column', MAIN, [A]), context, B)))).toBe('H(main:56, V(a:50, b:50):44):100')
  })

  it('fills a grid row by row and adds a column to a row of three', () => {
    expect(show(ok(addPane(buildPreset('grid', MAIN, [A, B]), context, C)))).toBe('V(H(main:50, a:50):50, H(b:50, c:50):50):100')
    expect(show(ok(addPane(buildPreset('side-by-side', MAIN, [A, B]), context, C)))).toBe('H(main:25, a:25, b:25, c:25):100')
  })

  it('splits beside a named pane, and joins its tabs on the middle', () => {
    expect(show(ok(addPane(columnAB(), context, C, { kind: 'pane', pane: A, region: 'right' })))).toBe('H(main:56, V(H(a:50, c:50):50, b:50):44):100')
    expect(show(ok(addPane(columnAB(), context, C, { kind: 'pane', pane: A, region: 'center' })))).toBe('H(main:56, V(a+*c:50, b:50):44):100')
  })

  it('refuses a pane already shown, an unknown target and a full layout', () => {
    expect(addPane(columnAB(), context, A)).toEqual({ ok: false, reason: 'duplicate-pane' })
    expect(addPane(columnAB(), context, C, { kind: 'pane', pane: D, region: 'left' })).toEqual({ ok: false, reason: 'unknown-pane' })
    const six = buildPreset('grid', MAIN, [A, B, C, D, pane('e')])
    expect(addPane(six, context, pane('f'))).toEqual({ ok: false, reason: 'max-panes' })
    expect(addPane(six, { ...context, limits: { ...DEFAULT_LAYOUT_LIMITS, maxPanes: 7 }, area: { width: 700, height: 500 } }, pane('f'))).toEqual({ ok: false, reason: 'no-room' })
  })
})

describe('moving a pane', () => {
  it('docks a pane to the edge of another to split there', () => {
    expect(show(ok(movePane(columnAB(), B, { kind: 'pane', pane: MAIN, region: 'bottom' })))).toBe('H(V(main:50, b:50):56, a:44):100')
  })

  it('moves the main chat like any other pane', () => {
    expect(show(ok(movePane(columnAB(), MAIN, { kind: 'pane', pane: B, region: 'bottom' })))).toBe('V(a:50, b:25, main:25):100')
  })

  it('docks along an edge of the whole layout', () => {
    expect(show(ok(movePane(columnAB(), B, { kind: 'edge', edge: 'bottom' })))).toBe('V(H(main:56, a:44):50, b:50):100')
  })

  it('joins tabs on the middle and leaves the other leaf', () => {
    const joined = ok(movePane(columnAB(), B, { kind: 'pane', pane: MAIN, region: 'center' }))
    expect(show(joined)).toBe('H(main+*b:56, a:44):100')
  })

  it('refuses an unknown pane, a pane onto itself and a layout of one pane', () => {
    expect(movePane(columnAB(), D, { kind: 'edge', edge: 'left' })).toEqual({ ok: false, reason: 'unknown-pane' })
    expect(movePane(columnAB(), A, { kind: 'pane', pane: A, region: 'left' })).toEqual({ ok: false, reason: 'same-pane' })
    expect(movePane(layoutOf(leafOf([MAIN])), MAIN, { kind: 'edge', edge: 'left' })).toEqual({ ok: false, reason: 'same-pane' })
  })

  it('does not change how many panes there are, so the limit does not apply', () => {
    const six = buildPreset('grid', MAIN, [A, B, C, D, pane('e')])
    expect(panesOf(ok(movePane(six, pane('e'), { kind: 'pane', pane: MAIN, region: 'right' })))).toHaveLength(6)
  })
})

describe('swapping, closing and selecting', () => {
  it('swaps two panes and leaves the sizes with the places', () => {
    expect(show(ok(swapPanes(columnAB(), MAIN, B)))).toBe('H(b:56, V(a:50, main:50):44):100')
  })

  it('closes around a pane and gives its space to the neighbours', () => {
    expect(show(ok(closePane(columnAB(), context, B)))).toBe('H(main:56, a:44):100')
    expect(show(ok(closePane(buildPreset('side-by-side', MAIN, [A, B]), context, A)))).toBe('H(main:50, b:50):100')
  })

  it('never closes the main chat', () => {
    expect(closePane(columnAB(), context, MAIN)).toEqual({ ok: false, reason: 'main-pane' })
    expect(closePane(columnAB(), context, D)).toEqual({ ok: false, reason: 'unknown-pane' })
  })

  it('shows another tab of a leaf', () => {
    const tabs = ok(movePane(columnAB(), B, { kind: 'pane', pane: MAIN, region: 'center' }))
    expect(show(ok(selectPane(tabs, MAIN)))).toBe('H(*main+b:56, a:44):100')
    expect(selectPane(tabs, D)).toEqual({ ok: false, reason: 'unknown-pane' })
  })
})

describe('presets and reset', () => {
  it('rearranges the same panes without closing any, and puts the main chat first', () => {
    const moved = ok(movePane(columnAB(), MAIN, { kind: 'pane', pane: B, region: 'bottom' }))
    const grid = applyPreset(moved, context, 'grid')
    expect([...panesOf(grid)].sort()).toEqual([A, B, MAIN].sort())
    expect(panesOf(grid)[0]).toBe(MAIN)
  })

  it('resets to the default arrangement, Auto: up to three panes side by side', () => {
    const moved = ok(movePane(columnAB(), B, { kind: 'edge', edge: 'bottom' }))
    expect(show(resetLayout(moved, context))).toBe('H(main:33.3, a:33.3, b:33.3):100')
  })
})

describe('reconciling with the panes that exist', () => {
  it('drops panes that are gone and adds panes the layout lacks', () => {
    expect(show(reconcileLayout(columnAB(), MAIN, [B, C]))).toBe('H(main:56, V(b:50, c:50):44):100')
  })

  it('builds the default layout, Auto, when nothing was saved', () => {
    expect(show(reconcileLayout(undefined, MAIN, [A, B]))).toBe('H(main:33.3, a:33.3, b:33.3):100')
  })

  it('keeps the main chat when a saved layout lacks it', () => {
    expect(panesOf(reconcileLayout(layoutOf(leafOf([A])), MAIN, [A]))).toEqual([MAIN, A])
  })

  it('restores more panes than the limit allows; the surface decides what fits', () => {
    const many = [A, B, C, D, pane('e'), pane('f'), pane('g')]
    expect(panesOf(reconcileLayout(undefined, MAIN, many))).toHaveLength(8)
  })
})
