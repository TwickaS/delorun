import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it } from 'vitest'
import { ChangesError, isChangesError } from '../src/errors.ts'
import { CHANGE_ID_PATTERN, changeId, parseChangeId } from '../src/ids.ts'
import type { ContentVersion } from '../src/types.ts'

describe('changeId', () => {
  it('derives the same id from the same change and another from different content', () => {
    const from = brandString<ContentVersion>('a'.repeat(64))
    const to = brandString<ContentVersion>('b'.repeat(64))
    const subject = { plugin: 'p', source: '/s', file: 'f', setting: 's', spec: 'p@1' }
    const id = changeId('plugin-edit', subject, from, to)
    expect(id).toMatch(CHANGE_ID_PATTERN)
    expect(changeId('plugin-edit', { ...subject }, from, to)).toBe(id)
    expect(changeId('plugin-edit', subject, from, from)).not.toBe(id)
    expect(changeId('guard-weakening', {}, undefined, undefined)).toMatch(CHANGE_ID_PATTERN)
  })
})

describe('parseChangeId', () => {
  it('reads an id and refuses other text', () => {
    expect(parseChangeId('c0123456789')).toBe('c0123456789')
    expect(parseChangeId('C0123456789')).toBeUndefined()
    expect(parseChangeId('c012345678')).toBeUndefined()
  })
})

describe('isChangesError', () => {
  it('tells a ChangesError from other errors', () => {
    const cause = new Error('underneath')
    const error = new ChangesError('UNKNOWN_CHANGE', 'c0123456789', 'No change has this id.', { cause })
    expect(isChangesError(error)).toBe(true)
    expect(error).toMatchObject({ name: 'ChangesError', code: 'UNKNOWN_CHANGE', subject: 'c0123456789', message: 'No change has this id.', cause })
    expect(isChangesError(cause)).toBe(false)
  })
})
