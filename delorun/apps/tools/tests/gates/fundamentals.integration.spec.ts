import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TestContext } from 'vitest'
import { describe, expect, it } from 'vitest'
import {
  checkFundamentals,
  codeSpans,
  declaredInputs,
  FUNDAMENTALS_PAGE,
  fundamentalErrors,
  parseTable,
  proofs,
  summaryLine,
  tableCells,
  testTitles,
  type FundamentalFacts,
  type FundamentalRow,
} from '../../src/checks/gates/fundamentals.ts'
import { GATES } from '../../src/checks/gates/index.ts'
import { gatePath, REPO, runTsx, scratchRepo } from './support.ts'

const HEADER = '| ID | Fundamental | Status | Enforced by | Proven by |\n| --- | --- | --- | --- | --- |'

/** A page holding the table with the given rows after an introduction. */
function page(...rows: string[]): string {
  return `# Fundamentals\n\nIntroduction.\n\n${HEADER}\n${rows.join('\n')}\n\nAfter the table.\n`
}

const ENFORCED = '| F1 | A download is verified. | `enforced` | `src/check.ts` | `tests/check.spec.ts` "refuses a forged download" |'
const DESIGNED = '| F2 | A rule not built yet. | `designed` | — | — |'

/** A row as the parser returns it, with defaults for the fields a case does not set. */
function row(fields: Partial<FundamentalRow>): FundamentalRow {
  return { line: 7, id: 'F1', statement: 'A rule.', status: 'enforced', enforcedBy: ['src/check.ts'], provenBy: [{ spec: 'tests/check.spec.ts', title: 'refuses' }], ...fields }
}

/** Facts in which the given paths exist, the spec declares the given titles, and every path is an input. */
function facts(paths: readonly string[], titles: readonly string[] = ['refuses'], inputs: readonly string[] = ['**']): FundamentalFacts {
  return { exists: (path) => paths.includes(path), titles: () => titles, inputs }
}

/** A temporary directory holding the given files, removed when the test ends. */
function scratchDir(test: TestContext, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'delorun-fundamentals-'))
  test.onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  return root
}

describe('gates:fundamentals table cells', () => {
  it('splits a row on unescaped bars and keeps an escaped bar in its cell', () => {
    expect(tableCells('| F1 | a \\| b | `enforced` |')).toEqual(['F1', 'a | b', '`enforced`'])
  })

  it('reads every code span of a cell', () => {
    expect(codeSpans('`a/one.ts` and `b/two.ts`')).toEqual(['a/one.ts', 'b/two.ts'])
    expect(codeSpans('—')).toEqual([])
  })

  it('reads each spec path with its quoted title, unescaping a quote inside the title', () => {
    expect(proofs('`a.spec.ts` "refuses it"; `b.spec.ts`: "names \\"x\\""')).toEqual([
      { spec: 'a.spec.ts', title: 'refuses it' },
      { spec: 'b.spec.ts', title: 'names "x"' },
    ])
    expect(proofs('`a.spec.ts` with no title')).toEqual([])
  })
})

describe('gates:fundamentals table layout', () => {
  it('reads the rows of the first table whose first column is ID, and stops at the table\'s end', () => {
    const table = parseTable(`| Other | table |\n| --- | --- |\n| x | y |\n\n${page(ENFORCED, DESIGNED)}`)
    expect(table.errors).toEqual([])
    expect(table.rows).toEqual([
      { line: 11, id: 'F1', statement: 'A download is verified.', status: 'enforced', enforcedBy: ['src/check.ts'], provenBy: [{ spec: 'tests/check.spec.ts', title: 'refuses a forged download' }] },
      { line: 12, id: 'F2', statement: 'A rule not built yet.', status: 'designed', enforcedBy: [], provenBy: [] },
    ])
  })

  it('fails a page with no table whose first column is ID', () => {
    expect(parseTable('# Fundamentals\n\nNo table.\n')).toEqual({ rows: [], errors: [`${FUNDAMENTALS_PAGE}: no table whose first column is "ID"`] })
  })

  it('fails a table with a missing column or an unexpected one, and reads no row of it', () => {
    const missing = parseTable('| ID | Fundamental | Status | Enforced by |\n| --- | --- | --- | --- |\n| F1 | a | `designed` | — |\n')
    expect(missing).toEqual({ rows: [], errors: [`${FUNDAMENTALS_PAGE}:1: the table has no "Proven by" column`] })
    const extra = parseTable('| ID | Fundamental | Status | Enforced by | Proven by | Owner |\n')
    expect(extra.errors).toEqual([`${FUNDAMENTALS_PAGE}:1: unexpected column "Owner"; the columns are ID, Fundamental, Status, Enforced by, Proven by`])
  })

  it('fails a row whose cell count differs from the header\'s, and reads the others', () => {
    const table = parseTable(page('| F1 | a | `designed` | — |', DESIGNED))
    expect(table.errors).toEqual([`${FUNDAMENTALS_PAGE}:7: the row has 4 cells; the table has 5 columns`])
    expect(table.rows.map((entry) => entry.id)).toEqual(['F2'])
  })
})

