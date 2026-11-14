/**
 * Fundamentals gate: the table of Delorun's security fundamentals in `delorun/docs/security/fundamentals.md` stays traceable
 * to code and tests. Run from anywhere inside the repository:
 * `node_modules/.bin/tsx delorun/apps/tools/src/checks/gates/fundamentals.ts`. It prints the counts by status and one line
 * per violation, and exits 1 on a violation.
 *
 * The rules:
 *
 * 1. The page holds a table whose header names exactly the columns of {@link FUNDAMENTAL_COLUMNS}, and every row has
 *    one cell per column.
 * 2. Each id is `F` and a number, and no id repeats.
 * 3. Each status is `enforced` or `designed`, and each fundamental is stated.
 * 4. An `enforced` row names at least one repository path in code spans under "Enforced by", and each path exists.
 * 5. An `enforced` row names at least one proof under "Proven by", a spec path in a code span followed by a test title
 *    in double quotes, and the spec file holds an `it` or `test` call (`.each` and `.concurrent` included) whose
 *    literal title, or `.each` template, equals the quoted title. A skipped or to-do test is no proof.
 * 6. Every path an `enforced` row names is one of the gate's declared inputs in `gates/index.ts`, so the runner's pass
 *    cache never reuses a pass after a named file changed.
 *
 * A `designed` row's paths and proofs are not checked: it describes a rule that the code does not enforce yet.
 *
 * @module @delorun/tools/checks/gates/fundamentals
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { repositoryRoot } from '../../git.ts'
import type { GateCheck } from '../types.ts'
import { GATES } from './index.ts'

/** The page the gate reads, relative to the repository root. */
export const FUNDAMENTALS_PAGE = 'delorun/docs/security/fundamentals.md'

/** The gate's id in the check runner. */
export const FUNDAMENTALS_GATE_ID = 'gates:fundamentals'

/** The table's columns, in order. */
export const FUNDAMENTAL_COLUMNS = ['ID', 'Fundamental', 'Status', 'Enforced by', 'Proven by'] as const

/** The statuses a fundamental records. */
export const FUNDAMENTAL_STATUSES = ['enforced', 'designed'] as const

/** One of {@link FUNDAMENTAL_STATUSES}. */
export type FundamentalStatus = (typeof FUNDAMENTAL_STATUSES)[number]

/** One test that proves a fundamental: a spec file and the title of one test in it. */
export interface Proof {
  /** The spec file, relative to the repository root. */
  readonly spec: string
  /** The test's title as the page quotes it. */
  readonly title: string
}

/** One row of the table as the page states it. */
export interface FundamentalRow {
  /** The row's line number in the page, from 1. */
  readonly line: number
  readonly id: string
  readonly statement: string
  /** The status cell without code-span backticks. */
  readonly status: string
  /** The paths in the "Enforced by" cell's code spans. */
  readonly enforcedBy: readonly string[]
  /** The proofs in the "Proven by" cell. */
  readonly provenBy: readonly Proof[]
}

/** The table as read from the page, with the problems found in its layout. */
export interface FundamentalTable {
  readonly rows: readonly FundamentalRow[]
  /** Layout errors: no table, a missing or unexpected column, a row with the wrong number of cells. */
  readonly errors: readonly string[]
}

/** What the rules read beyond the page. */
export interface FundamentalFacts {
  /**
   * Whether a repository path exists.
   * @param path - the path, relative to the repository root.
   * @returns true when a file or directory is there.
   */
  readonly exists: (path: string) => boolean
  /**
   * The test titles a spec file declares.
   * @param path - the spec file, relative to the repository root; it exists.
   * @returns the literal titles and `.each` templates of its runnable tests.
   */
  readonly titles: (path: string) => readonly string[]
  /** The gate's declared inputs, which must name every path an `enforced` row names. */
  readonly inputs: readonly string[]
}

/**
 * Split one Markdown table line into its cells, honouring `\|` as a literal bar.
 * @param line - a line that starts with `|`.
 * @returns the trimmed cells, with `\|` unescaped.
 */
export function tableCells(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll('\\|', '|'))
}

/**
 * The paths a cell names in code spans.
 * @param cell - the cell's text.
 * @returns each code span's content, in order.
 */
export function codeSpans(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((match) => String(match[1]))
}

/**
 * The proofs a "Proven by" cell names: each a spec path in a code span followed by a title in double quotes, with `\"`
 * for a quote inside the title.
 * @param cell - the cell's text.
 * @returns the proofs, in order.
 */
