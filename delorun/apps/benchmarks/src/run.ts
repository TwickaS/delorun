/**
 * `pnpm run benchmark:delorun`: measure the points where a person waits on Delorun, suite by suite, on local releases of
 * this commit in throwaway homes, with no request leaving the machine. `--prepare` builds the base runtime closure
 * first, outside the isolated network, because the release recipe installs dependencies; the measured run then
 * re-runs itself in a loopback-only network namespace ([isolation](./harness/isolation.ts)), writes the JSON result,
 * prints the table and, with `--check-budgets`, fails when a median is over its ceiling in `budgets.json`.
 *
 * Exit codes: 0 measured (and within budgets when checked), 1 a refusal, a failure or a budget violation, 2 a usage error,
 * 3 budgets not judged because storage pressure was over the limit during the run.
 *
 * @module @delorun/benchmarks/run
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { CleanupScope } from '@delorun/release/tests/local/support'
import { createChannel, type LocalChannel } from './fixtures/channel.ts'
import { BENCH_PLATFORM, buildBase, cachedBase, closureCache, closureFrom, derivedClosure, type ClosureDirectory } from './fixtures/closure.ts'
import { checkBudgets, proposeBudgets, readBudgets, unjudgeable } from './harness/budgets.ts'
import { assertIsolated, ISOLATED_ENV, rerunIsolated } from './harness/isolation.ts'
import { ioPressure, loadAverages, machineFacts } from './harness/machine.ts'
import { parseCommandLine, selection, USAGE, BenchmarkUsageError, type CommandLine } from './harness/options.ts'
import { RESULT_SCHEMA, Scrubber, type BenchmarkResult, type SuiteResult } from './harness/result.ts'
import { canonical, createRoot, realHomes, type BenchRoot } from './harness/roots.ts'
import type { SharedFixtures, SuiteContext } from './harness/suite.ts'
import { resultTable } from './harness/table.ts'
import { SUITES } from './suites/index.ts'
import { closureFileNames } from '@delorun/release/closure/tree'

/** This package's directory. */
const PACKAGE = fileURLToPath(new URL('..', import.meta.url))

/** The checked-in ceilings. */
export const BUDGETS_PATH = join(PACKAGE, 'budgets.json')

/** The rule the ceilings follow, written into a proposed budget file. */
export const CEILING_RULE = 'Each ceiling is four times the median measured on the recorded machine and load, at least one second, rounded up to two significant digits; see delorun/docs/performance/README.md.'

/** The exit code of a run whose timings the budget check refused to judge. */
export const NOT_JUDGED = 3

/**
 * The storage pressure fields a result carries, without the unknown ones.
 * @param before - at the start.
 * @param after - at the end.
 * @param max - the highest sample.
 * @returns the fields.
 */
function pressures(before: number | undefined, after: number | undefined, max: number | undefined): { ioBefore?: number, ioAfter?: number, ioMax?: number } {
  const highest = max === undefined && after === undefined ? undefined : Math.max(max ?? 0, after ?? 0)
  return { ...before === undefined ? {} : { ioBefore: before }, ...after === undefined ? {} : { ioAfter: after }, ...highest === undefined ? {} : { ioMax: highest } }
}

/**
 * Write a progress line.
 * @param text - the line.
 */
function log(text: string): void {
  process.stderr.write(`${text}\n`)
}

/**
 * The repository root and commit.
 * @returns both.
 */
function repositoryFacts(): { readonly repository: string, readonly commit: string } {
  const repository = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: PACKAGE, encoding: 'utf8' }).trim()
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
  return { repository, commit }
}

/**
 * The base closure the run derives its releases from, and the cache key of the releases derived from it.
 * @param line - the command line.
 * @param cache - the benchmark cache.
 * @param commit - the measured commit.
 * @returns the closure and its key, or `undefined` when none was built.
 */
function baseClosure(line: CommandLine, cache: string, commit: string): { readonly base: ClosureDirectory, readonly key: string } | undefined {
  if (line.closureFrom !== undefined) {
    const base = closureFrom(resolve(line.closureFrom))
    const list = readFileSync(join(base.directory, closureFileNames(base.version, BENCH_PLATFORM).files))
    return { base, key: `from-${createHash('sha256').update(list).digest('hex').slice(0, 16)}` }
  }
  const base = cachedBase(cache, commit)
  return base === undefined ? undefined : { base, key: commit }
}

/**
 * Run the measured part inside the isolated network.
 * @param line - the command line.
 * @param facts - the repository and commit.
 * @param cache - the benchmark cache.
 * @returns the exit code.
 */
