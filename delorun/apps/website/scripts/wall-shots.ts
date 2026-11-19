/**
 * Picks the home page's wall and mosaic pictures from a capture lane's set of studio screenshots and writes
 * `src/home/wall-shots.ts`. The source folder holds
 * `manifest*.json` files (fields `file`, `screen`, `theme`, `themeLabel`, `mode`, `width`, `caption`) and the PNGs they
 * name. Nothing is drawn or retouched: each copy is the screenshot, scaled.
 *
 * The pick is fixed for a given set, so every run gives the same page: the light pictures with the most peach in them
 * (for the mosaic's plug), the dark computer frames of a chat while the agent works and after it wrote a file (the
 * mosaic's living tile), then a set quota per screen, each pick taking the look, mode and device used least so far,
 * then more of each look the theme control steps through until each has enough light and dark pictures to re-tile most
 * of the mosaic in that look.
 * Empty states and screens that show a warning only a source build gives are left out.
 *
 * Then run `lod.ts tiles`, `shot-colours.ts`, `mosaic-plans.ts` and `lod.ts atlases`, in that
 * order.
 *
 * With `--owner <inbox folder>`, the vetted entries of its `manifest.json` (vetted, with a screen, a
 * theme and a caption) join the candidates; every other entry is ignored. Every picked picture, captured or owner's, is written as WebP into the folder `SITE_PICTURES_DIR` names.
 *
 * Usage: `node scripts/wall-shots.ts [--owner <inbox folder>] <capture folder>...`; a picture in several folders comes from the first.
 *
 * @module @delorun/website/scripts/wall-shots
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { measure, type Colour } from './colour.ts'
import { picturesDir } from './pictures-dir.ts'

/** One manifest entry, as the capture lane writes it. */
interface Entry {
  readonly file: string
  readonly screen: string
  readonly theme: string
  readonly themeLabel: string
  readonly mode: 'light' | 'dark'
  readonly width: number
  readonly caption: string
  /** The picture's id, when it is not its file name without `.png`: owner pictures. */
  readonly id?: string
  /** The picture's full path, when it is not in the source folder: owner pictures. */
  readonly path?: string
}

/** One entry of an owner inbox's `manifest.json`, as `ingest-owner-shots.ts` writes it and a person completes it. */
interface OwnerRecord {
  readonly file: string
  readonly id: string
  readonly vetted: boolean
  readonly width: number
  readonly mode: 'light' | 'dark'
  readonly screen: string | null
  readonly theme: string | null
  readonly caption: string
}

/** One candidate picture with its measured colour. */
interface Candidate extends Entry {
  readonly id: string
  readonly device: 'computer' | 'phone'
  readonly colour: Colour
}

/** Screens left out: an empty list, and a first-run step that shows a warning only a source build gives. */
const LEFT_OUT = new Set(['settings-changes', 'onboarding-step-4'])

/** The WebP quality of a source picture. */
const SOURCE_QUALITY = 95

/** How many pictures each screen gets on the wall, besides the plug's peach pictures. */
const QUOTA: Readonly<Record<string, number>> = {
  'chat-finished': 12,
  'chat-working': 10,
  'chat-after-run': 8,
  'chat-new': 6,
  'settings-appearance': 10,
  'plugins': 8,
  'settings-plugins': 8,
  'settings-general': 6,
  'settings-permissions': 6,
  'settings-models': 4,
  'onboarding-step-1': 6,
  'onboarding-step-2': 6,
  'onboarding-step-3': 6,
  'onboarding-step-5': 6,
  'onboarding-step-6': 6,
  'onboarding-step-7': 6,
  'onboarding-step-8': 6,
}

/** How many peach-look light pictures the mosaic's plug gets. */
const PLUG = 14

/** The looks the header's theme control steps through, by the captures' look ids, and how many light and how many dark
 * pictures each needs. */
const CYCLE = ['soft', 't3-code', 't3-chat', 'grove', 'ocean', 'ember', 'iris']
const PER_LOOK = 16

/** The screens whose dark computer frames the living tile plays, in order. */
const LIVING = ['chat-working', 'chat-after-run']

/** The looks whose accent is the brand's peach. */
const PEACH_LOOKS = new Set(['ember', 'custom-peach', 'custom-brand-peach'])

