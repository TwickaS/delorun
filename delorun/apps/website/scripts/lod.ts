/**
 * Builds the home page's level-of-detail pyramid as static files in `public/lod/` (git-ignored; Cloudflare serves them
 * as static assets with immutable caching, see `public/_headers`), each as AVIF with a WebP fallback:
 *
 * - `tiles`: for every picture in `src/home/shots.ts` and the film, L1 (96 px wide, a mosaic tile), L2 (480 px, or 300
 *   for a phone capture: the zoom and the wall) and L3 (the capture's own width: the lightbox). Manifest:
 *   `src/home/lod-tiles.ts`.
 * - `atlases`: for every layout, look and mode in `src/home/mosaic-plans.ts`, L0, the whole mosaic as one picture: the
 *   first paint, and the sprite a re-tile turns each tile to. Manifest: `src/home/lod-atlases.ts`.
 *
 * Sources are the pictures in the folder `SITE_PICTURES_DIR` names (written by `wall-shots.ts` and `ingest-owner-shots.ts`). Nothing is drawn or
 * retouched; each file is the screenshot, scaled. A file's name carries a hash of what it is made from (the source's
 * bytes, the level and the encoder settings), so the names are the same on every machine and a changed picture gets a
 * new name. Files no longer named are removed. A cache in `node_modules/.cache/lod/` skips what exists.
 *
 * With no argument the script runs `tiles`, then `atlases`, in verify mode, which is what `pnpm build` runs: it encodes
 * the files the committed manifests name and fails when a manifest is stale. `--write` rewrites the manifests; run
 * `shot-colours.ts` and `mosaic-plans.ts` between the two modes when the pictures change. Needs `ffmpeg` with libaom-av1
 * and libwebp on the PATH.
 *
 * Usage: `node scripts/lod.ts [tiles|atlases] [--write]`
 *
 * @module @delorun/website/scripts/lod
 */
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { LOD_TILES } from '../src/home/lod-tiles.ts'
import { FILM, SHOTS, type Device } from '../src/home/shots.ts'
import { picturesDir } from './pictures-dir.ts'

/** A picture the pyramid covers. */
interface Picture {
  readonly id: string
  readonly device: Device
}

/** Every picture the page shows: the wall's, then the film's own computer and phone frames. */
const PICTURES: readonly Picture[] = [...new Map<string, Picture>([
  ...SHOTS.map(shot => [shot.id, shot] as const),
  ...FILM.flatMap(chapter => [chapter.id, ...(chapter.dark === undefined ? [] : [chapter.dark.id])].map(id => [id, { id, device: 'computer' }] as const)),
  ...FILM.flatMap(chapter => [chapter.phone.file, ...(chapter.phone.dark === undefined ? [] : [chapter.phone.dark])].map(id => [id, { id, device: 'phone' }] as const)),
].reverse()).values()].reverse()

const run = promisify(execFile)

const args = process.argv.slice(2)
const write = args.includes('--write')
const requested = args.filter(arg => !arg.startsWith('--'))
const modes = requested.length === 0 ? ['tiles', 'atlases'] : requested
if (modes.some(mode => mode !== 'tiles' && mode !== 'atlases')) throw new Error('Usage: node scripts/lod.ts [tiles|atlases] [--write]')

const out = new URL('../public/lod/', import.meta.url).pathname
const cacheDir = new URL('../node_modules/.cache/lod/', import.meta.url).pathname
mkdirSync(out, { recursive: true })
mkdirSync(cacheDir, { recursive: true })

/** Each level's width by device; L3 keeps the source's width. */
const WIDTHS = { 1: { computer: 96, phone: 96 }, 2: { computer: 480, phone: 300 } } as const

/** The encoder settings by level. They are part of every file's hash, so changing them renames the files. */
const QUALITY = { tile: { crf: 34, webp: 74 }, full: { crf: 30, webp: 80 }, atlas: { crf: 40, webp: 62 } } as const

/** Bumped when the encoder's command line changes in a way the settings above do not show. */
const ENCODER = 'ffmpeg-libaom-cpu6-libwebp-v1'

/** How many encodes run at once; the machine is shared. */
const PARALLEL = 2

const hashes = new Map<string, string>()

/**
 * The hash of a picture file's bytes.
 * @param source - the path.
 * @returns the first ten hex digits of its SHA-256.
 */
function sourceHash(source: string): string {
  const known = hashes.get(source)
  if (known !== undefined) return known
  const hash = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 10)
  hashes.set(source, hash)
  return hash
}

/**
 * The width of a picture file, in pixels.
 * @param source - the path.
 * @returns the width.
 */
function widthOf(source: string): number {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', source], { encoding: 'utf8' }).trim())
}

/**
 * The source picture of a shot.
 * @param shot - the shot.
 * @returns its path.
 */
function sourceOf(shot: Picture): string {
  const path = join(picturesDir(), `${shot.id}.webp`)
  if (!existsSync(path)) throw new Error(`No source picture for ${shot.id} in ${picturesDir()}: run scripts/wall-shots.ts or ingest-owner-shots.ts`)
  return path
}

