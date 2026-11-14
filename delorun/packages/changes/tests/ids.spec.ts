import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it, vi } from 'vitest'
import { ChangesError, changesDescriber, isChangesError } from '../src/errors.ts'
import { CHANGE_ID_PATTERN, changeId, parseChangeId } from '../src/ids.ts'
import type { ContentVersion } from '../src/types.ts'

// The cases write real files and git histories; on a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 30_000 })

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

  it('gives a later request of the same change its own id, and the first one the id without a count', () => {
    const subject = { plugin: 'p', spec: 'p@1' }
    const first = changeId('plugin-install', subject, undefined, undefined)
    expect(changeId('plugin-install', subject, undefined, undefined, 0)).toBe(first)
    expect(changeId('plugin-install', subject, undefined, undefined, 1)).not.toBe(first)
    expect(changeId('plugin-install', subject, undefined, undefined, 2)).not.toBe(changeId('plugin-install', subject, undefined, undefined, 1))
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

describe('changesDescriber', () => {
  it('says nothing changed, names the code and points to the list with the profile', () => {
    const refusal = changesDescriber.describe(new ChangesError('UNKNOWN_CHANGE', 'c0123456789', 'no change has this id'), { profile: 'work' })
    expect(refusal.lead).toBe('Delorun did not change what your harness runs.')
    expect(refusal.reason).toContain('UNKNOWN_CHANGE')
    expect(refusal.remedies).toEqual(['See your changes: delorun changes list --profile work'])
  })
})
