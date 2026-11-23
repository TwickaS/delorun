import { describe, expect, it } from 'vitest'
import { buildPreset, layoutProblem, LAYOUT_IDS, panesOf, DEFAULT_PRESET, type LayoutPreset, type LegacyLayoutPreset } from '../../src/layout/index.ts'

/** Every preset, and the one saved before Auto existed. */
const PRESETS: readonly (LayoutPreset | LegacyLayoutPreset)[] = [...LAYOUT_IDS, 'main-column']
import { A, B, C, D, MAIN, pane, show, sizesSumTo100 } from './helpers.ts'

describe('layout presets', () => {
  it('defaults to Auto, and still reads the arrangement saved before it: the main chat left, the agents stacked right', () => {
    expect(DEFAULT_PRESET).toBe('auto')
    expect(show(buildPreset('main-column', MAIN, [A, B]))).toBe('H(main:56, V(a:50, b:50):44):100')
  })

  it('puts every pane in one equal row side by side', () => {
    expect(show(buildPreset('side-by-side', MAIN, [A, B]))).toBe('H(main:33.3, a:33.3, b:33.3):100')
  })

  it('stacks the main chat above a row of the others', () => {
    expect(show(buildPreset('main-top', MAIN, [A, B]))).toBe('V(main:56, H(a:50, b:50):44):100')
  })

  it('lays four panes out as a two by two grid with the main chat top left', () => {
    expect(show(buildPreset('grid', MAIN, [A, B, C]))).toBe('V(H(main:50, a:50):50, H(b:50, c:50):50):100')
  })

  it('lets the last grid row fill its width', () => {
    expect(show(buildPreset('grid', MAIN, [A, B]))).toBe('V(H(main:50, a:50):50, b:50):100')
    expect(show(buildPreset('grid', MAIN, [A, B, C, D]))).toBe('V(H(main:33.3, a:33.3, b:33.3):50, H(c:50, d:50):50):100')
  })

  it('shows the main chat alone when there are no agents, in every preset', () => {
    for (const preset of PRESETS) expect(show(buildPreset(preset, MAIN, []))).toBe('main:100')
  })

  it('keeps every pane exactly once with sizes summing to 100 in every preset and for one to six panes', () => {
    for (const preset of PRESETS) {
      for (let others = 0; others <= 5; others += 1) {
        const agents = Array.from({ length: others }, (_, index) => pane(`agent-${index}`))
        const model = buildPreset(preset, MAIN, agents)
        expect([...panesOf(model)].sort()).toEqual([MAIN, ...agents].sort())
        expect(layoutProblem(model)).toBeUndefined()
        expect(sizesSumTo100(model)).toBe(true)
      }
    }
  })
})
