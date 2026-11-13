/**
 * The report's `harness` items and C3's denial tests for them: a change that carries as it is is kept and confirmable;
 * a merged file is named as merged, carries its result and diff, and keeps `--yes` from confirming the report; and a
 * conflicted file is named as such, says the person's file is kept beside the release's, offers to skip the update and
 * keeps `--yes` from confirming the report.
 */
import { describe, expect, it } from 'vitest'
import type { HarnessMerge, HarnessResult } from '@delo/contract-update-report'
import { buildUpdateReport, confirmsWithoutAsking, harnessItems, reasonMessage, type HarnessFact } from '../src/index.ts'
import { input, installed, MANIFEST, profile, target } from './support.ts'

const FILE = 'app/node_modules/@delo/cli/src/start.js'
const RESULT: HarnessResult = { sha256: MANIFEST, executable: false }

/**
 * A report whose only items are the harness facts'.
 * @param harness - the facts.
 * @returns the report.
 */
function reportOf(harness: readonly HarnessFact[]): ReturnType<typeof buildUpdateReport> {
  return buildUpdateReport(input({ profile: profile({ plugins: [installed('dsh-tools', '1.4.0', { dsh: '^0.3.0' })] }), target: target(), harness }))
}

describe('c03-harness-change-carried', () => {
  it.each<HarnessMerge>(['release-unchanged', 'in-release'])('keeps a change whose merge is %s, verified and with no action', (merge) => {
    const report = reportOf([{ file: FILE, merge }])

    expect(report.items).toEqual([{ kind: 'harness', subject: { file: FILE }, reason: 'harness-change-carried', effect: 'kept', verification: 'verified', detail: { merge }, actions: [] }])
    expect(reasonMessage(report.items[0]!, report)).toBe(`Your change to ${FILE} carries over to Delo 1.0.0.`)
    expect(report.counts).toEqual({ disabled: 0, removed: 0, changed: 0, unverified: 0, data: 0, harness: 1 })
    expect(confirmsWithoutAsking(report)).toBe(true)
  })

  it('states what the target runs of a carried file', () => {
    expect(reportOf([{ file: FILE, merge: 'release-unchanged', result: RESULT }]).items[0]?.detail).toEqual({ merge: 'release-unchanged', result: RESULT })
  })
})

describe('c03-harness-change-merged', () => {
  it('names a merged file as merged with its result and diff, as a change that offers to skip the update', () => {
    const diff = { text: '--- a/x\n+++ b/x\n' }
    const report = reportOf([{ file: FILE, merge: 'merged', result: RESULT, diff }])

    expect(report.items).toEqual([{ kind: 'harness', subject: { file: FILE }, reason: 'harness-change-merged', effect: 'changed', verification: 'verified', detail: { merge: 'merged', result: RESULT, diff }, actions: ['skip-update'] }])
    expect(reasonMessage(report.items[0]!, report)).toBe(`Your change to ${FILE} and Delo 1.0.0's change to it merge into a file neither has; read the merge before you confirm.`)
    expect(report.counts).toMatchObject({ changed: 1, harness: 1 })
  })

  it('keeps `--yes` from confirming a report with a merged file, whatever else carries', () => {
    const report = reportOf([{ file: 'app/a.js', merge: 'release-unchanged' }, { file: FILE, merge: 'merged' }])

    expect(report.items.map(item => item.reason)).toEqual(['harness-change-carried', 'harness-change-merged'])
    expect(confirmsWithoutAsking(report)).toBe(false)
    expect(confirmsWithoutAsking({ ...report, items: report.items.filter(item => item.reason !== 'harness-change-merged') })).toBe(true)
  })
})

describe('c03-harness-conflict-keeps-mine', () => {
  it.each<HarnessMerge>(['edits-overlap', 'binary', 'too-large', 'release-removed', 'both-added'])('names a %s conflict, says the person\'s file is kept beside the release\'s, and offers to skip the update', (merge) => {
    const report = reportOf([{ file: FILE, merge }])

    expect(report.items).toEqual([{ kind: 'harness', subject: { file: FILE }, reason: 'harness-change-conflicts', effect: 'disabled', verification: 'verified', detail: { merge }, actions: ['skip-update'] }])
    expect(reasonMessage(report.items[0]!, report)).toBe(`Your change to ${FILE} conflicts with Delo 1.0.0's file; the new release's file runs, and yours is kept beside it as ${FILE}.mine.`)
    expect(report.counts).toMatchObject({ disabled: 1, harness: 1 })
  })

  it('says a file the person removed and the release changed runs again, with nothing kept beside it', () => {
    const report = reportOf([{ file: FILE, merge: 'release-changed-removed' }])

    expect(report.items).toMatchObject([{ reason: 'harness-change-conflicts', effect: 'disabled', actions: ['skip-update'] }])
    expect(reasonMessage(report.items[0]!, report)).toBe(`You removed ${FILE}, and Delo 1.0.0 changed it; the new release's file runs.`)
  })

  it('keeps `--yes` from confirming a report with a conflicted file, whatever else carries', () => {
    const report = reportOf([{ file: 'app/a.js', merge: 'release-unchanged' }, { file: FILE, merge: 'edits-overlap' }])

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
