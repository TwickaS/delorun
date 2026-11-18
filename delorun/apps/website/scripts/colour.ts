/**
 * Measures a screenshot's colour as a 16:10 mosaic tile shows it: the whole computer picture, or the top of a phone
 * picture, decoded and scaled down by `ffmpeg` (on the PATH). Shared by the home page's picture scripts.
 *
 * @module @delorun/website/scripts/colour
 */
import { execFileSync } from 'node:child_process'

/** The size each picture is scaled to before measuring. */
const W = 64
const H = 40

/** A picture's mean colour in CIE Lab (lightness 0 to 100) and as an sRGB hex, and the share of its pixels in the peach
 * family. */
export interface Colour { readonly l: number; readonly a: number; readonly b: number; readonly hex: string; readonly peach: number }

/**
 * Converts an sRGB colour to CIE Lab (D65).
 * @param r - red, 0 to 255.
 * @param g - green, 0 to 255.
 * @param b - blue, 0 to 255.
 * @returns lightness 0 to 100, then a and b.
 */
function lab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  const [R, G, B] = [lin(r), lin(g), lin(b)]
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883
  const f = (t: number) => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}

/**
 * Whether a pixel is in the peach family: an orange hue, saturated and bright enough to read as the brand colour.
 * @param r - red.
 * @param g - green.
 * @param b - blue.
 * @returns true for a peach pixel.
 */
function peach(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max < 150 || max - min < 70 || max !== r) return false
  const hue = 60 * (((g - b) / (max - min)) % 6)
  return hue >= 5 && hue <= 40
}

/**
 * Measures one picture.
 * @param file - the picture's path, in any format `ffmpeg` reads.
 * @param phone - true for a phone picture, whose top 16:10 part the tile shows.
 * @returns its colour.
 */
export function measure(file: string, phone: boolean): Colour {
  const crop = phone ? 'crop=iw:iw*10/16:0:0,' : ''
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-vf', `${crop}scale=${W}:${H}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  let [sr, sg, sb, peachCount] = [0, 0, 0, 0]
  for (let i = 0; i < raw.length; i += 3) {
    const [r, g, b] = [raw[i] ?? 0, raw[i + 1] ?? 0, raw[i + 2] ?? 0]
    sr += r; sg += g; sb += b
    if (peach(r, g, b)) peachCount++
  }
  const n = raw.length / 3
  const [l, a, bb] = lab(sr / n, sg / n, sb / n)
  const hex = `#${[sr, sg, sb].map(sum => Math.round(sum / n).toString(16).padStart(2, '0')).join('')}`
  return { l, a, b: bb, hex, peach: peachCount / n }
}
