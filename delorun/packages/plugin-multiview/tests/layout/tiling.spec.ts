import { describe, expect, it } from 'vitest'
import {
  applyShape, arrangeLayout, autoChoice, buildPreset, cycleChoice, DEFAULT_LAYOUT_LIMITS, DEFAULT_PRESET, DEFAULT_PRESET_OPTIONS,
  fitsMinimums, fitToMinimums, LAYOUT_CHOICE_IDS, LAYOUT_CHOICES, LAYOUT_IDS, layoutProblem, neighbourPane, paneCount, panesOf, placeLeaves,
  resizePaneShare, shapeOf, shapeProblem, slotOrder, type ChatArrangement, type LayoutArea, type LayoutModel, type PaneId,
} from '../../src/layout/index.ts'
import { A, B, C, D, MAIN, pane, show, sizesSumTo100 } from './helpers.ts'

const AREAS = {
  laptop: { width: 1440, height: 900 },
  ultrawide: { width: 3440, height: 1440 },
  portrait: { width: 900, height: 1400 },
} satisfies Record<string, LayoutArea>
const limits = DEFAULT_LAYOUT_LIMITS
const agents = (count: number): PaneId[] => Array.from({ length: count }, (_, index) => pane(`agent-${index + 1}`))
const leaves = (model: LayoutModel, area: LayoutArea) => placeLeaves(model, area)
const arrange = (arrangement: ChatArrangement, others: readonly PaneId[], area: LayoutArea | undefined, extra: Partial<Parameters<typeof arrangeLayout>[0]> = {}) =>
  arrangeLayout({ arrangement, slots: [MAIN, ...others], options: { ...DEFAULT_PRESET_OPTIONS, area, limits }, limits, ...extra })

describe('every layout, one to eight panes, three areas', () => {
  for (const [name, area] of Object.entries(AREAS)) {
    for (const choice of LAYOUT_CHOICE_IDS) {
      it(`${choice} at ${name} keeps every pane, never under the least size`, () => {
        for (let total = 1; total <= 8; total += 1) {
          const others = agents(total - 1)
          const shape = shapeOf(buildPreset('grid', MAIN, others), [MAIN, ...others])
          const model = arrange(choice, others, area, { shape })
          expect([...panesOf(model)].sort()).toEqual([MAIN, ...others].sort())
          expect(layoutProblem(model)).toBeUndefined()
          expect(sizesSumTo100(model)).toBe(true)
          expect(fitsMinimums(model, limits, area)).toBe(true)
        }
      })
    }
  }
})

describe('the picker list', () => {
  it('offers every preset and Yours, Auto first, and Auto is the default', () => {
    expect(DEFAULT_PRESET).toBe('auto')
    expect(LAYOUT_CHOICES.map(choice => choice.id)).toEqual([...LAYOUT_IDS, 'yours'])
    expect(LAYOUT_CHOICES.every(choice => choice.labelKey === `choice.${choice.id}`)).toBe(true)
  })

  it('dims a choice that does not apply yet', () => {
    const spiral = LAYOUT_CHOICES.find(choice => choice.id === 'spiral')!
    expect(spiral.available(2)).toBe(false)
    expect(spiral.available(3)).toBe(true)
    const centred = LAYOUT_CHOICES.find(choice => choice.id === 'centred')!
    expect(centred.available(4, { width: 900, height: 900 }, limits)).toBe(false)
    expect(centred.available(4, AREAS.ultrawide, limits)).toBe(true)
  })
})

