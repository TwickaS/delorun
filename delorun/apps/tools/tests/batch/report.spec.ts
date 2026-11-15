/**
 * The batch's reports: each reason a lane is set aside or faulted, each outcome, and the `--plan` text.
 */
import { describe, expect, it } from 'vitest'
import { faultReport, laneReports, outcomeLine, planText, setAsideReport, summaryText, type BatchSummary } from '../../src/batch/report.ts'
import type { Outcome } from '../../src/batch/state.ts'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const summary: BatchSummary = {
  id: '20261110-120000',
  remote: 'origin',
  trunk: 'main',
  start: SHA,
  included: [],
  setAside: [],
  faults: [],
  flaky: [],
  outcome: { kind: 'nothing-to-land' },
}

describe('setAsideReport', () => {
  it('names each reason and the rebase that reproduces it', () => {
    expect(setAsideReport(summary, { lane: 'l', reason: { kind: 'conflict', commit: SHA, paths: ['a', 'b'] }, round: 0 })).toContain('Set aside: commit 0123456789ab conflicts with the candidate in a, b.')
    expect(setAsideReport(summary, { lane: 'l', reason: { kind: 'conflict', commit: SHA, paths: ['a'] }, round: 1 })).toContain('when the candidate was rebuilt without the faulted lanes in a')
    expect(setAsideReport(summary, { lane: 'l', reason: { kind: 'merge-commits', commits: [SHA] }, round: 0 })).toContain('git fetch origin && git rebase origin/main')
    expect(setAsideReport(summary, { lane: 'l', reason: { kind: 'no-commits' }, round: 0 })).not.toContain('git rebase')
    expect(setAsideReport(summary, { lane: 'l', reason: { kind: 'pick-failed', commit: SHA, detail: 'error: x' }, round: 0 })).toContain('git cherry-pick failed on 0123456789ab: error: x.')
  })
})

describe('faultReport', () => {
  it('names the reason, the excerpt, the other lanes and the commands', () => {
    const group = {
      fault: { lanes: ['l', 'm'], why: 'together' as const, checks: ['tests:docker', 'jsdoc'] },
      failures: [
        { check: 'tests:docker', reason: 'exit 1', logPath: null, excerpt: ['FAIL x'], specs: ['delorun/apps/a/tests/a.docker.spec.ts'], commits: [] },
        { check: 'jsdoc', reason: null, logPath: null, excerpt: [], specs: [], commits: [] },
      ],
    }
    const text = faultReport(summary, 'l', group)
    expect(text).toContain('Fails together with: m.')
    expect(text).toContain('Reason: exit 1')
    expect(text).toContain('```text\nFAIL x\n```')
    expect(text).toContain('node_modules/.bin/vitest run --config delorun/vitest.docker.config.ts delorun/apps/a/tests/a.docker.spec.ts')
    expect(text).toContain('node_modules/.bin/tsx delorun/apps/tools/src/run-checks.ts --only jsdoc --changed --tier merge')
    expect(faultReport(summary, 'l', { ...group, fault: { ...group.fault, lanes: ['l'], why: 'fails-alone' } })).not.toContain('Fails together')
  })

  it('writes one report per lane of every group and every lane set aside', () => {
    const reports = laneReports({ ...summary, setAside: [{ lane: 's', reason: { kind: 'no-commits' }, round: 0 }], faults: [{ fault: { lanes: ['l', 'm'], why: 'together', checks: [] }, failures: [] }] })
    expect(reports.map(report => report.lane)).toEqual(['s', 'l', 'm'])
  })
})

describe('outcomeLine and summaryText', () => {
  const outcomes: [Outcome, string][] = [
    [{ kind: 'landed', commit: SHA }, 'landed: origin/main moved from 0123456789ab to 0123456789ab'],
    [{ kind: 'passed', commit: SHA }, 'nothing was pushed (--no-land)'],
    [{ kind: 'trunk-moved', detail: 'rejected' }, 'moved while the batch ran'],
    [{ kind: 'gate-error', detail: 'boom' }, 'rerun with --resume 20261110-120000'],
    [{ kind: 'not-attributable', checks: ['x'] }, 'x fail with every suspect lane removed'],
    [{ kind: 'flaky', checks: ['x'] }, 'x failed again after passing on a rerun'],
    [{ kind: 'nothing-to-land' }, 'every lane was set aside or faulted'],
  ]
  it.each(outcomes)('describes %j', (outcome, line) => {
    expect(outcomeLine({ ...summary, outcome })).toContain(line)
  })

  it('heads the lanes by whether they landed or passed', () => {
    expect(summaryText({ ...summary, included: ['a'], outcome: { kind: 'landed', commit: SHA } })).toContain('## Landed\n\n- a')
    expect(summaryText({ ...summary, included: ['a'], outcome: { kind: 'passed', commit: SHA } })).toContain('## Passed\n\n- a')
    const stopped = summaryText({ ...summary, flaky: ['f'] })
    expect(stopped).toContain('## Last candidate\n\n- none')
    expect(stopped).toContain('## Flaky\n\n- f')
  })
})

describe('planText', () => {
  it('prints none for a plan without suspects', () => {
    expect(planText('origin', 'main', SHA, [])).toBe('delorun batch (plan): 0 lane(s) onto origin/main at 0123456789ab\nsuspects by check (merge tier, each lane\'s own changed paths):\n  none\n')
  })

  it('marks a lane with merge commits as refused', () => {
    const lane = { name: 'm', tip: SHA, base: SHA, commits: [SHA, SHA], merges: [SHA] }
    expect(planText('origin', 'main', SHA, [{ lane, packages: [], checks: ['x'] }])).toContain('  1. m: 2 commit(s); packages: none; refused: it holds merge commits\n')
  })
})
