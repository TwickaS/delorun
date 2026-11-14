/**
 * The CLI's harness facts (`delorun/apps/cli/src/update/harness-items.ts`): each merge's name in the report, what the
 * target runs of a carried file, and the diff of a merged one.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ApprovedHarnessFile, HarnessCarryEntry, HarnessCarryPlan, HarnessFileSide } from '@delorun/changes'
import { harnessFacts, mergeOf, reportedHarnessFacts } from '../../src/update/harness-items.ts'

/**
 * @param text - the file's text.
 * @param executable - its execute bit.
 * @returns the side.
 */
const side = (text: string, executable = false): HarnessFileSide => ({ bytes: Buffer.from(text), executable })

/**
 * @param text - the text.
 * @returns its SHA-256.
 */
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/**
 * A plan of files.
 * @param entries - each file's target side and merge.
 * @returns the plan.
 */
function planOf(entries: readonly Pick<HarnessCarryEntry, 'file' | 'theirs' | 'merge'>[]): HarnessCarryPlan {
  const approved = { version: 'v'.repeat(64), change: 'c0123456789', approvedAt: '2026-11-11T12:00:00.000Z' } as ApprovedHarnessFile
  return { from: '1.0.0', entries: entries.map(entry => ({ ...entry, approved, base: undefined, mine: undefined })) }
}

describe('mergeOf', () => {
  it('names a file the target already holds as in-release, and every other outcome by how it carried or conflicted', () => {
    expect(mergeOf({ outcome: 'same' })).toBe('in-release')
    expect(mergeOf({ outcome: 'carried', carry: 'merged', result: undefined })).toBe('merged')
    expect(mergeOf({ outcome: 'conflict', conflict: 'both-added' })).toBe('both-added')
    expect(harnessFacts({ from: '1.0.0', entries: [] })).toEqual([])
  })
})

describe('harnessFacts', () => {
  const plan = planOf([
    { file: 'app/a.js', theirs: side('a\n'), merge: { outcome: 'carried', carry: 'release-unchanged', result: side('A\n', true) } },
    { file: 'app/b.js', theirs: side('b\n'), merge: { outcome: 'carried', carry: 'merged', result: side('B\n') } },
    { file: 'app/c.js', theirs: side('c\n'), merge: { outcome: 'carried', carry: 'release-unchanged', result: undefined } },
    { file: 'app/d.js', theirs: side('d\n'), merge: { outcome: 'conflict', conflict: 'edits-overlap' } },
    { file: 'app/e.js', theirs: side('e\n'), merge: { outcome: 'same' } },
  ])

  it('states what the target runs of each carried file, and nothing of a removal, a conflict or a file the release holds', () => {
    expect(harnessFacts(plan)).toEqual([
      { file: 'app/a.js', merge: 'release-unchanged', result: { sha256: sha256('A\n'), executable: true } },
      { file: 'app/b.js', merge: 'merged', result: { sha256: sha256('B\n'), executable: false } },
      { file: 'app/c.js', merge: 'release-unchanged' },
      { file: 'app/d.js', merge: 'edits-overlap' },
      { file: 'app/e.js', merge: 'in-release' },
    ])
  })

  it('adds the diff from the target\'s file to each merged file for the report', () => {
    const reported = reportedHarnessFacts(plan)

    expect(reported.map(fact => fact.diff === undefined ? fact.file : `${fact.file}: diff`)).toEqual(['app/a.js', 'app/b.js: diff', 'app/c.js', 'app/d.js', 'app/e.js'])
    expect(reported[1]?.diff?.text).toContain('-b\n+B\n')
  })
})
