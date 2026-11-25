/**
 * The private fix board: the causes of failing cards ranked by what fixing each would unblock, in plugins and in the
 * downloads those plugins have. A plugin counts as unblocked by a cause when that is the only cause on its Delorun card.
 * Downloads come from the npm registry's public download counts, fetched at run time and cached for a day.
 *
 * @module @delorun/tools/compat-bench/board
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadCauses, type Card } from './card.ts'

/** How long a cached download count is used, in milliseconds. */
export const DOWNLOADS_TTL_MS = 24 * 60 * 60 * 1000

/** The cache file of download counts. */
export const DOWNLOADS_CACHE = join(homedir(), '.cache', 'delorun', 'compat-bench', 'downloads.json')

/** Fetches one package's last-month downloads, or undefined when the registry does not know it. */
export type DownloadsFetch = (name: string) => Promise<number | undefined>

/**
 * The npm registry's public API.
 * @param name - the package.
 * @returns its downloads in the last month.
 */
export const registryDownloads: DownloadsFetch = async (name) => {
  const response = await fetch(`https://api.npmjs.org/downloads/point/last-month/${name.replace('/', '%2f')}`, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) return undefined
  const body = await response.json() as { downloads?: number }
  return typeof body.downloads === 'number' ? body.downloads : undefined
}

/**
 * Downloads for each package: the card's own figure, the cache while fresh, otherwise the registry.
 * @param cards - the cards.
 * @param options - the fetcher, the cache file and the clock, replaceable in tests.
 * @returns downloads by package name; a package the registry does not know is absent.
 */
export async function downloadsFor(cards: readonly Card[], options: { readonly fetch?: DownloadsFetch, readonly cache?: string, readonly now?: number } = {}): Promise<Map<string, number>> {
  const fetcher = options.fetch ?? registryDownloads
  const cachePath = options.cache ?? DOWNLOADS_CACHE
  const now = options.now ?? Date.now()
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, { downloads: number, at: number }> : {}
  const result = new Map<string, number>()
  let changed = false
  for (const name of new Set(cards.map(card => card.plugin.package))) {
    const own = cards.find(card => card.plugin.package === name && card.plugin.downloads !== undefined)?.plugin.downloads
    const cached = cache[name]
    if (own !== undefined) { result.set(name, own); continue }
    if (cached !== undefined && now - cached.at < DOWNLOADS_TTL_MS) { result.set(name, cached.downloads); continue }
    const fetched = await fetcher(name).catch(() => undefined)
    if (fetched !== undefined) {
      result.set(name, fetched)
      cache[name] = { downloads: fetched, at: now }
      changed = true
    }
  }
  if (changed) {
    mkdirSync(dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`)
  }
  return result
}

/** One line of the board. */
export interface BoardRow {
  /** The cause id. */
  readonly cause: string
  /** Plugins that have this cause on their Delorun card. */
  readonly plugins: readonly string[]
  /** Plugins whose only cause it is: fixing it unblocks them. */
  readonly unblocked: readonly string[]
  /** The downloads of the unblocked plugins. */
  readonly downloads: number
}

/**
 * Rank the causes of the Delorun cards that did not work.
 * @param cards - one card per plugin and host.
 * @param downloads - downloads by package.
 * @returns the rows, most downloads unblocked first, then most plugins, then the cause id.
 */
export function rankCauses(cards: readonly Card[], downloads: ReadonlyMap<string, number>): BoardRow[] {
  const byCause = new Map<string, { plugins: Set<string>, unblocked: Set<string> }>()
  for (const card of cards) {
    if (card.host.kind === 'stock') continue
    const causes = new Set(card.stages.flatMap(each => each.failures.map(failure => failure.cause)))
    for (const cause of causes) {
      const entry = byCause.get(cause) ?? { plugins: new Set<string>(), unblocked: new Set<string>() }
      entry.plugins.add(card.plugin.package)
      if (causes.size === 1) entry.unblocked.add(card.plugin.package)
      byCause.set(cause, entry)
    }
  }
  return [...byCause.entries()].map(([cause, entry]) => ({
    cause,
    plugins: [...entry.plugins].sort(),
    unblocked: [...entry.unblocked].sort(),
    downloads: [...entry.unblocked].reduce((sum, name) => sum + (downloads.get(name) ?? 0), 0),
  })).sort((a, b) => b.downloads - a.downloads || b.plugins.length - a.plugins.length || a.cause.localeCompare(b.cause))
}

/**
 * Render the board.
 * @param rows - the ranked rows.
 * @returns the Markdown text.
 */
export function renderBoard(rows: readonly BoardRow[]): string {
  const summaries = new Map(loadCauses().map(cause => [cause.id, cause]))
  return [
    '# Plugin fix board (private)',
    '',
    'Causes of the Delorun cards that did not work, ranked by the monthly npm downloads of the plugins that this cause alone blocks.',
    '',
    '| Cause | Fix class | Plugins | Unblocked alone | Downloads unblocked |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.cause}: ${summaries.get(row.cause)?.summary ?? 'not in causes.json'} | ${summaries.get(row.cause)?.fixClass ?? '?'} | ${row.plugins.join(', ')} | ${row.unblocked.join(', ') || 'none'} | ${String(row.downloads)} |`),
    '',
  ].join('\n')
}