export function proofs(cell: string): Proof[] {
  return [...cell.matchAll(/`([^`]+)`[\s:]*"((?:[^"\\]|\\.)*)"/g)].map((match) => ({
    spec: String(match[1]),
    title: String(match[2]).replace(/\\(.)/g, '$1'),
  }))
}

/**
 * Read the fundamentals table: the first table in the page whose header's first cell is `ID`.
 * @param page - the page's Markdown text.
 * @returns the rows and the layout errors.
 */
export function parseTable(page: string): FundamentalTable {
  const lines = page.split('\n')
  const start = lines.findIndex((line) => line.trim().startsWith('|') && tableCells(line)[0] === 'ID')
  if (start === -1) return { rows: [], errors: [`${FUNDAMENTALS_PAGE}: no table whose first column is "ID"`] }
  const header = tableCells(String(lines[start]))
  const errors: string[] = []
  for (const column of FUNDAMENTAL_COLUMNS) {
    if (!header.includes(column)) errors.push(`${FUNDAMENTALS_PAGE}:${String(start + 1)}: the table has no "${column}" column`)
  }
  for (const column of header) {
    if (!(FUNDAMENTAL_COLUMNS as readonly string[]).includes(column)) errors.push(`${FUNDAMENTALS_PAGE}:${String(start + 1)}: unexpected column "${column}"; the columns are ${FUNDAMENTAL_COLUMNS.join(', ')}`)
  }
  if (errors.length > 0) return { rows: [], errors }
  const at = (cells: readonly string[], column: (typeof FUNDAMENTAL_COLUMNS)[number]): string => String(cells[header.indexOf(column)])
  const rows: FundamentalRow[] = []
  // The body starts after the header and its delimiter row, and ends at the first line that is not a table row.
  for (const [offset, text] of lines.slice(start + 2).entries()) {
    if (!text.trim().startsWith('|')) break
    const cells = tableCells(text)
    const line = start + 3 + offset
    if (cells.length !== header.length) {
      errors.push(`${FUNDAMENTALS_PAGE}:${String(line)}: the row has ${String(cells.length)} cells; the table has ${String(header.length)} columns`)
      continue
    }
    rows.push({
      line,
      id: at(cells, 'ID'),
      statement: at(cells, 'Fundamental'),
      status: at(cells, 'Status').replaceAll('`', ''),
      enforcedBy: codeSpans(at(cells, 'Enforced by')),
      provenBy: proofs(at(cells, 'Proven by')),
    })
  }
  return { rows, errors }
}

/**
 * Whether a named path is a plain repository-relative path.
 * @param path - the path as the page names it.
 * @returns true when it is relative, normalised and stays inside the repository.
 */
function insideRepository(path: string): boolean {
  return path !== '' && !isAbsolute(path) && posix.normalize(path) === path && !path.startsWith('../')
}

/**
 * The violations of rules 2 to 6 in the rows of the table.
 * @param rows - the table's rows.
 * @param facts - what the rules read from the repository.
 * @returns one message per violation, in row order; empty when every row holds.
 */
export function fundamentalErrors(rows: readonly FundamentalRow[], facts: FundamentalFacts): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const where = `${FUNDAMENTALS_PAGE}:${String(row.line)}: ${row.id === '' ? 'a row' : row.id}`
    if (!/^F\d+$/.test(row.id)) errors.push(`${where}: the id is not F and a number`)
    else if (seen.has(row.id)) errors.push(`${where}: the id repeats`)
    seen.add(row.id)
    if (row.statement === '') errors.push(`${where}: the fundamental is empty`)
    if (!(FUNDAMENTAL_STATUSES as readonly string[]).includes(row.status)) {
      errors.push(`${where}: the status "${row.status}" is not one of ${FUNDAMENTAL_STATUSES.join(', ')}`)
      continue
    }
    if (row.status !== 'enforced') continue
    if (row.enforcedBy.length === 0) errors.push(`${where}: an enforced fundamental names the code that enforces it`)
    if (row.provenBy.length === 0) errors.push(`${where}: an enforced fundamental names a spec file and a quoted test title that prove it`)
    const named = [...row.enforcedBy, ...row.provenBy.map((proof) => proof.spec)]
    for (const path of named) {
      if (!insideRepository(path)) errors.push(`${where}: "${path}" is not a repository-relative path`)
      else if (!facts.exists(path)) errors.push(`${where}: ${path} does not exist`)
      else if (!facts.inputs.some((input) => posix.matchesGlob(path, input))) {
        errors.push(`${where}: ${path} is not an input of ${FUNDAMENTALS_GATE_ID}; add it to the gate's inputs in delorun/apps/tools/src/checks/gates/index.ts`)
      }
    }
    for (const proof of row.provenBy) {
      if (!insideRepository(proof.spec) || !facts.exists(proof.spec)) continue
      if (!facts.titles(proof.spec).includes(proof.title)) errors.push(`${where}: ${proof.spec} has no test titled "${proof.title}"`)
    }
  }
  return errors
}

