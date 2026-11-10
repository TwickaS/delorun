/**
 * `pnpm run benchmark:delo`: measure the points where a person waits on Delo, suite by suite, on local releases of
 * this commit in throwaway homes, with no request leaving the machine. `--prepare` builds the base runtime closure
 * first, outside the isolated network, because the release recipe installs dependencies; the measured run then
 * re-runs itself in a loopback-only network namespace ([isolation](./harness/isolation.ts)), writes the JSON result,
 * prints the table and, with `--check-budgets`, fails when a median is over its ceiling in `budgets.json`.
 *
 * Exit codes: 0 measured (and within budgets when checked), 1 a refusal, a failure or a budget violation, 2 a usage error.
 *
 * @module @delo/benchmarks/run
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { CleanupScope } from '@delo/release/tests/local/support'
import { createChannel, type LocalChannel } from './fixtures/channel.ts'
import { BENCH_PLATFORM, buildBase, cachedBase, closureCache, closureFrom, derivedClosure, type ClosureDirectory } from './fixtures/closure.ts'
import { checkBudgets, proposeBudgets, readBudgets } from './harness/budgets.ts'
import { assertIsolated, ISOLATED_ENV, rerunIsolated } from './harness/isolation.ts'
import { loadAverages, machineFacts } from './harness/machine.ts'
import { parseCommandLine, selection, USAGE, UsageError, type CommandLine } from './harness/options.ts'
import { RESULT_SCHEMA, Scrubber, type BenchmarkResult, type SuiteResult } from './harness/result.ts'
import { canonical, createRoot, realHomes, type BenchRoot } from './harness/roots.ts'
import type { SharedFixtures, SuiteContext } from './harness/suite.ts'
import { resultTable } from './harness/table.ts'
import { SUITES } from './suites/index.ts'
import { closureFileNames } from '@delo/release/closure/tree'

/** This package's directory. */
const PACKAGE = fileURLToPath(new URL('..', import.meta.url))

/** The checked-in ceilings. */
export const BUDGETS_PATH = join(PACKAGE, 'budgets.json')

/** The rule the ceilings follow, written into a proposed budget file. */
export const CEILING_RULE = 'Each ceiling is four times the median measured on the recorded machine and load, at least one second, rounded up to two significant digits; see delo/docs/performance/README.md.'

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
  if (closure === undefined) throw new Error('no base closure for this commit; run pnpm run benchmark:delo -- --prepare first')
  const cleanups: (() => void | Promise<void>)[] = []
  const scope: CleanupScope = { onTestFinished(fn) { cleanups.push(fn) } }
  const homes = realHomes()
  const scrubber = new Scrubber(homes)
  const rootBase = canonical(line.rootBase ?? tmpdir())
  const roots: BenchRoot[] = []
  const newRoot = (): BenchRoot => {
    const root = createRoot(rootBase, homes)
    scrubber.addRoot(root.path)
    roots.push(root)
    return root
  }
  const machine = machineFacts(rootBase)
  const startedAt = new Date().toISOString()
  const before = loadAverages()
  let shared: Promise<SharedFixtures> | undefined
  const fixtures = (): Promise<SharedFixtures> => {
    shared ??= (async () => {
      const work = newRoot()
      const channel: LocalChannel = await createChannel({ repository: facts.repository, directory: join(work.path, 'channel'), scope })
      const derivedCache = closureCache(cache, closure.key)
      return { channel, closure: (version, variant) => derivedClosure(closure.base, derivedCache, version, variant) }
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
    for (const cleanup of cleanups.reverse()) await cleanup()
    for (const root of roots) root.dispose()
  }
  const result: BenchmarkResult = {
    schema: RESULT_SCHEMA, startedAt, commit: facts.commit, machine,
    load: { before, after: loadAverages() },
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
    if (!(error instanceof UsageError)) throw error
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
    const cache = join(facts.repository, '.cache', 'delo-benchmarks')
    if (line.prepare) {
      if (line.closureFrom !== undefined) closureFrom(resolve(line.closureFrom))
      else if (cachedBase(cache, facts.commit) === undefined) await buildBase(facts.repository, cache, facts.commit, log)
      log('the base closure is ready')
      return 0
    }
    if (process.env[ISOLATED_ENV] === '1') return await measure(line, facts, cache)
    if (baseClosure(line, cache, facts.commit) === undefined) throw new Error('no base closure for this commit; run pnpm run benchmark:delo -- --prepare first')
    return await rerunIsolated([...process.execArgv, ...process.argv.slice(1)])
  } catch (error) {
    log(`benchmark: ${new Scrubber(realHomes()).scrub(error instanceof Error ? error.message : String(error))}`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
