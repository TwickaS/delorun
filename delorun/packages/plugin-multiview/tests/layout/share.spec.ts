import { describe, expect, it } from 'vitest'
import { buildPreset, drawnPreset, layoutOf, mainShareFromDrag, type LayoutModel, type LayoutNode } from '../../src/layout/index.ts'
import { DEFAULT_LAYOUT_LIMITS } from '../../src/layout/limits.ts'
import { A, B, C, MAIN } from './helpers.ts'

/** The same layout with the root split's children at new sizes. */
const resized = (model: LayoutModel, sizes: readonly number[]): LayoutModel => {
  if (model.root.kind !== 'split') return model
  const children: LayoutNode[] = model.root.children.map((child, index) => ({ ...child, size: sizes[index] ?? child.size }))
  return layoutOf({ ...model.root, children })
}

describe('the layout a chat draws', () => {
  it('is the chosen preset, Auto’s pick for Auto, and nothing for Yours or a custom arrangement', () => {
    const options = { area: { width: 1440, height: 900 }, limits: DEFAULT_LAYOUT_LIMITS, autoColumns: 3 }
    expect(drawnPreset('grid', 4, options)).toBe('grid')
    expect(drawnPreset('auto', 2, options)).toBe('side-by-side')
    expect(drawnPreset('auto', 5, options)).toBe('main-stack')
    expect(drawnPreset('yours', 3, options)).toBeUndefined()
    expect(drawnPreset('custom', 3, options)).toBeUndefined()
  })
})

describe('the main share a divider drag sets', () => {
  it('is the main pane’s new size in Main and stack, on either side, and in Main on top', () => {
    const left = buildPreset('main-stack', MAIN, [A, B])
    expect(mainShareFromDrag(left, resized(left, [64, 36]), 'main-stack', MAIN)).toBe(64)
    const right = buildPreset('main-stack', MAIN, [A, B], { mainSide: 'right' })
    expect(mainShareFromDrag(right, resized(right, [30, 70]), 'main-stack', MAIN)).toBe(70)
    const top = buildPreset('main-top', MAIN, [A, B])
    expect(mainShareFromDrag(top, resized(top, [40, 60]), 'main-top', MAIN)).toBe(40)
  })

  it('maps Centred main’s middle back to the share of the other layouts', () => {
    const centred = buildPreset('centred', MAIN, [A, B])
    expect(mainShareFromDrag(centred, resized(centred, [20, 60, 20]), 'centred', MAIN)).toBe(66)
  })

  it('is nothing for layouts without a main share, for a moved pane and for a drag inside the stack', () => {
    const columns = buildPreset('side-by-side', MAIN, [A, B])
    expect(mainShareFromDrag(columns, resized(columns, [50, 25, 25]), 'side-by-side', MAIN)).toBeUndefined()
    const stack = buildPreset('main-stack', MAIN, [A, B, C])
    expect(mainShareFromDrag(stack, buildPreset('main-stack', MAIN, [B, A, C]), 'main-stack', MAIN)).toBeUndefined()
    expect(mainShareFromDrag(stack, buildPreset('main-stack', MAIN, [A, B, C], { mainShare: 56, stackStyle: 'columns' }), 'main-stack', MAIN)).toBeUndefined()
    expect(mainShareFromDrag(stack, resized(stack, [60, 40]), undefined, MAIN)).toBeUndefined()
  })
})
