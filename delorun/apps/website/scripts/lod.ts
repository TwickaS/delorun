/**
 * Builds the home page's level-of-detail pyramid as static files in `public/lod/`, each as AVIF with a WebP
 * fallback and a content hash in its name, so they can be cached for good:
 *
 * - `tiles`: for every picture in `shots.ts` and the film, L1 (96 px wide, a mosaic tile), L2 (480 px, or 300 for a phone capture:
 *   the zoom and the wall) and L3 (the capture's own width: the lightbox). Writes `src/home/lod-tiles.ts`.
 * - `atlases`: for every layout and look in `mosaic-plans.ts`, L0, the whole mosaic as one picture: the first paint, and
 *   the sprite a re-tile turns each tile to. Writes `src/home/lod-atlases.ts`.
 *
 * Sources are the capture lane's PNGs where the folder has one, otherwise the hand-picked pictures and vetted owner
 * pictures in `pictures/`.
 * Nothing is drawn or retouched; each file is the screenshot, scaled. Files no longer named are removed. A cache in
 * `node_modules/.cache/lod/` skips pictures whose source has not changed. Run `tiles`, then `shot-colours.ts`
 * and `mosaic-plans.ts`, then `atlases`. needs `ffmpeg` with libaom-av1 and
 * libwebp on the PATH.
 *
 * Usage: `node scripts/lod.ts tiles|atlases <capture folder>`
 *
 * @module @delorun/website/scripts/lod
 */
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { FILM, SHOTS, type Device } from '../src/home/shots.ts'

/** A picture the pyramid covers. */
interface Picture {
  readonly id: string
  readonly device: Device
}

/** Every picture the page shows: the wall's, then the film's own computer and phone frames. */
const PICTURES: readonly Picture[] = [...new Map<string, Picture>([
  ...SHOTS.map(shot => [shot.id, shot] as const),
  ...FILM.flatMap(chapter => [chapter.id, ...(chapter.dark === undefined ? [] : [chapter.dark.id])].map(id => [id, { id, device: 'computer' }] as const)),
  ...FILM.map(chapter => [chapter.phone.file, { id: chapter.phone.file, device: 'phone' }] as const),
].reverse()).values()].reverse()

const run = promisify(execFile)

const [mode, captures] = process.argv.slice(2)
if ((mode !== 'tiles' && mode !== 'atlases') || captures === undefined) throw new Error('Usage: node scripts/lod.ts tiles|atlases <capture folder>')

const out = new URL('../public/lod/', import.meta.url).pathname
const cacheDir = new URL('../node_modules/.cache/lod/', import.meta.url).pathname
mkdirSync(out, { recursive: true })
mkdirSync(cacheDir, { recursive: true })

/** Each level's width by device; L3 keeps the source's width. */
const WIDTHS = { 1: { computer: 96, phone: 96 }, 2: { computer: 480, phone: 300 } } as const

/** How many encodes run at once; the machine is shared. */
const PARALLEL = 2

/**
 * The source picture of a shot.
 * @param shot - the shot.
 * @returns its path.
 */
function sourceOf(shot: Picture): string {
  const capture = join(captures ?? '', `${shot.id}.png`)
  if (existsSync(capture)) return capture
  for (const name of [`${shot.id}.png`, `${shot.id}.jpg`, `${shot.id}.jpeg`, `${shot.id}.webp`]) {
    const copy = new URL(`../pictures/${name}`, import.meta.url).pathname
    if (existsSync(copy)) return copy
  }
  throw new Error(`No source picture for ${shot.id}`)
}

/**
 * Encodes one picture, or raw RGB on standard input, as AVIF and WebP, names both by their content and returns the hash.
 * @param input - ffmpeg input arguments.
 * @param filter - the video filter, or undefined for none.
 * @param name - the file name before the hash.
 * @param quality - AVIF crf and WebP quality.
 * @param raw - raw RGB to pipe in, when the input is standard input.
 * @returns the hash in both files' names.
 */
