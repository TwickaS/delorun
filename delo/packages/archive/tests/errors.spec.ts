/**
 * Proves `isArchiveError` recognises an archive refusal, by class and not by
 * message or code, so a caller can narrow a caught value to the refusal and
 * read its code; and that `failureCode` names a system failure by its code
 * alone.
 */
import { describe, expect, it } from 'vitest'
import { ArchiveError, isArchiveError } from '../src/index.ts'
import { failureCode } from '../src/errors.ts'

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

describe('failureCode', () => {
  it.each([
    ['a system error', Object.assign(new Error('/home/someone/x: no space'), { code: 'ENOSPC' }), 'ENOSPC'],
    ['an error without a code', new Error('/home/someone/x'), 'unexpected error'],
    ['an error whose code is not a string', Object.assign(new Error('x'), { code: 7 }), 'unexpected error'],
    ['a value that is no error', 'ENOSPC', 'unexpected error'],
  ])('names %s', (_name, error, code) => {
    expect(failureCode(error)).toBe(code)
  })
})
