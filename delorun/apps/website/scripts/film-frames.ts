/**
 * Prepares the scripted film capture's frames for the home page: `film-scripted.ts` takes six moments at 1440 and 390
 * pixels wide in light and dark (`<moment>-<width>-<mode>.png`), and this script writes them to the source pictures
 * folder (the folder `SITE_PICTURES_DIR` names) as lossless WebP, named `film-<moment>-<light|dark>` for the wide frames
 * and `film-<moment>-390-<light|dark>` for the phone frames.
 *
 * The edits are crops, and one fill:
 *
 * - `handoff-consent`: the card's chip "Claude Code · Standard" is removed. On a wide frame the chip's box is painted with the
 *   card's own background; on a phone frame, where the chip sits on its own row, that row is cut out.
 * - The wide `agent-steps`, `approval`, `agent-finished` and `answer` frames drop the sidebar (the chat column is kept), so the
 *   film's camera never shows a sliver of it.
 * - Rows under the header that hold the cut lower half of a line are removed (`approval` wide and phone, `agent-steps` phone,
 *   `answer` wide), so the chat starts on a whole line.
 * - `answer` ends at its "Summary line" row; the paragraph below it, which contradicts the run, and the composer are cut off.
 *
 * Nothing else in a frame changes. All numbers are 2× pixels.
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

/**
 * How a frame is cropped: the first column kept, rows removed from the middle, the row the frame ends at (before the removals) and
 * the aspect ratio (width over height) the result is brought to, which the film's stage shows whole: a frame taller than that has a
 * band of rows between two blank rows removed, and one wider than that loses equal columns on both sides.
 */
interface Crop { readonly left?: number; readonly cuts?: readonly (readonly [number, number])[]; readonly bottom?: number; readonly aspect?: number }

/** The crops by moment, for 1440 and 390 captures. The header's rule is at row 151. */
const CROPS: Readonly<Record<string, { readonly 1440?: Crop; readonly 390?: Crop }>> = {
  'agent-steps': { 1440: { left: 532, aspect: 1.6 }, 390: { cuts: [[152, 172]] } },
  approval: { 1440: { left: 532, cuts: [[152, 170]], aspect: 1.6 }, 390: { cuts: [[152, 186]] } },
  'agent-finished': { 1440: { left: 532, aspect: 1.6 } },
  answer: { 1440: { left: 532, cuts: [[0, 220]], bottom: 1250, aspect: 1.6 }, 390: { bottom: 930 } },
}

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

/**
 * Apply a moment's crop.
 * @param r - the frame.
 * @param crop - the crop.
 * @returns the cropped frame.
 */
function applyCrop(r: Raster, crop: Crop): Raster {
  let out = r
  if (crop.bottom !== undefined) out = { w: out.w, h: crop.bottom, data: out.data.subarray(0, crop.bottom * out.w * 3) }
  for (const [y0, y1] of [...crop.cuts ?? []].reverse()) out = cutRows(out, y0, y1)
  if (crop.left !== undefined) {
    const w = out.w - crop.left
    const data = Buffer.alloc(w * out.h * 3)
    for (let y = 0; y < out.h; y++) out.data.copy(data, y * w * 3, (y * out.w + crop.left) * 3, (y + 1) * out.w * 3)
    out = { w, h: out.h, data }
  }
  if (crop.aspect !== undefined) out = fitAspect(out, crop.aspect)
  return out
}

/**
 * Bring a frame to an aspect ratio without padding it.
 * @param r - the frame.
 * @param aspect - width over height.
 * @returns the frame with rows or columns removed.
 */
function fitAspect(r: Raster, aspect: number): Raster {
  const height = Math.round(r.w / aspect)
  if (height < r.h) {
    const excess = r.h - height
    const blank = (y: number): boolean => {
      const first = px(r, 2, y)
      for (let x = 3; x < r.w; x += 1) { const c = px(r, x, y); if (Math.abs(c[0] - first[0]) + Math.abs(c[1] - first[1]) + Math.abs(c[2] - first[2]) > 12) return false }
      return true
    }
    for (let y = 160; y + excess < r.h; y++) if (blank(y) && blank(y + excess)) return cutRows(r, y, y + excess)
    return cutRows(r, 160, 160 + excess)
  }
  const width = Math.round(r.h * aspect)
  const left = Math.floor((r.w - width) / 2)
  const data = Buffer.alloc(width * r.h * 3)
  for (let y = 0; y < r.h; y++) r.data.copy(data, y * width * 3, (y * r.w + left) * 3, (y * r.w + left + width) * 3)
  return { w: width, h: r.h, data }
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
      const crop = CROPS[moment]?.[width]
      if (crop !== undefined) frame = applyCrop(frame, crop)
      encode(frame, join(out, width === 1440 ? `film-${moment}-${mode}.webp` : `film-${moment}-390-${mode}.webp`))
    }
  }
}