describe('gates:fundamentals rules', () => {
  it('passes an enforced row whose paths exist, are inputs, and whose spec holds the quoted title', () => {
    expect(fundamentalErrors([row({})], facts(['src/check.ts', 'tests/check.spec.ts']))).toEqual([])
  })

  it('checks nothing beyond the id, the statement and the status of a designed row', () => {
    expect(fundamentalErrors([row({ status: 'designed', enforcedBy: ['missing.ts'], provenBy: [] })], facts([]))).toEqual([])
  })

  it('fails an id that is not F and a number, an empty id, and a repeated id', () => {
    const rows = [row({ id: 'X1', status: 'designed' }), row({ id: '', status: 'designed' }), row({ id: 'F1', status: 'designed' }), row({ id: 'F1', status: 'designed' })]
    expect(fundamentalErrors(rows, facts([]))).toEqual([
      `${FUNDAMENTALS_PAGE}:7: X1: the id is not F and a number`,
      `${FUNDAMENTALS_PAGE}:7: a row: the id is not F and a number`,
      `${FUNDAMENTALS_PAGE}:7: F1: the id repeats`,
    ])
  })

  it('fails an empty fundamental', () => {
    expect(fundamentalErrors([row({ statement: '', status: 'designed' })], facts([]))).toEqual([`${FUNDAMENTALS_PAGE}:7: F1: the fundamental is empty`])
  })

  it('fails a status outside enforced and designed, and checks no path of that row', () => {
    expect(fundamentalErrors([row({ status: 'planned' })], facts([]))).toEqual([`${FUNDAMENTALS_PAGE}:7: F1: the status "planned" is not one of enforced, designed`])
  })

  it('fails an enforced row that names no enforcing code or no proof', () => {
    expect(fundamentalErrors([row({ enforcedBy: [], provenBy: [] })], facts([]))).toEqual([
      `${FUNDAMENTALS_PAGE}:7: F1: an enforced fundamental names the code that enforces it`,
      `${FUNDAMENTALS_PAGE}:7: F1: an enforced fundamental names a spec file and a quoted test title that prove it`,
    ])
  })

  it('fails an enforced row whose code path or spec file does not exist', () => {
    expect(fundamentalErrors([row({})], facts([]))).toEqual([
      `${FUNDAMENTALS_PAGE}:7: F1: src/check.ts does not exist`,
      `${FUNDAMENTALS_PAGE}:7: F1: tests/check.spec.ts does not exist`,
    ])
  })

  it('fails a path that is absolute, not normalised or outside the repository, and reads no title from such a spec', () => {
    const rows = [row({ enforcedBy: ['/etc/passwd', 'src/../check.ts'], provenBy: [{ spec: '../outside.spec.ts', title: 'refuses' }] })]
    expect(fundamentalErrors(rows, facts(['/etc/passwd', 'src/../check.ts', '../outside.spec.ts'], []))).toEqual([
      `${FUNDAMENTALS_PAGE}:7: F1: "/etc/passwd" is not a repository-relative path`,
      `${FUNDAMENTALS_PAGE}:7: F1: "src/../check.ts" is not a repository-relative path`,
      `${FUNDAMENTALS_PAGE}:7: F1: "../outside.spec.ts" is not a repository-relative path`,
    ])
  })

  it('fails a spec file that holds no test with the quoted title', () => {
    expect(fundamentalErrors([row({})], facts(['src/check.ts', 'tests/check.spec.ts'], ['refuses something else']))).toEqual([
      `${FUNDAMENTALS_PAGE}:7: F1: tests/check.spec.ts has no test titled "refuses"`,
    ])
  })

  it('fails a named path that is not one of the gate\'s declared inputs', () => {
    expect(fundamentalErrors([row({})], facts(['src/check.ts', 'tests/check.spec.ts'], ['refuses'], ['src/**']))).toEqual([
      `${FUNDAMENTALS_PAGE}:7: F1: tests/check.spec.ts is not an input of gates:fundamentals; add it to the gate's inputs in delorun/apps/tools/src/checks/gates/index.ts`,
    ])
  })
})

