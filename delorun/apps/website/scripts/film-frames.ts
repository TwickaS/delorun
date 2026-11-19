/**
 * Prepares the retaken film frames for the home page. The frames come from a folder of 2× captures (`--src`, with the
 * six moments at 1440 and 390 pixels in light and dark) and go to the source pictures folder (`--out`, the folder
 * `SITE_PICTURES_DIR` names) as lossless WebP, named `film-<moment>-<light|dark>` for the wide frames and
 * `film-<moment>-390-<light|dark>` for the phone frames.
 *
 * Four edits are made, and nothing else in a frame changes:
 *
 * - The request bubble of the root chat (moments `handoff-working`, `handoff-consent` and `answer`) is replaced by the
 *   short request. The new bubble is drawn in a headless Chromium with the studio's own bubble styles (the system font
 *   stack, `padding: 10px 16px`, line height 22px, the same radius, colours sampled from the old bubble) at a device
 *   pixel ratio of 2, to the old bubble's width, and pasted at the old bubble's top right corner. The rows the shorter
 *   bubble frees are not left blank: on a wide frame the chat column below the bubble moves up to the place where
 *   the chat's content ends (the sidebar and the controls pinned to the bottom stay); on a phone frame the freed rows
 *   are cut out, so the frame is shorter.
 * - The phone `approval` frame is cut from the phone `agent-steps` capture (its own capture has a half-open sidebar over the card).
 * - The cropped `approval` strip is centred on a canvas of the stage's aspect ratio, in its own page colour, so the stage
 *   shows it on the page rather than on the stage's ground.
 * - The chip "Claude Code · Standard · no sandbox" is removed from the `handoff-consent` card. On a wide frame the
 *   chip's box is painted with the card's own background; on a phone frame, where the chip sits on its own row,
 *   that row is cut out.
 *
 * Usage: `node scripts/film-frames.ts --src <film-2x dir> --out <pictures dir>`. Needs `ffmpeg` with libwebp on the PATH
 * and Playwright's Chromium; `PLAYWRIGHT_MODULE` names the Playwright package folder when `playwright` does not resolve.
 *
 * @module @delorun/website/scripts/film-frames
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

/** The text of the new request bubble. */
export const REQUEST = 'Hand this task to Claude Code: run the project tests and report which pass.'

/** Delorun's typeface, the studio's own font file. */
const TYPEFACE = new URL('../../../packages/plugin-theme/src/client/assets/fonts/schibsted-grotesk-latin.woff2', import.meta.url)

/** The studio's text font stack: Delorun's typeface, then the system stack of `base.css`. */
const FONT = "'Schibsted Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif"

/** The moments, with the capture widths that show the long request bubble (the phone consent frame is scrolled past it) and whether the consent chip shows. */
const MOMENTS: readonly { readonly id: string; readonly bubble: readonly number[]; readonly chip: boolean; readonly pad?: boolean; readonly phoneFrom?: string }[] = [
  { id: 'handoff-working', bubble: [1440, 390], chip: false },
  { id: 'handoff-consent', bubble: [1440], chip: true },
  { id: 'agent-steps', bubble: [], chip: false },
  { id: 'approval', bubble: [], chip: false, pad: true, phoneFrom: 'agent-steps' },
  { id: 'agent-finished', bubble: [], chip: false },
  { id: 'answer', bubble: [1440, 390], chip: false },
]

/**
 * The phone `approval` capture shows a half-open sidebar over the card, so the phone frame is cut from the `agent-steps`
 * capture, which holds the same kind of approval card, from the top of the card down (2× pixels).
 */
const PHONE_APPROVAL = { y0: 890, y1: 1688 }

/** Where to look for the old bubble, by capture width: a point inside it and the box to scan (2× pixels). */
const BUBBLE_SEARCH = {
  1440: { inside: [2400, 230], from: [1300, 150], to: [2880, 500] },
  390: { inside: [300, 190], from: [0, 150], to: [780, 700] },
} as const

/** The left edge of the chat column in a 1440 capture, where the sidebar ends (2× pixels). */
const PANE_X = 528

/** The chip's box in a 1440 capture, padded to cover its border (2× pixels), and the rows of its own row in a 390 capture. */
const CHIP = { wide: { x0: 1310, x1: 1772, y0: 1572, y1: 1688 }, phone: { y0: 1480, y1: 1552 } } as const

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
 * Whether two colours are within a tolerance.
 * @param a - the first colour.
 * @param b - the second colour.
 * @param tolerance - the sum of channel differences allowed.
 * @returns true when close.
 */
function near(a: readonly number[], b: readonly number[], tolerance: number): boolean {
  return Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!) <= tolerance
}

/**
 * Copy a rectangle of rows and columns from one picture into another of the same width.
 * @param from - the source.
 * @param to - the destination.
 * @param box - the source rectangle, columns `[x0, x1)` and rows `[y0, y1)`.
 * @param dy - how many rows down in the destination the rectangle goes (negative is up).
 * @returns nothing.
 */
