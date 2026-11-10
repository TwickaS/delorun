/**
 * The moved-clock check (`tests:moved-clock`): it runs the fork's unit and client component specs in process three
 * times, with `Date` at the real time and moved forward by each of {@link MOVED_CLOCK_DAYS} days
 * (`delo/vitest.moved-clock.config.ts`), and fails on each test that passes at the real time and fails at a moved
 * one. Such a test fixes a date but lets the code under test read the clock, so it starts failing on the day the
 * real clock passes the fixed date. The check does not move the times the file system records, so a fixed date
 * compared with a file's modification time is not caught; the rule in the contributor workflow covers that case. The
 * integration project is left out: its git, Node and `tsx` children read the system clock, which an in-process fake
 * does not move; so are the specs {@link MOVED_CLOCK_EXCLUDED} lists, each with its reason. Before its verdict it prints, as warnings, the specs {@link fixedDateWarnings} names. Run from the
 * repository root:
 * `node_modules/.bin/tsx delo/apps/tools/src/checks/moved-clock.ts [--workers <n>]`. It prints one line per such test
 * and exits 1.
 *
 * @module @delo/tools/checks/moved-clock
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { repositoryRoot } from '../git.ts'

/** How far each moved run sets the clock forward, in days: past a fixed date of this week, and past one of next year. */
export const MOVED_CLOCK_DAYS = [2, 400] as const

/** The variable the setup file reads. */
export const MOVED_CLOCK_ENV = 'DELO_MOVED_CLOCK_DAYS'

/** The Vitest configuration of the check. */
export const MOVED_CLOCK_CONFIG = 'delo/vitest.moved-clock.config.ts'

/** A spec the check leaves out, relative to `delo/`, and why a moved `Date` cannot judge it. */
export interface ExcludedSpec {
  readonly spec: string
  readonly reason: string
}

const TLS = 'it serves and verifies TLS certificates it makes with `Date`; OpenSSL checks their validity against the system clock, so a moved `Date` makes them not yet valid'

/** The specs the check leaves out, each with its reason; `delo/vitest.moved-clock.config.ts` excludes them. */
export const MOVED_CLOCK_EXCLUDED: readonly ExcludedSpec[] = [
  { spec: 'apps/cli/tests/denial/admission/listeners.spec.ts', reason: TLS },
  { spec: 'apps/relay/tests/node/end-to-end.spec.ts', reason: TLS },
  { spec: 'apps/tools/tests/stack/acme.spec.ts', reason: TLS },
  { spec: 'apps/tools/tests/stack/certificate-transparency.spec.ts', reason: TLS },
  { spec: 'apps/tools/tests/stack/oidc-provider.spec.ts', reason: TLS },
  { spec: 'apps/tools/tests/stack/stack.spec.ts', reason: TLS },
  { spec: 'packages/logs/tests/retention.spec.ts', reason: 'it compares `Date.now()` with the modification times of files it writes, which agree in a real run; the check moves `Date` and not the file times, so past the retention window every new file reads as expired' },
]

