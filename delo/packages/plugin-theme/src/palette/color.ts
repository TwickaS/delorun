/**
 * Colour arithmetic for generated palettes: CSS `rgb()` parsing and printing,
 * OKLCH conversion through OKLab, sRGB gamut mapping by chroma reduction, and
 * WCAG 2 contrast. OKLCH keeps perceived lightness separate from hue and
 * chroma, so a palette can change hue while every step keeps the lightness
 * (and therefore the contrast) of the step it replaces.
 * @module @delo/plugin-theme/palette/color
 */

/** An sRGB colour with channels in 0..1 and an alpha in 0..1. */
export interface Rgb {
  /** Red channel, gamma-encoded, 0..1. */
  readonly r: number
  /** Green channel, gamma-encoded, 0..1. */
  readonly g: number
  /** Blue channel, gamma-encoded, 0..1. */
  readonly b: number
  /** Opacity, 0..1. */
  readonly alpha: number
}

/** An OKLCH colour: lightness 0..1, chroma 0..~0.37, hue in degrees, alpha 0..1. */
export interface Oklch {
  /** Perceived lightness, 0 (black) to 1 (white). */
  readonly l: number
  /** Colourfulness; 0 is grey. */
  readonly c: number
  /** Hue angle in degrees, 0..360. */
  readonly h: number
  /** Opacity, 0..1. */
  readonly alpha: number
}

const RGB_FUNCTION = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/

/**
 * Parse a CSS `rgb()` or `rgba()` value in comma or space syntax.
 * @param value - the CSS value, such as `rgb(34 197 94 / 8%)`.
 * @returns the colour, or `undefined` when the value is not a literal `rgb()` colour.
 */
export function parseRgb(value: string): Rgb | undefined {
  const match = RGB_FUNCTION.exec(value.trim())
  if (match === null) return undefined
  const [, r, g, b, alpha, percent] = match
  const a = alpha === undefined ? 1 : Number(alpha) / (percent === '%' ? 100 : 1)
  return { r: Number(r) / 255, g: Number(g) / 255, b: Number(b) / 255, alpha: a }
}

/**
 * Print a colour as CSS `rgb()`, with an alpha only when it is below 1.
 * @param color - the colour; channels are clamped and rounded to whole 0..255 steps.
 * @returns the CSS value.
 */
export function formatRgb(color: Rgb): string {
  const channel = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 255)
  const rgb = `${channel(color.r)} ${channel(color.g)} ${channel(color.b)}`
  if (color.alpha >= 1) return `rgb(${rgb})`
  return `rgb(${rgb} / ${Math.round(color.alpha * 1000) / 10}%)`
}

function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

function fromLinear(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055
}

/**
 * Convert an sRGB colour to OKLCH.
 * @param color - the sRGB colour.
 * @returns the same colour in OKLCH; a grey gets hue 0.
 */
export function toOklch(color: Rgb): Oklch {
  const r = toLinear(color.r)
  const g = toLinear(color.g)
  const b = toLinear(color.b)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const chroma = Math.hypot(a, bb)
  const hue = chroma < 1e-6 ? 0 : (Math.atan2(bb, a) * 180 / Math.PI + 360) % 360
  return { l: lightness, c: chroma, h: hue, alpha: color.alpha }
}

/** Convert OKLCH to unclamped sRGB; channels outside 0..1 mean the colour is out of gamut. */
function oklchToRgbUnclamped(color: Oklch): Rgb {
  const radians = color.h * Math.PI / 180
  const a = color.c * Math.cos(radians)
  const b = color.c * Math.sin(radians)
  const l = (color.l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (color.l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (color.l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return {
    r: fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    alpha: color.alpha,
  }
}

function inGamut(color: Rgb): boolean {
  const epsilon = 1e-4
  return [color.r, color.g, color.b].every(channel => channel >= -epsilon && channel <= 1 + epsilon)
}

/**
 * Convert OKLCH to sRGB, reducing chroma until the colour fits the sRGB gamut,
 * so lightness and hue are kept and only colourfulness gives way.
 * @param color - the OKLCH colour; lightness is clamped to 0..1.
 * @returns an in-gamut sRGB colour.
 */
export function fromOklch(color: Oklch): Rgb {
  const target = { ...color, l: Math.min(1, Math.max(0, color.l)) }
  const direct = oklchToRgbUnclamped(target)
  if (inGamut(direct)) return direct
  let low = 0
  let high = target.c
  for (let step = 0; step < 24; step++) {
    const middle = (low + high) / 2
    if (inGamut(oklchToRgbUnclamped({ ...target, c: middle }))) low = middle
    else high = middle
  }
  return oklchToRgbUnclamped({ ...target, c: low })
}

/**
 * WCAG 2 relative luminance of an opaque colour.
 * @param color - the colour; alpha is ignored.
 * @returns luminance, 0 (black) to 1 (white).
 */
export function luminance(color: Rgb): number {
  return 0.2126 * toLinear(color.r) + 0.7152 * toLinear(color.g) + 0.0722 * toLinear(color.b)
}

/**
 * Composite a translucent colour over an opaque background.
 * @param top - the colour drawn on top.
 * @param bottom - the opaque colour underneath.
 * @returns the opaque colour a viewer sees.
 */
export function over(top: Rgb, bottom: Rgb): Rgb {
  const mix = (front: number, back: number): number => front * top.alpha + back * (1 - top.alpha)
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), alpha: 1 }
}

/**
 * WCAG 2 contrast ratio between a foreground and an opaque background.
 * @param foreground - the text or mark colour; a translucent one is composited over the background first.
 * @param background - the opaque colour underneath.
 * @returns the ratio, 1 to 21.
 */
export function contrast(foreground: Rgb, background: Rgb): number {
  const front = luminance(foreground.alpha < 1 ? over(foreground, background) : foreground)
  const back = luminance(background)
  return (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05)
}

/**
 * Round a colour's channels to whole 0..255 steps, as {@link formatRgb} prints them.
 * @param color - the colour; channels are clamped first, and alpha is kept.
 * @returns the colour a viewer gets from the printed value.
 */
export function quantized(color: Rgb): Rgb {
  const channel = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 255) / 255
  return { r: channel(color.r), g: channel(color.g), b: channel(color.b), alpha: color.alpha }
}
