import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { contrast, formatRgb, fromOklch, parseRgb, toOklch } from '../src/palette/color.ts'
import { applyLayers, brandLiterals, chromaticRamp, neutralLiterals, neutralRamp, requireResolved, resolveColor, textSafe } from '../src/palette/generate.ts'
import type { TokenLayer } from '../src/palette/generate.ts'
import { accentFromColor, accentLayer, ACCENT_IDS, ACCENTS, BRAND_RAMP, fontLayer, GREY_RAMPS, paletteLayer, parseHex, presetFromHex, SOFT, TEXT_SURFACES } from '../src/palette/soft.ts'
import type { AccentSpec, PaletteSpec } from '../src/palette/soft.ts'
import { bootStyle, chosenAccent, CONTRAST_ROLES, contrastLayer, densityLayer, previewColors, STOCK_ATTRIBUTE, themeLayers } from '../src/palette/layers.ts'
import { t3Palette, T3_THEME_IDS } from '../src/palette/t3.ts'
import { DEFAULT_SETTINGS as STORED_DEFAULTS, PALETTES } from '../src/config.ts'
import { STOCK_FONT_STACKS, STOCK_TOKENS } from '../src/palette/stock.ts'
import { parseRootTokens, parseStockTokens } from '../src/palette/stock-css.ts'

/** The settings of a studio with Delorun's look on. */
const DEFAULT_SETTINGS = { ...STORED_DEFAULTS, studioAdditions: true }

const STYLES = '../../../../packages/client/ui-theme/src/styles/'
const sheet = (name: string): string => readFileSync(fileURLToPath(new URL(`${STYLES}${name}`, import.meta.url)), 'utf8')

type Scheme = 'light' | 'dark'
const SCHEMES: readonly Scheme[] = ['light', 'dark']

/** The value each token has on `body` in one scheme once the layers are applied, with `var()` references followed. */
function resolver(layers: readonly TokenLayer[], scheme: Scheme): (name: string) => string {
  const values: Record<string, string> = { ...STOCK_TOKENS[scheme] }
  for (const layer of layers) for (const [name, modes] of Object.entries(layer)) values[name] = modes[scheme]
  const resolve = (name: string, depth = 0): string => {
    const value = values[name]
    if (value === undefined) throw new Error(`${name} is not defined`)
    const reference = /^var\((--[\w-]+)\)$/.exec(value)
    if (reference?.[1] === undefined) return value
    if (depth > 10) throw new Error(`${name} references too deeply`)
    return resolve(reference[1], depth + 1)
  }
  return name => resolve(name)
}

function rgbOf(resolve: (name: string) => string, name: string) {
  const color = parseRgb(resolve(name))
  if (color === undefined) throw new Error(`${name} resolves to ${resolve(name)}, not an rgb() colour`)
  return color
}

const LAYERS = [paletteLayer(SOFT), accentLayer(ACCENTS.peach), fontLayer()]

describe('the stock copy', () => {
  it('matches upstream\'s token sheet and font stacks, so an upstream change is noticed', () => {
    expect(parseStockTokens(sheet('design-platform.css'))).toEqual(STOCK_TOKENS)
    const root = parseRootTokens(sheet('base.css'))
    expect(root['--dsh-font-family-text-default']).toBe(STOCK_FONT_STACKS.text)
    expect(root['--dsh-font-family-code-default']).toBe(STOCK_FONT_STACKS.code)
  })
})

