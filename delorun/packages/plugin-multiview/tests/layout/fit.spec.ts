import { describe, expect, it } from 'vitest'
import { buildPreset, fitLayout, moveOptions, panesOf } from '../../src/layout/index.ts'
import { A, B, C, D, MAIN, show } from './helpers.ts'

describe('fitting a layout to the room', () => {
  it('leaves a layout that fits as it is', () => {
    const model = buildPreset('main-column', MAIN, [A, B])
    expect(fitLayout(model, MAIN, 3)).toEqual({ model, hidden: [] })
  })

  it('leaves out the last panes in reading order and lists them as hidden', () => {
    const fitted = fitLayout(buildPreset('main-column', MAIN, [A, B, C, D]), MAIN, 3)
    expect(show(fitted.model)).toBe('H(main:56, V(a:50, b:50):44):100')
    expect(fitted.hidden).toEqual([C, D])
  })

  it('never leaves out the main chat, even when it is last in reading order', () => {
    const model = buildPreset('side-by-side', A, [B, C])
    const swapped = { ...model, root: model.root }
    const fitted = fitLayout(swapped, C, 2)
    expect(panesOf(fitted.model)).toContain(C)
    expect(panesOf(fitted.model)).toHaveLength(2)
  })

  it('keeps one pane when there is room for none', () => {
    expect(panesOf(fitLayout(buildPreset('grid', MAIN, [A, B]), MAIN, 0).model)).toEqual([MAIN])
  })
})

describe('Move to… options', () => {
  it('offers every side and the tabs of each other pane, then the four edges', () => {
    const options = moveOptions(buildPreset('main-column', MAIN, [A]), A)
    expect(options.map(option => JSON.stringify(option.target))).toEqual([
      ...['left', 'right', 'top', 'bottom', 'center'].map(region => JSON.stringify({ kind: 'pane', pane: MAIN, region })),
      ...['left', 'right', 'top', 'bottom'].map(edge => JSON.stringify({ kind: 'edge', edge })),
    ])
  })

  it('offers nothing for the only pane', () => {
    expect(moveOptions(buildPreset('main-column', MAIN, []), MAIN)).toEqual([])
  })
})
