/** The schema-free settings module: its key order and preset accents equal the schema's and the generator's, and the writes each change makes. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Config, DEFAULT_SETTINGS } from '../src/config.ts'
import { fromOklch } from '../src/palette/color.ts'
import { t3Palette } from '../src/palette/t3.ts'
import { CONTRAST, customSeed, lookOf, PRESET_ACCENT_HEX, PRESET_PALETTES, SETTING_KEYS, writesFor, type LookValues, type ThemeChange } from '../src/settings.ts'

const soft: LookValues = { palette: 'soft', accent: 'peach', customAccent: DEFAULT_SETTINGS.customAccent, contrast: CONTRAST.default }

/**
 * A T3 Code theme's accent as `#RRGGBB` in the light scheme, drawn by the palette generator.
 * @param id - the theme.
 * @returns the colour.
 */
function generatedAccent(id: keyof typeof PRESET_ACCENT_HEX): string {
  const accent = t3Palette(id).accent
  const rgb = fromOklch({ l: accent.fill.light, c: accent.chroma, h: accent.hue, alpha: 1 })
  const channel = (value: number): string => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0')
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`.toUpperCase()
}

describe('the schema-free settings module', () => {
  it('imports no schema library and nothing at run time', () => {
    const imports = readFileSync(new URL('../src/settings.ts', import.meta.url), 'utf8').match(/^import .*$/gm)
    expect(imports).toEqual(["import type { StoredBranding } from '@delorun/brand/branding'"])
  })

  it('lists the keys in the order of the schema\'s fields', () => {
    expect(SETTING_KEYS).toEqual(Object.keys(Config.dict ?? {}))
  })

  it('holds each T3 Code preset\'s accent as the generator draws it', () => {
    expect(Object.keys(PRESET_ACCENT_HEX)).toEqual(PRESET_PALETTES.filter(id => id !== 'soft'))
    for (const [id, hex] of Object.entries(PRESET_ACCENT_HEX)) expect(hex, id).toBe(generatedAccent(id as keyof typeof PRESET_ACCENT_HEX))
  })
})

describe('the keys a change writes', () => {
  it('writes only the palette for a preset chosen from a preset, and only the density for a density', () => {
    expect(writesFor({ kind: 'palette', palette: 'ocean' }, soft)).toEqual([{ op: 'set', path: ['palette'], value: 'ocean' }])
    expect(writesFor({ kind: 'density', density: 'spacious' }, soft)).toEqual([{ op: 'set', path: ['density'], value: 'spacious' }])
  })

  it('writes the whole custom theme, its palette last, seeded from the preset shown', () => {
    const fields = (writes: ReturnType<typeof writesFor>) => writes.map(write => [write.path[0], write.value])
    expect(fields(writesFor({ kind: 'palette', palette: 'custom' }, soft))).toEqual([['accent', 'peach'], ['customAccent', DEFAULT_SETTINGS.customAccent], ['contrast', 100], ['palette', 'custom']])
    const ocean = { ...soft, palette: 'ocean' } as const
    expect(customSeed(ocean)).toEqual({ accent: 'custom', customAccent: PRESET_ACCENT_HEX.ocean, contrast: 100 })
    expect(fields(writesFor({ kind: 'custom', values: { accent: 'moss' } }, ocean))).toEqual([['accent', 'moss'], ['customAccent', PRESET_ACCENT_HEX.ocean], ['contrast', 100], ['palette', 'custom']])
    const custom = { palette: 'custom', accent: 'moss', customAccent: '#12AB34', contrast: 130 } as const
    expect(fields(writesFor({ kind: 'custom', values: { contrast: 150 } }, custom))).toEqual([['accent', 'moss'], ['customAccent', '#12AB34'], ['contrast', 150], ['palette', 'custom']])
  })
})

describe('a preset after Custom', () => {
  /** Applies a change as the studio does: the writes for the settings read through `lookOf`, then stored. */
  const press = (stored: LookValues, change: ThemeChange): LookValues => ({ ...stored, ...Object.fromEntries(writesFor(change, lookOf(stored)).map(write => [write.path[0], write.value])) })

  it('resets the accent for Soft and the contrast for every preset, so the preset reads back', () => {
    const moss = { palette: 'custom', accent: 'moss', customAccent: '#12AB34', contrast: 125 } as const
    expect(writesFor({ kind: 'palette', palette: 'soft' }, moss).map(write => [write.path[0], write.value])).toEqual([['accent', 'peach'], ['contrast', 100], ['palette', 'soft']])
    expect(writesFor({ kind: 'palette', palette: 'ocean' }, moss).map(write => [write.path[0], write.value])).toEqual([['contrast', 100], ['palette', 'ocean']])
  })

  it('goes from Soft to Custom moss and back to Soft, and from Custom at 150 to Ocean', () => {
    const custom = press(soft, { kind: 'palette', palette: 'custom' })
    const moss = press(custom, { kind: 'custom', values: { accent: 'moss' } })
    expect(lookOf(moss)).toMatchObject({ palette: 'custom', accent: 'moss' })
    expect(lookOf(press(moss, { kind: 'palette', palette: 'soft' }))).toMatchObject({ palette: 'soft', accent: 'peach', contrast: 100 })
    const high = press(moss, { kind: 'custom', values: { contrast: 150 } })
    expect(lookOf(press(high, { kind: 'palette', palette: 'ocean' }))).toMatchObject({ palette: 'ocean', contrast: 100 })
  })
})
