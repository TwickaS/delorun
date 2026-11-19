/**
 * The {@link SEARCH_PATH} route: find folders whose name holds the search text, walking the configured roots
 * breadth-first. The walk is bounded by depth, by the number of folders read and by time, and stops at the first bound
 * it meets, saying which. It skips hidden folders, dependency and build folders, the Delorun home and the stock home, and
 * never follows a symbolic link, so it stays inside the roots. Only folder names are read.
 * @module @delorun/plugin-new-workspace/search
 */
import { opendir } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalRoots, locationHomes, type LocationDeps } from './location.ts'
import { MAX_SEARCH_RESULTS, type SearchAnswer, type SuggestedPlace } from './wire.ts'

/** Folder names a search never enters: dependency, build and cache folders, and system folders that hold no projects. */
export const SKIPPED_NAMES: ReadonlySet<string> = new Set([
  'node_modules', 'bower_components', 'vendor', 'target', 'dist', 'build', 'out', '__pycache__', 'venv', 'env', 'site-packages',
  'Library', 'AppData', 'Applications', 'snap', 'go', 'Pods', 'DerivedData',
])

/** What a search needs from the harness. */
export interface SearchDeps extends LocationDeps {
  /** The configured roots. */
  readonly roots: readonly string[]
  /** How many folders deep below each root the walk looks. */
  readonly depth: number
  /** The most folders the walk reads. */
  readonly folders: number
  /** The most time the walk may take, in milliseconds. */
  readonly timeMs: number
  /** The clock, in milliseconds; `Date.now` outside tests. */
  readonly now?: () => number
}

/**
 * Find folders by name.
 * @param query - the text a folder's name holds, matched without case.
 * @param deps - the roots, the bounds, the environment and the log.
 * @returns the matches, nearest first, and where the walk stopped.
 */
export async function searchFolders(query: string, deps: SearchDeps): Promise<SearchAnswer> {
  const now = deps.now ?? Date.now
  const deadline = now() + deps.timeMs
  const needle = query.toLocaleLowerCase()
  const homes = await locationHomes(deps)
  const avoided = homes === 'unresolved' ? [] : await canonicalRoots([homes.delorunHome, homes.stockHome])
  const results: SuggestedPlace[] = []
  const queue: { readonly path: string, readonly depth: number }[] = (await canonicalRoots(deps.roots)).map(path => ({ path, depth: 0 }))
  const seen = new Set<string>()
  let read = 0
  while (queue.length > 0) {
    const next = queue.shift() as { readonly path: string, readonly depth: number }
    if (seen.has(next.path)) continue
    seen.add(next.path)
    if (now() >= deadline) return { results, stopped: 'time' }
    if (++read > deps.folders) return { results, stopped: 'limit' }
    let directory
    try {
      directory = await opendir(next.path)
    } catch (_unreadable) {
      // A folder the person cannot read holds nothing to find.
      continue
    }
    for await (const entry of directory) {
      // A link is never followed, so the walk cannot leave the roots.
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED_NAMES.has(entry.name)) continue
      const path = join(next.path, entry.name)
      if (avoided.includes(path)) continue
      if (entry.name.toLocaleLowerCase().includes(needle)) {
        results.push({ path, name: entry.name })
        // Returning from the loop closes the directory.
        if (results.length >= MAX_SEARCH_RESULTS) return { results, stopped: 'limit' }
      }
      if (next.depth + 1 < deps.depth) queue.push({ path, depth: next.depth + 1 })
    }
  }
  return { results, stopped: 'complete' }
}