describe('Auto', () => {
  it('puts up to three views side by side in equal columns', () => {
    expect(autoChoice(2, { area: AREAS.laptop, limits })).toBe('side-by-side')
    expect(autoChoice(3, { area: AREAS.ultrawide, limits })).toBe('side-by-side')
    expect(show(buildPreset('auto', MAIN, [A, B], { area: AREAS.laptop }))).toBe('H(main:33.3, a:33.3, b:33.3):100')
  })

  it('from four views chooses by the shape of the area', () => {
    expect(autoChoice(4, { area: AREAS.laptop, limits })).toBe('main-stack')
    expect(autoChoice(4, { area: AREAS.ultrawide, limits })).toBe('centred')
    expect(autoChoice(4, { area: AREAS.portrait, limits })).toBe('rows')
  })

  it('switches at the documented points', () => {
    expect(autoChoice(4, { area: { width: 2099, height: 1000 }, limits })).toBe('main-stack')
    expect(autoChoice(4, { area: { width: 2100, height: 1000 }, limits })).toBe('centred')
    expect(autoChoice(4, { area: { width: 2560, height: 1600 }, limits })).toBe('centred')
    expect(autoChoice(4, { area: { width: 2559, height: 1600 }, limits })).toBe('main-stack')
    expect(autoChoice(4, { area: { width: 999, height: 1000 }, limits })).toBe('rows')
    expect(autoChoice(4, { area: { width: 1000, height: 1000 }, limits })).toBe('main-stack')
  })

  it('shows tabs on a tall area when stacked rows would be under the least height', () => {
    expect(autoChoice(5, { area: AREAS.portrait, limits })).toBe('rows')
    expect(autoChoice(6, { area: AREAS.portrait, limits })).toBe('tabs')
  })

  it('tiles the stack as a grid in Main and stack', () => {
    // The stack is 634 px wide at 1440, too narrow for two columns of 340 px, so its grid is one column.
    expect(show(buildPreset('auto', MAIN, [A, B, C], { area: AREAS.laptop, limits }))).toBe('H(main:56, V(a:33.3, b:33.3, c:33.3):44):100')
    expect(show(buildPreset('auto', MAIN, [A, B, C, D], { area: AREAS.laptop, limits }))).toBe('H(main:56, V(a:25, b:25, c:25, d:25):44):100')
    expect(show(buildPreset('main-stack', MAIN, [A, B, C, D], { stackStyle: 'grid', area: { width: 2000, height: 900 }, limits }))).toBe('H(main:56, V(H(a:50, b:50):50, H(c:50, d:50):50):44):100')
  })

  it('without an area, from four views, shows Main and stack', () => {
    expect(autoChoice(4, {})).toBe('main-stack')
  })

  it('turns panes that do not fit into tabs, never hiding one', () => {
    const narrow: LayoutArea = { width: 900, height: 800 }
    const model = arrange('auto', [A, B], narrow)
    expect(panesOf(model)).toEqual([MAIN, A, B])
    expect(leaves(model, narrow).map(entry => entry.leaf.panes.length)).toEqual([1, 2])
    expect(fitsMinimums(model, limits, narrow)).toBe(true)
  })
})

describe('Main and stack', () => {
  it('reads the arrangement saved before Auto as Main and stack on the left with rows', () => {
    expect(show(buildPreset('main-column', MAIN, [A, B]))).toBe('H(main:56, V(a:50, b:50):44):100')
    expect(show(buildPreset('main-stack', MAIN, [A, B]))).toBe(show(buildPreset('main-column', MAIN, [A, B])))
  })

  it('keeps the main chat full height on the chosen side', () => {
    expect(show(buildPreset('main-stack', MAIN, [A, B], { mainSide: 'right' }))).toBe('H(V(a:50, b:50):44, main:56):100')
  })

  it('tiles the others as rows, columns, a grid or a spiral', () => {
    expect(show(buildPreset('main-stack', MAIN, [A, B], { stackStyle: 'columns' }))).toBe('H(main:56, a:22, b:22):100')
    expect(show(buildPreset('main-stack', MAIN, [A, B, C, D], { stackStyle: 'grid' }))).toBe('H(main:56, V(H(a:50, b:50):50, H(c:50, d:50):50):44):100')
    expect(show(buildPreset('main-stack', MAIN, [A, B, C], { stackStyle: 'spiral' }))).toBe('H(main:56, V(a:50, H(c:50, b:50):50):44):100')
  })

  it('keeps the main share inside its bounds', () => {
    expect(show(buildPreset('main-stack', MAIN, [A], { mainShare: 90 }))).toBe('H(main:75, a:25):100')
    expect(show(buildPreset('main-stack', MAIN, [A], { mainShare: 10 }))).toBe('H(main:25, a:75):100')
  })
})

