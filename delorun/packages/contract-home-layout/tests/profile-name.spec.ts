/**
 * Contract C1's profile-name rule (`delorun/docs/contracts/c01-home-layout.md`, "Profiles"): the reserved names and the
 * characters a CLI profile's name may hold, through `profileNameProblem` and `PROFILE_NAME_PATTERN`.
 */
import { describe, expect, it } from 'vitest'
import { DATA_USERS_DIRECTORY, DESKTOP_PROFILE, HEADLESS_PROFILE, PROFILE_NAME_PATTERN, profileNameProblem, RESERVED_PROFILE_NAMES, WINDOWS_DEVICE_NAMES } from '../src/index.ts'

/** Every name C1 reserves, written out so a name dropped from the list fails here. */
const RESERVED = [
  'desktop', 'headless', 'data-users', 'node_modules',
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
] as const

describe('the profile-name rule', () => {
  it('reserved-profile-refused: refuses every reserved name, naming it and why, in any letter case', () => {
    expect([...RESERVED_PROFILE_NAMES.keys()].sort()).toEqual([...RESERVED].sort())
    for (const name of RESERVED) {
      const reason = RESERVED_PROFILE_NAMES.get(name)!
      expect(profileNameProblem(name)).toBe(`"${name}" is reserved: ${reason}`)
      expect(profileNameProblem(name.toUpperCase())).toBe(`"${name.toUpperCase()}" is reserved: ${reason}`)
      expect(PROFILE_NAME_PATTERN.test(name)).toBe(false)
    }
  })

  it('reserves the names the home and Delorun\'s commands use', () => {
    expect(RESERVED_PROFILE_NAMES.get(DATA_USERS_DIRECTORY)).toContain('escape the home-wide exclusion')
    expect(RESERVED_PROFILE_NAMES.get(HEADLESS_PROFILE)).toContain('`delorun headless` boots')
    expect(RESERVED_PROFILE_NAMES.get(DESKTOP_PROFILE)).toContain('the desktop app\'s own profile')
    expect(RESERVED_PROFILE_NAMES.get('node_modules')).toContain('upstream refuses')
    for (const name of WINDOWS_DEVICE_NAMES) expect(RESERVED_PROFILE_NAMES.get(name)).toContain('Windows device name')
  })

  it('refuses a name only when it is a reserved name in full', () => {
    for (const name of ['headless-2', 'my-headless', 'desktops', 'data-users2', 'node_modules_x', 'web', 'tui', 'default', 'com0', 'com10', 'console', 'lpt']) {
      expect(profileNameProblem(name)).toBeUndefined()
      expect(PROFILE_NAME_PATTERN.test(name)).toBe(true)
    }
  })

  it('refuses a name outside the characters a profile may hold', () => {
    for (const name of ['', '../etc', 'a/b', 'Work', '-work', '_work', 'a'.repeat(33), 'work\n']) {
      expect(profileNameProblem(name)).toBe(`${JSON.stringify(name)} is not a profile name: a profile is 1 to 32 lowercase letters, digits, hyphens or underscores, starting with a letter or digit`)
      expect(PROFILE_NAME_PATTERN.test(name)).toBe(false)
    }
  })

  it('accepts ordinary names', () => {
    for (const name of ['default', 'work', 'work-2_x', '0', 'a'.repeat(32)]) {
      expect(profileNameProblem(name)).toBeUndefined()
      expect(PROFILE_NAME_PATTERN.test(name)).toBe(true)
    }
  })

  it('keeps every reserved name literal in the pattern', () => {
    for (const name of RESERVED_PROFILE_NAMES.keys()) expect(name).toMatch(/^[a-z0-9_-]+$/u)
  })
})
