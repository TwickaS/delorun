/**
 * Prints the confirmed subscribers of one stage as CSV on standard output, for mailing. Only rows with the status
 * `confirmed` are read, so a pending or unsubscribed address cannot reach a mailing through this script.
 *
 * Usage: `node scripts/export-subscribers.ts --stage <stage> > subscribers.csv`, with `CLOUDFLARE_API_TOKEN` and
 * `CLOUDFLARE_ACCOUNT_ID` set for the account that holds the stage's D1 database.
 *
 * @module @delo/website/scripts/export-subscribers
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** The query: confirmed rows only, in the order of their confirmation. */
export const EXPORT_SQL = "SELECT email, first_name, confirmed_at FROM subscribers WHERE status = 'confirmed' ORDER BY confirmed_at, id"

/** The columns of the CSV. */
const COLUMNS = ['email', 'first_name', 'confirmed_at'] as const

/** One row as the database returns it. */
export type ExportRow = Record<(typeof COLUMNS)[number], string | null>

/**
 * Names a stage's database as the stack names it.
 * @param stage - the stage, such as `prod`.
 * @returns the D1 database name.
 */
export function databaseName(stage: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(stage)) throw new Error(`"${stage}" is not a stage name: use lower-case letters, digits and hyphens`)
  return `delo-website-${stage}-subscribers`
}

/**
 * Quotes one CSV cell. A cell a spreadsheet would read as a formula gets a leading apostrophe.
 * @param value - the cell's text, or null for an empty cell.
 * @returns the cell, quoted when it needs it.
 */
export function cell(value: string | null): string {
  if (value === null) return ''
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/**
 * Builds the CSV.
 * @param rows - the rows the query returned.
 * @returns the header and one line per row, each ending in a newline.
 */
export function toCsv(rows: readonly ExportRow[]): string {
  return [COLUMNS.join(','), ...rows.map(row => COLUMNS.map(column => cell(row[column])).join(','))].map(line => `${line}\n`).join('')
}

/**
 * Reads the confirmed rows of a stage through Wrangler.
 * @param stage - the stage.
 * @returns the rows.
 */
function readRows(stage: string): ExportRow[] {
  const output = execFileSync('pnpm', ['dlx', 'wrangler@4', 'd1', 'execute', databaseName(stage), '--remote', '--json', '--command', EXPORT_SQL], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  const [result] = JSON.parse(output) as { results: ExportRow[] }[]
  if (result === undefined) throw new Error('Wrangler returned no result')
  return result.results
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--stage')
  const stage = process.argv[index + 1]
  if (index < 0 || stage === undefined) {
    console.error('usage: node scripts/export-subscribers.ts --stage <stage>')
    process.exit(2)
  }
  process.stdout.write(toCsv(readRows(stage)))
}
