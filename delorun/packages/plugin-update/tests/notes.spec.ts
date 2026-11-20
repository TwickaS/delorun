/** The notes of a finished update: the versions after `from` up to `to`, newest first, with their highlights, capped. */
import { describe, expect, it } from 'vitest'
import { MAX_NOTES_BYTES, MAX_NOTES_VERSIONS, notesBetween } from '../src/notes.ts'

/**
 * Build one changelog version entry.
 * @param version - the version.
 * @param extra - fields added to the entry.
 * @returns the entry.
 */
const entry = (version: string, extra: Record<string, unknown> = {}) => ({ version, date: '2026-11-19', preview: true, areas: [{ area: 'Studio', items: [{ section: 'Added', text: `${version} one` }, { section: 'Fixed', text: `${version} two` }] }], previews: [], ...extra })

const DATA = { versions: [entry('0.1.0-preview.4', { headlines: ['A', 'B'] }), entry('0.1.0-preview.3'), entry('0.1.0-preview.2'), entry('0.1.0-preview.1')] }

describe('notesBetween', () => {
  it('covers every version skipped, newest first, and not the one that ran before', () => {
    const notes = notesBetween(DATA, '0.1.0-preview.1', '0.1.0-preview.4')
    expect(notes?.versions.map(version => version.version)).toEqual(['0.1.0-preview.4', '0.1.0-preview.3', '0.1.0-preview.2'])
    expect(notes?.truncated).toBe(false)
  })

  it('takes the headlines as highlights, else the first bullets', () => {
    const notes = notesBetween(DATA, '0.1.0-preview.2', '0.1.0-preview.4')
    expect(notes?.versions[0]?.highlights).toEqual(['A', 'B'])
    expect(notes?.versions[1]?.highlights).toEqual(['0.1.0-preview.3 one', '0.1.0-preview.3 two'])
    expect(notes?.versions[1]?.areas[0]?.items).toHaveLength(2)
  })

  it('gives nothing when from equals to, or the range holds no version', () => {
    expect(notesBetween(DATA, '0.1.0-preview.3', '0.1.0-preview.3')).toBeUndefined()
    expect(notesBetween(DATA, '0.1.0-preview.4', '0.1.0-preview.3')).toBeUndefined()
    expect(notesBetween(DATA, '0.2.0', '0.3.0')).toBeUndefined()
  })

  it('gives nothing, without an error, when the changelog is missing or not the changelog', () => {
    expect(notesBetween(undefined, '0.1.0', '0.2.0')).toBeUndefined()
    expect(notesBetween({ versions: 'x' }, '0.1.0', '0.2.0')).toBeUndefined()
    expect(notesBetween({ versions: [{ version: 'nope' }, 7, null] }, '0.1.0', '0.2.0')).toBeUndefined()
    expect(notesBetween(DATA, 'not-a-version', '0.2.0')).toBeUndefined()
  })

  it('counts the previews folded into a final version as versions of their own', () => {
    const final = entry('0.1.0', { preview: false, previews: [entry('0.1.0-preview.2'), entry('0.1.0-preview.1')] })
    const notes = notesBetween({ versions: [final] }, '0.1.0-preview.1', '0.1.0')
    expect(notes?.versions.map(version => version.version)).toEqual(['0.1.0', '0.1.0-preview.2'])
  })

  it('caps the versions and says it did', () => {
    const many = { versions: Array.from({ length: MAX_NOTES_VERSIONS + 5 }, (_, index) => entry(`1.0.${String(index + 1)}`)) }
    const notes = notesBetween(many, '1.0.0', '1.0.99')
    expect(notes?.versions).toHaveLength(MAX_NOTES_VERSIONS)
    expect(notes?.versions[0]?.version).toBe('1.0.25')
    expect(notes?.truncated).toBe(true)
  })

  it('caps the bytes and says it did, keeping at least the newest version', () => {
    const big = (version: string) => entry(version, { areas: [{ area: 'Studio', items: [{ section: 'Added', text: 'x'.repeat(MAX_NOTES_BYTES) }] }] })
    const notes = notesBetween({ versions: [big('1.0.3'), big('1.0.2')] }, '1.0.0', '1.0.3')
    expect(notes?.versions.map(version => version.version)).toEqual(['1.0.3'])
    expect(notes?.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(notes))).toBeLessThanOrEqual(MAX_NOTES_BYTES + 200)
  })
})