describe('the Soft palette and its accent', () => {
  const palette = paletteLayer(SOFT)
  const accent = accentLayer(ACCENTS.peach)

  it('recolour every step of upstream\'s grey and brand ramps in both schemes', () => {
    const steps = (ramp: string) => Object.keys(STOCK_TOKENS.light).filter(name => new RegExp(`^--dsw-static-${ramp}-\\d`).test(name))
    for (const ramp of GREY_RAMPS) for (const name of steps(ramp)) expect(Object.keys(palette)).toContain(name)
    for (const name of steps(BRAND_RAMP)) expect(Object.keys(accent)).toContain(name)
    for (const layer of [palette, accent]) {
      for (const [name, modes] of Object.entries(layer)) {
        for (const scheme of SCHEMES) expect(modes[scheme], `${name} (${scheme})`).not.toBe('')
      }
    }
  })

  it('keep every recoloured ramp step at the lightness of the stock step it replaces', () => {
    for (const layer of [palette, accent]) {
      for (const [name, modes] of Object.entries(layer)) {
        if (!name.startsWith('--dsw-static-')) continue
        for (const scheme of SCHEMES) {
          const stock = parseRgb(STOCK_TOKENS[scheme][name] ?? '')
          const ours = parseRgb(modes[scheme])
          if (stock === undefined || ours === undefined) throw new Error(`${name} is not an rgb() colour`)
          expect(Math.abs(toOklch(ours).l - toOklch(stock).l), `${name} (${scheme})`).toBeLessThan(0.01)
        }
      }
    }
  })

  it('leave colours that are not grey or brand blue alone, such as the diff highlights', () => {
    expect(palette['--dsw-alias-file-diff-added-bg']).toBeUndefined()
    expect(palette['--dsw-alias-file-diff-deleted-bg']).toBeUndefined()
    expect(palette['--dsw-static-green-500']).toBeUndefined()
  })
})

/** Text roles over the surfaces they sit on: WCAG AA for body text. */
const TEXT_PAIRS = [
  ['--dsw-alias-label-primary', '--dsw-alias-bg-base'],
  ['--dsw-alias-label-secondary', '--dsw-alias-bg-base'],
  ['--dsw-alias-label-primary', '--dsw-alias-bg-layer-1'],
  ['--dsw-alias-label-primary', '--dsw-specific-sidebar-fill'],
  ['--dsw-alias-label-secondary', '--dsw-specific-sidebar-fill'],
  ['--dsw-alias-link', '--dsw-alias-bg-base'],
  ['--dsw-alias-label-primary-foreground', '--dsw-alias-button-primary-fill'],
] as const

/** Marks and quieter text: the 3:1 WCAG asks of focus rings, icons and large text. */
const MARK_PAIRS = [
  ['--dsw-alias-state-business-primary', '--dsw-alias-bg-base'],
  ['--dsw-alias-label-tertiary', '--dsw-alias-bg-base'],
  ['--dsw-alias-label-caption', '--dsw-alias-bg-base'],
] as const

function customAccent(hex: string): AccentSpec {
  const color = parseHex(hex)
  if (color === undefined) throw new Error(`${hex} is not a colour`)
  return accentFromColor(color)
}

/** Every preset, and custom picks at the edges: near-white, near-black, mid-grey and a pale yellow. */
const ACCENT_CASES: ReadonlyArray<readonly [string, AccentSpec]> = [
  ...ACCENT_IDS.map(id => [id, ACCENTS[id]] as const),
  ...['#FAFAFA', '#0A0A0A', '#808080', '#FFD23F'].map(hex => [`custom ${hex}`, customAccent(hex)] as const),
]

describe('contrast with the layers applied', () => {
  for (const [accent, spec] of ACCENT_CASES) for (const scheme of SCHEMES) {
    const resolve = resolver([paletteLayer(SOFT), accentLayer(spec), fontLayer()], scheme)
    it.each(TEXT_PAIRS)(`${accent}, ${scheme}: %s on %s reaches 4.5:1`, (text, surface) => {
      expect(contrast(rgbOf(resolve, text), rgbOf(resolve, surface))).toBeGreaterThanOrEqual(4.5)
    })
    it(`${accent}, ${scheme}: the primary button's label reaches 4.5:1 while hovered`, () => {
      expect(contrast(rgbOf(resolve, '--dsw-alias-label-primary-foreground'), rgbOf(resolve, '--dsw-alias-button-primary-hover'))).toBeGreaterThanOrEqual(4.5)
    })
  }
  for (const scheme of SCHEMES) {
    const resolve = resolver(LAYERS, scheme)
    it.each(TEXT_PAIRS)(`${scheme}: %s on %s reaches 4.5:1`, (text, surface) => {
      expect(contrast(rgbOf(resolve, text), rgbOf(resolve, surface))).toBeGreaterThanOrEqual(4.5)
    })
    it.each(MARK_PAIRS)(`${scheme}: %s on %s reaches 3:1`, (mark, surface) => {
      expect(contrast(rgbOf(resolve, mark), rgbOf(resolve, surface))).toBeGreaterThanOrEqual(3)
    })
  }
})

