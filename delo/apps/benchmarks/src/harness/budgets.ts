/**
 * The checked-in ceilings (`delo/apps/benchmarks/budgets.json`, `delo.benchmark-budgets/1`): per suite and scenario, a
 * ceiling in milliseconds for some of its measured items. `--check-budgets` compares each item's median with its
 * ceiling and fails the run when a median is over it, when a budgeted item was not measured in a scenario that ran,
 * when a scenario that ran has no ceilings, or when a scenario failed. The ceilings are generous multiples of medians
 * measured on a loaded machine (the performance page records how each was chosen), so the check catches a regression
 * of several times, not noise.
 *
 * @module @delo/benchmarks/harness/budgets
 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { BenchmarkResult } from './result.ts'

/** The budget file's format. */
export const BUDGETS_SCHEMA = 'delo.benchmark-budgets/1'

const ceilings = z.record(z.string().min(1), z.number().int().positive())

/** The budget file. */
export const BudgetFile = z.strictObject({
  schema: z.literal(BUDGETS_SCHEMA),
  /** How the ceilings were chosen, for a reader of the file. */
  rule: z.string().min(1),
  suites: z.record(z.string().min(1), z.record(z.string().min(1), ceilings)),
})

/** {@link BudgetFile}'s parsed value. */
export type BudgetFile = z.output<typeof BudgetFile>

/** One reason the check fails. */
export interface Violation {
  /** `suite/scenario/item`, or `suite/scenario` for the scenario as a whole. */
  readonly where: string
  /** What is wrong. */
  readonly problem: string
}

/** The storage pressure above which a run's timings are not judged: they measure a busy disk, not Delo. */
export const IO_PRESSURE_LIMIT = 20

/**
 * Why a run's timings cannot be judged against the budgets, if they cannot.
 * @param load - the run's load.
 * @returns the reason, or `undefined` when the run can be judged.
 */
export function unjudgeable(load: BenchmarkResult['load']): string | undefined {
  const highest = Math.max(load.ioBefore ?? 0, load.ioAfter ?? 0, load.ioMax ?? 0)
  return highest > IO_PRESSURE_LIMIT ? `storage pressure reached ${String(highest)}% (some avg10 of /proc/pressure/io), over the ${String(IO_PRESSURE_LIMIT)}% above which timings measure the disk; rerun on a quiet machine` : undefined
}

/**
 * Read and validate a budget file.
 * @param path - the file.
 * @returns the budgets.
 * @throws {Error} when the file is missing or not a budget file.
 */
export function readBudgets(path: string): BudgetFile {
  return BudgetFile.parse(JSON.parse(readFileSync(path, 'utf8')))
}

/**
 * Compare a result with the budgets.
 * @param result - the run's result.
 * @param budgets - the ceilings.
 * @returns every violation; none when the run is within its budgets.
 */
export function checkBudgets(result: Pick<BenchmarkResult, 'suites'>, budgets: BudgetFile): readonly Violation[] {
  const violations: Violation[] = []
  for (const suite of result.suites) {
    for (const scenario of suite.scenarios) {
      const where = `${suite.suite}/${scenario.scenario}`
      for (const failure of scenario.failures) violations.push({ where, problem: `a repetition failed: ${failure.split('\n')[0]!}` })
      const budget = budgets.suites[suite.suite]?.[scenario.scenario]
      if (budget === undefined) {
        violations.push({ where, problem: 'no ceiling is recorded for this scenario in budgets.json' })
        continue
      }
      for (const [phase, ceiling] of Object.entries(budget)) {
        const measured = scenario.phases.find(candidate => candidate.phase === phase)
        if (measured === undefined) violations.push({ where: `${where}/${phase}`, problem: 'has a ceiling but was not measured' })
        else if (measured.summary.median > ceiling) violations.push({ where: `${where}/${phase}`, problem: `median ${String(measured.summary.median)} ms is over its ceiling of ${String(ceiling)} ms` })
      }
    }
  }
  return violations
}

/**
 * A ceiling proposed from a median: four times the median, at least one second, rounded up to two significant digits.
 * The performance page records why.
 * @param median - the measured median, in milliseconds.
 * @returns the ceiling.
 */
export function proposeCeiling(median: number): number {
  const raw = Math.max(4 * median, 1000)
  const unit = 10 ** Math.max(0, Math.floor(Math.log10(raw)) - 1)
  return Math.ceil(raw / unit) * unit
}

/**
 * Budgets proposed from a result, for every scenario that completed without failure.
 * @param result - the run's result.
 * @param rule - the rule text the file carries.
 * @returns the budget file's content.
 */
export function proposeBudgets(result: Pick<BenchmarkResult, 'suites'>, rule: string): BudgetFile {
  const suites: Record<string, Record<string, Record<string, number>>> = {}
  for (const suite of result.suites) {
    for (const scenario of suite.scenarios) {
      if (scenario.failures.length > 0 || scenario.phases.length === 0) continue
      const entry: Record<string, number> = {}
      for (const phase of scenario.phases) entry[phase.phase] = proposeCeiling(phase.summary.median)
      suites[suite.suite] = { ...suites[suite.suite], [scenario.scenario]: entry }
    }
  }
  return { schema: BUDGETS_SCHEMA, rule, suites }
}