/** One run of the specs: the command and the variables it sets. */
export interface ClockRun {
  readonly days: number
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/**
 * The run of the specs with the clock moved by a number of days.
 * @param days - how far forward; 0 is the real time.
 * @param workers - the Vitest workers.
 * @param reportPath - where Vitest writes its JSON report.
 * @returns the run.
 */
export function clockRun(days: number, workers: number, reportPath: string): ClockRun {
  return {
    days,
    command: 'node_modules/.bin/vitest',
    args: ['run', '--config', MOVED_CLOCK_CONFIG, `--maxWorkers=${String(workers)}`, '--reporter=json', `--outputFile=${reportPath}`],
    env: { [MOVED_CLOCK_ENV]: String(days) },
  }
}

const Report = z.object({
  testResults: z.array(z.object({
    name: z.string(),
    status: z.string(),
    assertionResults: z.array(z.object({ fullName: z.string(), status: z.string() })),
  })),
})

/**
 * Each test's status in a Vitest JSON report, keyed by its file, relative to `root`, and its full name. A file that
 * failed before any test ran is keyed by the file alone.
 * @param root - the directory the file names are made relative to.
 * @param text - the report.
 * @returns the statuses, such as `passed`, `failed` or `skipped`.
 * @throws Error when the text is not such a report.
 */
export function outcomes(root: string, text: string): Map<string, string> {
  const report = Report.parse(JSON.parse(text))
  const result = new Map<string, string>()
  for (const file of report.testResults) {
    const name = relative(root, file.name)
    if (file.assertionResults.length === 0) result.set(name, file.status)
    for (const test of file.assertionResults) result.set(`${name} > ${test.fullName}`, test.status)
  }
  return result
}

/**
 * The tests that pass at the real time and fail at a moved one.
 * @param base - the statuses at the real time.
 * @param moved - the statuses at the moved time.
 * @returns their keys, sorted.
 */
export function clockRegressions(base: ReadonlyMap<string, string>, moved: ReadonlyMap<string, string>): string[] {
  return [...moved].filter(([key, status]) => status === 'failed' && base.get(key) === 'passed').map(([key]) => key).sort()
}

/**
 * The check's lines for the regressions of each moved run.
 * @param regressions - the regressions, keyed by the days the run moved the clock.
 * @returns one line per regression, then a summary line.
 */
export function report(regressions: ReadonlyMap<number, readonly string[]>): string[] {
  const lines = [...regressions].flatMap(([days, keys]) => keys.map(key => `tests:moved-clock: +${String(days)} days: ${key} passes today and fails then; fix every time the spec compares against or inject the clock`))
  const runs = [...regressions.keys()].map(days => `+${String(days)}`).join(', ')
  return [...lines, lines.length === 0 ? `tests:moved-clock: no test fails with the clock moved ${runs} days that passes today` : `tests:moved-clock: ${String(lines.length)} test(s) fail with a moved clock`]
}

/** One spec file's path, relative to the repository root, and its text. */
export interface SpecText {
  readonly path: string
  readonly text: string
}

/**
 * The static complement of the moved clock, for what it cannot move: each spec that holds a literal date on or after
 * `today` and writes files without setting their times (`utimes`). Its files carry the real clock's time, so a
 * comparison with that date flips on the day the clock passes it. The lines are warnings, not failures: a spec may
 * hold such a date for a value no file time is compared with.
 * @param specs - the spec files.
 * @param today - the real date, `YYYY-MM-DD`.
 * @returns one warning line per such spec, naming its latest such date.
 */
export function fixedDateWarnings(specs: readonly SpecText[], today: string): string[] {
  return specs.flatMap(({ path, text }) => {
    if (!/\b(?:writeFileSync|writeFile|appendFileSync)\(/.test(text) || text.includes('utimes')) return []
    const [latest] = (text.match(/['"`]20\d{2}-[01]\d-[0-3]\d/g) ?? []).map(quoted => quoted.slice(1)).filter(date => date >= today).sort().reverse()
    return latest === undefined ? [] : [`tests:moved-clock: warning: ${path} holds the date ${latest} and writes files without setting their times; if a file time is compared with that date, set it with utimes`]
  })
}

/**
 * Every spec file under the `tests` directories of Delo's apps and packages.
 * @param root - the repository root.
 * @returns the files and their text, sorted by path.
 */
export function specTexts(root: string): SpecText[] {
  const found: SpecText[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory() && entry.name !== 'node_modules') walk(path)
      else if (/\.spec\.tsx?$/.test(entry.name)) found.push({ path, text: readFileSync(join(root, path), 'utf8') })
    }
  }
  for (const group of ['delo/apps', 'delo/packages']) {
    for (const pkg of readdirSync(join(root, group))) if (existsSync(join(root, group, pkg, 'tests'))) walk(join(group, pkg, 'tests'))
  }
  return found.sort((a, b) => a.path.localeCompare(b.path))
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { workers: { type: 'string', default: '8' } } })
  const workers = Number(values.workers)
  if (!Number.isSafeInteger(workers) || workers < 1) throw new Error(`--workers must be a positive integer, got ${values.workers}`)
  const root = repositoryRoot(process.cwd())
  const scratch = mkdtempSync(join(tmpdir(), 'delo-moved-clock-'))
  try {
    const statuses = new Map<number, Map<string, string>>()
    for (const days of [0, ...MOVED_CLOCK_DAYS]) {
      const path = join(scratch, `report-${String(days)}.json`)
      const run = clockRun(days, workers, path)
      const result = spawnSync(run.command, [...run.args], { cwd: root, env: { ...process.env, ...run.env }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 1_200_000 })
      if (result.error !== undefined || result.signal !== null) throw new Error(`the run at +${String(days)} days did not finish (${result.error?.message ?? String(result.signal)}):\n${result.stderr}`)
      statuses.set(days, outcomes(join(root, 'delo'), readFileSync(path, 'utf8')))
    }
    const base = statuses.get(0) ?? new Map<string, string>()
    const regressions = new Map(MOVED_CLOCK_DAYS.map(days => [days, clockRegressions(base, statuses.get(days) ?? new Map<string, string>())] as const))
    const lines = [...fixedDateWarnings(specTexts(root), new Date().toISOString().slice(0, 10)), ...report(regressions)]
    for (const line of lines) console.log(line)
    process.exitCode = [...regressions.values()].some(keys => keys.length > 0) ? 1 : 0
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
