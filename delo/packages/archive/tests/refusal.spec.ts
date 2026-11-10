/** How an archive refusal reads: Delo refused the archive and changed nothing, with contract C8's code and the entry. */
import { describeFailure } from '@delo/home'
import { describe, expect, it } from 'vitest'
import { ArchiveError, archiveDescriber } from '../src/index.ts'

describe('an archive refusal', () => {
  it('keeps C8\'s code and the refused entry', () => {
    expect(describeFailure(new ArchiveError('ARCHIVE_PATH_REJECTED', 'the entry ../x leaves the archive'), [archiveDescriber])).toEqual({ lead: 'Delo refused the archive and changed nothing.', reason: 'ARCHIVE_PATH_REJECTED: the entry ../x leaves the archive', remedies: [] })
  })
})
