/**
 * Delo's palette and accents as data. Soft is the one shipped palette: warm
 * greys generated from a neutral seed over every upstream grey ramp, plus the
 * few surfaces that give it its character. An accent is a separate layer that
 * recolours upstream's brand ramp, so any accent works with the palette.
 * Changing a hue or chroma here regenerates both colour schemes.
 * @module @delo/plugin-theme/palette/soft
 */
import { applyLayers, brandLiterals, chromaticRamp, neutralAt, neutralLiterals, neutralRamp, resolveColor, textSafe, textSafeColor } from './generate.ts'
import type { SchemeValues, Seed, TokenLayer, TokenModes } from './generate.ts'
import { contrast, formatRgb, fromOklch, luminance, toOklch } from './color.ts'
import type { Rgb } from './color.ts'
import { STOCK_FONT_STACKS, STOCK_TOKENS } from './stock.ts'
import type { StockTokens } from './stock-css.ts'

/** A text role kept at a minimum contrast on a surface in both schemes. */
export interface QuietText {
  /** The surface the text sits on. */
  readonly surface: string
  /** The WCAG ratio the text reaches there. */
  readonly contrast: number
}

/** A palette: the neutral seed, the surfaces it sets apart from upstream's steps, its quiet-text floors and its state roles. */
export interface PaletteSpec {
  /** Hue and chroma every grey takes. */
  readonly neutral: Seed
  /** Role tokens set to a neutral at a given OKLCH lightness in the light scheme; the dark scheme keeps upstream's step for these roles. */
  readonly lightSurfaces: Readonly<Record<string, number>>
  /** Quiet text roles darkened or lightened just enough to reach a floor upstream's value misses. */
  readonly quietText: Readonly<Record<string, QuietText>>
  /** State roles the palette sets to fixed values, such as running work's own blue. */
  readonly states: TokenLayer
}

/** Soft: warm stone greys, an off-white page and a sidebar one step below it, captions at 3:1, and running work in its own blue. */
export const SOFT: PaletteSpec = {
  neutral: { hue: 85, chroma: 0.008 },
  lightSurfaces: {
    '--dsw-alias-bg-base': 0.993,
    '--dsw-specific-sidebar-fill': 0.968,
  },
  quietText: {
    '--dsw-alias-label-caption': { surface: '--dsw-alias-bg-base', contrast: 3 },
  },
  states: {
    '--dsw-alias-label-deep-diving': {
      light: 'color-mix(in srgb, var(--dsw-static-blue-500) 70%, var(--dsw-static-blue-950))',
      dark: 'color-mix(in srgb, var(--dsw-static-blue-450) 55%, var(--dsw-static-neutral-bluish-400))',
    },
    '--dsw-alias-label-deep-diving-shimmer': {
      light: 'color-mix(in srgb, var(--dsw-static-blue-500) 30%, var(--dsw-static-blue-950))',
      dark: 'color-mix(in srgb, var(--dsw-static-blue-300) 65%, var(--dsw-static-blue-400))',
    },
  },
}

/** An accent: its hue and chroma, and the OKLCH lightness of its solid fill (primary buttons, switched-on switches) in each scheme. */
export interface AccentSpec extends Seed {
  /** Lightness of the fill per scheme; the text on it is ink or white, whichever reads better. */
  readonly fill: { readonly light: number; readonly dark: number }
}

/**
 * Parse a `#RRGGBB` colour, the form a colour picker gives.
 * @param value - the text, with or without the leading `#`.
 * @returns the colour, or `undefined` when the text is not six hex digits.
 */