describe('the other presets', () => {
  it('stacks every pane in rows', () => {
    expect(show(buildPreset('rows', MAIN, [A, B]))).toBe('V(main:33.3, a:33.3, b:33.3):100')
  })

  it('spirals inwards, each pane half of what is left, the newest smallest', () => {
    expect(show(buildPreset('spiral', MAIN, [A, B, C]))).toBe('H(main:50, V(a:50, H(c:50, b:50):50):50):100')
    const model = buildPreset('spiral', MAIN, agents(5))
    const sizes = leaves(model, AREAS.laptop).map(entry => entry.rect.width * entry.rect.height)
    const newest = sizes[panesOf(model).indexOf(pane('agent-5'))]!
    expect(Math.min(...sizes)).toBe(newest)
  })

  it('centres the main chat with the others alternating right and left', () => {
    expect(show(buildPreset('centred', MAIN, [A, B]))).toBe('H(b:25, main:50, a:25):100')
    expect(show(buildPreset('centred', MAIN, [A, B, C, D]))).toBe('H(V(b:50, d:50):25, main:50, V(a:50, c:50):25):100')
    expect(show(buildPreset('centred', MAIN, [A]))).toBe('H(main:56, a:44):100')
  })

  it('shows one pane with the others as tabs, the main chat shown', () => {
    expect(show(buildPreset('tabs', MAIN, [A, B]))).toBe('*main+a+b:100')
  })

  it('gives working panes large tiles and finished ones a strip below', () => {
    const activity = new Map<PaneId, 'large' | 'small'>([[A, 'large'], [B, 'small'], [C, 'small']])
    expect(show(buildPreset('mosaic', MAIN, [A, B, C], { activity }))).toBe('V(H(main:50, a:50):72, H(b:50, c:50):28):100')
    expect(show(buildPreset('mosaic', MAIN, [A, B], { activity: new Map([[A, 'large'], [B, 'large']]) }))).toBe('H(main:33.3, a:33.3, b:33.3):100')
  })

  it('collapses the small tiles to one tab strip when the area is tight', () => {
    const tight: LayoutArea = { width: 1000, height: 560 }
    const model = arrange('mosaic', [A, B, C], tight, { options: { ...DEFAULT_PRESET_OPTIONS, area: tight, limits, activity: new Map([[A, 'large']]) } })
    expect(panesOf(model)).toEqual([MAIN, A, B, C])
    expect(fitsMinimums(model, limits, tight)).toBe(true)
  })
})

describe('fitting to the least size', () => {
  it('turns the smallest leaf into a tab of its neighbour until every leaf fits', () => {
    const model = buildPreset('side-by-side', MAIN, [A, B])
    expect(show(fitToMinimums(model, limits, { width: 900, height: 600 }))).toBe('H(main:50, *a+b:50):100')
  })

  it('leaves a layout that fits as it is, and a single leaf alone', () => {
    const model = buildPreset('side-by-side', MAIN, [A, B])
    expect(fitToMinimums(model, limits, AREAS.laptop)).toBe(model)
    const tiny: LayoutArea = { width: 100, height: 100 }
    expect(placeLeaves(fitToMinimums(model, limits, tiny), tiny)).toHaveLength(1)
  })
})

