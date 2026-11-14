/**
 * Builds token override layers from a palette's seeds. A seed names a hue and
 * a chroma; the generator recolours upstream's ramps step by step, keeping
 * each step's OKLCH lightness, so pairings upstream designed for contrast
 * stay close to it while the palette changes hue. WCAG contrast still moves
 * with hue at equal lightness, so text roles get a text-safe shade.
 * @module @delorun/plugin-theme/palette/generate
 */
import { contrast, formatRgb, fromOklch, luminance, parseRgb, quantized, toOklch } from './color.ts'
import type { Rgb } from './color.ts'
import type { StockTokens } from './stock-css.ts'

/** One token value per colour scheme: the shape `ctx.theme.overrideTokens` takes. */
export interface TokenModes {
  /** Value while the light palette is active. */
  readonly light: string
  /** Value while the dark palette is active. */
  readonly dark: string
}

/** A token override layer: token name to its value in each scheme. */
export type TokenLayer = Readonly<Record<string, TokenModes>>

/** A hue and chroma that a ramp is recoloured to. */
export interface Seed {
  /** OKLCH hue in degrees. */
  readonly hue: number
  /** OKLCH chroma at full strength. */
  readonly chroma: number
}

/** Chroma below which a stock literal counts as grey whatever its hue. */
const GREY_CHROMA = 0.008

/** Chroma below which a stock literal in upstream's bluish-grey hue band counts as grey; faint diff greens and reds sit outside the band and keep their colour. */
const BLUISH_GREY_CHROMA = 0.05

/** Upstream's bluish-grey hue band, in OKLCH degrees. */
const BLUISH_GREY_HUES = { from: 220, to: 300 } as const

/** Lightness distance from black or white over which a neutral's chroma fades in, so near-whites and near-blacks stay quiet. */
const NEUTRAL_FADE = 0.15

/**
 * The colour a neutral seed gives at one lightness. Chroma fades towards
 * white and black, the way upstream's own greys carry less tint at the ends.
 * @param seed - the neutral hue and chroma.
 * @param lightness - OKLCH lightness, 0..1.
 * @param alpha - opacity, 0..1.
 * @returns the CSS `rgb()` value.
 */
export function neutralAt(seed: Seed, lightness: number, alpha = 1): string {
  const fade = Math.sqrt(Math.min(1, Math.max(0, Math.min(lightness, 1 - lightness) / NEUTRAL_FADE)))
  return formatRgb(fromOklch({ l: lightness, c: seed.chroma * fade, h: seed.hue, alpha }))
}

function stepsOf(stock: StockTokens, ramp: string): string[] {
  const pattern = new RegExp(`^--dsw-static-${ramp}-\\d`)
  return Object.keys(stock.light).filter(name => pattern.test(name))
}

/**
 * Recolour a grey ramp: every step keeps its lightness and alpha and takes
 * the seed's hue, with chroma fading towards white and black.
 * @param stock - upstream's token values.
 * @param ramp - the ramp's name between `--dsw-static-` and the step, such as `neutral-bluish`.
 * @param seed - the neutral hue and chroma.
 * @returns the ramp's overrides in both schemes.
 */
export function neutralRamp(stock: StockTokens, ramp: string, seed: Seed): TokenLayer {
  const layer: Record<string, TokenModes> = {}
  for (const name of stepsOf(stock, ramp)) {
    layer[name] = { light: recolourNeutral(stock.light[name], seed), dark: recolourNeutral(stock.dark[name], seed) }
  }
  return layer
}

function recolourNeutral(value: string | undefined, seed: Seed): string {
  const color = requireRgb(value)
  return neutralAt(seed, toOklch(color).l, color.alpha)
}

/**
 * Recolour a chromatic ramp: every step keeps its lightness and alpha, takes
 * the seed's hue, and scales its chroma by the step's share of the ramp's
 * strongest chroma, so pale tints stay pale and the main step gets the
 * seed's full chroma.
 * @param stock - upstream's token values.
 * @param ramp - the ramp's name, such as `deepseek`.
 * @param seed - the hue and full chroma.
 * @returns the ramp's overrides in both schemes.
 */
export function chromaticRamp(stock: StockTokens, ramp: string, seed: Seed): TokenLayer {
  const names = stepsOf(stock, ramp)
  const strongest = Math.max(...names.map(name => toOklch(requireRgb(stock.light[name])).c))
  const recolour = (value: string | undefined): string => {
    const color = toOklch(requireRgb(value))
    return formatRgb(fromOklch({ l: color.l, c: seed.chroma * color.c / strongest, h: seed.hue, alpha: color.alpha }))
  }
  const layer: Record<string, TokenModes> = {}
  for (const name of names) layer[name] = { light: recolour(stock.light[name]), dark: recolour(stock.dark[name]) }
  return layer
}

/**
 * Recolour the role tokens upstream writes as literal greys rather than as a
 * ramp step (borders, hover washes, menu materials), so translucent layers
 * take the palette's tint too. Literals with real colour (diff highlights)
 * and pure black or white masks keep their value.
 * @param stock - upstream's token values.
 * @param seed - the neutral hue and chroma.
 * @returns overrides for each grey literal that is not a ramp step.
 */
export function neutralLiterals(stock: StockTokens, seed: Seed): TokenLayer {
  const layer: Record<string, TokenModes> = {}
  for (const [name, original] of Object.entries(stock.light)) {
    if (name.startsWith('--dsw-static-')) continue
    const light = recolourGreyLiteral(original, seed)
    const dark = recolourGreyLiteral(stock.dark[name], seed)
    if (light === undefined && dark === undefined) continue
    layer[name] = { light: light ?? original, dark: dark ?? stock.dark[name] ?? original }
  }
  return layer
}

