/**
 * Measures the built home page against the site's weight limits, compressed with Brotli as a host sends them: the
 * first screen (the page's HTML, its stylesheets and the two font files) and the script that makes the page
 * interactive (the entry and every module the page preloads with it). Sections loaded on approach are not counted.
 *
 * Usage: `node scripts/page-weight.ts [out-dir]` after a build. Exits 1 when a total is over its limit.
 *
 * @module @delorun/website/scripts/page-weight
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { brotliCompressSync, constants } from 'node:zlib'

/** The limits in kilobytes (1024 bytes), compressed: the plan's first screen and the lead's entry limit (L38). */
export const LIMITS_KB = { firstScreen: 120, script: 110 } as const

/**
 * The Brotli size of some bytes at the quality a host uses for static files.
 * @param bytes - the file's contents.
 * @returns the compressed size in bytes.
 */
export function brotliSize(bytes: Uint8Array): number {
  return brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length
}

/**
 * The site paths a page links with one kind of tag.
 * @param html - the page.
 * @param pattern - a pattern whose first group is the path.
 * @returns the paths, each once.
 */
function linked(html: string, pattern: RegExp): string[] {
  return [...new Set([...html.matchAll(pattern)].map(match => match[1] as string))]
}

/** One file of a total, with its sizes. */
export interface Weighed {
  readonly path: string
  readonly raw: number
  readonly compressed: number
}

/**
 * Weighs the home page of a built site.
 * @param outDir - the static site's directory.
 * @returns the files of the first screen and of the interactive script.
 */
export function weighHome(outDir: string): { firstScreen: Weighed[], script: Weighed[] } {
  const weigh = (path: string): Weighed => {
    const bytes = readFileSync(join(outDir, path))
    return { path, raw: bytes.length, compressed: brotliSize(bytes) }
  }
  const html = readFileSync(join(outDir, 'index.html'), 'utf8')
  const styles = linked(html, /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)
  const fonts = readdirSync(join(outDir, 'assets')).filter(name => name.endsWith('.woff2')).map(name => `/assets/${name}`)
  const scripts = [...linked(html, /<script[^>]*type="module"[^>]*src="([^"]+)"/g), ...linked(html, /<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)]
  return {
    firstScreen: [weigh('index.html'), ...styles.map(weigh), ...fonts.map(weigh)],
    script: [...new Set(scripts)].map(weigh),
  }
}

/**
 * The compressed total of some files, in kilobytes.
 * @param files - the files.
 * @returns the total, to one decimal place.
 */
export function totalKb(files: readonly Weighed[]): number {
  return Math.round(files.reduce((sum, file) => sum + file.compressed, 0) / 102.4) / 10
}

if (import.meta.main) {
  const weights = weighHome(resolve(process.argv[2] ?? 'out'))
  let over = false
  for (const [name, files] of Object.entries(weights) as [keyof typeof LIMITS_KB, Weighed[]][]) {
    const total = totalKb(files)
    over ||= total > LIMITS_KB[name]
    console.log(`${name}: ${total} KB of ${LIMITS_KB[name]} KB`)
    for (const file of files) console.log(`  ${file.path} ${Math.round(file.raw / 102.4) / 10} KB raw, ${Math.round(file.compressed / 102.4) / 10} KB compressed`)
  }
  if (over) process.exitCode = 1
}
