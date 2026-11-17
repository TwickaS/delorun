/** The Look model: presets fix their own accent, and settings stored before the split read as the custom theme they drew. */
import { describe, expect, it } from 'vitest'
import { CONTRAST, DEFAULT_SETTINGS, type ThemeSettings } from '../src/config.ts'
import { chosenAccent, previewColors, themeLayers } from '../src/palette/layers.ts'
import { customSeed, lookOf } from '../src/palette/migrate.ts'
import { ACCENTS } from '../src/palette/soft.ts'
import { t3Palette } from '../src/palette/t3.ts'

const on: ThemeSettings = { ...DEFAULT_SETTINGS, studioAdditions: true }

describe('reading stored settings as presets or the custom theme', () => {
  it('leaves a preset with its own accent and the default contrast as it is', () => {
    expect(lookOf(on)).toBe(on)
    const ocean = { ...on, palette: 'ocean' } as const
    expect(lookOf(ocean)).toBe(ocean)
  })

  it('turns Soft beside a changed accent or contrast into Custom, keeping the values', () => {
    expect(lookOf({ ...on, accent: 'cobalt' })).toEqual({ ...on, palette: 'custom', accent: 'cobalt' })
    expect(lookOf({ ...on, accent: 'custom', customAccent: '#12AB34' })).toMatchObject({ palette: 'custom', accent: 'custom', customAccent: '#12AB34' })
    expect(lookOf({ ...on, contrast: 140 })).toMatchObject({ palette: 'custom', accent: 'peach', contrast: 140 })
  })

  it('turns a T3 Code theme beside a changed contrast into Custom seeded with that theme\'s accent colour', () => {
    const read = lookOf({ ...on, palette: 'ocean', contrast: 60 })
    expect(read).toMatchObject({ palette: 'custom', accent: 'custom', contrast: 60 })
    expect(read.customAccent).toMatch(/^#[0-9A-F]{6}$/)
    expect(chosenAccent(read).hue).toBeCloseTo(t3Palette('ocean').accent.hue, 0)
  })

  it('ignores a stale accent under a T3 Code theme with the default contrast', () => {
    expect(lookOf({ ...on, palette: 'grove', accent: 'moss' }).palette).toBe('grove')
    expect(chosenAccent({ ...on, palette: 'grove', accent: 'moss' })).toEqual(t3Palette('grove').accent)
  })

  it('draws a preset in its own accent whatever accent is stored, and Custom in the stored one', () => {
    const soft = previewColors(on)
    expect(chosenAccent(on)).toBe(ACCENTS.peach)
    expect(previewColors({ ...on, palette: 'custom', accent: 'peach' })).toEqual(soft)
    expect(previewColors({ ...on, palette: 'custom', accent: 'moss' }).light.accent).not.toBe(soft.light.accent)
  })

  it('applies contrast only under Custom', () => {
    expect(themeLayers({ ...on, palette: 'custom', contrast: 150 }).contrast).toBeDefined()
    expect(themeLayers({ ...on, palette: 'ocean', contrast: CONTRAST.default }).contrast).toBeUndefined()
  })
})

describe('the values Custom starts from', () => {
  it('are Soft\'s Peach, a T3 Code theme\'s accent colour with the default contrast, or the custom values themselves', () => {
    expect(customSeed(on)).toEqual({ accent: 'peach', customAccent: on.customAccent, contrast: 100 })
    expect(customSeed({ ...on, palette: 'iris' })).toMatchObject({ accent: 'custom', contrast: 100, customAccent: expect.stringMatching(/^#[0-9A-F]{6}$/) })
    const custom = { ...on, palette: 'custom', accent: 'moss', contrast: 130 } as const
    expect(customSeed(custom)).toEqual({ accent: 'moss', customAccent: on.customAccent, contrast: 130 })
  })
})
