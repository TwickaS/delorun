// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKSPACE_ICON, ICON_COLORS, ICON_GLYPHS, ICON_KINDS, ICON_SHAPES, ICON_STYLES, isCustomColor, MAX_ICON_SEED, parseWorkspaceIcon,
  patternCells, randomIcon, readWorkspaceIcons,
} from '../src/workspace-icon.ts'

describe('a Workspace icon', () => {
  it('fills a stored icon with the defaults and keeps a valid hex colour', () => {
    expect(parseWorkspaceIcon({ kind: 'glyph', glyph: 'tree', color: '#A1B2C3' }))
      .toEqual({ ...DEFAULT_WORKSPACE_ICON, kind: 'glyph', glyph: 'tree', color: '#A1B2C3' })
  })

  it('refuses anything that is not a whole valid icon', () => {
    for (const wrong of [
      undefined, null, 'folder', 7, [], {}, { kind: 'sticker' }, { kind: 'glyph', glyph: 'rocket' }, { kind: 'letters', letters: 'ABCD' },
      { kind: 'emoji', emoji: 'x'.repeat(17) }, { kind: 'pattern', seed: 0 }, { kind: 'pattern', seed: MAX_ICON_SEED + 1 },
      { kind: 'letters', color: 'chartreuse' }, { kind: 'letters', color: '#12345' }, { kind: 'letters', shape: 'star' }, { kind: 'letters', style: 'neon' },
    ]) expect(parseWorkspaceIcon(wrong)).toBeUndefined()
  })

  it('keeps the valid icons of a stored setting and leaves a malformed one out, so its Workspace shows the monogram', () => {
    const icons = readWorkspaceIcons({ good: { kind: 'letters', letters: 'ab' }, 'old-glyph': { kind: 'glyph', glyph: 'rocket' }, junk: 4 })
    expect(Object.keys(icons)).toEqual(['good'])
    expect(icons.good?.letters).toBe('ab')
    expect(readWorkspaceIcons({})).toEqual({})
  })

  it('tells a custom colour from a named one', () => {
    expect([isCustomColor('#00ff7F'), isCustomColor('blue'), isCustomColor('#abc')]).toEqual([true, false, false])
  })

  it('offers 36 glyphs, each named once', () => {
    expect(ICON_GLYPHS).toHaveLength(36)
    expect(new Set(ICON_GLYPHS).size).toBe(ICON_GLYPHS.length)
  })

  it('draws a random icon from the choices, never the Workspace colour', () => {
    const first = randomIcon(() => 0, ['🚀', '✨'])
    expect(first).toMatchObject({ kind: ICON_KINDS[0], glyph: ICON_GLYPHS[0], emoji: '🚀', shape: ICON_SHAPES[0], style: ICON_STYLES[0], color: 'blue', seed: 1 })
    const last = randomIcon(() => 0.9999999, ['🚀', '✨'])
    expect(last).toMatchObject({ kind: ICON_KINDS.at(-1), glyph: ICON_GLYPHS.at(-1), emoji: '✨', shape: ICON_SHAPES.at(-1), style: ICON_STYLES.at(-1), color: ICON_COLORS.at(-1) })
    expect(last.seed).toBeLessThanOrEqual(MAX_ICON_SEED)
  })

  it('draws a pattern that is the same for a seed, mirrored left to right, inside the 5 by 5 grid, and never empty', () => {
    for (const seed of [1, 2, 3, 99, 12_345, MAX_ICON_SEED]) {
      const cells = patternCells(seed)
      expect(patternCells(seed)).toEqual(cells)
      expect(cells.length).toBeGreaterThan(0)
      const filled = new Set(cells.map(([row, column]) => `${String(row)}:${String(column)}`))
      for (const [row, column] of cells) {
        expect(row >= 0 && row < 5 && column >= 0 && column < 5).toBe(true)
        expect(filled.has(`${String(row)}:${String(4 - column)}`)).toBe(true)
      }
    }
    expect(patternCells(1)).not.toEqual(patternCells(2))
  })

  it('puts one centre cell in a seed that would draw none', () => {
    expect(patternCells(10_134)).toEqual([[2, 2]])
  })
})
