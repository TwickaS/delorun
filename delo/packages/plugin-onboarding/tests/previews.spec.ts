import { describe, expect, it } from 'vitest'
import { ACCENT_CHOICES, DEFAULT_SETTINGS, PALETTES } from '../../plugin-theme/src/config.ts'
import { previewColors } from '../../plugin-theme/src/palette/layers.ts'
import { ACCENT_PRESETS, ACCENT_PREVIEWS, PALETTE_CHOICES, PALETTE_PREVIEWS } from '../src/client/previews.ts'

const base = { ...DEFAULT_SETTINGS, studioAdditions: true }

describe('the look previews', () => {
  it('offer every palette the theme has, in its order', () => {
    expect([...PALETTE_CHOICES]).toEqual([...PALETTES])
    expect(Object.keys(PALETTE_PREVIEWS).toSorted()).toEqual([...PALETTES].toSorted())
  })

  it.each(PALETTES)('show the colours the theme gives the %s palette', (palette) => {
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
})
