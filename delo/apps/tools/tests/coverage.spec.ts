import { describe, expect, it } from 'vitest'
import { coverage, coverageLines, coverageScope, type CoverageHost } from '../src/coverage.ts'

const SUMMARY = JSON.stringify({
  total: { statements: { pct: 90 }, branches: { pct: 90 }, functions: { pct: 90 }, lines: { pct: 90 } },
  '/r/delo/apps/tools/src/b.ts': { statements: { pct: 100 }, branches: { pct: 'Unknown' }, functions: { pct: 100 }, lines: { pct: 100 } },
  '/r/delo/apps/tools/src/a.ts': { statements: { pct: 98.5 }, branches: { pct: 100 }, functions: { pct: 100 }, lines: { pct: 99 } },
})

/**
 * A host that records the command and serves the summary.
 * @param status - the command's status.
 * @returns the host, the commands it ran and the lines it printed.
 */
function host(status = 0): { host: CoverageHost, ran: string[][], said: string[] } {
  const ran: string[][] = []
  const said: string[] = []
  return { ran, said, host: { root: '/r', cwd: '/r/delo/apps/tools', reportDir: () => '/t/cov', run: async (argv) => { ran.push([...argv]); return status }, read: () => SUMMARY, say: (line) => { said.push(line) } } }
}

describe('the coverage command', () => {
  it('measures the named globs, or the src files of the packages the paths lie in', () => {
    expect(coverageScope(['delo/x/**'], ['delo/apps/tools/tests/a.spec.ts'])).toEqual(['delo/x/**'])
    expect(coverageScope([], ['delo/apps/tools/tests/a.spec.ts', 'delo/apps/tools/', 'delo/packages/trash'])).toEqual(['delo/apps/tools/src/**', 'delo/packages/trash/src/**'])
    expect(() => coverageScope([], ['README.md'])).toThrow('name a spec file or package')
  })

  it('lists every file in scope, fully covered ones included, and counts those below 100 %', () => {
    expect(coverageLines(SUMMARY, '/r')).toEqual({ below: 1, lines: ['  stmts   branch  funcs   lines   file', '✗ 98.50  100.00  100.00  99.00  delo/apps/tools/src/a.ts', '  100.00  100.00  100.00  100.00  delo/apps/tools/src/b.ts'] })
  })

  it('runs the suite inside the slot budget into a report directory of its own, and fails when a file is below 100 %', async () => {
    const { host: h, ran, said } = host()
    expect(await coverage(['tests/a.spec.ts'], h)).toBe(1)
    expect(ran[0]).toEqual(['node_modules/.bin/tsx', 'delo/apps/tools/src/with-slots.ts', '--slots', '4', '--disk', '--', 'node_modules/.bin/vitest', 'run', '--config', 'delo/vitest.config.ts', '--maxWorkers=4', '--coverage.enabled', '--coverage.reportsDirectory=/t/cov', '--coverage.reporter=json-summary', '--coverage.include=delo/apps/tools/src/**', 'delo/apps/tools/tests/a.spec.ts'])
    expect(said.at(-1)).toBe('coverage: 2 file(s) in scope, 1 below 100 %; report in /t/cov')
  })

  it('passes Vitest\'s failure through, and needs a path', async () => {
    expect(await coverage(['tests/a.spec.ts'], host(7).host)).toBe(7)
    await expect(coverage([], host().host)).rejects.toThrow('name the spec files or package directories to run')
    const full = host()
    full.host = { ...full.host, read: () => JSON.stringify({ '/r/x.ts': { statements: { pct: 100 }, branches: { pct: 100 }, functions: { pct: 100 }, lines: { pct: 100 } } }) }
    expect(await coverage(['--include', 'x.ts', 'tests/a.spec.ts'], full.host)).toBe(0)
  })
})
