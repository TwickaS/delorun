/**
 * Prepares the scripted film capture's frames for the home page: `film-scripted.ts` takes six moments at 1440 and 390
 * pixels wide in light and dark (`<moment>-<width>-<mode>.png`), and this script writes them to the source pictures
 * folder (the folder `SITE_PICTURES_DIR` names) as lossless WebP, named `film-<moment>-<light|dark>` for the wide frames
 * and `film-<moment>-390-<light|dark>` for the phone frames.
 *
 * The one edit is on the `handoff-consent` frames: the card's chip "Claude Code · Standard" is removed. On a wide frame
 * the chip's box is painted with the card's own background; on a phone frame, where the chip sits on its own row, that
 * row is cut out. Nothing else in a frame changes.
 *
 * Usage: `node scripts/film-frames.ts --src <film-scripted capture dir> --out <pictures dir>`. Needs `ffmpeg` with libwebp and `ffprobe` on the PATH.
 *
 * @module @delorun/website/scripts/film-frames
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

/** The moments, in the film's order. */
const MOMENTS = ['handoff-working', 'handoff-consent', 'agent-steps', 'approval', 'agent-finished', 'answer'] as const

/** The consent chip's box in a 1440 capture, padded to cover its border, and the rows of its own row in a 390 capture (2× pixels). */
const CHIP = { wide: { x0: 1310, x1: 1624, y0: 1586, y1: 1650 }, phone: { y0: 1992, y1: 2064 } } as const

/** A decoded picture: 8-bit RGB rows. */
interface Raster { readonly w: number; h: number; data: Buffer }

/**
 * Decode a picture with ffmpeg.
 * @param file - the PNG.
 * @returns the pixels.
 */
function decode(file: string): Raster {
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim().split(',').map(Number) as [number, number]
  const data = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 })
  return { w, h, data }
}

/**
 * Write a picture as lossless WebP with ffmpeg.
 * @param raster - the pixels.
 * @param file - the output path.
 * @returns nothing.
 */
function encode(raster: Raster, file: string): void {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${raster.w}x${raster.h}`, '-i', '-', '-c:v', 'libwebp', '-lossless', '1', '-compression_level', '6', file], { input: raster.data, maxBuffer: 1 << 30 })
}

/**
 * Read a pixel.
 * @param r - the picture.
 * @param x - the column.
 * @param y - the row.
 * @returns red, green and blue.
 */
function px(r: Raster, x: number, y: number): [number, number, number] {
  const i = (y * r.w + x) * 3
  return [r.data[i]!, r.data[i + 1]!, r.data[i + 2]!]
}

/**
 * Fill a rectangle with one colour.
 * @param r - the picture.
 * @param box - the rectangle, columns `[x0, x1)` and rows `[y0, y1)`.
 * @param colour - the colour.
 * @returns nothing.
 */
function fill(r: Raster, box: { x0: number; x1: number; y0: number; y1: number }, colour: readonly number[]): void {
  for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) { const i = (y * r.w + x) * 3; r.data[i] = colour[0]!; r.data[i + 1] = colour[1]!; r.data[i + 2] = colour[2]! }
}

/**
 * Remove rows from a picture.
 * @param r - the picture.
 * @param y0 - the first row removed.
 * @param y1 - the row after the last one removed.
 * @returns the shorter picture.
 */
function cutRows(r: Raster, y0: number, y1: number): Raster {
  return { w: r.w, h: r.h - (y1 - y0), data: Buffer.concat([r.data.subarray(0, y0 * r.w * 3), r.data.subarray(y1 * r.w * 3)]) }
}


/**
 * Remove the consent chip.
 * @param r - the frame.
 * @param width - the capture width.
 * @returns the edited frame.
 */
function removeChip(r: Raster, width: 1440 | 390): Raster {
  if (width === 390) return cutRows(r, CHIP.phone.y0, CHIP.phone.y1)
  const out: Raster = { w: r.w, h: r.h, data: Buffer.from(r.data) }
  fill(out, CHIP.wide, px(r, CHIP.wide.x1 + 20, CHIP.wide.y0 + 10))
  return out
}

const { values } = parseArgs({ options: { src: { type: 'string' }, out: { type: 'string' } } })
if (values.src === undefined || values.out === undefined) throw new Error('Usage: node scripts/film-frames.ts --src <film-scripted capture dir> --out <pictures dir>')
const src = resolve(values.src)
const out = resolve(values.out)
mkdirSync(out, { recursive: true })
for (const moment of MOMENTS) {
  for (const width of [1440, 390] as const) {
    for (const mode of ['light', 'dark'] as const) {
      const file = join(src, `${moment}-${width}-${mode}.png`)
      if (!existsSync(file)) throw new Error(`${file} is missing`)
      let frame = decode(file)
      if (moment === 'handoff-consent') frame = removeChip(frame, width)
      encode(frame, join(out, width === 1440 ? `film-${moment}-${mode}.webp` : `film-${moment}-390-${mode}.webp`))
    }
  }
}
