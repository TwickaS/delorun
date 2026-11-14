import { describe, expect, it } from 'vitest'
import { mergedDiffs, mergeHarnessFile, type HarnessCarryEntry, type HarnessCarryPlan, type HarnessFileSide } from '../src/harness-merge.ts'
import type { ApprovedHarnessFile, ContentVersion } from '../src/types.ts'

/**
 * A text side.
 * @param text - the file's text.
 * @param executable - its execute bit.
 * @returns the side.
 */
function side(text: string, executable = false): HarnessFileSide {
  return { bytes: Buffer.from(text, 'utf8'), executable }
}

/**
 * Lines `one` to `twelve` with some replaced.
 * @param changes - replacement lines by index.
 * @returns the text, one line each, ending in a newline.
 */
function lines(changes: Readonly<Record<number, string>> = {}): string {
  const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
  return `${words.map((word, at) => changes[at] ?? word).join('\n')}\n`
}

const BASE = side(lines())

describe('mergeHarnessFile', () => {
  it('carries the person\'s change unchanged when the new release did not change the file', () => {
    const mine = side(lines({ 2: 'THREE' }))

    expect(mergeHarnessFile({ base: BASE, mine, theirs: BASE })).toEqual({ outcome: 'carried', carry: 'release-unchanged', result: mine })
  })

  it('carries the person\'s change merged into a release edit it does not overlap', () => {
    const merged = mergeHarnessFile({ base: BASE, mine: side(lines({ 0: 'ONE' })), theirs: side(lines({ 11: 'TWELVE' })) })

    expect(merged).toEqual({ outcome: 'carried', carry: 'merged', result: side(lines({ 0: 'ONE', 11: 'TWELVE' })) })
  })

  it('conflicts when the person\'s edit and the release\'s edit overlap', () => {
    expect(mergeHarnessFile({ base: BASE, mine: side(lines({ 5: 'mine' })), theirs: side(lines({ 5: 'theirs' })) })).toEqual({ outcome: 'conflict', conflict: 'edits-overlap' })
  })

  it('conflicts when the new release removes a file the person changed', () => {
    expect(mergeHarnessFile({ base: BASE, mine: side(lines({ 0: 'ONE' })), theirs: undefined })).toEqual({ outcome: 'conflict', conflict: 'release-removed' })
  })

  it('conflicts when the person removed a file the new release changed', () => {
    expect(mergeHarnessFile({ base: BASE, mine: undefined, theirs: side(lines({ 0: 'ONE' })) })).toEqual({ outcome: 'conflict', conflict: 'release-changed-removed' })
  })

  it('carries the person\'s removal when the new release left the file as it was', () => {
    expect(mergeHarnessFile({ base: BASE, mine: undefined, theirs: BASE })).toEqual({ outcome: 'carried', carry: 'release-unchanged', result: undefined })
  })

  it('conflicts when the person and the new release add a file with different content', () => {
    expect(mergeHarnessFile({ base: undefined, mine: side('mine\n'), theirs: side('theirs\n') })).toEqual({ outcome: 'conflict', conflict: 'both-added' })
  })

  it('conflicts when both sides changed a binary file', () => {
    const binary = (byte: number): HarnessFileSide => ({ bytes: Buffer.from([0, 1, 2, byte]), executable: false })

    expect(mergeHarnessFile({ base: binary(3), mine: binary(4), theirs: binary(5) })).toEqual({ outcome: 'conflict', conflict: 'binary' })
  })

  it('conflicts when both sides changed a file that is not UTF-8', () => {
    const latin = (text: string): HarnessFileSide => ({ bytes: Buffer.from(text, 'latin1'), executable: false })

    expect(mergeHarnessFile({ base: latin('café\nbase\n'), mine: latin('café\nmine\n'), theirs: latin('café\ntheirs\n') })).toEqual({ outcome: 'conflict', conflict: 'binary' })
  })

  it('conflicts when both sides changed a file larger than the limit, even where the edits would not overlap', () => {
    const input = { base: BASE, mine: side(lines({ 0: 'ONE' })), theirs: side(lines({ 11: 'TWELVE' })) }

    expect(mergeHarnessFile({ ...input, fileLimit: BASE.bytes.length - 1 })).toEqual({ outcome: 'conflict', conflict: 'too-large' })
    expect(mergeHarnessFile({ ...input, fileLimit: BASE.bytes.length + 8 })).toMatchObject({ outcome: 'carried' })
  })

  it('needs nothing carried when the new release already holds the person\'s content', () => {
    const mine = side(lines({ 3: 'FOUR' }))

    expect(mergeHarnessFile({ base: BASE, mine, theirs: side(lines({ 3: 'FOUR' })) })).toEqual({ outcome: 'same' })
    expect(mergeHarnessFile({ base: BASE, mine: undefined, theirs: undefined })).toEqual({ outcome: 'same' })
  })

  it('runs the new release\'s file when the person\'s content equals the old release\'s', () => {
    const theirs = side(lines({ 0: 'ONE' }))

    expect(mergeHarnessFile({ base: BASE, mine: BASE, theirs })).toEqual({ outcome: 'carried', carry: 'merged', result: theirs })
  })

  describe('the execute bit', () => {
    it('keeps the person\'s execute bit over a release that changed only the bytes', () => {
      const theirs = side(lines({ 0: 'ONE' }))

      expect(mergeHarnessFile({ base: BASE, mine: side(lines(), true), theirs })).toEqual({ outcome: 'carried', carry: 'merged', result: side(lines({ 0: 'ONE' }), true) })
    })

    it('keeps the release\'s execute bit over a person who changed only the bytes', () => {
      expect(mergeHarnessFile({ base: BASE, mine: side(lines({ 0: 'ONE' })), theirs: side(lines(), true) })).toEqual({ outcome: 'carried', carry: 'merged', result: side(lines({ 0: 'ONE' }), true) })
    })

    it('merges the bytes both changed the same way with the execute bit only the person changed', () => {
      const theirs = side(lines({ 0: 'ONE' }))

      expect(mergeHarnessFile({ base: BASE, mine: side(lines({ 0: 'ONE' }), true), theirs })).toEqual({ outcome: 'carried', carry: 'merged', result: side(lines({ 0: 'ONE' }), true) })
    })

    it('merges text both changed with the execute bit the release changed', () => {
      expect(mergeHarnessFile({ base: BASE, mine: side(lines({ 0: 'ONE' })), theirs: side(lines({ 11: 'TWELVE' }), true) })).toEqual({ outcome: 'carried', carry: 'merged', result: side(lines({ 0: 'ONE', 11: 'TWELVE' }), true) })
    })
  })

  it('does not convert line endings to fit the person\'s patch', () => {
    const crlf = (text: string): HarnessFileSide => side(text.replaceAll('\n', '\r\n'))

    expect(mergeHarnessFile({ base: BASE, mine: side(lines({ 0: 'ONE' })), theirs: crlf(lines({ 11: 'TWELVE' })) })).toEqual({ outcome: 'conflict', conflict: 'edits-overlap' })
  })
})

