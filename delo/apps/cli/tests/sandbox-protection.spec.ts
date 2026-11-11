/**
 * The post-boot check of the sandbox row's escape directories: a booted row must name every directory the start set,
 * and may name more; and the row's protection and other settings as C3's H3 compares them across an update.
 */
import { describe, expect, it } from 'vitest'
import { hostProtectionOf, missingEscapeSocketDirectories, protectionWeakenings, settingsBeyondProtection, WSL_INTEROP_DIRECTORIES } from '../src/sandbox-protection.ts'

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

describe('a sandbox row\'s protection as H3 compares it', () => {
  const config = { networkAccess: false, protectedHome: '/h', protectedHomeReadable: ['runtimes', 7], deniedSockets: ['/srv/mine.sock', '/h/run/default/update.sock', '/var/run/docker.sock'], escapeSocketDirectories: ['/run/WSL'] }

  it('hashes the settings beyond the protection, and reads the protection without the sockets the start found', () => {
    expect(settingsBeyondProtection(config)).toEqual({ networkAccess: false })
    expect(settingsBeyondProtection(null)).toBeNull()
    expect(hostProtectionOf(config, ['/var/run/docker.sock'])).toEqual({ protectedHome: '/h', protectedHomeReadable: ['runtimes'], deniedSockets: ['/srv/mine.sock', '/h/run/default/update.sock'], escapeSocketDirectories: ['/run/WSL'] })
    expect(hostProtectionOf({ protectedHome: '/h', deniedSockets: 'not a list' }, [])).toEqual({ protectedHome: '/h', protectedHomeReadable: [], deniedSockets: [], escapeSocketDirectories: [] })
    expect(hostProtectionOf({ deniedSockets: [] }, [])).toBeUndefined()
    expect(hostProtectionOf('no config', [])).toBeUndefined()
  })

  it('names every way a later protection is weaker, and none for a stricter one', () => {
    const before = { protectedHome: '/h', protectedHomeReadable: ['runtimes'], deniedSockets: ['/a.sock'], escapeSocketDirectories: ['/run/WSL'] }
    expect(protectionWeakenings(before, { ...before, protectedHomeReadable: [], deniedSockets: ['/a.sock', '/b.sock'], escapeSocketDirectories: ['/run/WSL', '/x'] })).toEqual([])
    expect(protectionWeakenings(before, { protectedHome: '/g', protectedHomeReadable: ['runtimes', 'secrets'], deniedSockets: [], escapeSocketDirectories: [] })).toEqual([
      'protects /g instead of /h', 'lets confined commands read secrets', 'no longer denies /a.sock', 'no longer hides /run/WSL',
    ])
  })
})
