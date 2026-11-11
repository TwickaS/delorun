/**
 * The report's `harness` items and C3's denial tests for them: a change that carries is kept and confirmable, and a
 * conflicted file is named as such, says the person's file is kept beside the release's, offers to skip the update and
 * keeps `--yes` from confirming the report.
 */
import { describe, expect, it } from 'vitest'
import type { HarnessMerge } from '@delo/contract-update-report'
import { buildUpdateReport, confirmsWithoutAsking, harnessItems, reasonMessage, type HarnessFact } from '../src/index.ts'
import { input, installed, profile, target } from './support.ts'

const FILE = 'app/node_modules/@delo/cli/src/start.js'

/**
 * A report whose only items are the harness facts'.
 * @param harness - the facts.
 * @returns the report.
 */
function reportOf(harness: readonly HarnessFact[]): ReturnType<typeof buildUpdateReport> {
  return buildUpdateReport(input({ profile: profile({ plugins: [installed('dsh-tools', '1.4.0', { dsh: '^0.3.0' })] }), target: target(), harness }))
}

describe('c03-harness-change-carried', () => {
  it.each<HarnessMerge>(['release-unchanged', 'merged', 'in-release'])('keeps a change whose merge is %s, verified and with no action', (merge) => {
    const report = reportOf([{ file: FILE, merge }])

    expect(report.items).toEqual([{ kind: 'harness', subject: { file: FILE }, reason: 'harness-change-carried', effect: 'kept', verification: 'verified', detail: { merge }, actions: [] }])
    expect(reasonMessage(report.items[0]!, report)).toBe(`Your change to ${FILE} carries over to Delo 1.0.0.`)
    expect(report.counts).toEqual({ disabled: 0, removed: 0, changed: 0, unverified: 0, data: 0, harness: 1 })
    expect(confirmsWithoutAsking(report)).toBe(true)
  })
})

describe('c03-harness-conflict-keeps-mine', () => {
  it.each<HarnessMerge>(['edits-overlap', 'binary', 'too-large', 'release-removed', 'release-changed-removed', 'both-added'])('names a %s conflict, says the person\'s file is kept beside the release\'s, and offers to skip the update', (merge) => {
    const report = reportOf([{ file: FILE, merge }])

    expect(report.items).toEqual([{ kind: 'harness', subject: { file: FILE }, reason: 'harness-change-conflicts', effect: 'disabled', verification: 'verified', detail: { merge }, actions: ['skip-update'] }])
    expect(reasonMessage(report.items[0]!, report)).toBe(`Your change to ${FILE} conflicts with Delo 1.0.0's file; the new release's file runs, and yours is kept beside it as ${FILE}.mine.`)
    expect(report.counts).toMatchObject({ disabled: 1, harness: 1 })
  })

  it('keeps `--yes` from confirming a report with a conflicted file, whatever else carries', () => {
    const report = reportOf([{ file: 'app/a.js', merge: 'merged' }, { file: FILE, merge: 'edits-overlap' }])

    expect(confirmsWithoutAsking(report)).toBe(false)
    expect(confirmsWithoutAsking({ ...report, items: report.items.filter(item => item.reason !== 'harness-change-conflicts') })).toBe(true)
  })
})

describe('harnessItems', () => {
  it('lists one item per approved file, sorted after every other kind by file', () => {
    expect(harnessItems([])).toEqual([])
    const report = buildUpdateReport(input({ harness: [{ file: 'app/b.js', merge: 'merged' }, { file: 'app/a.js', merge: 'both-added' }] }))

    expect(report.items.slice(-2).map(item => item.kind === 'harness' ? item.subject.file : item.kind)).toEqual(['app/a.js', 'app/b.js'])
    expect(report.items.filter(item => item.kind === 'harness')).toHaveLength(2)
  })
})