function recolourGreyLiteral(value: string | undefined, seed: Seed): string | undefined {
  const color = value === undefined ? undefined : parseRgb(value)
  if (color === undefined) return undefined
  const oklch = toOklch(color)
  const bluish = oklch.h >= BLUISH_GREY_HUES.from && oklch.h <= BLUISH_GREY_HUES.to
  const grey = oklch.c < GREY_CHROMA || (bluish && oklch.c < BLUISH_GREY_CHROMA)
  if (!grey || oklch.c < 1e-4) return undefined
  return neutralAt(seed, oklch.l, color.alpha)
}

/**
 * Recolour literal role tokens that carry the stock brand hue (such as a
 * one-off brand blue written as `rgb()`), so no blue survives an accent change.
 * @param stock - upstream's token values.
 * @param brand - the stock brand hue and the tolerance around it, in degrees.
 * @param seed - the accent hue and chroma.
 * @returns overrides for each such literal.
 */
export function brandLiterals(stock: StockTokens, brand: { readonly hue: number; readonly tolerance: number }, seed: Seed): TokenLayer {
  const layer: Record<string, TokenModes> = {}
  const recolour = (value: string | undefined): string | undefined => {
    const color = value === undefined ? undefined : parseRgb(value)
    if (color === undefined) return undefined
    const oklch = toOklch(color)
    if (oklch.c < 0.1 || Math.abs(oklch.h - brand.hue) > brand.tolerance) return undefined
    return formatRgb(fromOklch({ ...oklch, c: Math.min(oklch.c, seed.chroma), h: seed.hue }))
  }
  for (const [name, original] of Object.entries(stock.light)) {
    if (name.startsWith('--dsw-static-')) continue
    const light = recolour(original)
    const dark = recolour(stock.dark[name])
    if (light === undefined && dark === undefined) continue
    layer[name] = { light: light ?? original, dark: dark ?? stock.dark[name] ?? original }
  }
  return layer
}

function requireRgb(value: string | undefined): Rgb {
  const color = value === undefined ? undefined : parseRgb(value)
  if (color === undefined) throw new Error(`stock value ${String(value)} is not an rgb() colour`)
  return color
}

/** One colour scheme's token values once layers apply: name to CSS value. */
export type SchemeValues = Readonly<Record<string, string>>

/**
 * Lay override layers over upstream's values for one scheme.
 * @param stock - upstream's token values.
 * @param layers - override layers, later ones winning per token.
 * @param scheme - which scheme's values to take.
 * @returns every token's value in that scheme.
 */
export function applyLayers(stock: StockTokens, layers: readonly TokenLayer[], scheme: 'light' | 'dark'): SchemeValues {
  const values: Record<string, string> = { ...stock[scheme] }
  for (const layer of layers) for (const [name, modes] of Object.entries(layer)) values[name] = modes[scheme]
  return values
}

/**
 * Follow a token through plain `var(--name)` references to its colour.
 * @param values - one scheme's token values.
 * @param name - the token to resolve.
 * @returns the colour, or `undefined` when the chain ends in something other than an `rgb()` literal (a `color-mix()`, a fallback, an unknown token).
 */
export function resolveColor(values: SchemeValues, name: string): Rgb | undefined {
  let current: string | undefined = name
  for (let depth = 0; depth < 16 && current !== undefined; depth++) {
    const value: string | undefined = values[current]
    if (value === undefined) return undefined
    const reference = /^var\((--[\w-]+)\)$/.exec(value)
    if (reference === null) return parseRgb(value)
    current = reference[1]
  }
  return undefined
}

/**
 * Follow a token to its colour, for a token that must have one.
 * @param values - one scheme's token values.
 * @param name - the token to resolve.
 * @returns the colour.
 * @throws Error when the token does not resolve to an `rgb()` colour.
 */
export function requireResolved(values: SchemeValues, name: string): Rgb {
  const color = resolveColor(values, name)
  if (color === undefined) throw new Error(`token ${name} does not resolve to an rgb() colour`)
  return color
}

/**
 * Shift a colour's OKLCH lightness away from a surface until text in it
 * reaches a contrast ratio there; hue and chroma stay.
 * @param color - the starting colour.
 * @param surface - the opaque surface the text sits on.
 * @param minimum - the contrast ratio to reach, such as 4.5.
 * @returns the first lightness whose printed (whole-step) colour reaches it, or black or white when none does.
 */
export function textSafeColor(color: Rgb, surface: Rgb, minimum: number): Rgb {
  const start = toOklch(color)
  const direction = luminance(surface) > 0.18 ? -1 : 1
  for (let step = 0; step <= 200; step++) {
    const candidate = quantized(fromOklch({ ...start, l: start.l + direction * step * 0.005 }))
    if (contrast(candidate, surface) >= minimum) return candidate
  }
  return quantized(fromOklch({ ...start, l: direction < 0 ? 0 : 1 }))
}

/**
 * The CSS value of {@link textSafeColor}.
 * @param color - the starting colour.
 * @param surface - the opaque surface the text sits on.
 * @param minimum - the contrast ratio to reach, such as 4.5.
 * @returns the CSS `rgb()` value.
 */
export function textSafe(color: Rgb, surface: Rgb, minimum: number): string {
  return formatRgb(textSafeColor(color, surface, minimum))
}