/** The wall's kind of screen for each captured screen. */
const KIND: Readonly<Record<string, string>> = {
  'chat-finished': 'chat',
  'chat-working': 'chat',
  'chat-after-run': 'chat',
  'chat-new': 'chat',
  'settings-appearance': 'looks',
  'plugins': 'plugins',
  'settings-plugins': 'plugins',
  'settings-general': 'settings',
  'settings-permissions': 'settings',
  'settings-models': 'settings',
}

const argv = process.argv.slice(2)
const at = argv.indexOf('--owner')
const inbox = at < 0 ? undefined : argv[at + 1]
const folders = argv.filter((_, index) => at < 0 || (index !== at && index !== at + 1))
if (folders.length === 0 || (at >= 0 && inbox === undefined)) throw new Error('Usage: node scripts/wall-shots.ts [--owner <inbox folder>] <capture folder>...')
const sources = picturesDir(process.env, false)

// A picture that appears in more than one folder comes from the first folder that has it, so a sharper set can go first
// and a set with screens the sharper one lacks can follow.
const captured: Entry[] = [...new Map(folders.flatMap(folder => readdirSync(folder)
  .filter(name => /^manifest.*\.json$/.test(name))
  .flatMap(name => (JSON.parse(readFileSync(join(folder, name), 'utf8')) as Entry[]).map(entry => ({ ...entry, path: join(folder, entry.file) })))
  .filter(entry => existsSync(entry.path ?? ''))).reverse().map(entry => [entry.file, entry] as const)).values()].reverse()

/**
 * Reads an owner inbox's manifest and keeps the entries a person has vetted and described.
 * @param folder - the inbox folder.
 * @returns the vetted entries as manifest entries with their own ids and full paths.
 */
function ownerEntries(folder: string): Entry[] {
  const records = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as OwnerRecord[]
  const entries = records.flatMap((record): Entry[] => {
    const { screen, theme, caption } = record
    if (record.vetted !== true || !screen?.trim() || !theme?.trim() || !caption.trim()) return []
    return [{ file: record.file, screen, theme, themeLabel: theme, mode: record.mode, width: record.width, caption, id: record.id, path: join(folder, record.file) }]
  })
  console.log(`owner inbox: ${entries.length} vetted, ${records.length - entries.length} ignored`)
  return entries
}
const entries: Entry[] = [...captured, ...(inbox === undefined ? [] : ownerEntries(inbox))]
const candidates: Candidate[] = entries
  .filter(entry => !LEFT_OUT.has(entry.screen))
  .sort((p, q) => p.file.localeCompare(q.file))
  .map(entry => {
    const device = entry.width < 1000 ? 'phone' : 'computer'
    return { ...entry, id: entry.id ?? entry.file.replace(/\.png$/, ''), device, colour: measure(entry.path ?? '', device === 'phone') }
  })
console.log(`measured ${candidates.length} candidates`)

// The plug's pictures first, then each screen's quota, each pick the least used look, mode and device so far.
const picked: Candidate[] = []
const used = new Map<string, number>()
const count = (key: string) => used.get(key) ?? 0
const take = (candidate: Candidate) => {
  picked.push(candidate)
  for (const key of [`look:${candidate.theme}`, `mode:${candidate.screen}:${candidate.mode}`, `device:${candidate.screen}:${candidate.device}`]) used.set(key, count(key) + 1)
}
candidates
  .filter(each => each.mode === 'light' && PEACH_LOOKS.has(each.theme))
  .sort((p, q) => q.colour.peach - p.colour.peach || p.id.localeCompare(q.id))
  .slice(0, PLUG)
  .forEach(take)
candidates
  .filter(each => LIVING.includes(each.screen) && each.mode === 'dark' && each.device === 'computer')
  .forEach(take)
for (const [screen, quota] of Object.entries(QUOTA)) {
  for (let i = 0; i < quota; i++) {
    const pool = candidates.filter(each => each.screen === screen && !picked.includes(each))
    const cost = (each: Candidate) => count(`look:${each.theme}`) * 4 + count(`mode:${screen}:${each.mode}`) * 3
      // Two computer pictures for each phone one: computer pictures read better as tiles.
      + count(`device:${screen}:${each.device}`) * (each.device === 'phone' ? 6 : 3)
    const best = pool.reduce<Candidate | undefined>((sofar, each) => sofar === undefined || cost(each) < cost(sofar) ? each : sofar, undefined)
    if (best === undefined) throw new Error(`Screen ${screen} has fewer than ${quota} pictures`)
    take(best)
  }
}