function blit(from: Raster, to: Raster, box: { x0: number; x1: number; y0: number; y1: number }, dy: number): void {
  for (let y = box.y0; y < box.y1; y++) {
    if (y + dy < 0 || y + dy >= to.h) continue
    from.data.copy(to.data, ((y + dy) * to.w + box.x0) * 3, (y * from.w + box.x0) * 3, (y * from.w + box.x1) * 3)
  }
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

/** Where the old bubble is, and the colours it is drawn in. */
interface Bubble { readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number; readonly fill: [number, number, number]; readonly ink: [number, number, number]; readonly page: [number, number, number] }

/**
 * Find the old request bubble in a frame.
 * @param r - the frame.
 * @param width - the capture width, 1440 or 390.
 * @returns the bubble's box, its fill, its text colour (the extreme pixel inside it) and the page colour beside it.
 */
function findBubble(r: Raster, width: 1440 | 390): Bubble {
  const { inside, from, to } = BUBBLE_SEARCH[width]
  const fillColour = px(r, inside[0], inside[1])
  // The bubble is the first run of rows below the header that hold many fill-coloured pixels; a stray icon of the
  // same colour in the time row below it holds few.
  let x0 = r.w, x1 = 0, y0 = -1, y1 = 0
  for (let y = from[1]; y < to[1]; y++) {
    let count = 0
    let left = r.w, right = 0
    for (let x = from[0]; x < to[0]; x++) {
      if (!near(px(r, x, y), fillColour, 6)) continue
      count++
      if (x < left) left = x
      if (x > right) right = x
    }
    if (count > 40) {
      if (y0 < 0) y0 = y
      y1 = y
      if (left < x0) x0 = left
      if (right > x1) x1 = right
    } else if (y0 >= 0) break
  }
  const lum = (c: readonly number[]): number => c[0]! + c[1]! + c[2]!
  const dark = lum(fillColour) < 384
  let ink = fillColour
  for (let y = y0 + 20; y < y1 - 20; y++) for (let x = x0 + 40; x < x1 - 40; x++) { const c = px(r, x, y); if (dark ? lum(c) > lum(ink) : lum(c) < lum(ink)) ink = c }
  return { x0, x1, y0, y1, fill: fillColour, ink, page: px(r, x0 - 24, y0 + 12) }
}

/**
 * Draw the request bubble with the studio's styles.
 * @param page - a Chromium page.
 * @param bubble - the old bubble, for its width, colours and corner radius.
 * @param text - the text.
 * @returns the bubble as a PNG with transparent corners, at 2×.
 */
async function drawBubble(page: { setContent(html: string): Promise<void>; evaluate(script: string): Promise<unknown>; locator(selector: string): { screenshot(options: { omitBackground: boolean }): Promise<Buffer> } }, bubble: Bubble, text: string): Promise<Buffer> {
  const rgb = (c: readonly number[]): string => `rgb(${c.join(',')})`
  const maxWidth = (bubble.x1 - bubble.x0 + 1) / 2
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>@font-face{font-family:'Schibsted Grotesk';font-weight:400 900;src:url(data:font/woff2;base64,${readFileSync(TYPEFACE).toString('base64')}) format('woff2')}</style><body style="margin:0;background:transparent"><div id="b" style="box-sizing:border-box;width:fit-content;max-width:${maxWidth}px;background:${rgb(bubble.fill)};color:${rgb(bubble.ink)};border-radius:20px;padding:10px 16px;font:14px/22px ${FONT};white-space:pre-wrap;word-break:break-word;-webkit-font-smoothing:antialiased">${text}</div>`)
  await page.evaluate('document.fonts.ready')
  return page.locator('#b').screenshot({ omitBackground: true })
}

/**
 * Decode a PNG with an alpha channel.
 * @param png - the PNG bytes.
 * @returns width, height and RGBA bytes.
 */
function decodeRgba(png: Buffer): { w: number; h: number; data: Buffer } {
  const dir = mkdirSync(join('/tmp', `film-frames-${String(process.pid)}`), { recursive: true }) ?? join('/tmp', `film-frames-${String(process.pid)}`)
  const file = join(dir, 'b.png')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', '-', '-frames:v', '1', file], { input: png })
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim().split(',').map(Number) as [number, number]
  const data = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 28 })
  return { w, h, data }
}

/**
 * Paste an RGBA picture onto a frame with its alpha.
 * @param r - the frame.
 * @param src - the picture.
 * @param left - the column of its left edge.
 * @param top - the row of its top edge.
 * @returns nothing.
 */
function paste(r: Raster, src: { w: number; h: number; data: Buffer }, left: number, top: number): void {
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      const i = (y * src.w + x) * 4
      const a = src.data[i + 3]! / 255
      if (a === 0) continue
      const o = ((top + y) * r.w + left + x) * 3
      for (let c = 0; c < 3; c++) r.data[o + c] = Math.round(src.data[i + c]! * a + r.data[o + c]! * (1 - a))
    }
  }
}

/**
 * Replace the old bubble with the new one and close the gap.
 * @param r - the frame.
 * @param width - the capture width.
 * @param newBubble - the new bubble, decoded.
 * @param old - the old bubble.
 * @returns the edited frame.
 */
function replaceBubble(r: Raster, width: 1440 | 390, newBubble: { w: number; h: number; data: Buffer }, old: Bubble): Raster {
  const oldHeight = old.y1 - old.y0 + 1
  const freed = oldHeight - newBubble.h
  const left = old.x1 + 1 - newBubble.w
  if (width === 390) {
    const out = cutRows(r, old.y0 + newBubble.h, old.y0 + oldHeight)
    fill(out, { x0: 0, x1: out.w, y0: old.y0, y1: old.y0 + newBubble.h }, old.page)
    paste(out, newBubble, left, old.y0)
    return out
  }
  const out: Raster = { w: r.w, h: r.h, data: Buffer.from(r.data) }
  const columns = { x0: PANE_X, x1: r.w }
  // Where the chat's content ends: the last row before the first blank run of 100 rows below the bubble.
  let end = old.y1 + 1
  let blank = 0
  for (let y = old.y1 + 1; y < r.h && blank < 100; y++) {
    let busy = false
    for (let x = PANE_X + 8; x < r.w - 8 && !busy; x++) busy = !near(px(r, x, y), old.page, 10)
    if (busy) { end = y + 1; blank = 0 } else blank++
  }
  fill(out, { ...columns, y0: old.y0, y1: old.y1 + 1 }, old.page)
  blit(r, out, { ...columns, y0: old.y1 + 1, y1: end }, -freed)
  fill(out, { ...columns, y0: end - freed, y1: end }, old.page)
  paste(out, newBubble, left, old.y0)
  return out
}

/**
 * Centre a cropped strip on a canvas of the stage's aspect ratio (wide 16:10, phone 4:5), filled with the strip's page colour,
 * so the film's stage shows the strip on the page instead of the stage's ground.
 * @param r - the strip.
 * @param aspect - the canvas width divided by its height.
 * @returns the padded picture, or the strip when it is already at least that tall.
 */
function padToAspect(r: Raster, aspect: number): Raster {
  const h = Math.round(r.w / aspect)
  if (h <= r.h) return r
  const out: Raster = { w: r.w, h, data: Buffer.alloc(r.w * h * 3) }
  fill(out, { x0: 0, x1: r.w, y0: 0, y1: h }, px(r, 4, 4))
  const top = Math.floor((h - r.h) / 2)
  blit(r, out, { x0: 0, x1: r.w, y0: 0, y1: r.h }, top)
  return out
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

const { values } = parseArgs({ options: { src: { type: 'string' }, out: { type: 'string' }, only: { type: 'string' }, text: { type: 'string' } } })
if (values.src === undefined || values.out === undefined) throw new Error('Usage: node scripts/film-frames.ts --src <film-2x dir> --out <pictures dir> [--only <moment>]')
const src = resolve(values.src)
const out = resolve(values.out)
mkdirSync(out, { recursive: true })

const require = createRequire(import.meta.url)
const playwright = require(process.env['PLAYWRIGHT_MODULE'] ?? 'playwright') as typeof import('playwright')
const browser = await playwright.chromium.launch()
try {
  for (const moment of MOMENTS) {
    if (values.only !== undefined && values.only !== moment.id) continue
    for (const width of [1440, 390] as const) {
      for (const mode of ['light', 'dark'] as const) {
        const file = `${width === 390 && moment.phoneFrom !== undefined ? moment.phoneFrom : moment.id}-${width}-${mode}.png`
        if (!readdirSync(src).includes(file)) throw new Error(`${file} is missing from ${src}`)
        let frame = decode(join(src, file))
        if (width === 390 && moment.phoneFrom !== undefined) frame = cutRows(cutRows(frame, PHONE_APPROVAL.y1, frame.h), 0, PHONE_APPROVAL.y0)
        if (moment.chip) frame = removeChip(frame, width)
        if (moment.bubble.includes(width)) {
          const old = findBubble(frame, width)
          if (process.env['FILM_DEBUG'] !== undefined) console.log(moment.id, width, mode, JSON.stringify(old))
          const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 700, height: 300 } })
          const page = await context.newPage()
          const drawn = decodeRgba(await drawBubble(page, old, values.text ?? REQUEST))
          await context.close()
          frame = replaceBubble(frame, width, drawn, old)
        }
        if (moment.pad === true) frame = padToAspect(frame, width === 1440 ? 1.6 : 0.8)
        encode(frame, join(out, width === 1440 ? `film-${moment.id}-${mode}.webp` : `film-${moment.id}-390-${mode}.webp`))
      }
    }
  }
} finally {
  await browser.close()
}
