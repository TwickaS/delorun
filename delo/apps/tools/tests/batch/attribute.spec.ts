/**
 * Attribution: the suspects of a failing check from the selection, the failing specs and the named commits, and the
 * narrowing rules over a stand-in trial.
 */
import { describe, expect, it } from 'vitest'
import { narrow, suspectsFor, suspectsOf, type LaneFacts, type TrialResult } from '../../src/batch/attribute.ts'
import type { FailedCheck } from '../../src/batch/state.ts'

/**
 * A failing check.
 * @param check - its id.
 * @param more - the specs and commits its log names.
 * @returns the failure.
 */
function failure(check: string, more: Partial<FailedCheck> = {}): FailedCheck {
  return { check, reason: null, logPath: null, excerpt: [], specs: [], commits: [], ...more }
}

const lanes: LaneFacts[] = [
  { name: 'a', selected: [{ id: 'tests:fork', scope: ['delo/apps/a/'] }, { id: 'gates:dco' }], commits: ['aaaa1111aaaa'] },
  { name: 'b', selected: [{ id: 'tests:fork', scope: ['delo/apps/b/'] }, { id: 'gates:dco' }], commits: ['bbbb2222bbbb'] },
  { name: 'wide', selected: [{ id: 'tests:fork' }, { id: 'gates:dco' }], commits: ['cccc3333cccc'] },
  { name: 'docs', selected: [{ id: 'docs-site' }], commits: ['dddd4444dddd'] },
]

describe('suspectsFor', () => {
  it('takes the lanes whose selection picks the check', () => {
    expect(suspectsFor(failure('tests:fork'), lanes)).toEqual(['a', 'b', 'wide'])
    expect(suspectsFor(failure('nothing'), lanes)).toEqual([])
  })

  it('narrows a test lane to the lanes that reach its failing specs, an unscoped run included', () => {
    expect(suspectsFor(failure('tests:fork', { specs: ['delo/apps/b/tests/x.spec.ts'] }), lanes)).toEqual(['b', 'wide'])
  })

  it('narrows a range gate to the lanes that contributed a named commit', () => {
    expect(suspectsFor(failure('gates:dco', { commits: ['bbbb222'] }), lanes)).toEqual(['b'])
    expect(suspectsFor(failure('gates:dco', { commits: ['ffff999'] }), lanes)).toEqual(['a', 'b', 'wide'])
  })

  it('falls back to the selection when no lane reaches a named spec', () => {
    const scoped = lanes.filter(lane => lane.name !== 'wide')
    expect(suspectsFor(failure('tests:fork', { specs: ['delo/apps/z/tests/x.spec.ts'] }), scoped)).toEqual(['a', 'b'])
  })

  it('lists each failing check\'s suspects', () => {
    expect(suspectsOf([failure('docs-site'), failure('tests:fork', { specs: ['delo/apps/a/tests/x.spec.ts'] })], lanes)).toEqual([{ check: 'docs-site', lanes: ['docs'] }, { check: 'tests:fork', lanes: ['a', 'wide'] }])
  })
})

/**
 * A trial that passes when no lane of a failing set is present, recording each trial.
 * @param fails - decides whether a set of lanes fails.
 * @returns the trial and its record.
 */
function trialOf(fails: (lanes: readonly string[]) => TrialResult): { trial: (lanes: readonly string[]) => TrialResult, seen: string[] } {
  const seen: string[] = []
  return { seen, trial: candidate => { seen.push(candidate.join(',')); return fails(candidate) } }
}

const all = ['a', 'b', 'c']
const everyone = [{ check: 'x', lanes: all }]

describe('narrow', () => {
  it('reports no suspect as not attributable without a trial', () => {
    const { trial, seen } = trialOf(() => 'failed')
    expect(narrow(all, [{ check: 'x', lanes: [] }], trial)).toEqual({ kind: 'not-attributable', checks: ['x'] })
    expect(seen).toEqual([])
  })

  it('faults the one lane whose removal fixes every failing check', () => {
    const { trial } = trialOf(lanes => lanes.includes('b') ? 'failed' : 'passed')
    expect(narrow(all, [{ check: 'x', lanes: ['b'] }, { check: 'y', lanes: ['a'] }], trial)).toEqual({ kind: 'faulted', faults: [{ lanes: ['b'], why: 'removal-fixes', checks: ['x'] }] })
  })

  it('faults lanes that fail only together as one group', () => {
    const { trial } = trialOf(lanes => lanes.includes('a') && lanes.includes('b') ? 'failed' : 'passed')
    expect(narrow(all, everyone, trial)).toEqual({ kind: 'faulted', faults: [{ lanes: ['a', 'b'], why: 'together', checks: ['x'] }] })
  })

  it('counts a lane that does not apply alone as not failing alone', () => {
    const { trial } = trialOf(lanes => lanes.length === 1 ? 'unbuildable' : lanes.includes('a') && lanes.includes('b') ? 'failed' : 'passed')
    expect(narrow(all, everyone, trial)).toEqual({ kind: 'faulted', faults: [{ lanes: ['a', 'b'], why: 'together', checks: ['x'] }] })
  })

  it('faults the fixers that fail alone', () => {
    const { trial } = trialOf(lanes => lanes.join(',') === 'a' || (lanes.includes('a') && lanes.includes('b')) ? 'failed' : 'passed')
    expect(narrow(all, everyone, trial)).toEqual({ kind: 'faulted', faults: [{ lanes: ['a'], why: 'fails-alone', checks: ['x'] }] })
  })

  it('removes every suspect when no single removal fixes it, and faults those that fail alone', () => {
    const { trial, seen } = trialOf(lanes => lanes.includes('a') || lanes.includes('c') ? 'failed' : 'passed')
    expect(narrow(all, everyone, trial)).toEqual({ kind: 'faulted', faults: [{ lanes: ['a'], why: 'fails-alone', checks: ['x'] }, { lanes: ['c'], why: 'fails-alone', checks: ['x'] }] })
    expect(seen).toEqual(['b,c', 'a,c', 'a,b', '', 'a', 'b', 'c'])
  })

  it('reports a failure that persists without every suspect as not attributable', () => {
    const { trial } = trialOf(() => 'failed')
    expect(narrow(all, [{ check: 'x', lanes: ['a'] }], trial)).toEqual({ kind: 'not-attributable', checks: ['x'] })
  })
})
