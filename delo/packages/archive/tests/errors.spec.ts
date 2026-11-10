/**
 * Proves `isArchiveError` recognises an archive refusal, by class and not by
 * message or code, so a caller can narrow a caught value to the refusal and
 * read its code.
 */
import { describe, expect, it } from 'vitest'
import { ArchiveError, isArchiveError } from '../src/index.ts'

describe('isArchiveError', () => {
  it('recognises an archive refusal and exposes its code', () => {
    const error: unknown = new ArchiveError('ARCHIVE_TRUNCATED', 'ends early')

    expect(isArchiveError(error) && error.code).toBe('ARCHIVE_TRUNCATED')
    expect((error as Error).name).toBe('ArchiveError')
  })

  it.each([
    ['an ordinary error', new Error('ARCHIVE_TRUNCATED')],
    ['an object that carries a code', { code: 'ARCHIVE_TRUNCATED' }],
    ['a string', 'ARCHIVE_TRUNCATED'],
    ['undefined', undefined],
  ])('does not recognise %s', (_name, value) => {
    expect(isArchiveError(value)).toBe(false)
  })
})
