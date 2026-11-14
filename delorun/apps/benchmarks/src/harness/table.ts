/**
 * The short table a run prints: per suite and scenario, each measured item's median, minimum, maximum and sample
 * count, with the machine's facts and load above it.
 *
 * @module @delorun/benchmarks/harness/table
 */
import type { BenchmarkResult } from './result.ts'

/**
 * Milliseconds as a person reads them.
 * @param milliseconds - the value.
 * @returns `850 ms` below ten seconds' worth of milliseconds, otherwise seconds to one decimal.
 */
export function formatDuration(milliseconds: number): string {
  return milliseconds < 10_000 ? `${String(Math.round(milliseconds))} ms` : `${(milliseconds / 1000).toFixed(1)} s`
}

/**
 * A percentage, or `unknown`.
 * @param value - the value.
 * @returns the text.
 */
function percent(value: number | undefined): string {
  return value === undefined ? 'unknown' : `${String(value)}%`
}

/**
 * Pad the columns of rows to a common width.
 * @param rows - the rows, the first being the header.
 * @returns the lines.
 */
export function columns(rows: readonly (readonly string[])[]): readonly string[] {
  const widths = rows[0]!.map((_, at) => Math.max(...rows.map(row => row[at]?.length ?? 0)))
  return rows.map(row => row.map((cell, at) => at === 0 ? cell.padEnd(widths[at]!) : cell.padStart(widths[at]!)).join('  ').trimEnd())
}

/**
 * The table of a result.
 * @param result - the result.
 * @returns the lines.
 */
export function resultTable(result: BenchmarkResult): readonly string[] {
  const { machine, load } = result
  const lines = [
    `Delorun benchmarks at ${result.commit.slice(0, 12)}, ${result.startedAt}`,
    `Machine: ${String(machine.cpus)} CPUs (${machine.cpuModel}), ${String(machine.memoryGiB)} GiB, ${machine.platform}-${machine.arch} ${machine.kernel}, Node ${machine.node}, ${machine.fileSystem}${machine.clone ? ' with clones' : ' without clones'}`,
    `Load average before ${load.before.join(' / ')}, after ${load.after.join(' / ')}; storage pressure before ${percent(load.ioBefore)}, after ${percent(load.ioAfter)}, highest ${percent(load.ioMax)}`,
  ]
  for (const suite of result.suites) {
    for (const scenario of suite.scenarios) {
      const parameters = Object.entries(scenario.parameters).map(([key, value]) => `${key}=${String(value)}`).join(', ')
      lines.push('', `${suite.suite} / ${scenario.scenario} (${String(scenario.completed)} run${scenario.completed === 1 ? '' : 's'}${parameters === '' ? '' : `; ${parameters}`})`)
      const rows = [['item', 'median', 'min', 'max', 'n'], ...scenario.phases.map(phase => [phase.phase, formatDuration(phase.summary.median), formatDuration(phase.summary.min), formatDuration(phase.summary.max), String(phase.summary.n)])]
      lines.push(...columns(rows).map(line => `  ${line}`))
      for (const failure of scenario.failures) lines.push(`  failed: ${failure.split('\n')[0]!}`)
    }
    for (const skipped of suite.skipped) lines.push(`${suite.suite}: skipped ${skipped.item}: ${skipped.reason}`)
  }
  return lines
}
