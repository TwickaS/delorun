import { describe, expect, it } from 'vitest'
import { PALETTES } from '../src/config.ts'
import { parseT3Constants, parseT3Themes } from '../src/palette/t3-source.ts'
import { t3Palette, T3_THEME_IDS } from '../src/palette/t3.ts'
import { T3_THEMES } from '../src/palette/t3-themes.ts'

/** A file in the form T3 Code's `themePalettes.ts` has: colour constants and theme definitions that name or hold them. */
const SOURCE = `
import type { ThemeColors, ThemeDefinition } from "./types"
export const T3_CODE_LIGHT_THEME_COLORS: ThemeColors = {
  // Lines that are not a colour are skipped.
  canvas: "#ffffff",
  text: "#111111",
}
export const T3_CODE_DARK_THEME_COLORS: ThemeColors = {
  canvas: "#000000",
  text: "#eeeeee",
}
export const MINT_DARK: ThemeColors = {
  canvas: "oklch(0.2 0.02 160)",
}
export const MINT_THEME: ThemeDefinition = {
  id: "mint",
  label: "Mint",
  appearance: "light",
  colors: {
    canvas: "oklch(0.97 0.005 160)",
  },
  variants: {
    dark: MINT_DARK,
  },
}
export const NIGHT_THEME: ThemeDefinition = {
  id: "night",
  label: "Night",
  appearance: "dark",
  colors: MINT_DARK,
  variants: {
    light: {
      canvas: "#fafafa",
    },
  },
}
`

describe('T3 Code\'s theme source', () => {
  it('reads each constant as nested records, naming a constant a theme refers to', () => {
    const constants = parseT3Constants(SOURCE)
    expect([...constants.keys()]).toEqual(['T3_CODE_LIGHT_THEME_COLORS', 'T3_CODE_DARK_THEME_COLORS', 'MINT_DARK', 'MINT_THEME', 'NIGHT_THEME'])
    expect(constants.get('NIGHT_THEME')).toMatchObject({ id: 'night', colors: '@MINT_DARK', variants: { light: { canvas: '#fafafa' } } })
  })

  it('reads the default theme and every built-in theme in both schemes, whichever scheme the theme is written in', () => {
    expect(parseT3Themes(SOURCE)).toEqual({
      't3-code': { label: 'T3 Code', light: { canvas: '#ffffff', text: '#111111' }, dark: { canvas: '#000000', text: '#eeeeee' } },
      'mint': { label: 'Mint', light: { canvas: 'oklch(0.97 0.005 160)' }, dark: { canvas: 'oklch(0.2 0.02 160)' } },
      'night': { label: 'Night', light: { canvas: '#fafafa' }, dark: { canvas: 'oklch(0.2 0.02 160)' } },
    })
  })

  it('refuses a theme without an id, label or appearance, a scheme without colours, and a colour that is not a string', () => {
    const theme = (body: string): string => `${SOURCE}\nexport const ODD_THEME: ThemeDefinition = {\n${body}\n}\n`
    expect(() => parseT3Themes(theme('  label: "Odd",\n  appearance: "light",'))).toThrow('ODD_THEME lacks an id, label or appearance')
    expect(() => parseT3Themes(theme('  id: "odd",\n  label: "Odd",\n  appearance: "sepia",'))).toThrow('ODD_THEME lacks an id, label or appearance')
    expect(() => parseT3Themes(theme('  id: "odd",\n  label: "Odd",\n  appearance: "light",\n  colors: {\n    canvas: "#fff",\n  },'))).toThrow('ODD_THEME.variants.dark has no colours')
    expect(() => parseT3Themes(theme('  id: "odd",\n  label: "Odd",\n  appearance: "light",\n  colors: "plain",\n  variants: {\n    dark: MINT_DARK,\n  },'))).toThrow('ODD_THEME.colors has no colours')
    expect(() => parseT3Themes(theme('  id: "odd",\n  label: "Odd",\n  appearance: "light",\n  colors: {\n    nested: {\n      deep: "#fff",\n    },\n  },\n  variants: {\n    dark: MINT_DARK,\n  },'))).toThrow('ODD_THEME.colors.nested is not a colour')
    expect(() => parseT3Themes('export const NOTHING: ThemeColors = {\n}\n')).toThrow('T3_CODE_LIGHT_THEME_COLORS has no colours')
  })
})

describe('T3 Code\'s themes as shipped', () => {
  it('are the six the Appearance section offers after Soft, each in both schemes with the roles the palettes read', () => {
    expect(Object.keys(T3_THEMES)).toEqual(PALETTES.slice(1))
    for (const theme of Object.values(T3_THEMES)) {
      for (const scheme of [theme.light, theme.dark]) {
        expect(Object.keys(scheme)).toEqual(expect.arrayContaining(['canvas', 'sidebar', 'accent', 'textMuted']))
      }
    }
  })

  it('give each palette the accent, page and sidebar lightness that its theme carries', () => {
    expect(T3_THEME_IDS).toEqual(PALETTES.slice(1))
    const grove = t3Palette('grove')
    expect(grove.accent.fill).toEqual({ light: 0.523295, dark: 0.796228 })
    expect(grove.palette.lightSurfaces).toEqual({ '--dsw-alias-bg-base': 0.972369, '--dsw-specific-sidebar-fill': 0.936464 })
    expect(grove.palette.neutral).toEqual({ hue: 163.554, chroma: 0.014601 })
  })

  it('read T3 Code\'s own theme, written in hex, with the tint of its quiet text because its sidebar is flat grey', () => {
    const own = t3Palette('t3-code')
    expect(own.palette.neutral.chroma).toBeGreaterThan(0.01)
    expect(own.accent.hue).toBeCloseTo(264, 0)
  })
})
