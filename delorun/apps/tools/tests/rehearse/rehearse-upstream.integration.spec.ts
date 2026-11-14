import { describe, expect, it } from 'vitest'
import type { Patch, PathRule } from '../../src/fork-boundary.ts'
import {
  budgetCaps,
  budgetFailures,
  type ClassCounts,
  type Count,
  type Rehearsal,
} from '../../src/rehearse-upstream.ts'
import {
  checkoutState,
  editsAt,
  leftoverScratch,
  lines,
  PROCESS_TIMEOUT_MS,
  rehearsalFixture,
  rehearseIn,
  type FixtureFiles,
  type RehearsalFixture,
} from './fixtures.ts'

const A = 'docs/a.md'
const B = 'docs/b.md'
const BIG = 'docs/big.md'
const GATE = 'src/gate.ts'

/**
 * A ledger patch.
 * @param path - the listed path.
 * @param kind - the patch's class.
 * @returns the patch.
 */
function patch(path: string, kind: Patch['class'] = 'delorun-feature'): Patch {
  return kind === 'security'
    ? { path, class: kind, reason: `reason for ${path}`, sha256: '0'.repeat(64) }
    : { path, class: kind, feature: 'a-feature', reason: `reason for ${path}` }
}

/** A rule for the documentation pages of the fixtures. */
const DOCS_RULE: PathRule = { pattern: 'docs/**/*.md', kind: 'documentation', reason: 'pages that document Delorun changes' }

/**
 * Run a rehearsal of `v2` in a fixture and check that it left the fork as it found it.
 * @param fixture - the fixture.
 * @returns the exit status and the combined output.
 */
function rehearseV2(fixture: RehearsalFixture): { status: number; output: string } {
  const before = checkoutState(fixture.fork)
  const result = rehearseIn(fixture, ['--tag', 'v2'])
  expect(checkoutState(fixture.fork)).toEqual(before)
  expect(leftoverScratch(fixture)).toEqual([])
  return result
}

/**
 * Build a fixture and rehearse `v2` in it.
 * @param test - the running test.
 * @param files - the fixture's files.
 * @returns the exit status and the combined output.
 */
function rehearseFixture(test: Parameters<typeof rehearsalFixture>[0], files: FixtureFiles): { status: number; output: string } {
  return rehearseV2(rehearsalFixture(test, files))
}

