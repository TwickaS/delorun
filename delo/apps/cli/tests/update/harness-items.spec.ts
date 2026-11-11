/**
 * The CLI's harness facts (`delo/apps/cli/src/update/harness-items.ts`): each merge's name in the report.
 */
import { describe, expect, it } from 'vitest'
import { harnessFacts, mergeOf } from '../../src/update/harness-items.ts'

describe('mergeOf', () => {
  it('names a file the target already holds as in-release, and every other outcome by how it carried or conflicted', () => {
    expect(mergeOf({ outcome: 'same' })).toBe('in-release')
    expect(mergeOf({ outcome: 'carried', carry: 'merged', result: undefined })).toBe('merged')
    expect(mergeOf({ outcome: 'conflict', conflict: 'both-added' })).toBe('both-added')
    expect(harnessFacts({ from: '1.0.0', entries: [] })).toEqual([])
  })
})
