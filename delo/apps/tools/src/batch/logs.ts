/**
 * The check runner's report and logs as the batch reads them. A run replaces the previous run's logs, so a gate's
 * failing checks are read, with their first failure, the spec files and the commit ids their logs name, as soon as the
 * gate ends.
 *
 * @module @delo/tools/batch/logs
 */
import { join } from 'node:path'
import { z } from 'zod'
import { excerpt, plainLines } from '../checks/failure.ts'
import type { Files, FailedCheck } from './state.ts'

export { excerpt }

/** The check runner's report, relative to the repository root. */
export const REPORT_PATH = 'node_modules/.cache/delo-checks/report.json'

/** The test lanes whose logs name failing spec files: the directory the paths are relative to, and the configuration that runs one. */
export const SPEC_LANES: Readonly<Record<string, { readonly root: string, readonly config: string }>> = {
  'tests:fork': { root: 'delo/', config: 'delo/vitest.config.ts' },
  'tests:docker': { root: 'delo/', config: 'delo/vitest.docker.config.ts' },
  'tests:upstream-changed': { root: '', config: 'vitest.config.ts' },
}

/** The range gates, whose logs name the commits they refuse. */
export const RANGE_GATES: readonly string[] = ['gates:dco', 'gates:commits', 'gates:changelog', 'gates:doc-times', 'gates:personal-data']

/** The report fields the batch reads. */
const ReportSchema = z.object({
  checks: z.array(z.object({
    check: z.string(),
    status: z.enum(['passed', 'failed', 'declined', 'skipped']),
    reason: z.string().nullable(),
    logPath: z.string().nullable(),
  })),
})

/** One check of the runner's report. */
export type ReportEntry = z.infer<typeof ReportSchema>['checks'][number]

const SPEC_PATH = /\bFAIL\s+(?:\|[^|\s]+\|\s+)?(\S+?\.(?:spec|test)\.[cm]?[jt]sx?)\b/
const COMMIT_ID = /\b[0-9a-f]{7,64}\b/g

/**
 * Read the runner's report.
 * @param files - the file port.
 * @param root - the repository root.
 * @returns its checks, or undefined when there is no report or it is not one.
 */
export function readReport(files: Files, root: string): ReportEntry[] | undefined {
  const text = files.read(join(root, REPORT_PATH))
  if (text === undefined) return undefined
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    // SyntaxError: a report cut short when the runner was stopped, which names no result.
    void error
    return undefined
  }
  const parsed = ReportSchema.safeParse(json)
  return parsed.success ? parsed.data.checks : undefined
}

/**
 * The spec files a test lane's log names as failing, repository-relative.
 * @param check - the check's id; only {@link SPEC_LANES} name spec files.
 * @param log - the check's log.
 * @returns the paths, in first-seen order.
 */
export function failingSpecs(check: string, log: string): string[] {
  const lane = SPEC_LANES[check]
  if (lane === undefined) return []
  const specs = plainLines(log).flatMap(line => {
    const path = SPEC_PATH.exec(line)?.[1]
    return path === undefined ? [] : [`${lane.root}${path}`]
  })
  return [...new Set(specs)]
}

/**
 * The commit ids, full or abbreviated, a range gate's log names.
 * @param check - the check's id; only {@link RANGE_GATES} name commits.
 * @param log - the check's log.
 * @returns the ids, in first-seen order.
 */
export function namedCommits(check: string, log: string): string[] {
  if (!RANGE_GATES.includes(check)) return []
  return [...new Set(log.match(COMMIT_ID) ?? [])]
}

/**
 * The failing checks of a report, each with its log's excerpt, failing specs and named commits.
 * @param files - the file port.
 * @param root - the repository root, which the report's log paths are relative to.
 * @param entries - the report's checks.
 * @returns the failed ones, in report order.
 */
export function failuresOf(files: Files, root: string, entries: readonly ReportEntry[]): FailedCheck[] {
  return entries.filter(entry => entry.status === 'failed').map(entry => {
    const log = entry.logPath === null ? '' : files.read(join(root, entry.logPath)) ?? ''
    return {
      check: entry.check,
      reason: entry.reason,
      logPath: entry.logPath,
      excerpt: excerpt(log),
      specs: failingSpecs(entry.check, log),
      commits: namedCommits(entry.check, log),
    }
  })
}
