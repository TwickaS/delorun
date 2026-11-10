/**
 * The parity form of this bundle's patch list: each listed row in the form its `LOCAL_ROWS` entry gives, and a refusal
 * for a patch the list cannot place.
 */
import { describe, expect, it } from 'vitest'
import { LOCAL_ROWS, parityPatches } from '../src/rows.ts'

describe('parityPatches', () => {
  it('leaves out an upstream row, keeps an as-written row and disables an inserted row whose parity form is disabled', () => {
    expect(parityPatches([
      { id: 'session-log-deepseek', config: { enabled: false } },
      { id: 'product-analytics', config: { enabled: false } },
      { insert: [{ id: 'delo-update-gate', name: '@delo/bundle-local/update-gate', config: { enabled: true } }] },
    ])).toEqual([
      { id: 'product-analytics', config: { enabled: false } },
      { insert: [{ id: 'delo-update-gate', name: '@delo/bundle-local/update-gate', config: { enabled: true }, disabled: true }] },
    ])
    // An inserted row keeps its form when its entry restates it as written.
    expect(parityPatches([{ insert: [{ id: 'product-analytics', name: 'x' }] }])).toEqual([{ insert: [{ id: 'product-analytics', name: 'x' }] }])
  })

  it('refuses a patch that is neither an id patch nor an insert, an inserted row that is not a mapping, and an unlisted row', () => {
    expect(() => parityPatches([{ config: {} }])).toThrow('neither an id patch nor an insert')
    expect(() => parityPatches([{ insert: ['delo-update-gate'] }])).toThrow('inserts a row that is not a mapping')
    expect(() => parityPatches([{ insert: [null] }])).toThrow('inserts a row that is not a mapping')
    expect(() => parityPatches([{ id: 'web-search-deepseek' }])).toThrow('which LOCAL_ROWS does not list')
  })

  it('lists the update gate as an added row whose parity form is disabled', () => {
    expect(LOCAL_ROWS.find(row => row.id === 'delo-update-gate')).toMatchObject({ kind: 'added', parity: { kind: 'disabled' } })
  })
})