async function measure(line: CommandLine, facts: { readonly repository: string, readonly commit: string }, cache: string): Promise<number> {
  assertIsolated()
  const closure = baseClosure(line, cache, facts.commit)
  if (closure === undefined) throw new Error('no base closure for this commit; run pnpm run benchmark:delorun -- --prepare first')
  const cleanups: (() => void | Promise<void>)[] = []
  const scope: CleanupScope = { onTestFinished(fn) { cleanups.push(fn) } }
  const homes = realHomes()
  const scrubber = new Scrubber(homes)
  const rootBase = canonical(line.rootBase ?? tmpdir())
  const roots: BenchRoot[] = []
  const newRoot = (): BenchRoot => {
    const created = createRoot(rootBase, homes)
    const root = line.keepRoots ? { ...created, dispose: () => {} } : created
    scrubber.addRoot(root.path)
    roots.push(root)
    return root
  }
  const machine = machineFacts(rootBase)
  const startedAt = new Date().toISOString()
  const before = loadAverages()
  const ioBefore = ioPressure()
  let ioMax = ioBefore
  const sampler = setInterval(() => {
    const now = ioPressure()
    if (now !== undefined) ioMax = Math.max(ioMax ?? 0, now)
  }, 5000)
  let shared: Promise<SharedFixtures> | undefined
  const fixtures = (): Promise<SharedFixtures> => {
    shared ??= (async () => {
      const work = newRoot()
      const channel: LocalChannel = await createChannel({ repository: facts.repository, directory: join(work.path, 'channel'), scope })
      const derivedCache = closureCache(cache, closure.key)
      const templates = new Map<string, Promise<BenchRoot>>()
      return {
        channel,
        closure: (version, variant) => derivedClosure(closure.base, derivedCache, version, variant),
        template(key, make) {
          const existing = templates.get(key)
          if (existing !== undefined) return existing
          const root = newRoot()
          const made = make(root).then(() => root)
          templates.set(key, made)
          return made
        },
      }
    })()
    return shared
  }
  const context: SuiteContext = {
    repository: facts.repository, cache, machine, scrubber, fixtures, newRoot, log,
    options: { repeat: line.repeat, chatsSmall: line.chatsSmall, chatsLarge: line.chatsLarge, plugins: line.plugins },
  }
  const suites: SuiteResult[] = []
  try {
    for (const { suite, scenarios } of selection(line, SUITES)) {
      log(`suite ${suite.id}: ${scenarios.join(', ')}`)
      suites.push(await suite.run(context, scenarios))
    }
  } finally {
    clearInterval(sampler)
    for (const cleanup of cleanups.reverse()) await cleanup()
    for (const root of roots) root.dispose()
    if (line.keepRoots) log(`kept the roots: ${roots.map(root => root.path).join(' ')}`)
  }
  const result: BenchmarkResult = {
    schema: RESULT_SCHEMA, startedAt, commit: facts.commit, machine,
    load: { before, after: loadAverages(), ...pressures(ioBefore, ioPressure(), ioMax) },
    options: { repeat: line.repeat, chatsSmall: line.chatsSmall, chatsLarge: line.chatsLarge, plugins: line.plugins, suites: line.suites, scenarios: line.scenarios },
    suites,
  }
  const out = line.out ?? join(cache, 'results', `${startedAt.replace(/[:.]/gu, '-')}.json`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(result, undefined, 2)}\n`)
  for (const text of resultTable(result)) process.stdout.write(`${text}\n`)
  process.stdout.write(`\nresult: ${scrubber.scrub(resolve(out))}\n`)
  if (line.proposeBudgets !== undefined) writeFileSync(line.proposeBudgets, `${JSON.stringify(proposeBudgets(result, CEILING_RULE), undefined, 2)}\n`)
  const failed = suites.some(suite => suite.scenarios.some(scenario => scenario.failures.length > 0))
  if (!line.checkBudgets) return failed ? 1 : 0
  const refusal = unjudgeable(result.load)
  if (refusal !== undefined) {
    process.stdout.write(`budgets not judged: ${refusal}\n`)
    return NOT_JUDGED
  }
  const violations = checkBudgets(result, readBudgets(BUDGETS_PATH))
  for (const violation of violations) process.stdout.write(`over budget: ${violation.where}: ${violation.problem}\n`)
  if (violations.length === 0) process.stdout.write('every measured item is within its ceiling\n')
  return violations.length === 0 ? 0 : 1
}

/**
 * Run the command.
 * @param argv - the arguments after the script.
 * @returns the exit code.
 */
export async function main(argv: readonly string[]): Promise<number> {
  let line: CommandLine
  try {
    line = parseCommandLine(argv, SUITES)
  } catch (error) {
    if (!(error instanceof BenchmarkUsageError)) throw error
    log(`${error.message}\n\n${USAGE}`)
    return 2
  }
  if (line.list) {
    for (const suite of SUITES) {
      process.stdout.write(`${suite.id}: ${suite.title}\n`)
      for (const scenario of suite.scenarios) process.stdout.write(`  scenario ${scenario.id}: ${scenario.description}\n`)
      for (const [item, text] of Object.entries(suite.items)) process.stdout.write(`  item ${item}: ${text}\n`)
    }
    return 0
  }
  try {
    const facts = repositoryFacts()
    const cache = join(facts.repository, '.cache', 'delorun-benchmarks')
    if (line.prepare) {
      if (line.closureFrom !== undefined) closureFrom(resolve(line.closureFrom))
      else if (cachedBase(cache, facts.commit) === undefined) await buildBase(facts.repository, cache, facts.commit, log)
      log('the base closure is ready')
      return 0
    }
    if (process.env[ISOLATED_ENV] === '1') return await measure(line, facts, cache)
    if (baseClosure(line, cache, facts.commit) === undefined) throw new Error('no base closure for this commit; run pnpm run benchmark:delorun -- --prepare first')
    return await rerunIsolated([...process.execArgv, ...process.argv.slice(1)])
  } catch (error) {
    log(`benchmark: ${new Scrubber(realHomes()).scrub(error instanceof Error ? error.message : String(error))}`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
