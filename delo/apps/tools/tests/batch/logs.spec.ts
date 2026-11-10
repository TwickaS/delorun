/**
 * The check runner's report and logs as the batch reads them: the report's failing checks, the first failure of a log,
 * the spec files a test lane names and the commits a range gate names.
 */
import { describe, expect, it } from 'vitest'
import { excerpt, failingSpecs, failuresOf, namedCommits, readReport, REPORT_PATH } from '../../src/batch/logs.ts'
import type { Files } from '../../src/batch/state.ts'

/**
 * A file port over a map of absolute paths.
 * @param files - the contents.
 * @returns the port.
 */
function memory(files: Record<string, string>): Files {
  return { read: path => files[path], write: (path, text) => { files[path] = text }, remove: path => { Reflect.deleteProperty(files, path) }, exists: path => path in files }
}

describe('readReport', () => {
  it('reads the checks of a report, and nothing from a missing, cut or foreign one', () => {
    const report = { checks: [{ check: 'tests:fork', status: 'failed', reason: 'exit 1', logPath: 'logs/f.log', cached: false }] }
    expect(readReport(memory({ [`/r/${REPORT_PATH}`]: JSON.stringify(report) }), '/r')).toEqual([{ check: 'tests:fork', status: 'failed', reason: 'exit 1', logPath: 'logs/f.log' }])
    expect(readReport(memory({}), '/r')).toBeUndefined()
    expect(readReport(memory({ [`/r/${REPORT_PATH}`]: '{"checks": [' }), '/r')).toBeUndefined()
    expect(readReport(memory({ [`/r/${REPORT_PATH}`]: '{"checks": 1}' }), '/r')).toBeUndefined()
  })
})

describe('excerpt', () => {
  it('keeps the first failing test and the assertion after it, without colours', () => {
    const log = ['\u001b[31m FAIL \u001b[39m |fork| apps/a/tests/a.spec.ts > a > adds', '', 'AssertionError: expected 1 to be 2', '- Expected', '+ Received', '', '', 'more', 'FAIL |fork| apps/b/tests/b.spec.ts > b'].join('\n')
    expect(excerpt(log)).toEqual(['FAIL  |fork| apps/a/tests/a.spec.ts > a > adds', 'AssertionError: expected 1 to be 2', '- Expected', '+ Received'])
  })

  it('keeps a failing test\'s name alone when no error line follows it', () => {
    expect(excerpt('FAIL  x.spec.ts > named\nnothing else')).toEqual(['FAIL  x.spec.ts > named'])
  })

  it('falls back to the first error lines, then to the first lines, and cuts long lines', () => {
    expect(excerpt('start\nError: one\nok\nTypeError: two\n')).toEqual(['Error: one', 'TypeError: two'])
    expect(excerpt(`${'x'.repeat(300)}\n\n${Array.from({ length: 10 }, (_, index) => `line ${String(index)}`).join('\n')}`)).toHaveLength(8)
    expect(excerpt('x'.repeat(300))[0]).toHaveLength(240)
  })
})

describe('failingSpecs', () => {
  it('names the failing specs of a test lane, relative to the repository', () => {
    const log = ' FAIL  |fork| apps/a/tests/a.spec.ts > a\n FAIL  |fork| apps/a/tests/a.spec.ts > b\n FAIL  |fork-client| packages/p/tests/v.spec.tsx > c\n'
    expect(failingSpecs('tests:fork', log)).toEqual(['delo/apps/a/tests/a.spec.ts', 'delo/packages/p/tests/v.spec.tsx'])
    expect(failingSpecs('tests:upstream-changed', 'FAIL packages/core/x/tests/y.test.ts > z')).toEqual(['packages/core/x/tests/y.test.ts'])
    expect(failingSpecs('jsdoc', log)).toEqual([])
  })
})

describe('namedCommits', () => {
  it('names the commit ids of a range gate only', () => {
    expect(namedCommits('gates:dco', 'abc1234 lacks a sign-off; abc1234 again; deadbeefcafe1234 too; 123456 is short')).toEqual(['abc1234', 'deadbeefcafe1234'])
    expect(namedCommits('gates:dco', 'nothing')).toEqual([])
    expect(namedCommits('tests:fork', 'abc1234')).toEqual([])
  })
})

describe('failuresOf', () => {
  it('reads each failed check\'s log, and an absent or unnamed log as empty', () => {
    const files = memory({ '/r/logs/dco.log': 'abc1234 has no Signed-off-by' })
    expect(failuresOf(files, '/r', [
      { check: 'gates:dco', status: 'failed', reason: 'exit 1', logPath: 'logs/dco.log' },
      { check: 'tests:fork', status: 'failed', reason: null, logPath: 'logs/missing.log' },
      { check: 'jsdoc', status: 'failed', reason: null, logPath: null },
      { check: 'boundary', status: 'passed', reason: null, logPath: null },
    ])).toEqual([
      { check: 'gates:dco', reason: 'exit 1', logPath: 'logs/dco.log', excerpt: ['abc1234 has no Signed-off-by'], specs: [], commits: ['abc1234'] },
      { check: 'tests:fork', reason: null, logPath: 'logs/missing.log', excerpt: [], specs: [], commits: [] },
      { check: 'jsdoc', reason: null, logPath: null, excerpt: [], specs: [], commits: [] },
    ])
  })
})