for (const look of CYCLE) {
  for (const mode of ['light', 'dark'] as const) {
    while (picked.filter(each => each.theme === look && each.mode === mode).length < PER_LOOK) {
      const pool = candidates.filter(each => each.theme === look && each.mode === mode && !picked.includes(each))
      // The screen this look has fewest of, then a computer picture before a phone one.
      const cost = (each: Candidate) => picked.filter(other => other.theme === look && other.screen === each.screen).length * 3 + (each.device === 'phone' ? 1 : 0)
      const best = pool.reduce<Candidate | undefined>((sofar, each) => sofar === undefined || cost(each) < cost(sofar) ? each : sofar, undefined)
      if (best === undefined) break
      take(best)
    }
  }
}

// The wall's order: each next picture the one least like the last few placed, by kind of screen, mode, look and
// device, so neighbours differ.
const order: Candidate[] = []
const rest = [...picked]
while (rest.length > 0) {
  const recent = order.slice(-4)
  const likeness = (each: Candidate) => recent.reduce((sum, near, i) => sum + (i + 1) * (
    (KIND[near.screen] ?? 'setup') === (KIND[each.screen] ?? 'setup') ? 4 : 0) + (i + 1) * (near.mode === each.mode ? 2 : 0)
    + (i + 1) * (near.theme === each.theme ? 2 : 0) + (i + 1) * (near.device === each.device ? 1 : 0), 0)
  const next = rest.reduce((best, each) => likeness(each) < likeness(best) ? each : best)
  order.push(next)
  rest.splice(rest.indexOf(next), 1)
}

// Each picked picture becomes a source `lod.ts` reads: the capture re-encoded as WebP at high quality, at its own size,
// which keeps the repository's copy a fraction of the PNG's.
mkdirSync(sources, { recursive: true })
for (const each of order) {
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', each.path ?? '', '-c:v', 'libwebp', '-quality', String(SOURCE_QUALITY), '-compression_level', '6', join(sources, `${each.id}.webp`)])
}

/**
 * The look's name as the lightbox's plate shows it.
 * @param label - the manifest's look label, such as `Ember` or `Custom brand peach`.
 * @returns the name, such as `Ember` or `Custom, brand peach accent`.
 */
function lookName(label: string): string {
  const custom = /^Custom (.+)$/.exec(label)
  return custom === null ? label : `Custom, ${(custom[1] ?? '').toLowerCase()} accent`
}

const rows = order.map(each => {
  const caption = each.caption.split(' · ')[0] ?? each.caption
  const kind = KIND[each.screen] ?? 'setup'
  return `  { id: '${each.id}', screen: '${kind}', tone: '${each.mode}', device: '${each.device}', caption: ${JSON.stringify(caption)}, theme: ${JSON.stringify(lookName(each.themeLabel))}, look: '${each.theme}' },`
})
writeFileSync(new URL('../src/home/wall-shots.ts', import.meta.url), `/**
 * The capture lane's pictures the home page's wall and mosaic show, in the wall's order. Generated by
 * \`scripts/wall-shots.ts\`; do not edit by hand.
 *
 * @module @delorun/website/home/wall-shots
 */
import type { Shot } from './shots.ts'

/** The pictures. Each caption names the screen; \`theme\` is the look the whole picture is in. */
export const WALL_SHOTS: readonly Shot[] = [
${rows.join('\n')}
]
`)
const plug = picked.slice(0, PLUG).map(each => `${each.id} ${(each.colour.peach * 100).toFixed(1)}%`)
console.log(`picked ${order.length}: ${order.filter(each => each.mode === 'light').length} light, ${order.filter(each => each.device === 'phone').length} phone; plug: ${plug.join(', ')}`)
console.log(`looks: ${[...new Set(order.map(each => each.theme))].map(theme => `${theme} ${order.filter(each => each.theme === theme).length}`).join(', ')}`)