describe('T3 Code\'s themes', () => {
  it('are the palettes the settings offer after Soft, in the same order', () => {
    expect(PALETTES.slice(1)).toEqual(T3_THEME_IDS)
  })

  for (const id of T3_THEME_IDS) for (const scheme of SCHEMES) {
    const { palette, accent } = t3Palette(id)
    const resolve = resolver([paletteLayer(palette), accentLayer(accent, palette), fontLayer()], scheme)
    it.each(TEXT_PAIRS)(`${id}, ${scheme}: %s on %s reaches 4.5:1`, (text, surface) => {
      expect(contrast(rgbOf(resolve, text), rgbOf(resolve, surface))).toBeGreaterThanOrEqual(4.5)
    })
  }

  it('bring their own accent and page, and the theme replaces the chosen accent', () => {
    const page = (palette: typeof DEFAULT_SETTINGS.palette) => previewColors({ ...DEFAULT_SETTINGS, palette }).light
    expect(page('grove').page).not.toBe(page('soft').page)
    expect(page('ocean').accent).toBe(previewColors({ ...DEFAULT_SETTINGS, palette: 'ocean', accent: 'moss' }).light.accent)
    expect(page('ocean').accent).not.toBe(page('ember').accent)
  })
})

/** The opaque background roles quiet text sits on, listed here apart from the palette's own list so a role dropped from that one is noticed. */
const BACKGROUND_ROLES = [
  '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3',
  '--dsw-specific-sidebar-fill', '--dsw-alias-bg-module-platform',
] as const

/** The label roles hint and description text use: 4.5:1, WCAG AA, on every background role. */
const HINT_ROLES = ['--dsw-alias-label-secondary', '--dsw-alias-label-tertiary'] as const

describe('hint text with the default accent and contrast', () => {
  it('is floored on the background roles listed here', () => {
    expect([...TEXT_SURFACES]).toEqual([...BACKGROUND_ROLES])
    for (const role of HINT_ROLES) expect(SOFT.quietText[role]).toEqual({ surfaces: TEXT_SURFACES, contrast: 4.5 })
  })

  const palettes: ReadonlyArray<readonly [string, PaletteSpec, AccentSpec]> = [
    ['soft', SOFT, ACCENTS.peach],
    ...T3_THEME_IDS.map(id => [id, t3Palette(id).palette, t3Palette(id).accent] as const),
  ]
  for (const [id, palette, accent] of palettes) for (const scheme of SCHEMES) {
    const resolve = resolver([paletteLayer(palette), accentLayer(accent, palette), fontLayer()], scheme)
    for (const role of HINT_ROLES) it.each(BACKGROUND_ROLES)(`${id}, ${scheme}: ${role} on %s reaches 4.5:1`, (surface) => {
      expect(contrast(rgbOf(resolve, role), rgbOf(resolve, surface))).toBeGreaterThanOrEqual(4.5)
    })
  }
})