describe('the rehearsal command', () => {
  it('exits 0 for a clean merge within budget and prints the counts beside the caps', (test) => {
    const result = rehearseFixture(test, {
      base: { [A]: lines(30) },
      tag: { [A]: lines(30, { 20: 'upstream 20' }), 'docs/new.md': 'new\n' },
      fork: { [A]: lines(30, { 5: 'delorun 5' }) },
      patches: [patch(A)],
    })
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain('conflicted paths: none')
    expect(result.output).toContain('conflicted hunks: 0 of 1 ledger hunk at v2 (0 %), limit 15 %')
    expect(result.output).toContain('  delorun-feature: 1 → 1 entries (0), 1 → 1 hunks (0)')
    expect(result.output).toContain('  ruled: 0 → 0 entries (0), 0 → 0 hunks (0)')
    expect(result.output).toContain('  total: 1 → 1 entries (0, cap 20), 1 → 1 hunks (0, cap 150)')
    expect(result.output).toContain('caps: the floors of 20 entries and 150 hunks; the first release\'s baseline is not recorded')
    expect(result.output).toContain('generated paths are counted with the rule-covered paths under ruled, not separated')
    expect(result.output).toContain('rehearse-upstream: v2 merges within the divergence budget')
  }, PROCESS_TIMEOUT_MS)

  it('counts the paths a rule covers as ruled, and a conflict in one under ruled', (test) => {
    const result = rehearseFixture(test, {
      base: { [A]: lines(30), [B]: lines(30) },
      tag: { [B]: lines(30, { 3: 'upstream 3' }) },
      fork: { [A]: lines(30, { 5: 'delorun 5' }), [B]: lines(30, { 3: 'delorun 3' }) },
      patches: [],
      rules: [DOCS_RULE],
    })
    expect(result.output).toContain(`conflicted paths: 1\n  ${B} (ruled, 1 hunk)`)
    expect(result.output).toContain('  ruled: 2 → 2 entries (0), 2 → 3 hunks (+1)')
    expect(result.output).toContain('  unlisted: 0 → 0 entries (0), 0 → 0 hunks (0)')
  }, PROCESS_TIMEOUT_MS)

  it('rehearses a branch already in the clone with --ref, without fetching', (test) => {
    const fixture = rehearsalFixture(test, {
      base: { [A]: lines(30) },
      tag: { [A]: lines(30, { 20: 'upstream 20' }) },
      fork: { [A]: lines(30, { 5: 'delorun 5' }) },
      patches: [patch(A)],
    })
    fixture.fork.run(['fetch', '-q', '--no-tags', fixture.upstream.root, 'refs/tags/v2:refs/remotes/upstream/master'])
    const commit = fixture.fork.run(['rev-parse', 'upstream/master^{commit}'])
    const before = checkoutState(fixture.fork)
    const result = rehearseIn(fixture, ['--ref', 'upstream/master'])
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain(`rehearsal merge of upstream/master (${commit}) from this clone into HEAD `)
    expect(result.output).toContain('rehearse-upstream: upstream/master merges within the divergence budget')
    expect(checkoutState(fixture.fork)).toEqual(before)
    expect(leftoverScratch(fixture)).toEqual([])
  }, PROCESS_TIMEOUT_MS)

  it('exits 2 for a --ref that names no commit in the clone, or one that starts with a dash', (test) => {
    const fixture = rehearsalFixture(test, { base: { [A]: lines(30) }, tag: {}, fork: {}, patches: [] })
    for (const ref of ['upstream/missing', '--output=x']) {
      const result = rehearseIn(fixture, [`--ref=${ref}`])
      expect(result.status, result.output).toBe(2)
      expect(result.output).toContain(`rehearse-upstream: ${ref} names no commit in this clone; fetch it first or pass --tag`)
    }
  }, PROCESS_TIMEOUT_MS)

  it('credits an entry whose change the tag absorbs', (test) => {
    const result = rehearseFixture(test, {
      base: { [A]: lines(30), [B]: lines(30) },
      tag: { [B]: lines(30, { 3: 'delorun 3' }) },
      fork: { [A]: lines(30, { 5: 'delorun 5' }), [B]: lines(30, { 3: 'delorun 3' }) },
      patches: [patch(A), patch(B)],
    })
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain('absorbed by v2 (credited): 1 entry, 1 hunk')
    expect(result.output).toContain(`  ${B} (delorun-feature, 1 hunk)`)
    expect(result.output).toContain('  total: 2 → 1 entries (-1, cap 20), 2 → 1 hunks (-1, cap 150)')
  }, PROCESS_TIMEOUT_MS)

  it('exits 1 when the conflicted hunks exceed 15 % of the ledger\'s hunks at the tag', (test) => {
    const fixture = rehearsalFixture(test, {
      base: { [A]: lines(30) },
      tag: { [A]: lines(30, { 10: 'upstream 10' }) },
      fork: { [A]: lines(30, { 10: 'delorun 10' }) },
      patches: [patch(A)],
    })
    fixture.fork.write({ 'local-note.txt': 'untracked\n', [A]: lines(30, { 10: 'delorun 10', 11: 'staged 11' }) })
    fixture.fork.run(['add', A])
    fixture.fork.write({ [A]: lines(30, { 10: 'delorun 10', 11: 'staged 11', 12: 'unstaged 12' }) })
    const result = rehearseV2(fixture)
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain(`conflicted paths: 1\n  ${A} (delorun-feature, 1 hunk)`)
    expect(result.output).toContain('rehearse-upstream: conflicted hunks 1 of 2 ledger hunks at v2 (50 %) exceed the limit of 15 %')
    expect(result.output).not.toContain('security-class')
  }, PROCESS_TIMEOUT_MS)

  it('exits 1 when a security-class file conflicts, whatever the conflict share', (test) => {
    const result = rehearseFixture(test, {
      base: { [GATE]: lines(30), [BIG]: lines(100) },
      tag: { [GATE]: lines(30, { 5: 'upstream 5' }) },
      fork: { [GATE]: lines(30, { 5: 'delorun 5' }), [BIG]: lines(100, editsAt([4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 68, 72, 76, 80], 'delorun')) },
      patches: [patch(GATE, 'security'), patch(BIG)],
    })
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain(`  ${GATE} (security, 1 hunk)`)
    expect(result.output).toContain('conflicted hunks: 1 of 22 ledger hunks at v2 (4.5 %), limit 15 %')
    expect(result.output).toContain(`rehearse-upstream: ${GATE}: security-class file conflicts without a recorded maintainer decision`)
    expect(result.output).not.toContain('exceed the limit')
  }, PROCESS_TIMEOUT_MS)

  it('exits 1 when the hunk growth exceeds the cap of 150 hunks', (test) => {
    const forkLines = Array.from({ length: 1010 }, (_, index) => 4 * (index + 1))
    const tagLines = Array.from({ length: 151 }, (_, index) => 24 * (index + 1))
    const result = rehearseFixture(test, {
      base: { [BIG]: lines(4100) },
      tag: { [BIG]: lines(4100, editsAt(tagLines, 'upstream')) },
      fork: { [BIG]: lines(4100, editsAt(forkLines, 'delorun')) },
      patches: [patch(BIG)],
    })
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('  total: 1 → 1 entries (0, cap 20), 1010 → 1161 hunks (+151, cap 150)')
    expect(result.output).toContain('conflicted hunks: 151 of 1161 ledger hunks at v2 (13 %), limit 15 %')
    expect(result.output).toContain('rehearse-upstream: hunk growth +151 exceeds the cap of 150')
    expect(result.output).not.toContain('exceed the limit')
  }, PROCESS_TIMEOUT_MS)

  it('exits 2 and removes the scratch worktree when the tag cannot be fetched', (test) => {
    const fixture = rehearsalFixture(test, { base: { [A]: lines(30) }, tag: {}, fork: { [A]: lines(30, { 5: 'delorun 5' }) }, patches: [patch(A)] })
    const before = checkoutState(fixture.fork)
    const result = rehearseIn(fixture, ['--tag', 'v9'])
    expect(result.status, result.output).toBe(2)
    expect(result.output).toContain('rehearse-upstream: cannot fetch tag v9 from')
    expect(checkoutState(fixture.fork)).toEqual(before)
    expect(leftoverScratch(fixture)).toEqual([])
  }, PROCESS_TIMEOUT_MS)

  it('exits 2 with a usage line without --tag or --ref, with both, or with an unknown option', (test) => {
    const fixture = rehearsalFixture(test, { base: { [A]: lines(30) }, tag: {}, fork: {}, patches: [] })
    for (const args of [[], ['--tag', 'v2', '--ref', 'main'], ['--tag', ''], ['--branch', 'main']]) {
      const result = rehearseIn(fixture, args)
      expect(result.status, args.join(' ')).toBe(2)
      expect(result.output).toContain('usage: rehearse-upstream.ts --tag <tag> | --ref <ref>')
    }
  }, PROCESS_TIMEOUT_MS)
})

