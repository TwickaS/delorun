/**
 * The product site's weight table (plan, "Weight limits"; L38) as a measurement of a built `out/` directory. Sizes are
 * brotli, which is what a static host sends. `scripts/check-weight.ts` prints the numbers and fails over a limit.
 *
 * @module @delorun/website/scripts/weight
 */
import { brotliCompressSync } from 'node:zlib'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** One kilobyte, as the plan counts it. */
const KB = 1000

/** The limits, in bytes. The names match the plan's table. */
export const LIMITS = {
  /**
   * The whole prerendered HTML of the page (every section's still included, below the fold too, since a page with scripts
   * off shows them), its linked stylesheets and the brand fonts, before any section script. 125 KB by L54; the plan's
   * table said 120 KB for the first screen alone.
   */
  firstScreen: 125 * KB,
  /** Font files preloaded on the first screen. */
  preloadedFonts: 2,
  /** The script that makes the page interactive: the chunks the page loads at start. */
  interactiveScript: 115 * KB,
  /** A living section's own script and data, loaded on first use. */
  section: 40 * KB,
  /** The studio replica: its script, styles and one session's fixture. */
  replica: 120 * KB,
  /** Each further session's fixture. */
  session: 15 * KB,
  /** The whole page after every section has loaded, without pictures. */
  wholePage: 450 * KB,
} as const

/** The measured sizes, in bytes, and the chunks they came from. */
export interface Weights {
  readonly firstScreen: number
  readonly preloadedFonts: number
  readonly interactiveScript: number
  /** Every lazy chunk (script or style) with its size, by file name. */
  readonly lazy: ReadonlyArray<{ readonly file: string; readonly bytes: number; readonly kind: 'section' | 'replica' | 'session' }>
  readonly wholePage: number
}

/** The brand typefaces; their files count toward the first screen. */
const FONT_FILES = /(?:schibsted-grotesk|jetbrains-mono)[^/]*\.woff2$/

const brotli = (path: string): number => brotliCompressSync(readFileSync(path)).length

/**
 * What kind of lazy chunk a file is, by name: `replica` chunks hold the studio replica, `session` chunks a replayed
 * session's fixture, everything else a section.
 * @param file - the chunk's file name.
 * @returns the kind.
 */
export function chunkKind(file: string): 'section' | 'replica' | 'session' {
  if (/session/i.test(file)) return 'session'
  if (/replica/i.test(file)) return 'replica'
  return 'section'
}

/**
 * Measures a built site.
 * @param out - the built `out/` directory.
 * @returns the weights.
 * @throws Error when `out/index.html` is missing.
 */
export function measure(out: string): Weights {
  const indexPath = join(out, 'index.html')
  if (!existsSync(indexPath)) throw new Error(`${indexPath} does not exist; build the site first`)
  const html = readFileSync(indexPath, 'utf8')
  const assets = join(out, 'assets')
  const files = existsSync(assets) ? readdirSync(assets) : []
  const referenced = (pattern: RegExp): string[] => [...new Set([...html.matchAll(pattern)].map(match => match[1] ?? ''))].map(path => path.replace(/^\//, ''))
  const styles = referenced(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)
  const startScripts = [...referenced(/<script[^>]*src="([^"]+\.js)"/g), ...referenced(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)]
  const startSet = new Set(startScripts)
  const fonts = files.filter(file => FONT_FILES.test(file)).map(file => join('assets', file))
  const preloadedFonts = [...html.matchAll(/<link[^>]*rel="preload"[^>]*as="font"/g)].length
  const lazy = files
    .filter(file => /\.(?:js|css)$/.test(file) && !startSet.has(`assets/${file}`) && !styles.includes(`assets/${file}`))
    .map(file => ({ file, bytes: brotli(join(assets, file)), kind: chunkKind(file) }))
  const sum = (paths: readonly string[]): number => paths.reduce((total, path) => total + brotli(join(out, path)), 0)
  const firstScreen = brotli(indexPath) + sum(styles) + sum(fonts)
  const interactiveScript = sum([...startSet])
  const wholePage = brotli(indexPath) + sum(styles) + sum(fonts) + sum([...startSet]) + lazy.reduce((total, chunk) => total + chunk.bytes, 0)
  return { firstScreen, preloadedFonts, interactiveScript, lazy, wholePage }
}

/**
 * The limits a measurement breaks.
 * @param weights - the measurement.
 * @param limits - the limits; defaults to the plan's.
 * @returns one sentence per broken limit; empty when all hold.
 */
export function failures(weights: Weights, limits: typeof LIMITS = LIMITS): string[] {
  const out: string[] = []
  const over = (name: string, bytes: number, limit: number): void => { if (bytes > limit) out.push(`${name} is ${String(bytes)} bytes, over the limit of ${String(limit)}`) }
  over('the first screen', weights.firstScreen, limits.firstScreen)
  if (weights.preloadedFonts > limits.preloadedFonts) out.push(`${String(weights.preloadedFonts)} fonts are preloaded, over the limit of ${String(limits.preloadedFonts)}`)
  over('the interactive script', weights.interactiveScript, limits.interactiveScript)
  for (const chunk of weights.lazy) over(`the ${chunk.kind} chunk ${chunk.file}`, chunk.bytes, limits[chunk.kind])
  const replica = weights.lazy.filter(chunk => chunk.kind === 'replica').reduce((total, chunk) => total + chunk.bytes, 0)
  over('the replica', replica, limits.replica)
  over('the whole page', weights.wholePage, limits.wholePage)
  return out
}