/** The `it`/`test` modifiers whose test runs. */
const RUNNING_MODIFIERS = new Set(['concurrent', 'sequential'])

/**
 * Whether an expression names the test function, `it` or `test`, optionally with a modifier whose test runs.
 * @param node - the callee, or the tag of a tagged `.each` table.
 * @param each - true when the expression must end in `.each`.
 * @returns true for `it`, `test`, `it.concurrent` and the like, or with `each` for `it.each` and `test.concurrent.each`.
 */
function isTestFunction(node: ts.Expression, each: boolean): boolean {
  if (each) return ts.isPropertyAccessExpression(node) && node.name.text === 'each' && isTestFunction(node.expression, false)
  if (ts.isIdentifier(node)) return node.text === 'it' || node.text === 'test'
  return ts.isPropertyAccessExpression(node) && RUNNING_MODIFIERS.has(node.name.text) && isTestFunction(node.expression, false)
}

/**
 * The titles of the runnable tests a spec declares: the literal first argument of each `it(…)` and `test(…)` call,
 * with `.concurrent` and `.sequential`, and the template of each `it.each(…)(…)` and tagged `it.each\`…\`(…)` call.
 * A title built with a substitution is not literal and is left out.
 * @param path - the spec's path, which selects TypeScript or TSX parsing.
 * @param source - the spec's text.
 * @returns the titles, in source order.
 */
export function testTitles(path: string, source: string): string[] {
  const titles: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const runs = isTestFunction(callee, false)
        || (ts.isCallExpression(callee) && isTestFunction(callee.expression, true))
        || (ts.isTaggedTemplateExpression(callee) && isTestFunction(callee.tag, true))
      const title = node.arguments[0]
      if (runs && title !== undefined && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) titles.push(title.text)
    }
    ts.forEachChild(node, visit)
  }
  const kind = path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  visit(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, kind))
  return titles
}

/**
 * The line the gate prints on success.
 * @param rows - the table's rows.
 * @returns the counts by status.
 */
export function summaryLine(rows: readonly FundamentalRow[]): string {
  const count = (status: FundamentalStatus): number => rows.filter((row) => row.status === status).length
  return `${FUNDAMENTALS_GATE_ID}: ${String(rows.length)} fundamentals: ${String(count('enforced'))} enforced, ${String(count('designed'))} designed`
}

/**
 * Run the gate over a repository.
 * @param root - the repository root.
 * @param inputs - the gate's declared inputs.
 * @returns the lines to print on standard output and on standard error; the gate fails when `errors` is not empty.
 */
export function checkFundamentals(root: string, inputs: readonly string[]): { readonly lines: readonly string[]; readonly errors: readonly string[] } {
  const page = join(root, FUNDAMENTALS_PAGE)
  if (!existsSync(page)) return { lines: [], errors: [`${FUNDAMENTALS_PAGE} does not exist`] }
  const table = parseTable(readFileSync(page, 'utf8'))
  const errors = [
    ...table.errors,
    ...fundamentalErrors(table.rows, {
      exists: (path) => existsSync(join(root, path)),
      titles: (path) => testTitles(path, readFileSync(join(root, path), 'utf8')),
      inputs,
    }),
  ]
  return { lines: errors.length === 0 ? [summaryLine(table.rows)] : [], errors }
}

/**
 * The gate's declared inputs, from the runner's catalogue.
 * @param gates - the catalogue; the runner's own by default.
 * @returns the input globs of {@link FUNDAMENTALS_GATE_ID}, empty when the catalogue declares none.
 */
export function declaredInputs(gates: readonly GateCheck[] = GATES): readonly string[] {
  return gates.find((gate) => gate.id === FUNDAMENTALS_GATE_ID)?.inputs ?? []
}

/* v8 ignore start -- the entry-point guard runs only when the module is the command, which the specs run as a child process */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkFundamentals(repositoryRoot(process.cwd()), declaredInputs())
  for (const line of result.lines) console.log(line)
  for (const error of result.errors) console.error(`${FUNDAMENTALS_GATE_ID}: ${error}`)
  if (result.errors.length > 0) console.error(`${FUNDAMENTALS_GATE_ID}: ${String(result.errors.length)} problem(s); the rules are in ${FUNDAMENTALS_PAGE}`)
  process.exitCode = result.errors.length === 0 ? 0 : 1
}
/* v8 ignore stop */
