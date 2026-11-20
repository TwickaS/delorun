/**
 * The sheet's glyph map covers every strong action: each `face` row of `AUTH_CLASSES` resolves to words and a glyph the
 * client names, so a new row fails here until the sheet has an entry for it.
 *
 * Each test's comment names the behaviour whose removal makes it fail.
 */
import { describe, expect, it } from 'vitest'
import { AUTH_CLASSES, type AuthRow } from '../../home-auth/src/auth-classes.ts'
import { COPY_ICON, faceIconOf } from '../src/client/face-id-icon-keys.ts'
import { ACTION_COPY } from '../src/client/face-id-locales.ts'
import { problemOf } from './face-id-rows.ts'

const faceRows = AUTH_CLASSES.filter(row => row.authClass === 'face')

describe('the sheet\'s glyph map', () => {
  // A new face row with no copy entry resolves to the generic words and fails here.
  it('has words and a glyph for every face row of AUTH_CLASSES', () => {
    expect(faceRows.length).toBeGreaterThan(50)
    expect(faceRows.flatMap(row => problemOf(row) ?? [])).toEqual([])
  })

  // Proves the check rejects: a row the client does not name is reported, and so is one it only words generically.
  it('rejects a new row that no entry covers', () => {
    const row = (id: string, surface: AuthRow['surface']): AuthRow => ({ id, surface, authClass: 'face', reason: 'r' })
    expect(problemOf(row('remote:newThing/do', 'remote'))).toContain('generic words')
    expect(problemOf(row('route:x/src/routes.ts#NEW', 'route'))).toContain('names no client action')
    expect(problemOf(row('changes:new-control', 'changes'))).toContain('no Changes words')
    expect(problemOf(row('answer:new-grant', 'answer'))).toContain('no answer glyph')
  })

  // A copy id with no glyph would leave a sheet with an empty header.
  it('names a glyph for every copy id of ACTION_COPY', () => {
    expect(Object.keys(COPY_ICON).sort()).toEqual([...new Set(Object.values(ACTION_COPY)), 'generic'].sort())
  })

  // The shield is the plain fallback for a Changes control with no entry.
  it('falls back to the shield for an action with no entry of its own', () => {
    expect(faceIconOf('changes/unknown-control')).toBe('shield')
    expect(faceIconOf('somewhere/else')).toBe('shield')
    expect(faceIconOf('terminal/create')).toBe('terminal')
    expect(faceIconOf('changes/update-begin')).toBe('download')
  })
})