async function encode(input: readonly string[], filter: string | undefined, name: string, quality: { readonly crf: number; readonly webp: number }, raw?: Buffer): Promise<string> {
  const tmpAvif = join(cacheDir, `${name}.tmp.avif`)
  const tmpWebp = join(cacheDir, `${name}.tmp.webp`)
  const vf = filter === undefined ? [] : ['-vf', filter]
  const avifArgs = ['-loglevel', 'error', '-y', ...input, ...vf, '-c:v', 'libaom-av1', '-still-picture', '1', '-crf', String(quality.crf), '-cpu-used', '6', '-pix_fmt', 'yuv420p', tmpAvif]
  const webpArgs = ['-loglevel', 'error', '-y', ...input, ...vf, '-c:v', 'libwebp', '-quality', String(quality.webp), tmpWebp]
  if (raw === undefined) {
    await run('nice', ['-n', '10', 'ffmpeg', ...avifArgs])
    await run('nice', ['-n', '10', 'ffmpeg', ...webpArgs])
  } else {
    execFileSync('nice', ['-n', '10', 'ffmpeg', ...avifArgs], { input: raw })
    execFileSync('nice', ['-n', '10', 'ffmpeg', ...webpArgs], { input: raw })
  }
  const avif = readFileSync(tmpAvif)
  const webp = readFileSync(tmpWebp)
  const hash = createHash('sha256').update(avif).update(webp).digest('hex').slice(0, 10)
  writeFileSync(join(out, `${name}.${hash}.avif`), avif)
  writeFileSync(join(out, `${name}.${hash}.webp`), webp)
  rmSync(tmpAvif)
  rmSync(tmpWebp)
  return hash
}

/**
 * Runs jobs a few at a time.
 * @param jobs - the jobs.
 */
async function pool(jobs: readonly (() => Promise<void>)[]): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (next < jobs.length) await jobs[next++]?.()
  }))
}

/** The cache: a source's identity and level, to the hash of its files. */
const cacheFile = join(cacheDir, 'hashes.json')
const cache = new Map<string, string>(existsSync(cacheFile) ? Object.entries(JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<string, string>) : [])
const keep = new Set<string>()

/**
 * Encodes one picture at one level unless the cache has it.
 * @param key - the cache key.
 * @param name - the file name before the hash.
 * @param make - encodes it and returns the hash.
 * @returns the hash.
 */
async function cached(key: string, name: string, make: () => Promise<string>): Promise<string> {
  const known = cache.get(key)
  const hash = known !== undefined && existsSync(join(out, `${name}.${known}.avif`)) && existsSync(join(out, `${name}.${known}.webp`)) ? known : await make()
  cache.set(key, hash)
  keep.add(`${name}.${hash}.avif`)
  keep.add(`${name}.${hash}.webp`)
  return hash
}

/**
 * Removes files of a kind this run did not name.
 * @param prefix - true for the files of this kind.
 */
function prune(prefix: (file: string) => boolean): void {
  for (const file of readdirSync(out)) if (prefix(file) && !keep.has(file)) rmSync(join(out, file))
}

