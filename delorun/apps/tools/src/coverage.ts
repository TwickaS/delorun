/**
 * Coverage of Delorun's specs for the files a change touches, with every file in scope listed:
 *
 * ```sh
 * node_modules/.bin/tsx delorun/apps/tools/src/coverage.ts [--include <glob>]... <spec file or package directory>...
 * ```
 *
 * It runs the fork suite's Vitest over the named specs or packages inside the machine-wide slot budget (through
 * `with-slots.ts`), writes the report into a directory of its own under the system's temporary directory, so two runs never
 * share one, and prints one line per file in scope with its statements, branches, functions and lines, fully covered files
 * included. The files in scope are the `--include` globs, or else the `src` files of each named package. It exits with
 * Vitest's status, or 1 when a file in scope is below 100 % in any measure.
 *
 * @module @delorun/tools/coverage
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { packageDirOf } from './checks/plan.ts'
import { repositoryRoot } from './git.ts'
import { runInherited } from './with-slots.ts'

/** The slots a coverage run takes. */
const COVERAGE_SLOTS = 4

const Measure = z.object({ pct: z.union([z.number(), z.literal('Unknown')]) })
const Summary = z.record(z.string(), z.object({ statements: Measure, branches: Measure, functions: Measure, lines: Measure }))

/**
 * The globs a coverage run measures: the given ones, or the `src` files of each package a path lies in.
 * @param include - the `--include` globs.
 * @param paths - the spec files and package directories named.
 * @returns the globs, repository-relative.
 * @throws Error when no glob is given and no path lies in a Delorun package.
 */
export function coverageScope(include: readonly string[], paths: readonly string[]): string[] {
  if (include.length > 0) return [...include]
  const dirs = [...new Set(paths.flatMap(path => packageDirOf(path) ?? []))]
  if (dirs.length === 0) throw new Error('name a spec file or package under delorun/apps or delorun/packages, or the files to measure with --include')
  return dirs.map(dir => `${dir}/src/**`)
}

/**
 * The lines that list every file of a Vitest `json-summary` report, and how many are below 100 % in any measure.
 * @param text - the report's text.
 * @param root - the repository root, which the paths are printed relative to.
 * @returns the lines and the count of files below full coverage.
 */
export function coverageLines(text: string, root: string): { readonly lines: string[], readonly below: number } {
  const summary = Summary.parse(JSON.parse(text))
  const percent = (measure: z.infer<typeof Measure>): string => measure.pct === 'Unknown' ? '100.00' : measure.pct.toFixed(2)
  let below = 0
  const lines = Object.entries(summary).filter(([file]) => file !== 'total').sort(([a], [b]) => (a < b ? -1 : 1)).map(([file, measures]) => {
    const values = [measures.statements, measures.branches, measures.functions, measures.lines].map(percent)
    const full = values.every(value => value === '100.00')
    if (!full) below += 1
    return `${full ? '  ' : '✗ '}${values.join('  ')}  ${relative(root, file)}`
  })
  return { lines: ['  stmts   branch  funcs   lines   file', ...lines], below }
}

/** What a coverage run needs from its process. */
export interface CoverageHost {
  readonly root: string
  /** The directory the command line's paths are relative to. */
  readonly cwd: string
  /** A fresh directory for the report. */
  readonly reportDir: () => string
  /**
   * Run a command and resolve with its status.
   * @param argv - the command.
   * @returns the exit status.
   */
  readonly run: (argv: readonly string[]) => Promise<number>
  /** Read a file. */
  readonly read: (path: string) => string
  /** Print a line. */
  readonly say: (line: string) => void
}

/**
 * Measure coverage and list every file in scope.
 * @param argv - the command line: `--include` globs and the spec files or package directories.
 * @param host - the repository and the process.
 * @returns Vitest's status, or 1 when a file in scope is not fully covered.
 * @throws Error when nothing is named.
 */
export async function coverage(argv: readonly string[], host: CoverageHost): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...argv], allowPositionals: true, options: { include: { type: 'string', multiple: true } } })
  if (positionals.length === 0) throw new Error('name the spec files or package directories to run')
  const paths = positionals.map(path => relative(host.root, resolve(host.cwd, path)))
  const scope = coverageScope(values.include ?? [], paths)
  const dir = host.reportDir()
  const status = await host.run([
    'node_modules/.bin/tsx', 'delorun/apps/tools/src/with-slots.ts', '--slots', String(COVERAGE_SLOTS), '--disk', '--',
    'node_modules/.bin/vitest', 'run', '--config', 'delorun/vitest.config.ts', `--maxWorkers=${String(COVERAGE_SLOTS)}`,
    '--coverage.enabled', `--coverage.reportsDirectory=${dir}`, '--coverage.reporter=json-summary',
    ...scope.map(glob => `--coverage.include=${glob}`), ...paths,
  ])
  const { lines, below } = coverageLines(host.read(join(dir, 'coverage-summary.json')), host.root)
  for (const line of lines) host.say(line)
  host.say(`coverage: ${String(lines.length - 1)} file(s) in scope, ${String(below)} below 100 %; report in ${dir}`)
  return status !== 0 ? status : below > 0 ? 1 : 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = repositoryRoot(process.cwd())
  const cwd = process.cwd()
  // The commands it runs name paths from the repository root.
  process.chdir(root)
  process.exitCode = await coverage(process.argv.slice(2), {
    root,
    cwd,
    reportDir: () => mkdtempSync(join(tmpdir(), 'delorun-coverage-')),
    run: argv => runInherited(argv, process.env),
    read: path => readFileSync(path, 'utf8'),
    say: line => { console.log(line) },
  }).catch((error: unknown) => {
    console.error(`coverage: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  })
}