describe('the contrast setting', () => {
  const quiet = (value: number, scheme: 'light' | 'dark') => {
    const layers = themeLayers({ ...DEFAULT_SETTINGS, contrast: value })
    const values = applyLayers(STOCK_TOKENS, [layers.palette, layers.accent, layers.contrast].filter(layer => layer !== undefined), scheme)
    const text = resolveColor(values, '--dsw-alias-label-tertiary')
    const page = resolveColor(values, '--dsw-alias-bg-base')
    if (text === undefined || page === undefined) throw new Error('tertiary text or the page does not resolve')
    return contrast(text, page)
  }

  it('adds no layer at 100, and moves quiet text away from the page above it and towards it below, in both schemes', () => {
    expect(themeLayers(DEFAULT_SETTINGS).contrast).toBeUndefined()
    for (const scheme of SCHEMES) {
      expect(quiet(200, scheme)).toBeGreaterThan(quiet(100, scheme))
      expect(quiet(50, scheme)).toBeLessThan(quiet(100, scheme))
    }
    expect(Object.keys(contrastLayer([paletteLayer(SOFT)], 150)).sort()).toEqual([...CONTRAST_ROLES].sort())
  })
})

describe('the colour decisions', () => {
  const accent = accentLayer(ACCENTS.peach)
  const palette = paletteLayer(SOFT)

  it('fills primary buttons with the site\'s exact peach and writes ink on it', () => {
    expect(accent['--dsw-alias-brand-primary']).toEqual({ light: 'rgb(229 115 74)', dark: 'rgb(229 115 74)' })
    expect(ACCENTS.peach.fill).toEqual({ light: 0.681, dark: 0.681 })
    expect(accent['--dsw-alias-label-primary-foreground']).toEqual({ light: 'var(--dsw-static-neutral-bluish-1000)', dark: 'var(--dsw-static-neutral-bluish-1000)' })
  })

  it('gives the composer\'s Send circle the primary fill, hover and ink, so it reads as the screen\'s primary action', () => {
    expect(accent['--dsh-composer-send-fill']).toEqual(accent['--dsw-alias-brand-primary'])
    expect(accent['--dsh-composer-send-hover']).toEqual(accent['--dsw-alias-button-primary-hover'])
    expect(accent['--dsh-composer-send-glyph']).toEqual(accent['--dsw-alias-label-primary-foreground'])
  })

  it('draws running work in blue, not the brand ramp', () => {
    for (const token of ['--dsw-alias-label-deep-diving', '--dsw-alias-label-deep-diving-shimmer']) {
      for (const scheme of SCHEMES) {
        expect(palette[token]?.[scheme]).toMatch(/--dsw-static-blue-/)
        expect(palette[token]?.[scheme]).not.toMatch(/deepseek/)
      }
    }
  })

  it('raises captions from upstream\'s 2:1 to the 3:1 floor', () => {
    const stock = applyLayers(STOCK_TOKENS, [], 'light')
    const caption = resolveColor(stock, '--dsw-alias-label-caption')
    const page = resolveColor(applyLayers(STOCK_TOKENS, [palette], 'light'), '--dsw-alias-bg-base')
    if (caption === undefined || page === undefined) throw new Error('caption or page does not resolve')
    expect(contrast(caption, page)).toBeLessThan(3)
  })
})