describe('gates:fundamentals test titles', () => {
  it('reads the literal titles of it and test calls, with their running modifiers and .each templates', () => {
    const source = [
      "describe('a group', () => {",
      "  it('plain it', () => {})",
      '  test(`plain test`, () => {})',
      "  it.concurrent('concurrent it', () => {})",
      "  test.sequential('sequential test', () => {})",
      "  it.each([1, 2])('each %s', () => {})",
      "  test.concurrent.each([1])('concurrent each %s', () => {})",
      "  it.each`a\n${1}`('tagged each $a', () => {})",
      '})',
    ].join('\n')
    expect(testTitles('a.spec.ts', source)).toEqual(['plain it', 'plain test', 'concurrent it', 'sequential test', 'each %s', 'concurrent each %s', 'tagged each $a'])
  })

  it('leaves out skipped and to-do tests, titles with a substitution, describe blocks and other calls', () => {
    const source = [
      "it.skip('skipped', () => {})",
      "it.todo('to do')",
      "it.skip.each([1])('skipped each %s', () => {})",
      "const name = 'x'",
      'it(`built ${name}`, () => {})',
      "it(name, () => {})",
      "it()",
      "describe('a group', () => {})",
      "expect('value').toBe('value')",
      "helper.it('not a test', () => {})",
      "(() => it)()('called result', () => {})",
      "String.raw`x`('tagged other', () => {})",
    ].join('\n')
    expect(testTitles('a.spec.ts', source)).toEqual([])
  })

  it('parses a TSX spec', () => {
    expect(testTitles('a.spec.tsx', "it('renders', () => { render(<Card title=\"x\" />) })")).toEqual(['renders'])
  })
})

describe('gates:fundamentals run', () => {
  it('prints the counts by status', () => {
    expect(summaryLine([row({}), row({ id: 'F2', status: 'designed' })])).toBe('gates:fundamentals: 2 fundamentals: 1 enforced, 1 designed')
  })

  it('fails a repository without the page', (test) => {
    expect(checkFundamentals(scratchDir(test, {}), ['**'])).toEqual({ lines: [], errors: [`${FUNDAMENTALS_PAGE} does not exist`] })
  })

  it('passes a repository whose page, code and spec agree, and fails it once the proving test is gone', (test) => {
    const files = {
      [FUNDAMENTALS_PAGE]: page(ENFORCED, DESIGNED),
      'src/check.ts': 'export const check = 1\n',
      'tests/check.spec.ts': "it('refuses a forged download', () => {})\n",
    }
    const root = scratchDir(test, files)
    expect(checkFundamentals(root, ['**'])).toEqual({ lines: ['gates:fundamentals: 2 fundamentals: 1 enforced, 1 designed'], errors: [] })
    writeFileSync(join(root, 'tests/check.spec.ts'), "it.skip('refuses a forged download', () => {})\n")
    expect(checkFundamentals(root, ['**'])).toEqual({ lines: [], errors: [`${FUNDAMENTALS_PAGE}:7: F1: tests/check.spec.ts has no test titled "refuses a forged download"`] })
  })

  it('reports a layout error and a rule violation together', (test) => {
    const root = scratchDir(test, { [FUNDAMENTALS_PAGE]: page('| F1 | a | `designed` |', '| F1 | b | `maybe` | — | — |') })
    expect(checkFundamentals(root, ['**']).errors).toEqual([
      `${FUNDAMENTALS_PAGE}:7: the row has 3 cells; the table has 5 columns`,
      `${FUNDAMENTALS_PAGE}:8: F1: the status "maybe" is not one of enforced, designed`,
    ])
  })

  it('reads its inputs from the runner\'s catalogue, and none from a catalogue without the gate', () => {
    expect(declaredInputs()).toBe(GATES.find((gate) => gate.id === 'gates:fundamentals')?.inputs)
    expect(declaredInputs()).toContain(FUNDAMENTALS_PAGE)
    expect(declaredInputs([])).toEqual([])
  })

  it('passes over this repository\'s page and exits 0 as the runner runs it', () => {
    expect(checkFundamentals(REPO, declaredInputs()).errors).toEqual([])
    const run = runTsx(REPO, gatePath('fundamentals'))
    expect(run.output).toMatch(/^gates:fundamentals: \d+ fundamentals: \d+ enforced, \d+ designed$/m)
    expect(run.status).toBe(0)
  })

  it('exits 1 and names the problem in a repository whose page is missing', (test) => {
    const run = runTsx(scratchRepo(test).root, gatePath('fundamentals'))
    expect(run.status).toBe(1)
    expect(run.output).toContain(`gates:fundamentals: ${FUNDAMENTALS_PAGE} does not exist`)
  })
})