if (mode === 'tiles') {
  const hashes = new Map<string, string[]>()
  const jobs = PICTURES.flatMap(shot => {
    const source = sourceOf(shot)
    const stamp = `${statSync(source).size}:${statSync(source).mtimeMs}`
    const list: string[] = ['', '', '']
    hashes.set(shot.id, list)
    return ([1, 2, 3] as const).map(level => async () => {
      const width = level === 3 ? undefined : WIDTHS[level][shot.device]
      const filter = width === undefined ? 'scale=trunc(iw/2)*2:trunc(ih/2)*2' : `scale=${width}:-2:flags=lanczos`
      const quality = level === 3 ? { crf: 30, webp: 80 } : { crf: 34, webp: 74 }
      list[level - 1] = await cached(`${shot.id}|${level}|${stamp}`, `${shot.id}.${level}`, () => encode(['-i', source], filter, `${shot.id}.${level}`, quality))
    })
  })
  await pool(jobs)
  prune(file => !file.startsWith('atlas-'))
  writeFileSync(new URL('../src/home/lod-tiles.ts', import.meta.url), `/**
 * The content hashes of each picture's level-of-detail files in \`public/lod/\`: L1, L2 and L3, each as AVIF and
 * WebP. Generated by \`scripts/lod.ts tiles\`; do not edit by hand.
 *
 * @module @delorun/website/home/lod-tiles
 */

/** The hashes of L1, L2 and L3, by picture id. */
export const LOD_TILES: Readonly<Record<string, readonly [string, string, string]>> = {
${[...hashes].map(([id, list]) => `  '${id}': [${list.map(hash => `'${hash}'`).join(', ')}],`).join('\n')}
}
`)
  console.log(`tiles: ${PICTURES.length} pictures, ${keep.size} files`)
} else {
  const { MOSAIC_PLANS, PLAN_IDS, PLAN_LOOKS } = await import('../src/home/mosaic-plans.ts')
  const { WIDE, NARROW } = await import('../src/home/mosaic.ts')
  /** Each layout's cell and gap in atlas pixels: about twice a tile's size on a typical screen of that width. */
  const GEOMETRY = { wide: { cell: [112, 70], gap: 3, layout: WIDE }, narrow: { cell: [96, 60], gap: 2, layout: NARROW } } as const
  const byId = new Map(SHOTS.map(shot => [shot.id, shot]))
  const rows: string[] = []
  for (const name of ['wide', 'narrow'] as const) {
    const { cell: [cw, ch], gap, layout } = GEOMETRY[name]
    const width = layout.cols * cw + (layout.cols - 1) * gap
    const height = layout.rows * ch + (layout.rows - 1) * gap
    const tiles = new Map<string, Buffer>()
    const tileOf = (id: string): Buffer => {
      const known = tiles.get(id)
      if (known !== undefined) return known
      const shot = byId.get(id)
      if (shot === undefined) throw new Error(`The plan names an unknown picture ${id}`)
      const filter = shot.device === 'phone' ? `scale=${cw}:-2:flags=area,crop=${cw}:${ch}:0:0` : `scale=${cw}:${ch}:flags=area`
      const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', sourceOf(shot), '-vf', filter, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
      tiles.set(id, raw)
      return raw
    }
    const looks: string[] = []
    const tinies: string[] = []
    for (const look of PLAN_LOOKS) {
      const plan = MOSAIC_PLANS[name].looks[look]
      const canvas = Buffer.alloc(width * height * 3)
      for (let i = 0; i < canvas.length; i += 3) { canvas[i] = 0x0c; canvas[i + 1] = 0x0b; canvas[i + 2] = 0x0a }
      plan.cells.forEach((index, at) => {
        const tile = tileOf(PLAN_IDS[index] ?? '')
        const x0 = (at % layout.cols) * (cw + gap)
        const y0 = Math.floor(at / layout.cols) * (ch + gap)
        for (let y = 0; y < ch; y++) tile.copy(canvas, ((y0 + y) * width + x0) * 3, y * cw * 3, (y + 1) * cw * 3)
      })
      const key = `atlas-${name}-${look}|${createHash('sha256').update(canvas).digest('hex')}`
      const file = `atlas-${name}-${look}`
      const hash = await cached(key, file, () => encode(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-i', '-'], undefined, file, { crf: 40, webp: 62 }, canvas))
      // The first paint's placeholder: one pixel per cell, inlined, drawn blocky under the atlas until it loads.
      const tiny = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-i', '-', '-vf', `scale=${layout.cols}:${layout.rows}:flags=area`, '-c:v', 'libwebp', '-lossless', '1', '-f', 'webp', '-'], { input: canvas })
      looks.push(`      '${look}': '${hash}',`)
      tinies.push(`      '${look}': 'data:image/webp;base64,${tiny.toString('base64')}',`)
      const size = statSync(join(out, `${file}.${hash}.avif`)).size
      console.log(`${file}: ${width}x${height}, AVIF ${(size / 1024).toFixed(0)} KB, WebP ${(statSync(join(out, `${file}.${hash}.webp`)).size / 1024).toFixed(0)} KB`)
    }
    rows.push(`  ${name}: {\n    cell: [${cw}, ${ch}],\n    gap: ${gap},\n    width: ${width},\n    height: ${height},\n    looks: {\n${looks.join('\n')}\n    },\n    tiny: {\n${tinies.join('\n')}\n    },\n  },`)
  }
  prune(file => file.startsWith('atlas-'))
  writeFileSync(new URL('../src/home/lod-atlases.ts', import.meta.url), `/**
 * The home page's mosaic atlases (L0): each layout's whole mosaic in each look as one picture in \`public/lod/\`,
 * with the cell and gap sizes it was laid out with, in atlas pixels, and a one-pixel-per-cell placeholder. Generated by \`scripts/lod.ts atlases\`; do
 * not edit by hand.
 *
 * @module @delorun/website/home/lod-atlases
 */

/** The atlases, by layout. */
export const LOD_ATLASES = {
${rows.join('\n')}
} as const
`)
}
writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(cache)))
