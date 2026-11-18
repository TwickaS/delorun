/**
 * Adds the owner's own screenshots to a local inbox, ready for a person to vet. For each PNG, JPEG or WebP in the inbox
 * that `manifest.json` does not list yet, it makes the three level-of-detail files `lod.ts` makes (L1, L2, L3,
 * each as AVIF and WebP with a content hash in the name), measures the picture's colour and appends an unvetted
 * manifest entry. Level files go into `<inbox>/lod/`, never into `public/`: an unvetted picture must not sit in a
 * served folder.
 *
 * Each new entry has `vetted: false`, `screen: null`, `theme: null` and an empty caption, and its `mode` is a guess from
 * the picture's lightness (`modeGuessed: true`). A person must look at every picture for paths, names, email addresses
 * and keys, fill in `screen`, `theme` and `caption`, correct `mode` if needed, and set `vetted: true`. Only then does
 * `wall-shots.ts <source folder> <inbox>` consider it. needs `ffmpeg` with
 * libaom-av1 and libwebp, and `ffprobe`, on the PATH.
 *
 * Usage: `node scripts/ingest-owner-shots.ts [inbox folder]` (default `~/delorun-shots-inbox`)
 *
 * @module @delorun/website/scripts/ingest-owner-shots
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { measure, type Colour } from './colour.ts'

/** One entry of the inbox's `manifest.json`. */
interface OwnerEntry {
  readonly file: string
  readonly id: string
  readonly source: 'owner'
  readonly vetted: boolean
  readonly width: number
  readonly height: number
  readonly device: 'computer' | 'phone'
  readonly mode: 'light' | 'dark'
  readonly modeGuessed: boolean
  readonly screen: string | null
  readonly theme: string | null
  readonly caption: string
  readonly colour: Colour
  readonly lod: readonly [string, string, string]
  readonly addedAt: string
}

/** The picture extensions the inbox accepts. */
const PICTURE = /\.(png|jpe?g|webp)$/i

/** A computer picture is at least this wide; the same split `wall-shots.ts` uses. */
const COMPUTER_WIDTH = 800

/** A picture at least this light (CIE L) is guessed to be a light-mode picture. */
const LIGHT_FROM = 50

/** Each level's width by device; L3 keeps the source's width, as in `lod.ts`. */
const WIDTHS = { 1: { computer: 96, phone: 96 }, 2: { computer: 480, phone: 300 } } as const

/**
 * Makes a manifest id from a file name.
 * @param file - the picture's file name.
 * @param taken - ids already in use.
 * @returns `owner-` and the name's lower-case letters, digits and hyphens, with a number appended if needed to be unique.
 */
function idOf(file: string, taken: ReadonlySet<string>): string {
  const slug = file.replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const base = `owner-${slug === '' ? 'shot' : slug}`
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}

/**
 * Reads a picture's size with `ffprobe`.
 * @param path - the picture's path.
 * @returns its width and height in pixels.
 */
function sizeOf(path: string): { readonly width: number; readonly height: number } {
  const text = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path]).toString().trim()
  const [width, height] = text.split(',').map(Number)
  if (width === undefined || height === undefined || !(width > 0) || !(height > 0)) throw new Error(`Could not read the size of ${path}: ${text}`)
  return { width, height }
}

/**
 * Writes one level of one picture as AVIF and WebP, named by their content, with the arguments `lod.ts` uses.
 * @param source - the picture's path.
 * @param level - 1, 2 or 3.
 * @param device - the picture's device, which sets L1 and L2's width.
 * @param name - the file name before the hash.
 * @param lod - the folder the files go into.
 * @param scratch - a folder for the files before they are named.
 * @returns the hash in both files' names.
 */
function encode(source: string, level: 1 | 2 | 3, device: 'computer' | 'phone', name: string, lod: string, scratch: string): string {
  const width = level === 3 ? undefined : WIDTHS[level][device]
  const filter = width === undefined ? 'scale=trunc(iw/2)*2:trunc(ih/2)*2' : `scale=${width}:-2:flags=lanczos`
  const quality = level === 3 ? { crf: 30, webp: 80 } : { crf: 34, webp: 74 }
  const tmpAvif = join(scratch, `${name}.tmp.avif`)
  const tmpWebp = join(scratch, `${name}.tmp.webp`)
  const input = ['-i', source, '-vf', filter]
  execFileSync('nice', ['-n', '10', 'ffmpeg', '-loglevel', 'error', '-y', ...input, '-c:v', 'libaom-av1', '-still-picture', '1', '-crf', String(quality.crf), '-cpu-used', '6', '-pix_fmt', 'yuv420p', tmpAvif])
  execFileSync('nice', ['-n', '10', 'ffmpeg', '-loglevel', 'error', '-y', ...input, '-c:v', 'libwebp', '-quality', String(quality.webp), tmpWebp])
  const avif = readFileSync(tmpAvif)
  const webp = readFileSync(tmpWebp)
  const hash = createHash('sha256').update(avif).update(webp).digest('hex').slice(0, 10)
  writeFileSync(join(lod, `${name}.${hash}.avif`), avif)
  writeFileSync(join(lod, `${name}.${hash}.webp`), webp)
  rmSync(tmpAvif)
  rmSync(tmpWebp)
  return hash
}

const inbox = resolve(process.argv[2] ?? join(homedir(), 'delorun-shots-inbox'))
if (!existsSync(inbox)) throw new Error(`The inbox ${inbox} does not exist`)
const manifestFile = join(inbox, 'manifest.json')
if (!existsSync(manifestFile)) writeFileSync(manifestFile, '[]\n')
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as OwnerEntry[]
const known = new Set(manifest.map(entry => entry.file))
const ids = new Set(manifest.map(entry => entry.id))
const fresh = readdirSync(inbox).filter(name => PICTURE.test(name) && !known.has(name)).sort()

const lod = join(inbox, 'lod')
mkdirSync(lod, { recursive: true })
const scratch = mkdtempSync(join(tmpdir(), 'ingest-owner-shots-'))
try {
  for (const file of fresh) {
    const path = join(inbox, file)
    const { width, height } = sizeOf(path)
    const device = width >= COMPUTER_WIDTH ? 'computer' : 'phone'
    const id = idOf(file, ids)
    ids.add(id)
    const colour = measure(path, device === 'phone')
    const hashes = ([1, 2, 3] as const).map(level => encode(path, level, device, `${id}.${level}`, lod, scratch)) as [string, string, string]
    manifest.push({
      file, id, source: 'owner', vetted: false, width, height, device,
      mode: colour.l >= LIGHT_FROM ? 'light' : 'dark', modeGuessed: true,
      screen: null, theme: null, caption: '', colour, lod: hashes, addedAt: new Date().toISOString(),
    })
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`added ${id}: ${width}x${height} ${device}, ${manifest[manifest.length - 1]?.mode} (guessed), L=${colour.l.toFixed(1)}`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

const unvetted = manifest.filter(entry => !entry.vetted).length
console.log(`${fresh.length} new, ${manifest.length - fresh.length} already listed, ${unvetted} unvetted in ${manifestFile}`)
if (unvetted > 0) console.log('Before any of these is used, a person must look at each picture for paths, names, emails and keys, fill in screen, theme and caption, and set vetted: true.')