/**
 * A plan of files, each merged from the target's side to a result, or planned with another outcome.
 * @param entries - each file's target side and merge.
 * @returns the plan.
 */
function planOf(entries: readonly Pick<HarnessCarryEntry, 'file' | 'theirs' | 'merge'>[]): HarnessCarryPlan {
  const approved: ApprovedHarnessFile = { version: 'v'.repeat(64) as ContentVersion, change: 'c0123456789' as ApprovedHarnessFile['change'], approvedAt: '2026-11-11T12:00:00.000Z' }
  return { from: '1.0.0', entries: entries.map(entry => ({ ...entry, approved, base: undefined, mine: undefined })) }
}

describe('mergedDiffs', () => {
  it('shows each merged file against the target\'s file, and no other outcome', () => {
    const theirs = side(lines({ 11: 'TWELVE' }))
    const plan = planOf([
      { file: 'app/a.js', theirs, merge: { outcome: 'carried', carry: 'merged', result: side(lines({ 0: 'ONE', 11: 'TWELVE' })) } },
      { file: 'app/b.js', theirs, merge: { outcome: 'carried', carry: 'release-unchanged', result: side('b\n') } },
      { file: 'app/c.js', theirs, merge: { outcome: 'conflict', conflict: 'edits-overlap' } },
      { file: 'app/d.js', theirs, merge: { outcome: 'same' } },
    ])

    const diffs = mergedDiffs(plan)

    expect([...diffs.keys()]).toEqual(['app/a.js'])
    expect(diffs.get('app/a.js')?.text).toContain('--- a/app/a.js\n+++ b/app/a.js\n@@ -1,5 +1,5 @@\n-one\n+ONE\n two\n')
    expect(diffs.get('app/a.js')?.notShown).toBeUndefined()
  })

  it('names a change of the execute bit with mode lines, and a removal against nothing', () => {
    const plan = planOf([
      { file: 'app/x.sh', theirs: side('x\n'), merge: { outcome: 'carried', carry: 'merged', result: side('x\n', true) } },
      { file: 'app/gone.js', theirs: undefined, merge: { outcome: 'carried', carry: 'merged', result: undefined } },
    ])

    const diffs = mergedDiffs(plan)

    expect(diffs.get('app/x.sh')?.text).toMatch(/^old mode 100644\nnew mode 100755\n--- a\/app\/x\.sh/u)
    expect(diffs.get('app/gone.js')).toEqual({ text: '--- a/app/gone.js\n+++ b/app/gone.js\n' })
  })

  it('shows no lines of a binary or too large side, and none of any diff after the total is passed', () => {
    const merged = (text: string): HarnessCarryEntry['merge'] => ({ outcome: 'carried', carry: 'merged', result: side(text) })
    const plan = planOf([
      { file: 'app/a.bin', theirs: { bytes: Buffer.from([0, 1, 2]), executable: false }, merge: merged('text\n') },
      { file: 'app/b.js', theirs: side('b'.repeat(40)), merge: merged('b\n') },
      { file: 'app/c.js', theirs: side('c\n'), merge: merged('C\n') },
      { file: 'app/d.js', theirs: side('d\n'), merge: merged('D\n') },
      { file: 'app/e.js', theirs: side('e\n'), merge: merged('E\n') },
    ])

    const diffs = mergedDiffs(plan, { file: 32, total: 60 })

    expect(diffs.get('app/a.bin')).toEqual({ text: '', notShown: 'binary' })
    expect(diffs.get('app/b.js')).toEqual({ text: '', notShown: 'too-large' })
    expect(diffs.get('app/c.js')?.text).toContain('+C')
    expect(diffs.get('app/d.js')).toEqual({ text: '', notShown: 'cut-short' })
    expect(diffs.get('app/e.js')).toEqual({ text: '', notShown: 'cut-short' })
  })
})
