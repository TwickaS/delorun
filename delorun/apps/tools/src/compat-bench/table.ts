/**
 * The public compatibility table: a header with A574's line and what a row means, then one row per plugin and host.
 * A card under an active embargo (A570, L154) has no row. Wording says what was seen (L141).
 *
 * @module @delorun/tools/compat-bench/table
 */
import { INDEPENDENCE_LINE, VERDICT_WORDS, embargoActive, mainCause, type Card } from './card.ts'

/**
 * One table row's cells for a card.
 * @param card - the card.
 * @returns the plugin, version, host, verdict and what was seen.
 */
function cells(card: Card): string[] {
  const failing = card.stages.filter(each => each.status === 'fail').map(each => each.name)
  const passed = card.stages.filter(each => each.status === 'pass').length
  const ran = card.stages.filter(each => each.status === 'pass' || each.status === 'fail').length
  const host = card.host.kind === 'stock' ? `stock DSH ${card.host.version}` : `Delorun ${card.host.version}`
  const seen = failing.length === 0 ? `${String(passed)} of ${String(ran)} stages passed` : `${String(passed)} of ${String(ran)} stages passed; ${failing.join(', ')} failed (${mainCause(card) ?? 'no cause named'})`
  return [card.plugin.package, card.plugin.version ?? '', host, VERDICT_WORDS[card.verdict], seen]
}

/**
 * Render the table.
 * @param cards - the cards, one per plugin and host.
 * @param now - the clock for embargo dates.
 * @returns the Markdown text.
 */
export function renderTable(cards: readonly Card[], now: Date = new Date()): string {
  const rows = cards.filter(card => !embargoActive(card, now)).map(card => `| ${cells(card).map(cell => cell.replaceAll('|', '\\|')).join(' | ')} |`)
  return [
    '# Plugin compatibility table',
    '',
    `_${INDEPENDENCE_LINE}_`,
    '',
    'Each row is what one test run saw for one plugin on one host: Delorun and stock DeepSeek Harness. A row is a short run with a mock model, not a promise.',
    '',
    '| Plugin | Version | Host | Result | What was seen |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n')
}
