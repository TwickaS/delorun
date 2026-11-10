/**
 * The post-boot check of the sandbox row's escape directories: a booted row must name every directory the start set,
 * and may name more.
 */
import { describe, expect, it } from 'vitest'
import { missingEscapeSocketDirectories, WSL_INTEROP_DIRECTORIES } from '../src/sandbox-protection.ts'

const START = { escapeSocketDirectories: [...WSL_INTEROP_DIRECTORIES, '/run/other'] }

describe('the escape directories a booted sandbox row must name', () => {
  it('are all present when the row names each one the start set, with more of its own', () => {
    expect(missingEscapeSocketDirectories(START, { escapeSocketDirectories: ['/run/mine', '/run/other', '/run/WSL'] })).toEqual([])
  })

  it('are reported in the start\'s order when the row dropped some', () => {
    expect(missingEscapeSocketDirectories(START, { escapeSocketDirectories: ['/run/other'] })).toEqual(['/run/WSL'])
    expect(missingEscapeSocketDirectories(START, { escapeSocketDirectories: ['/run/WSL/', '/run/W'] })).toEqual(['/run/WSL', '/run/other'])
  })

  it('are all reported when the row names none, has no list, or has no settings', () => {
    for (const config of [{ escapeSocketDirectories: [] }, { escapeSocketDirectories: '/run/WSL' }, { deniedSockets: ['/run/WSL'] }, undefined, null, 'x']) {
      expect(missingEscapeSocketDirectories(START, config)).toEqual(['/run/WSL', '/run/other'])
    }
  })

  it('are none when the start set none', () => {
    expect(missingEscapeSocketDirectories({ escapeSocketDirectories: [] }, undefined)).toEqual([])
  })
})
