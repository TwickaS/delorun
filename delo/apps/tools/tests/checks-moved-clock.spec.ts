/**
 * The moved-clock check's runs, the statuses it reads from Vitest's JSON report, the tests it reports, and its lines.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { clockRegressions, clockRun, fixedDateWarnings, MOVED_CLOCK_CONFIG, MOVED_CLOCK_DAYS, MOVED_CLOCK_ENV, MOVED_CLOCK_EXCLUDED, outcomes, report, specTexts } from '../src/checks/moved-clock.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('the moved-clock check', () => {
  it('runs the moved-clock configuration with the days in its variable and a JSON report', () => {
    expect(MOVED_CLOCK_DAYS).toEqual([2, 400])
    expect(clockRun(400, 6, '/r/report.json')).toEqual({
      days: 400,
      command: 'node_modules/.bin/vitest',
      args: ['run', '--config', MOVED_CLOCK_CONFIG, '--maxWorkers=6', '--reporter=json', '--outputFile=/r/report.json'],
      env: { [MOVED_CLOCK_ENV]: '400' },
    })
  })

  it('leaves out only specs that exist in the unit projects, each with a reason', () => {
    const delo = fileURLToPath(new URL('../../../', import.meta.url))
    for (const { spec, reason } of MOVED_CLOCK_EXCLUDED) {
      expect(existsSync(join(delo, spec)), spec).toBe(true)
      expect(spec).toMatch(/(?<!\.integration)\.spec\.tsx?$/)
      expect(reason.length, spec).toBeGreaterThan(40)
    }
  })

  it('reads each test by its file and full name, and a file that failed before its tests by the file', () => {
    const text = JSON.stringify({ testResults: [
      { name: '/repo/delo/packages/a/tests/a.spec.ts', status: 'failed', assertionResults: [{ fullName: 'a works', status: 'passed' }, { fullName: 'a dates', status: 'failed' }] },
      { name: '/repo/delo/packages/b/tests/b.spec.ts', status: 'failed', assertionResults: [] },
    ] })
    expect(outcomes('/repo/delo', text)).toEqual(new Map([
      ['packages/a/tests/a.spec.ts > a works', 'passed'],
      ['packages/a/tests/a.spec.ts > a dates', 'failed'],
      ['packages/b/tests/b.spec.ts', 'failed'],
    ]))
    expect(() => outcomes('/repo', '{"testResults":[{"name":1}]}')).toThrow()
  })

  it('reports only a test that passes at the real time and fails at the moved one', () => {
    const base = new Map([['x > dated', 'passed'], ['x > broken', 'failed'], ['x > skipped', 'skipped'], ['x > fine', 'passed']])
    const moved = new Map([['x > dated', 'failed'], ['x > broken', 'failed'], ['x > skipped', 'failed'], ['x > fine', 'passed'], ['x > new', 'failed']])
    expect(clockRegressions(base, moved)).toEqual(['x > dated'])
  })

  it('prints one line per regression and a summary', () => {
    expect(report(new Map([[2, []], [400, []]]))).toEqual(['tests:moved-clock: no test fails with the clock moved +2, +400 days that passes today'])
    expect(report(new Map([[2, []], [400, ['x > dated']]]))).toEqual([
      'tests:moved-clock: +400 days: x > dated passes today and fails then; fix every time the spec compares against or inject the clock',
      'tests:moved-clock: 1 test(s) fail with a moved clock',
    ])
  })

  it('warns about a spec that holds a date from today on and writes files without setting their times', () => {
    const write = "writeFileSync(path, 'x')\n"
    expect(fixedDateWarnings([
      { path: 'a.spec.ts', text: `const NOW = new Date('2026-11-12T00:00:00Z')\n${write}const OLD = '2026-11-09'\nconst LATER = "2027-01-01"\n` },
      { path: 'b.spec.ts', text: `const NOW = '2026-11-12'\n${write}utimesSync(path, NOW, NOW)\n` },
      { path: 'c.spec.ts', text: `const OLD = '2026-11-09'\n${write}` },
      { path: 'd.spec.ts', text: "const NOW = '2027-01-01'\nreadFileSync(path)\n" },
      { path: 'e.spec.ts', text: "await writeFile(path, 'x')\nconst SAME = `2026-11-10`\n" },
      { path: 'f.spec.ts', text: "appendFileSync(path, 'x')\n" },
    ], '2026-11-10')).toEqual([
      'tests:moved-clock: warning: a.spec.ts holds the date 2027-01-01 and writes files without setting their times; if a file time is compared with that date, set it with utimes',
      'tests:moved-clock: warning: e.spec.ts holds the date 2026-11-10 and writes files without setting their times; if a file time is compared with that date, set it with utimes',
    ])
  })

  it('reads every spec under the tests directories of Delo\'s apps and packages', () => {
    const root = mkdtempSync(join(tmpdir(), 'delo-moved-clock-tree-'))
    roots.push(root)
    for (const [path, text] of Object.entries({
      'delo/apps/a/tests/x.spec.ts': 'x',
      'delo/apps/a/tests/deep/y.integration.spec.ts': 'y',
      'delo/apps/a/tests/support.ts': 'not a spec',
      'delo/apps/a/tests/node_modules/z.spec.ts': 'dependency',
      'delo/apps/b/src/index.ts': 'no tests',
      'delo/packages/c/tests/w.client.spec.tsx': 'w',
    })) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    expect(specTexts(root)).toEqual([
      { path: 'delo/apps/a/tests/deep/y.integration.spec.ts', text: 'y' },
      { path: 'delo/apps/a/tests/x.spec.ts', text: 'x' },
      { path: 'delo/packages/c/tests/w.client.spec.tsx', text: 'w' },
    ])
  })
})