/**
 * The name hash of a file: what it is made from.
 * @param parts - the strings that make it, such as the source's hash and the level.
 * @returns ten hex digits.
 */
function nameHash(...parts: readonly string[]): string {
  return createHash('sha256').update([ENCODER, ...parts].join('|')).digest('hex').slice(0, 10)
}

const keep = new Set<string>()

/**
 * Encodes one picture, or raw RGB on standard input, as AVIF and WebP into `public/lod/` unless both files exist.
 * @param input - ffmpeg input arguments.
 * @param filter - the video filter, or undefined for none.
 * @param name - the file name before the hash.
 * @param hash - the hash in both files' names.
 * @param quality - AVIF crf and WebP quality.
 * @param raw - makes the raw RGB to pipe in, when the input is standard input; called only when a file is missing.
 */
async function encode(input: readonly string[], filter: string | undefined, name: string, hash: string, quality: { readonly crf: number; readonly webp: number }, raw?: () => Buffer): Promise<void> {
  keep.add(`${name}.${hash}.avif`)
  keep.add(`${name}.${hash}.webp`)
  if (existsSync(join(out, `${name}.${hash}.avif`)) && existsSync(join(out, `${name}.${hash}.webp`))) return
  const tmpAvif = join(cacheDir, `${name}.tmp.avif`)
  const tmpWebp = join(cacheDir, `${name}.tmp.webp`)
  const vf = filter === undefined ? [] : ['-vf', filter]
  const avifArgs = ['-loglevel', 'error', '-y', ...input, ...vf, '-c:v', 'libaom-av1', '-still-picture', '1', '-crf', String(quality.crf), '-cpu-used', '6', '-pix_fmt', 'yuv420p', tmpAvif]
  const webpArgs = ['-loglevel', 'error', '-y', ...input, ...vf, '-c:v', 'libwebp', '-quality', String(quality.webp), tmpWebp]
  if (raw === undefined) {
    await run('nice', ['-n', '10', 'ffmpeg', ...avifArgs])
    await run('nice', ['-n', '10', 'ffmpeg', ...webpArgs])
  } else {
    const pixels = raw()
    execFileSync('nice', ['-n', '10', 'ffmpeg', ...avifArgs], { input: pixels })
    execFileSync('nice', ['-n', '10', 'ffmpeg', ...webpArgs], { input: pixels })
  }
  writeFileSync(join(out, `${name}.${hash}.avif`), readFileSync(tmpAvif))
  writeFileSync(join(out, `${name}.${hash}.webp`), readFileSync(tmpWebp))
  rmSync(tmpAvif)
  rmSync(tmpWebp)
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

/**
 * Removes files of a kind this run did not name.
 * @param prefix - true for the files of this kind.
 */
function prune(prefix: (file: string) => boolean): void {
  for (const file of readdirSync(out)) if (prefix(file) && !keep.has(file)) rmSync(join(out, file))
}

/**
 * Fails when a hash the run computed differs from the committed manifest's, unless `--write` rewrites the manifest.
 * @param what - what the hash names, for the message.
 * @param computed - the hash this run computed.
 * @param committed - the hash in the committed manifest.
 * @throws Error when they differ and `--write` is not given.
 */
function expect(what: string, computed: string, committed: string | undefined): void {
  if (!write && computed !== committed) throw new Error(`${what} is stale in the committed manifest: run node scripts/lod.ts --write (after shot-colours.ts and mosaic-plans.ts when the pictures changed)`)
}

/**
 * Writes a manifest under `--write`.
 * @param file - the manifest's path under `src/home/`.
 * @param text - what the run computed.
 */
function settle(file: string, text: string): void {
  if (write) writeFileSync(new URL(`../src/home/${file}`, import.meta.url), text)
}

if (modes.includes('tiles')) {
  const table = new Map<string, (string | number)[]>()
  const jobs = PICTURES.flatMap(shot => {
    const source = sourceOf(shot)
    const list: (string | number)[] = ['', '', '', widthOf(source)]
    table.set(shot.id, list)
    return ([1, 2, 3] as const).map(level => async () => {
      const width = level === 3 ? undefined : WIDTHS[level][shot.device]
      const filter = width === undefined ? 'scale=trunc(iw/2)*2:trunc(ih/2)*2' : `scale=${width}:-2:flags=lanczos`
      const quality = level === 3 ? QUALITY.full : QUALITY.tile
      const hash = nameHash(sourceHash(source), String(level), filter, String(quality.crf), String(quality.webp))
      list[level - 1] = hash
      expect(`${shot.id} level ${String(level)}`, hash, LOD_TILES[shot.id]?.[level - 1])
      expect(`${shot.id} width`, String(list[3]), String(LOD_TILES[shot.id]?.[3]))
      await encode(['-i', source], filter, `${shot.id}.${level}`, hash, quality)
    })
  })
  await pool(jobs)
  prune(file => !file.startsWith('atlas-'))
  settle('lod-tiles.ts', `/**
 * The content hashes of each picture's level-of-detail files in \`public/lod/\`: L1, L2 and L3, each as AVIF and
 * WebP, and the width of L3, which is the source's. Generated by \`scripts/lod.ts tiles --write\`; do not edit by hand.
 *
 * @module @delorun/website/home/lod-tiles
 */

/** The hashes of L1, L2 and L3, then L3's width in pixels, by picture id. */
export const LOD_TILES: Readonly<Record<string, readonly [string, string, string, number]>> = {
${[...table].map(([id, list]) => `  '${id}': [${list.map(item => typeof item === 'number' ? String(item) : `'${item}'`).join(', ')}],`).join('\n')}
}
`)
  console.log(`tiles: ${String(PICTURES.length)} pictures ${write ? 'written' : 'verified'}`)
}

if (modes.includes('atlases')) {
  // Loaded here because a stale manifest from before a plan change must not stop the `tiles` run.
  const { LOD_ATLASES } = await import('../src/home/lod-atlases.ts')
  const { PLAN_IDS, PLAN_LOOKS, PLAN_MODES } = await import('../src/home/mosaic-plans.ts')
  const { planCells } = await import('../src/home/plans.ts')
  const { NARROW, WIDE } = await import('../src/home/mosaic.ts')
  /** Each layout's cell and gap in atlas pixels: about twice a tile's size on a typical screen of that width. */
  const GEOMETRY = { wide: { cell: [72, 45], gap: 2, layout: WIDE }, narrow: { cell: [64, 40], gap: 2, layout: NARROW } } as const
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
    const canvasOf = (cells: readonly number[]): Buffer => {
      const canvas = Buffer.alloc(width * height * 3)
      for (let i = 0; i < canvas.length; i += 3) { canvas[i] = 0x0c; canvas[i + 1] = 0x0b; canvas[i + 2] = 0x0a }
      cells.forEach((index, at) => {
        const tile = tileOf(PLAN_IDS[index] ?? '')
        const x0 = (at % layout.cols) * (cw + gap)
        const y0 = Math.floor(at / layout.cols) * (ch + gap)
        for (let y = 0; y < ch; y++) tile.copy(canvas, ((y0 + y) * width + x0) * 3, y * cw * 3, (y + 1) * cw * 3)
      })
      return canvas
    }
    const looks: string[] = []
    const tinies: string[] = []
    for (const look of PLAN_LOOKS) {
      const entries: string[] = []
      const tinyEntries: string[] = []
      for (const mode of PLAN_MODES) {
        const cells = planCells(name, look, mode)
        const file = `atlas-${name}-${look}-${mode}`
        const hash = nameHash(name, look, mode, `${String(width)}x${String(height)}`, ...cells.map(index => sourceHash(sourceOf({ id: PLAN_IDS[index] ?? '', device: 'computer' }))))
        await encode(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${String(width)}x${String(height)}`, '-i', '-'], undefined, file, hash, QUALITY.atlas, () => canvasOf(cells))
        expect(file, hash, LOD_ATLASES[name].looks[look][mode])
        entries.push(`        '${mode}': '${hash}',`)
        if (!write) continue
        // The first paint's placeholder: one pixel per cell, inlined, drawn blocky under the atlas until it loads.
        const tiny = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${String(width)}x${String(height)}`, '-i', '-', '-vf', `scale=${String(layout.cols)}:${String(layout.rows)}:flags=area`, '-c:v', 'libwebp', '-lossless', '1', '-f', 'webp', '-'], { input: canvasOf(cells) })
        tinyEntries.push(`        '${mode}': 'data:image/webp;base64,${tiny.toString('base64')}',`)
      }
      looks.push(`      '${look}': {\n${entries.join('\n')}\n      },`)
      tinies.push(`      '${look}': {\n${tinyEntries.join('\n')}\n      },`)
    }
    rows.push(`  ${name}: {\n    cell: [${String(cw)}, ${String(ch)}],\n    gap: ${String(gap)},\n    width: ${String(width)},\n    height: ${String(height)},\n    looks: {\n${looks.join('\n')}\n    },\n    tiny: {\n${tinies.join('\n')}\n    },\n  },`)
  }
  prune(file => file.startsWith('atlas-'))
  settle('lod-atlases.ts', `/**
 * The home page's mosaic atlases (L0): each layout's whole mosaic in each look and mode as one picture in
 * \`public/lod/\`, with the cell and gap sizes it was laid out with, in atlas pixels, and a one-pixel-per-cell
 * placeholder. Generated by \`scripts/lod.ts atlases --write\`; do not edit by hand.
 *
 * @module @delorun/website/home/lod-atlases
 */

/** The atlases, by layout. */
export const LOD_ATLASES = {
${rows.join('\n')}
} as const
`)
  console.log(write ? 'atlases: written' : 'atlases: verified')
}
