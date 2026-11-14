/**
 * C3's `--yes` gate for a `harness-change-merged` item beside the release-log check: each condition alone keeps
 * `delorun update --yes` from confirming, and only a report with neither condition confirms.
 */
import { describe, expect, it } from 'vitest'
import type { UpdateReport } from '@delorun/contract-update-report'
import { buildUpdateReport, confirmsWithoutAsking, type HarnessFact } from '../src/index.ts'
import { input, installed, profile, target } from './support.ts'

const MERGED: HarnessFact = { file: 'app/node_modules/@delorun/cli/src/start.js', merge: 'merged' }

/**
 * A report with the given harness fact and release-log state.
 * @param harness - the harness facts.
 * @param log - the release-log check's state in the report.
 * @returns the report.
 */
function reportWith(harness: readonly HarnessFact[], log: UpdateReport['release']['log']): UpdateReport {
  const report = buildUpdateReport(input({ profile: profile({ plugins: [installed('dsh-tools', '1.4.0', { dsh: '^0.3.0' })] }), target: target(), harness }))
  return { ...report, release: { ...report.release, log } }
}

describe('c03-harness-change-merged-confirm', () => {
  it.each([
    { harness: [], log: 'passed', confirms: true },
    { harness: [MERGED], log: 'passed', confirms: false },
    { harness: [], log: 'unchecked', confirms: false },
    { harness: [MERGED], log: 'unchecked', confirms: false },
  ] as const)('harness $harness.length merged, log $log: confirms $confirms', ({ harness, log, confirms }) => {
    const report = reportWith(harness, log)

    expect(report.items.some(item => item.reason === 'harness-change-merged')).toBe(harness.length > 0)
    expect(confirmsWithoutAsking(report)).toBe(confirms)
  })
})
