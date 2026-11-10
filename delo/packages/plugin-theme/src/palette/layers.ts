/**
 * The layers a set of theme settings applies: the palette, the chosen accent,
 * the type, the density and the contrast, or none while the studio additions
 * are off. The studio half applies them as override layers; the host half
 * prints the colour layers as the first paint.
 * @module @delo/plugin-theme/palette/layers
 */
import { CONTRAST, DENSITY_SCALE, type Density, type ThemeSettings } from '../config.ts'
import { formatRgb, type Rgb } from './color.ts'
import { t3Palette } from './t3.ts'
import { applyLayers, requireResolved, type TokenLayer } from './generate.ts'
import { accentFromColor, accentLayer, ACCENTS, fontLayer, paletteLayer, parseHex, SOFT } from './soft.ts'
import type { AccentSpec } from './soft.ts'
import { STOCK_TOKENS } from './stock.ts'

/** The layers in stacking order; empty while the studio additions are off. */
export interface ThemeLayers {
  /** The palette. */
  readonly palette?: TokenLayer
  /** The accent. */
  readonly accent?: TokenLayer
  /** Delo's typefaces; absent with the system typeface. */
  readonly type?: TokenLayer
  /** The density scale, `--dsh-density`. */
  readonly density?: TokenLayer
  /** Quiet text and rules moved for the contrast setting; absent at 100. */
  readonly contrast?: TokenLayer
}

/**
 * The accent a setting names.
 * @param settings - the theme settings.
 * @returns a T3 Code theme's own accent, the preset, or the custom colour's accent; a custom colour that does not parse falls back to Peach.
 */
export function chosenAccent(settings: ThemeSettings): AccentSpec {
  if (settings.palette !== 'soft') return t3Palette(settings.palette).accent
  if (settings.accent !== 'custom') return ACCENTS[settings.accent]
  const color = parseHex(settings.customAccent)
  return color === undefined ? ACCENTS.peach : accentFromColor(color)
}

/**
 * Build the layers for a set of settings.
 * @param settings - the theme settings.
 * @returns the layers to apply.
 */
export function themeLayers(settings: ThemeSettings): ThemeLayers {
  if (!settings.studioAdditions) return {}
  const palette = settings.palette === 'soft' ? SOFT : t3Palette(settings.palette).palette
  const colour = { palette: paletteLayer(palette), accent: accentLayer(chosenAccent(settings), palette) }
  return {
    ...colour,
    ...settings.typeface === 'delo' ? { type: fontLayer() } : {},
    density: densityLayer(settings.density),
    ...settings.contrast === CONTRAST.default ? {} : { contrast: contrastLayer([colour.palette, colour.accent], settings.contrast) },
  }
}

/** Quiet text roles and rules the contrast setting moves. */
export const CONTRAST_ROLES = [
  '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary', '--dsw-alias-label-caption', '--dsw-alias-label-dimmed',
  '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-border-l3', '--dsw-alias-border-l4',
] as const

/** How far the contrast's ends move a role towards primary text or the page: 60% at 200 or at 50. */
const CONTRAST_REACH = 0.6

function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  const at = (a: number, b: number): number => a + (b - a) * amount
  return { r: at(from.r, to.r), g: at(from.g, to.g), b: at(from.b, to.b), alpha: at(from.alpha, to.alpha) }
}

/**
 * The contrast layer: each quiet role moved towards primary text above 100, or towards the page below it, in each
 * scheme, from the values the palette and accent layers give.
 * @param colour - the palette and accent layers it adjusts.
 * @param contrast - the setting, `CONTRAST.min` to `CONTRAST.max`.
 * @returns the layer.
 */
export function contrastLayer(colour: readonly TokenLayer[], contrast: number): TokenLayer {
  const raise = contrast > CONTRAST.default
  // Each end of the slider is the full reach: 200 above the default, 50 below it.
  const share = raise ? (contrast - CONTRAST.default) / (CONTRAST.max - CONTRAST.default) : (CONTRAST.default - contrast) / (CONTRAST.default - CONTRAST.min)
  const amount = share * CONTRAST_REACH
  const target = raise ? '--dsw-alias-label-primary' : '--dsw-alias-bg-base'
  const layer: Record<string, { light: string; dark: string }> = {}
  const values = { light: applyLayers(STOCK_TOKENS, colour, 'light'), dark: applyLayers(STOCK_TOKENS, colour, 'dark') }
  for (const role of CONTRAST_ROLES) {
    const moved = (scheme: 'light' | 'dark'): string => formatRgb(mix(requireResolved(values[scheme], role), requireResolved(values[scheme], target), amount))
    layer[role] = { light: moved('light'), dark: moved('dark') }
  }
  return layer
}