const ZERO: Count = { entries: 0, hunks: 0 }

/**
 * Counts with every class empty except `delorun-feature`.
 * @param feature - the `delorun-feature` count.
 * @returns the counts.
 */
function counts(feature: Count): ClassCounts {
  return { 'delorun-feature': feature, 'generic-fix': ZERO, security: ZERO, ruled: ZERO, unlisted: ZERO }
}

/**
 * A measured rehearsal without conflicts.
 * @param current - the `delorun-feature` count against the pin.
 * @param atTag - the `delorun-feature` count against the tag.
 * @param caps - the caps to hold it to.
 * @returns the rehearsal.
 */
function measured(current: Count, atTag: Count, caps = budgetCaps(undefined)): Rehearsal {
  return {
    spec: {
      root: '/fork',
      target: { kind: 'tag', name: 'v2' },
      repository: '/upstream',
      pin: { ref: 'v1', commit: '0'.repeat(40) },
      head: '1'.repeat(40),
      manifest: { upstream: { repository: '/upstream', ref: 'v1', commit: '0'.repeat(40) }, forkOwned: ['delorun/'], rules: [], patches: [], retired: [] },
      caps,
    },
    targetCommit: '2'.repeat(40),
    conflicts: [],
    current: counts(current),
    atTarget: counts(atTag),
    absorbed: [],
  }
}

describe('the budget rules', () => {
  it('holds entry growth to the cap of 20 entries', () => {
    expect(budgetFailures(measured({ entries: 10, hunks: 10 }, { entries: 30, hunks: 30 }))).toEqual([])
    expect(budgetFailures(measured({ entries: 10, hunks: 10 }, { entries: 31, hunks: 31 }))).toEqual(['entry growth +21 exceeds the cap of 20'])
  })

  it('raises the caps to 10 % of a recorded baseline above the floors, and never below them', () => {
    expect(budgetCaps(undefined)).toEqual({ entries: 20, hunks: 150, baselineRecorded: false })
    expect(budgetCaps({ entries: 300, hunks: 2000 })).toEqual({ entries: 30, hunks: 200, baselineRecorded: true })
    expect(budgetCaps({ entries: 100, hunks: 1000 })).toEqual({ entries: 20, hunks: 150, baselineRecorded: true })
    const raised = budgetCaps({ entries: 300, hunks: 2000 })
    expect(budgetFailures(measured({ entries: 0, hunks: 0 }, { entries: 30, hunks: 200 }, raised))).toEqual([])
  })
})
