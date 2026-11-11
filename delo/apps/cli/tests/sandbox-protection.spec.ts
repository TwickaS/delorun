/**
 * The post-boot check of the sandbox row's escape directories: a booted row must name every directory the start set,
 * and may name more; and the row's settings beyond what one start set, which C3's H3 compares across an update.
 */
import { describe, expect, it } from 'vitest'
import { missingEscapeSocketDirectories, settingsBeyondProtection, WSL_INTEROP_DIRECTORIES } from '../src/sandbox-protection.ts'

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

describe('a sandbox row\'s settings beyond one start\'s protection', () => {
  const protection = { protectedHome: '/h', protectedHomeReadable: ['runtimes', 'skills'], deniedSockets: ['/h/run/default/update.sock', '/var/run/docker.sock'], escapeSocketDirectories: ['/run/WSL'] }

  it('leaves out what the start set and keeps every setting and entry a layer gives', () => {
    const config = { networkAccess: false, protectedHome: '/h', protectedHomeReadable: ['runtimes', 'skills'], deniedSockets: ['/srv/mine.sock', '/h/run/default/update.sock', '/var/run/docker.sock'], escapeSocketDirectories: ['/srv/escape', '/run/WSL'] }
    expect(settingsBeyondProtection(config, protection)).toEqual({ networkAccess: false, deniedSockets: ['/srv/mine.sock'], escapeSocketDirectories: ['/srv/escape'] })
  })

  it('keeps a protected home or read exemptions the start did not set, and lists that are not lists', () => {
    const config = { protectedHome: '/elsewhere', protectedHomeReadable: ['runtimes'], deniedSockets: 'not a list' }
    expect(settingsBeyondProtection(config, protection)).toEqual(config)
    expect(settingsBeyondProtection({ protectedHomeReadable: ['skills', 'runtimes'] }, protection)).toEqual({ protectedHomeReadable: ['skills', 'runtimes'] })
    expect(settingsBeyondProtection(null, protection)).toBeNull()
  })
})