/** The pixel sizes of `--delo-space-1` to `--delo-space-9`, before the density scale. */
export const SPACE_STEPS = [2, 4, 6, 8, 12, 16, 20, 24, 32] as const

/**
 * The density layer: `--dsh-density`, the scale spacing rules multiply by, and
 * `--delo-space-1` to `--delo-space-9`, the spacing steps of {@link SPACE_STEPS} already multiplied by it.
 * @param density - the density choice.
 * @returns the layer, the same in both schemes.
 */
export function densityLayer(density: Density): TokenLayer {
  const scale = String(DENSITY_SCALE[density])
  const layer: Record<string, { light: string; dark: string }> = { '--dsh-density': { light: scale, dark: scale } }
  SPACE_STEPS.forEach((step, index) => {
    const value = `calc(${step}px * var(--dsh-density, 1))`
    layer[`--delo-space-${index + 1}`] = { light: value, dark: value }
  })
  return layer
}

/** The attribute the studio half sets on `<html>` while the studio additions are off, which switches a first-paint style the page already holds off. */
export const STOCK_ATTRIBUTE = 'data-delo-stock'

/** Starts the first-paint style's text, so the studio half can find the element the host printed and remove it. */
export const FIRST_PAINT_MARK = '/*delo-first-paint*/'

/**
 * The first-paint style: the palette and accent layers as CSS on `body`, for
 * each scheme, until the studio half lays them on as inline values. The
 * selectors outrank upstream's token sheet, which loads later, and stop
 * applying once the studio half marks the stock look. The text starts with
 * {@link FIRST_PAINT_MARK}.
 * @param settings - the theme settings.
 * @returns the CSS text, or `''` while the studio additions are off.
 */
export function bootStyle(settings: ThemeSettings): string {
  const layers = themeLayers(settings)
  const colour = [layers.palette, layers.accent, layers.density, layers.contrast].filter((layer): layer is TokenLayer => layer !== undefined)
  if (colour.length === 0) return ''
  const block = (scheme: 'light' | 'dark'): string => colour.flatMap(layer => Object.entries(layer).map(([name, modes]) => `${name}:${modes[scheme]}`)).join(';')
  const root = `html:not([${STOCK_ATTRIBUTE}]) body`
  return `${FIRST_PAINT_MARK}${root}{${block('light')}}${root}[data-ds-dark-theme]{${block('dark')}}`
}

/** The colours a preview tile draws one scheme with. */
export interface SchemePreview {
  /** The page. */
  readonly page: string
  /** The sidebar. */
  readonly sidebar: string
  /** A raised layer, such as the composer. */
  readonly layer: string
  /** Primary text. */
  readonly text: string
  /** Quiet text and rules. */
  readonly quiet: string
  /** The brand primary. */
  readonly accent: string
}

const PREVIEW_TOKENS = {
  page: '--dsw-alias-bg-base',
  sidebar: '--dsw-specific-sidebar-fill',
  layer: '--dsw-alias-bg-layer-1',
  text: '--dsw-alias-label-primary',
  quiet: '--dsw-alias-label-tertiary',
  accent: '--dsw-alias-brand-primary',
} as const satisfies Record<keyof SchemePreview, string>

/**
 * The colours of the studio under a set of settings, in both schemes, for
 * drawing previews: the palette and accent layers over upstream's values, or
 * upstream's alone while the studio additions are off.
 * @param settings - the theme settings.
 * @returns each scheme's preview colours.
 */
export function previewColors(settings: ThemeSettings): Readonly<Record<'light' | 'dark', SchemePreview>> {
  const layers = themeLayers(settings)
  const stack = [layers.palette, layers.accent, layers.contrast].filter(layer => layer !== undefined)
  const scheme = (mode: 'light' | 'dark'): SchemePreview => {
    const values = applyLayers(STOCK_TOKENS, stack, mode)
    const colour = (token: string): string => formatRgb(requireResolved(values, token))
    return {
      page: colour(PREVIEW_TOKENS.page),
      sidebar: colour(PREVIEW_TOKENS.sidebar),
      layer: colour(PREVIEW_TOKENS.layer),
      text: colour(PREVIEW_TOKENS.text),
      quiet: colour(PREVIEW_TOKENS.quiet),
      accent: colour(PREVIEW_TOKENS.accent),
    }
  }
  return { light: scheme('light'), dark: scheme('dark') }
}
