import { describe, expect, it } from 'vitest'
import { ACCENT_CHOICES, DEFAULT_SETTINGS, PRESET_PALETTES } from '../../plugin-theme/src/config.ts'
import { previewColors } from '../../plugin-theme/src/palette/layers.ts'
import { customSeed, lookOf } from '../../plugin-theme/src/palette/migrate.ts'
import { ACCENT_PRESETS, ACCENT_PREVIEWS, customStart, lookView, PALETTE_CHOICES, PALETTE_PREVIEWS } from '../src/client/previews.ts'

const base = { ...DEFAULT_SETTINGS, studioAdditions: true }

describe('the look previews', () => {
  it('offer every palette the theme has, in its order', () => {
    expect([...PALETTE_CHOICES]).toEqual([...PRESET_PALETTES])
    expect(Object.keys(PALETTE_PREVIEWS).toSorted()).toEqual([...PRESET_PALETTES].toSorted())
  })

  it.each(PRESET_PALETTES)('show the colours the theme gives the %s palette', (palette) => {
    const colours = previewColors({ ...base, palette })
    for (const scheme of ['light', 'dark'] as const) {
      expect(PALETTE_PREVIEWS[palette][scheme]).toEqual({ page: colours[scheme].page, text: colours[scheme].text, accent: colours[scheme].accent })
    }
  })

  it('offer the theme\'s accent presets, and not its custom colour', () => {
    expect([...ACCENT_PRESETS]).toEqual(ACCENT_CHOICES.filter(choice => choice !== 'custom'))
  })

  it.each(ACCENT_PRESETS)('show the colour the theme gives the %s accent in each scheme', (accent) => {
    const colours = previewColors({ ...base, palette: 'soft', accent })
    expect(ACCENT_PREVIEWS[accent]).toEqual({ light: colours.light.accent, dark: colours.dark.accent })
  })

  it.each([
    { ...base },
    { ...base, accent: 'cobalt' as const },
    { ...base, contrast: 140 },
    { ...base, palette: 'ocean' as const },
    { ...base, palette: 'ocean' as const, accent: 'moss' as const, contrast: 70 },
    { ...base, palette: 'custom' as const, accent: 'mono' as const },
  ])('read stored settings as the custom or preset theme the way the theme does', (settings) => {
    const values = { palette: settings.palette, accent: settings.accent, customAccent: settings.customAccent, contrast: settings.contrast }
    const theirs = lookOf(settings)
    const mine = lookView(values)
    expect(mine.palette).toBe(theirs.palette)
    // The colour is the preset's own accent, drawn from this plugin's copy or the theme's palette; it may differ by rounding.
    const { customAccent: ours, ...rest } = customStart(mine)
    const { customAccent: theme, ...restTheme } = customSeed(theirs)
    expect(rest).toEqual(restTheme)
    expect(ours).toMatch(/^#[0-9A-F]{6}$/)
    expect(theme).toMatch(/^#[0-9A-F]{6}$/)
  })
})
