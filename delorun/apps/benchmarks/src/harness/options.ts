/**
 * The command line of `pnpm run benchmark:delorun`.
 *
 * @module @delorun/benchmarks/harness/options
 */
import { parseArgs } from 'node:util'
import type { Suite } from './suite.ts'

/** The usage text. */
export const USAGE = [
  'usage: pnpm run benchmark:delorun -- [--prepare] [--list] [--suite <id>]... [--scenario <id>]... [--repeat <n>]',
  '         [--chats-small <n>] [--chats-large <n>] [--plugins <n>] [--root-base <dir>] [--closure-from <dir>]',
  '         [--out <file>] [--check-budgets] [--propose-budgets <file>] [--keep-roots]',
  '',
  '  --prepare           build the base runtime closure of this commit into the cache (needs the built artifacts); no measurement',
  '  --list              print the suites, their scenarios and their measured items',
  '  --suite             run only these suites; all by default',
  '  --scenario          run only these scenarios of the selected suites; all by default',
  '  --repeat            repetitions per scenario (default 3)',
  '  --chats-small       chats in the small set (default 20)',
  '  --chats-large       chats in the large set (default 400)',
  '  --plugins           synthetic plugins where a scenario installs many (default 20)',
  '  --root-base         where throwaway roots are created; the system temporary directory by default',
  '  --closure-from      a directory holding a linux-x64 closure that build-closure.ts built, instead of the cached one',
  '  --out               the result file; .cache/delorun-benchmarks/results/<time>.json by default',
  '  --check-budgets     fail when a median is over its ceiling in budgets.json',
  '  --propose-budgets   write ceilings proposed from this run\'s medians to a file',
  '  --keep-roots        keep every throwaway root after the run, to read its homes\' logs after a failure',
].join('\n')

/** The parsed command line. */
export interface CommandLine {
  readonly prepare: boolean
  readonly list: boolean
  readonly suites: readonly string[]
  readonly scenarios: readonly string[]
  readonly repeat: number
  readonly chatsSmall: number
  readonly chatsLarge: number
  readonly plugins: number
  readonly rootBase: string | undefined
  readonly closureFrom: string | undefined
  readonly out: string | undefined
  readonly checkBudgets: boolean
  readonly proposeBudgets: string | undefined
  readonly keepRoots: boolean
}

/** A command line the harness refuses. */
export class BenchmarkUsageError extends Error {
  override readonly name = 'BenchmarkUsageError'
}

/**
 * A positive whole number option.
 * @param name - the option.
 * @param text - its value.
 * @param fallback - its default.
 * @returns the number.
 * @throws {BenchmarkUsageError} when it is not a positive whole number.
 */
function count(name: string, text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < 1) throw new BenchmarkUsageError(`--${name} takes a positive whole number, not ${JSON.stringify(text)}`)
  return value
}

/**
 * Parse the command line.
 * @param argv - the arguments after the script.
 * @param suites - the known suites, which `--suite` and `--scenario` must name.
 * @returns the parsed line.
 * @throws {BenchmarkUsageError} for an unknown option, suite or scenario, or a malformed number.
 */
export function parseCommandLine(argv: readonly string[], suites: readonly Suite[]): CommandLine {
  let values
  try {
    ({ values } = parseArgs({
      args: argv[0] === '--' ? argv.slice(1) : [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        'prepare': { type: 'boolean', default: false },
        'list': { type: 'boolean', default: false },
        'suite': { type: 'string', multiple: true },
        'scenario': { type: 'string', multiple: true },
        'repeat': { type: 'string' },
        'chats-small': { type: 'string' },
        'chats-large': { type: 'string' },
        'plugins': { type: 'string' },
        'root-base': { type: 'string' },
        'closure-from': { type: 'string' },
        'out': { type: 'string' },
        'check-budgets': { type: 'boolean', default: false },
        'propose-budgets': { type: 'string' },
        'keep-roots': { type: 'boolean', default: false },
      },
    }))
  } catch (error) {
    throw new BenchmarkUsageError(error instanceof Error ? error.message : String(error))
  }
  const known = new Set(suites.map(suite => suite.id))
  const selected = values.suite ?? []
  for (const id of selected) if (!known.has(id)) throw new BenchmarkUsageError(`no suite is called ${JSON.stringify(id)}; the suites are ${[...known].join(', ')}`)
  const scenarios = values.scenario ?? []
  const reachable = new Set(suites.filter(suite => selected.length === 0 || selected.includes(suite.id)).flatMap(suite => suite.scenarios.map(scenario => scenario.id)))
  for (const id of scenarios) if (!reachable.has(id)) throw new BenchmarkUsageError(`no selected suite has a scenario called ${JSON.stringify(id)}`)
  return {
    prepare: values.prepare,
    list: values.list,
    suites: selected,
    scenarios,
    repeat: count('repeat', values.repeat, 3),
    chatsSmall: count('chats-small', values['chats-small'], 20),
    chatsLarge: count('chats-large', values['chats-large'], 400),
    plugins: count('plugins', values.plugins, 20),
    rootBase: values['root-base'],
    closureFrom: values['closure-from'],
    out: values.out,
    checkBudgets: values['check-budgets'],
    proposeBudgets: values['propose-budgets'],
    keepRoots: values['keep-roots'],
  }
}

/**
 * The suites a command line selects, and in each the scenarios it selects.
 * @param line - the parsed line.
 * @param suites - every suite.
 * @returns each selected suite with its selected scenario ids.
 */
export function selection(line: Pick<CommandLine, 'suites' | 'scenarios'>, suites: readonly Suite[]): readonly { readonly suite: Suite, readonly scenarios: readonly string[] }[] {
  return suites
    .filter(suite => line.suites.length === 0 || line.suites.includes(suite.id))
    .map(suite => ({ suite, scenarios: suite.scenarios.map(scenario => scenario.id).filter(id => line.scenarios.length === 0 || line.scenarios.includes(id)) }))
    .filter(entry => entry.scenarios.length > 0)
}
