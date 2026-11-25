/**
 * Reads a folder of cards: the table and the board both start from the newest card of each plugin on each host.
 *
 * @module @delorun/tools/compat-bench/cards-dir
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { validateCard, type Card } from './card.ts'

/** A card and where it was read from. */
export interface LoadedCard {
  /** The card. */
  readonly card: Card
  /** The path of its `card.json`. */
  readonly path: string
}

/**
 * Find every `card.json` under a folder.
 * @param root - the folder.
 * @returns the paths, in directory order.
 */
export function findCardFiles(root: string): string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name === 'card.json') found.push(path)
    }
  }
  walk(root)
  return found
}

/**
 * Load the valid cards under a folder and keep the newest of each plugin and host.
 * @param root - the folder.
 * @param warn - receives a line for each file that is not a valid card.
 * @returns the cards, ordered by plugin name and host.
 */
export function loadLatestCards(root: string, warn: (line: string) => void = () => undefined): LoadedCard[] {
  const latest = new Map<string, LoadedCard>()
  for (const path of findCardFiles(root)) {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const result = validateCard(parsed)
    if (!result.ok) {
      warn(`${path}: ${result.problems.join('; ')}`)
      continue
    }
    const key = `${result.card.plugin.package}\u0000${result.card.host.kind}`
    const existing = latest.get(key)
    if (existing === undefined || existing.card.startedAt < result.card.startedAt) latest.set(key, { card: result.card, path })
  }
  return [...latest.values()].sort((a, b) => a.card.plugin.package.localeCompare(b.card.plugin.package) || a.card.host.kind.localeCompare(b.card.host.kind))
}