export function parseHex(value: string): Rgb | undefined {
  const digits = value.trim().replace(/^#/, '')
  if (!/^[0-9a-f]{6}$/i.test(digits)) return undefined
  const packed = Number.parseInt(digits, 16)
  return { r: (packed >> 16) / 255, g: ((packed >> 8) & 255) / 255, b: (packed & 255) / 255, alpha: 1 }
}

/**
 * Build an accent from one colour, as a person's custom pick: its hue, its
 * chroma, and its lightness as the fill in both schemes.
 * @param color - the colour.
 * @returns the accent.
 */
export function accentFromColor(color: Rgb): AccentSpec {
  const oklch = toOklch(color)
  return { hue: oklch.h, chroma: oklch.c, fill: { light: oklch.l, dark: oklch.l } }
}

/**
 * Build an accent preset from a `#RRGGBB` colour.
 * @param value - the colour.
 * @returns the accent.
 * @throws Error when the value is not six hex digits.
 */
export function presetFromHex(value: string): AccentSpec {
  const color = parseHex(value)
  if (color === undefined) throw new Error(`accent preset ${value} is not a #RRGGBB colour`)
  return accentFromColor(color)
}

/** The accents a person can pick from; Peach, the site's #E5734A, is the default, and Mono is near-black in light and near-white in dark. */
export const ACCENTS = {
  peach: { hue: 40, chroma: 0.152, fill: { light: 0.681, dark: 0.681 } },
  cobalt: presetFromHex('#3A5EE8'),
  moss: presetFromHex('#3F7A4F'),
  mono: { hue: 85, chroma: 0.004, fill: { light: 0.22, dark: 0.92 } },
} satisfies Readonly<Record<string, AccentSpec>>

/** An accent preset's id. */
export type AccentId = keyof typeof ACCENTS

/** The presets in the order Appearance lists them. */
export const ACCENT_IDS: readonly AccentId[] = ['peach', 'cobalt', 'moss', 'mono']

/** The accent applied when nothing else is chosen. */
export const DEFAULT_ACCENT: AccentId = 'peach'

/** Upstream's brand blue, which an accent replaces: its OKLCH hue and how far a literal may stray from it and still count. */
export const STOCK_BRAND_HUE = { hue: 263, tolerance: 12 } as const

/** Upstream's grey ramps, which the neutral seed recolours. */
export const GREY_RAMPS = ['neutral-bluish', 'neutral'] as const

/** Upstream's brand ramp, which the accent recolours. */
export const BRAND_RAMP = 'deepseek'

/**
 * The palette's override layer: every grey ramp step, every grey role literal,
 * the palette's own surfaces and state roles, and its quiet-text floors, in
 * both schemes.
 * @param spec - the palette.
 * @param stock - upstream's token values; defaults to the copy this package was built against.
 * @returns the layer for `ctx.theme.overrideTokens`.
 */
export function paletteLayer(spec: PaletteSpec, stock: StockTokens = STOCK_TOKENS): TokenLayer {
  const layer: Record<string, TokenModes> = {}
  for (const ramp of GREY_RAMPS) Object.assign(layer, neutralRamp(stock, ramp, spec.neutral))
  Object.assign(layer, neutralLiterals(stock, spec.neutral))
  for (const [name, lightness] of Object.entries(spec.lightSurfaces)) {
    const dark = stock.dark[name]
    if (dark === undefined) throw new Error(`palette surface ${name} is not an upstream token`)
    layer[name] = { light: neutralAt(spec.neutral, lightness), dark }
  }
  Object.assign(layer, spec.states)
  const light = applyLayers(stock, [layer], 'light')
  const dark = applyLayers(stock, [layer], 'dark')
  for (const [role, floor] of Object.entries(spec.quietText)) {
    layer[role] = { light: floored(light, role, floor), dark: floored(dark, role, floor) }
  }
  return layer
}

function floored(values: SchemeValues, role: string, floor: QuietText): string {
  const text = resolveColor(values, role)
  const surface = resolveColor(values, floor.surface)
  if (text === undefined || surface === undefined) throw new Error(`quiet text role ${role} or its surface ${floor.surface} does not resolve to a colour`)
  return textSafe(text, surface, floor.contrast)
}

/** Text and marks on the accent fill: the palette's near-black or white, whichever reads better on it, so the fill can be the exact accent. */
const FOREGROUNDS = ['--dsw-static-neutral-bluish-1000', '--dsw-static-neutral-bluish-00'] as const

/** How much darker, in OKLCH lightness, a primary button is while hovered. */
const PRESSED_STEP = 0.035

/** Accent-coloured text roles and the surface each must stay legible on: WCAG AA, 4.5:1. */
export const ACCENT_TEXT_ROLES = { '--dsw-alias-link': '--dsw-alias-bg-base' } as const

/** Contrast every accent-coloured text role reaches on its surface. */
export const TEXT_CONTRAST = 4.5

/** The accent fill in one scheme, its hovered step, and the foreground token drawn on both. */
interface Primary {
  readonly fill: string
  readonly pressed: string
  readonly foreground: string
}

function primaryOn(seed: AccentSpec, scheme: 'light' | 'dark', values: SchemeValues): Primary {
  const foregrounds = FOREGROUNDS.map(token => {
    const color = resolveColor(values, token)
    if (color === undefined) throw new Error(`foreground ${token} does not resolve to a colour`)
    return { token, color }
  })
  const base = fromOklch({ l: seed.fill[scheme], c: seed.chroma, h: seed.hue, alpha: 1 })
  const best = foregrounds.reduce((winner, each) => (contrast(each.color, base) > contrast(winner.color, base) ? each : winner))
  // Neither ink nor white reaches 4.5:1 on a mid-lightness pick; the fill moves away from the better one until it does.
  const fill = textSafeColor(base, best.color, TEXT_CONTRAST)
  const towards = luminance(best.color) > luminance(fill) ? -1 : 1
  const pressed = fromOklch({ ...toOklch(fill), l: toOklch(fill).l + towards * PRESSED_STEP })
  return { fill: formatRgb(fill), pressed: formatRgb(pressed), foreground: `var(${best.token})` }
}

/**
 * An accent's override layer: upstream's brand ramp and brand-blue literals
 * recoloured to the accent; the brand primary (primary buttons, switched-on
 * switches, checkboxes) as the accent's fill with ink or white on it, whichever
 * reads better, and a hover step that adds contrast, which the composer's
 * Send circle also takes; plus a text-safe shade for each accent text role,
 * darkened or lightened just enough to reach 4.5:1 on the palette's surface
 * in each scheme.
 * @param seed - the accent's hue and chroma.
 * @param palette - the palette the accent sits on; its surfaces decide the text-safe shades.
 * @param stock - upstream's token values; defaults to the copy this package was built against.
 * @returns the layer for `ctx.theme.overrideTokens`.
 */
export function accentLayer(seed: AccentSpec, palette: PaletteSpec = SOFT, stock: StockTokens = STOCK_TOKENS): TokenLayer {
  const layer: Record<string, TokenModes> = { ...chromaticRamp(stock, BRAND_RAMP, seed), ...brandLiterals(stock, STOCK_BRAND_HUE, seed) }
  const surfaces = paletteLayer(palette, stock)
  const primary = { light: primaryOn(seed, 'light', applyLayers(stock, [surfaces], 'light')), dark: primaryOn(seed, 'dark', applyLayers(stock, [surfaces], 'dark')) }
  layer['--dsw-alias-brand-primary'] = { light: primary.light.fill, dark: primary.dark.fill }
  layer['--dsw-alias-button-primary-hover'] = { light: primary.light.pressed, dark: primary.dark.pressed }
  layer['--dsw-alias-label-primary-foreground'] = { light: primary.light.foreground, dark: primary.dark.foreground }
  // The composer's Send circle is a primary action too: the brand fill with its readable ink, not upstream's info blue and white.
  layer['--dsh-composer-send-fill'] = layer['--dsw-alias-brand-primary']
  layer['--dsh-composer-send-hover'] = layer['--dsw-alias-button-primary-hover']
  layer['--dsh-composer-send-glyph'] = layer['--dsw-alias-label-primary-foreground']
  // The sidebar's open chat: a faint accent tint and a 2px accent bar on its leading edge.
  layer['--dsh-sidebar-row-selected-fill'] = {
    light: `color-mix(in srgb, ${primary.light.fill} 12%, transparent)`, dark: `color-mix(in srgb, ${primary.dark.fill} 16%, transparent)`,
  }
  layer['--dsh-sidebar-row-selected-edge'] = { light: '2px', dark: '2px' }
  layer['--dsh-sidebar-row-selected-edge-color'] = layer['--dsw-alias-brand-primary']
  const below = [surfaces, layer]
  const light = applyLayers(stock, below, 'light')
  const dark = applyLayers(stock, below, 'dark')
  const safe = (values: typeof light, role: string, surface: string): string => {
    const text = resolveColor(values, role)
    const ground = resolveColor(values, surface)
    if (text === undefined || ground === undefined) throw new Error(`accent text role ${role} or its surface ${surface} does not resolve to a colour`)
    return textSafe(text, ground, TEXT_CONTRAST)
  }
  for (const [role, surface] of Object.entries(ACCENT_TEXT_ROLES)) {
    layer[role] = { light: safe(light, role, surface), dark: safe(dark, role, surface) }
  }
  return layer
}

/** The text and code faces Delo ships, placed ahead of upstream's built-in stacks. */
export const FONT_FAMILIES = { text: 'Schibsted Grotesk', code: 'JetBrains Mono' } as const

/**
 * The type layer: Delo's faces lead upstream's built-in stacks, which stay as
 * fallbacks (system faces, then Chinese faces for the characters the shipped
 * Latin files lack). A person's own font list in Settings still comes first.
 * @returns the layer for `ctx.theme.overrideTokens`.
 */
export function fontLayer(): TokenLayer {
  const both = (value: string): TokenModes => ({ light: value, dark: value })
  const text = `'${FONT_FAMILIES.text}', ${STOCK_FONT_STACKS.text}`
  return {
    '--dsh-font-family-text-default': both(text),
    '--dsh-font-family-code-default': both(`'${FONT_FAMILIES.code}', ${STOCK_FONT_STACKS.code}`),
    '--dsw-font-family-brand': both(text),
  }
}