describe('the person’s own shape', () => {
  it('stores slots, not chats, and applies to another chat’s agents', () => {
    const mine = buildPreset('main-stack', MAIN, [A, B], { mainSide: 'right' })
    const shape = shapeOf(mine, [MAIN, A, B])
    expect(JSON.stringify(shape)).not.toContain('"a"')
    expect(shapeProblem(shape)).toBeUndefined()
    const other = applyShape(shape, pane('x'), [pane('y'), pane('z')])
    expect(show(other)).toBe('H(V(y:50, z:50):44, x:56):100')
  })

  it('closes up around missing slots and adds extra agents where a pin goes', () => {
    const shape = shapeOf(buildPreset('grid', MAIN, [A, B, C]), [MAIN, A, B, C])
    expect(show(applyShape(shape, MAIN, [A]))).toBe('H(main:50, a:50):100')
    expect(panesOf(applyShape(shape, MAIN, [A, B, C, D]))).toContain(D)
  })

  it('rejects a shape with a slot twice', () => {
    expect(shapeProblem({ version: 1, root: { kind: 'split', orientation: 'horizontal', size: 100, children: [
      { kind: 'leaf', slots: [0], active: 0, size: 50 }, { kind: 'leaf', slots: [0], active: 0, size: 50 },
    ] } })).toBe('a slot appears twice')
  })
})

describe('keyboard moves', () => {
  const grid = buildPreset('grid', MAIN, [A, B, C])
  it('finds the pane in each direction, and nothing at the edge', () => {
    expect(neighbourPane(grid, AREAS.laptop, MAIN, 'right')).toBe(A)
    expect(neighbourPane(grid, AREAS.laptop, MAIN, 'down')).toBe(B)
    expect(neighbourPane(grid, AREAS.laptop, C, 'left')).toBe(B)
    expect(neighbourPane(grid, AREAS.laptop, C, 'up')).toBe(A)
    expect(neighbourPane(grid, AREAS.laptop, MAIN, 'left')).toBeUndefined()
  })

  it('grows and shrinks a pane’s share within bounds', () => {
    const stack = buildPreset('main-stack', MAIN, [A])
    expect(show(resizePaneShare(stack, MAIN, 5))).toBe('H(main:61, a:39):100')
    expect(show(resizePaneShare(stack, MAIN, -40))).toBe('H(main:25, a:75):100')
  })

  it('cycles through the choices, skipping Yours when none is saved', () => {
    expect(cycleChoice('auto', 1, false)).toBe('main-stack')
    expect(cycleChoice('auto', -1, false)).toBe('tabs')
    expect(cycleChoice('tabs', 1, true)).toBe('yours')
    expect(cycleChoice('custom', 1, false)).toBe('auto')
  })

  it('keeps the slot order of panes that remain and appends new pins', () => {
    expect(slotOrder([A, MAIN, B], MAIN, [B, C, A])).toEqual([A, MAIN, B, C])
    expect(slotOrder(undefined, MAIN, [A, B])).toEqual([MAIN, A, B])
  })
})

describe('the space between panes in the layout', () => {
  it('places leaves with the gap between them and around the edge, sharing what the gaps leave', () => {
    const model = buildPreset('side-by-side', MAIN, [A])
    const placed = placeLeaves(model, { width: 1000, height: 600 }, 20)
    expect(placed.map(entry => entry.rect)).toEqual([
      { x: 20, y: 20, width: 470, height: 560 },
      { x: 510, y: 20, width: 470, height: 560 },
    ])
    expect(placeLeaves(model, { width: 1000, height: 600 }).map(entry => entry.rect.width)).toEqual([500, 500])
  })

  it('keeps the least pane size with the gap: a pane that the gap makes too small becomes a tab', () => {
    const area = { width: 1080, height: 900 }
    const threeColumns = buildPreset('side-by-side', MAIN, [A, B])
    expect(fitsMinimums(threeColumns, limits, area)).toBe(true)
    expect(fitsMinimums(threeColumns, { ...limits, paneGap: 16 }, area)).toBe(false)
    expect(paneCount(fitToMinimums(threeColumns, { ...limits, paneGap: 16 }, area))).toBe(3)
    expect(placeLeaves(fitToMinimums(threeColumns, { ...limits, paneGap: 16 }, area), area, 16)).toHaveLength(2)
  })
})