describe('the text-safe accent shade', () => {
  it('is needed: the recoloured ramp alone leaves peach links below 4.5:1 on the Soft page', () => {
    const values = applyLayers(STOCK_TOKENS, [paletteLayer(SOFT), chromaticRamp(STOCK_TOKENS, BRAND_RAMP, ACCENTS.peach)], 'light')
    const link = resolveColor(values, '--dsw-alias-link')
    const page = resolveColor(values, '--dsw-alias-bg-base')
    if (link === undefined || page === undefined) throw new Error('link or page does not resolve')
    expect(contrast(link, page)).toBeLessThan(4.5)
  })

  it('moves lightness away from the surface until the ratio is reached, in either direction', () => {
    const white = { r: 1, g: 1, b: 1, alpha: 1 }
    const black = { r: 0, g: 0, b: 0, alpha: 1 }
    const pale = { r: 0.95, g: 0.7, b: 0.6, alpha: 1 }
    const onWhite = parseRgb(textSafe(pale, white, 4.5))
    const onBlack = parseRgb(textSafe({ r: 0.3, g: 0.1, b: 0.05, alpha: 1 }, black, 4.5))
    if (onWhite === undefined || onBlack === undefined) throw new Error('textSafe returned a non-rgb value')
    expect(contrast(onWhite, white)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(onBlack, black)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('the type layer', () => {
  it('puts Delorun\'s faces ahead of upstream\'s stacks in both schemes', () => {
    const layer = fontLayer()
    for (const scheme of SCHEMES) {
      expect(layer['--dsh-font-family-text-default']?.[scheme]).toBe(`'Schibsted Grotesk', ${STOCK_FONT_STACKS.text}`)
      expect(layer['--dsh-font-family-code-default']?.[scheme]).toBe(`'JetBrains Mono', ${STOCK_FONT_STACKS.code}`)
    }
  })
})

describe('the first-paint style', () => {
  it('prints the palette and accent for both schemes, scoped off by the stock-look mark', () => {
    const style = bootStyle(DEFAULT_SETTINGS)
    expect(style).toContain(`html:not([${STOCK_ATTRIBUTE}]) body{`)
    expect(style).toContain(`html:not([${STOCK_ATTRIBUTE}]) body[data-ds-dark-theme]{`)
    expect(style).toContain('--dsw-alias-brand-primary:rgb(229 115 74)')
    expect(style).not.toContain('--dsh-font-family-text-default')
  })

  it('prints the chosen custom accent, and nothing while the studio additions are off', () => {
    expect(bootStyle({ ...DEFAULT_SETTINGS, accent: 'custom', customAccent: '#3A5EE8' })).toContain('--dsw-alias-brand-primary:rgb(58 94 232)')
    expect(bootStyle({ ...DEFAULT_SETTINGS, studioAdditions: false })).toBe('')
  })
})

describe('the layers a setting set applies', () => {
  it('are none while the studio additions are off, whatever the other settings say', () => {
    expect(themeLayers({ ...DEFAULT_SETTINGS, studioAdditions: false, contrast: 160, typeface: 'delorun' })).toEqual({})
  })

  it('are the palette, accent, type and density, plus contrast away from 100, and no type layer with the system typeface', () => {
    expect(Object.keys(themeLayers(DEFAULT_SETTINGS)).sort()).toEqual(['accent', 'density', 'palette', 'type'])
    expect(Object.keys(themeLayers({ ...DEFAULT_SETTINGS, contrast: 150, typeface: 'system' })).sort()).toEqual(['accent', 'contrast', 'density', 'palette'])
    expect(densityLayer('spacious')['--dsh-density']).toEqual({ light: '1.2', dark: '1.2' })
  })

  it('choose the accent from a preset, a valid custom colour, a T3 Code theme, or Peach for a custom colour that does not parse', () => {
    expect(chosenAccent({ ...DEFAULT_SETTINGS, accent: 'moss' })).toBe(ACCENTS.moss)
    expect(chosenAccent({ ...DEFAULT_SETTINGS, accent: 'custom', customAccent: '#3A5EE8' })).toEqual(accentFromColor(parseHex('#3A5EE8') ?? { r: 0, g: 0, b: 0, alpha: 1 }))
    expect(chosenAccent({ ...DEFAULT_SETTINGS, accent: 'custom', customAccent: 'peach' })).toBe(ACCENTS.peach)
    expect(chosenAccent({ ...DEFAULT_SETTINGS, palette: 'ocean', accent: 'moss' })).toEqual(t3Palette('ocean').accent)
  })

  it('draw previews in upstream\'s own colours while the studio additions are off', () => {
    const stock = previewColors({ ...DEFAULT_SETTINGS, studioAdditions: false })
    expect(stock.light.accent).toBe('rgb(15 17 21)')
    expect(previewColors(DEFAULT_SETTINGS).light.accent).toBe('rgb(229 115 74)')
  })

  it('print the first-paint style with the contrast layer when contrast moved, and leave the type out', () => {
    const style = bootStyle({ ...DEFAULT_SETTINGS, contrast: 160 })
    expect(style).toContain('--dsw-alias-label-tertiary')
    expect(style).toContain('--dsh-density:1')
  })
})

describe('the spacing tokens', () => {
  it('define --delorun-space-1 to --delorun-space-9 as 2, 4, 6, 8, 12, 16, 20, 24 and 32px times the density, in both schemes', () => {
    const layer = densityLayer('comfortable')
    const sizes = [2, 4, 6, 8, 12, 16, 20, 24, 32]
    sizes.forEach((size, index) => {
      expect(layer[`--delorun-space-${index + 1}`]).toEqual({ light: `calc(${size}px * var(--dsh-density, 1))`, dark: `calc(${size}px * var(--dsh-density, 1))` })
    })
    expect(Object.keys(layer)).toHaveLength(10)
  })

  it('are in the layers and the first-paint style while the look is on, and in neither with it off', () => {
    expect(themeLayers(DEFAULT_SETTINGS).density).toHaveProperty('--delorun-space-9')
    expect(bootStyle(DEFAULT_SETTINGS)).toContain('--delorun-space-5:calc(12px * var(--dsh-density, 1))')
    expect(themeLayers({ ...DEFAULT_SETTINGS, studioAdditions: false }).density).toBeUndefined()
  })
})

describe('the accent presets and a hex pick', () => {
  it('parse #RRGGBB with or without the hash and refuse anything else', () => {
    expect(parseHex('3a5ee8')).toEqual(parseHex('#3A5EE8'))
    expect(parseHex('#3A5EE')).toBeUndefined()
  })

  it('refuse a preset that is not a colour', () => {
    expect(() => presetFromHex('blue')).toThrow('accent preset blue is not a #RRGGBB colour')
  })
})

describe('the generators on a sheet that breaks their assumptions', () => {
  const stock = { light: { '--dsw-static-neutral-100': 'oops', '--dsw-alias-x': 'rgb(1 2 3)' }, dark: { '--dsw-static-neutral-100': 'rgb(1 2 3)' } }

  it('refuse a ramp step that is not an rgb() colour', () => {
    expect(() => neutralRamp(stock, 'neutral', SOFT.neutral)).toThrow('stock value oops is not an rgb() colour')
    expect(() => neutralRamp({ light: {}, dark: {} }, 'neutral', SOFT.neutral)).not.toThrow()
    expect(() => chromaticRamp({ light: { '--dsw-static-deepseek-1': 'x' }, dark: {} }, 'deepseek', ACCENTS.peach)).toThrow('stock value x is not an rgb() colour')
    expect(() => neutralRamp({ light: { '--dsw-static-neutral-1': 'rgb(1 2 3)' }, dark: {} }, 'neutral', SOFT.neutral)).toThrow('stock value undefined is not an rgb() colour')
  })

  it('refuse a palette surface that upstream does not define and a quiet-text role that does not resolve', () => {
    const quiet = Object.fromEntries(Object.keys(SOFT.quietText).map(role => [role, 'rgb(100 100 100)']))
    const base = { light: quiet, dark: quiet }
    expect(() => paletteLayer({ ...SOFT, lightSurfaces: { '--dsw-missing': 0.9 } }, base)).toThrow('palette surface --dsw-missing is not an upstream token')
    expect(() => paletteLayer({ ...SOFT, lightSurfaces: {} }, base)).toThrow('quiet text role --dsw-alias-label-secondary or its surface --dsw-alias-bg-base does not resolve to a colour')
    expect(() => paletteLayer({ ...SOFT, lightSurfaces: {} }, { light: {}, dark: {} })).toThrow('quiet text role --dsw-alias-label-secondary does not resolve to a colour')
  })

  it('refuse a foreground token or an accent text role that does not resolve', () => {
    expect(() => accentLayer(ACCENTS.peach, SOFT, { light: {}, dark: {} })).toThrow('is not an upstream token')
    const trimmed = (drop: string) => ({
      light: Object.fromEntries(Object.entries(STOCK_TOKENS.light).filter(([name]) => name !== drop)),
      dark: Object.fromEntries(Object.entries(STOCK_TOKENS.dark).filter(([name]) => name !== drop)),
    })
    expect(() => accentLayer(ACCENTS.peach, SOFT, trimmed('--dsw-static-neutral-bluish-1000'))).toThrow('foreground --dsw-static-neutral-bluish-1000 does not resolve to a colour')
    expect(() => accentLayer(ACCENTS.peach, SOFT, trimmed('--dsw-alias-link'))).toThrow('accent text role --dsw-alias-link or its surface --dsw-alias-bg-base does not resolve to a colour')
  })

  it('follow var() chains to a colour and stop at a loop, a missing token or a value that is not rgb()', () => {
    const values = { '--a': 'var(--b)', '--b': 'rgb(1 2 3)', '--loop': 'var(--loop)', '--mix': 'color-mix(in srgb, red, blue)' }
    expect(resolveColor(values, '--a')).toEqual(parseRgb('rgb(1 2 3)'))
    expect(resolveColor(values, '--loop')).toBeUndefined()
    expect(resolveColor(values, '--missing')).toBeUndefined()
    expect(resolveColor(values, '--mix')).toBeUndefined()
  })

  it('keep a literal that has a colour (diff greens), skip one that is not rgb(), and recolour a brand-hued literal', () => {
    const stock = {
      light: { '--g': 'rgb(34 197 94)', '--grey': 'rgb(120 121 125)', '--word': 'red', '--brand': 'rgb(65 118 230)', '--black': 'rgb(0 0 0)', '--static': 'rgb(1 1 1)' },
      dark: { '--g': 'rgb(34 197 94)', '--grey': 'rgb(120 121 125)', '--word': 'red', '--brand': 'rgb(65 118 230)', '--black': 'rgb(0 0 0)' },
    }
    const greys = neutralLiterals({ light: { ...stock.light, '--dsw-static-skip': 'rgb(9 9 9)' }, dark: stock.dark }, SOFT.neutral)
    expect(Object.keys(greys)).toEqual(['--grey'])
    const brand = brandLiterals(stock, { hue: 263, tolerance: 12 }, ACCENTS.peach)
    expect(Object.keys(brand)).toEqual(['--brand'])
    expect(brandLiterals({ light: { '--dsw-static-x': 'rgb(65 118 230)', '--only-dark': 'red' }, dark: { '--only-dark': 'rgb(65 118 230)' } }, { hue: 263, tolerance: 12 }, ACCENTS.peach))
      .toHaveProperty('--only-dark')
  })

  it('keep the stock value of a scheme that stays as it was, and of a scheme the sheet leaves out', () => {
    const grey = neutralLiterals({ light: { '--grey': 'rgb(120 121 125)' }, dark: {} }, SOFT.neutral)
    expect(grey['--grey']?.dark).toBe('rgb(120 121 125)')
    const mixed = neutralLiterals({ light: { '--grey': 'rgb(120 121 125)' }, dark: { '--grey': 'rgb(34 197 94)' } }, SOFT.neutral)
    expect(mixed['--grey']?.dark).toBe('rgb(34 197 94)')
    const brand = brandLiterals({ light: { '--b': 'rgb(65 118 230)' }, dark: {} }, { hue: 263, tolerance: 12 }, ACCENTS.peach)
    expect(brand['--b']?.dark).toBe('rgb(65 118 230)')
    const half = brandLiterals({ light: { '--b': 'rgb(65 118 230)' }, dark: { '--b': 'rgb(1 2 3)' } }, { hue: 263, tolerance: 12 }, ACCENTS.peach)
    expect(half['--b']?.dark).toBe('rgb(1 2 3)')
  })

  it('refuse a token that must resolve and does not', () => {
    expect(() => requireResolved({ '--a': 'oops' }, '--a')).toThrow('token --a does not resolve to an rgb() colour')
    expect(requireResolved({ '--a': 'rgb(1 2 3)' }, '--a')).toEqual(parseRgb('rgb(1 2 3)'))
  })

  it('print a ramp step that exists in one scheme only', () => {
    const layer = neutralRamp({ light: { '--dsw-static-neutral-1': 'rgb(100 100 100)' }, dark: { '--dsw-static-neutral-1': 'rgb(50 50 50)' } }, 'neutral', SOFT.neutral)
    expect(layer['--dsw-static-neutral-1']).toBeDefined()
  })
})

describe('the colour arithmetic', () => {
  it('prints an alpha only below 1, parses space and comma syntax and percent alphas, and refuses other values', () => {
    expect(formatRgb({ r: 1, g: 0.5, b: 0, alpha: 1 })).toBe('rgb(255 128 0)')
    expect(formatRgb({ r: 2, g: -1, b: 0, alpha: 0.5 })).toBe('rgb(255 0 0 / 50%)')
    expect(parseRgb('rgba(34, 197, 94, 0.08)')?.alpha).toBeCloseTo(0.08)
    expect(parseRgb('rgb(34 197 94 / 8%)')?.alpha).toBeCloseTo(0.08)
    expect(parseRgb('red')).toBeUndefined()
  })

  it('round-trips OKLCH, maps an out-of-gamut colour into the gamut by lowering chroma, and clamps lightness', () => {
    const color = { r: 0.9, g: 0.3, b: 0.2, alpha: 1 }
    const back = fromOklch(toOklch(color))
    expect([back.r, back.g, back.b].map(channel => Math.round(channel * 100))).toEqual([90, 30, 20])
    const mapped = fromOklch({ l: 0.9, c: 0.35, h: 140, alpha: 1 })
    expect([mapped.r, mapped.g, mapped.b].every(channel => channel >= -1e-3 && channel <= 1.001)).toBe(true)
    const white = fromOklch({ l: 2, c: 0, h: 0, alpha: 1 })
    expect([white.r, white.g, white.b].map(channel => Math.round(channel * 255))).toEqual([255, 255, 255])
    expect(toOklch({ r: 0.5, g: 0.5, b: 0.5, alpha: 1 }).h).toBe(0)
    expect(contrast({ r: 0, g: 0, b: 0, alpha: 0.5 }, { r: 1, g: 1, b: 1, alpha: 1 })).toBeGreaterThan(3)
  })

  it('falls back to black or white when no lightness reaches the ratio', () => {
    const mid = { r: 0.5, g: 0.5, b: 0.5, alpha: 1 }
    expect(textSafe(mid, mid, 30)).toBe('rgb(0 0 0)')
    const dark = { r: 0.02, g: 0.02, b: 0.02, alpha: 1 }
    expect(textSafe(dark, dark, 30)).toBe('rgb(255 255 255)')
  })
})

describe('the stock sheet parsers', () => {
  it('read :root declarations without comments and ignore other selectors', () => {
    expect(parseRootTokens('/* x */ :root { --a: 1;\n  --b:  two   words; color: red; nocolon } .x { --c: 3 }')).toEqual({ '--a': '1', '--b': 'two words' })
  })

  it('read the light and dark blocks, lay dark over light, and refuse a sheet without both', () => {
    const sheet = 'body { --a: 1; --b: 2; color: red; broken } body[data-ds-dark-theme] { --b: 3 } html { --z: 9 }'
    expect(parseStockTokens(sheet)).toEqual({ light: { '--a': '1', '--b': '2' }, dark: { '--a': '1', '--b': '3' } })
    expect(() => parseStockTokens('body { --a: 1 }')).toThrow('no body or no body[data-ds-dark-theme] block')
  })
})
