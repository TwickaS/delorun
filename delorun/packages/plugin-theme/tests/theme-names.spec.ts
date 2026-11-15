/** The themes carry Delorun's own names, and a choice saved under the old ids keeps working. */
import { describe, expect, it } from 'vitest'
import { parseBootSettings } from '../src/boot-settings.ts'
import { ACCENT_CHOICES, DEFAULT_SETTINGS, PALETTES } from '../src/config.ts'
import { en, zh } from '../src/client/locales.ts'
import { bootStyle, themeLayers } from '../src/palette/layers.ts'

describe('theme names', () => {
  it('names every theme and accent in both languages without another product\'s name', () => {
    const names = [...PALETTES.map(id => `palette.${id}` as const), ...ACCENT_CHOICES.map(id => `accent.${id}` as const)]
    for (const key of names) {
      for (const dictionary of [en, zh] as Record<string, string>[]) {
        expect(dictionary[key], key).toBeTruthy()
        expect(dictionary[key]).not.toMatch(/t3|code|chat/i)
      }
    }
    expect(en['palette.lead']).not.toMatch(/T3/)
    expect(zh['palette.lead']).not.toMatch(/T3/)
    expect([en['palette.t3-code'], en['palette.t3-chat']]).toEqual(['Slate', 'Berry'])
  })

  it('keeps the stored ids, so a saved choice still validates and draws the same look', () => {
    expect(PALETTES).toContain('t3-code')
    expect(PALETTES).toContain('t3-chat')
    for (const palette of ['t3-code', 't3-chat'] as const) {
      const saved = { ...DEFAULT_SETTINGS, studioAdditions: true, palette }
      expect(parseBootSettings(saved)).toEqual(saved)
      expect(bootStyle(saved)).not.toBe(bootStyle({ ...saved, palette: 'soft' }))
      expect(themeLayers(saved).palette).toBeDefined()
    }
  })
})
