/**
 * `selectProfile`, the CLI's use of contract C1's profile-name rule (`delo/docs/contracts/c01-home-layout.md`,
 * "Profiles"), for `--profile` and `DELO_PROFILE`.
 */
import { describe, expect, it } from 'vitest'
import { HEADLESS_PROFILE as CONTRACT_HEADLESS_PROFILE, RESERVED_PROFILE_NAMES } from '@delo/contract-home-layout'
import { CliError, EXIT } from '../src/exit.ts'
import { main } from '../src/main.ts'
import { HEADLESS_PROFILE } from '../src/headless.ts'
import { profileDirectory, profileOptionValues, selectCommandProfile, selectProfile } from '../src/profile.ts'

/**
 * The refusal `selectProfile` throws.
 * @param select - the call.
 * @returns the error.
 */
function refusal(select: () => string): CliError {
  try {
    select()
  } catch (error) {
    if (error instanceof CliError) return error
    throw error
  }
  throw new Error('selectProfile accepted the name')
}

describe('selectProfile', () => {
  it('reserved-profile-refused: refuses every reserved name from --profile and DELO_PROFILE, naming it and why', () => {
    for (const name of ['desktop', 'headless', 'data-users', 'node_modules']) {
      const reason = RESERVED_PROFILE_NAMES.get(name)!
      const flag = refusal(() => selectProfile(name, {}))
      expect(flag.exit).toBe(EXIT.usage)
      expect(flag.message).toBe(`delorun: --profile is refused: "${name}" is reserved: ${reason}; choose another profile name`)
      const env = refusal(() => selectProfile(undefined, { DELO_PROFILE: name }))
      expect(env.exit).toBe(EXIT.usage)
      expect(env.message).toBe(`delorun: DELO_PROFILE is refused: "${name}" is reserved: ${reason}; choose another profile name`)
    }
    expect(refusal(() => selectProfile('Headless', {})).message).toContain('"Headless" is reserved: it is the profile `delorun headless` boots')
  })

  it('refuses a name outside the profile-name characters', () => {
    for (const name of ['../etc', 'a/b', 'Work', 'a'.repeat(33)]) {
      const error = refusal(() => selectProfile(name, {}))
      expect(error.exit).toBe(EXIT.usage)
      expect(error.message).toContain(`${JSON.stringify(name)} is not a profile name`)
    }
  })

  it('accepts ordinary names, and the default when neither source names one', () => {
    for (const name of ['default', 'work', 'work-2_x', 'web', 'tui', 'my-headless']) {
      expect(selectProfile(name, {})).toBe(name)
      expect(selectProfile(undefined, { DELO_PROFILE: name })).toBe(name)
    }
    expect(selectProfile(undefined, {})).toBe('default')
    expect(selectProfile(undefined, { DELO_PROFILE: ' ' })).toBe('default')
  })

  it('reserves the profile delorun headless boots', () => {
    expect(HEADLESS_PROFILE).toBe(CONTRACT_HEADLESS_PROFILE)
  })

  it('reserves node_modules because upstream refuses it as a profile', () => {
    expect(() => profileDirectory('/home', 'node_modules')).toThrow('invalid profile name')
  })
})

describe('selectCommandProfile', () => {
  it('reserved-profile-refused: refuses a reserved name in any --profile value a command line carries, in any letter case', () => {
    for (const args of [['--profile', 'headless', 'add', 'x'], ['--profile=Headless', 'list'], ['add', 'x', '--profile', 'nul'], ['--profile', 'data-users']]) {
      const error = refusal(() => selectCommandProfile('plugin', args, {}))
      expect(error.exit).toBe(EXIT.usage)
      expect(error.message).toContain('is reserved')
    }
  })

  it('refuses --profile values that differ, so the profile checked is the profile the command\'s own parser uses', () => {
    const error = refusal(() => selectCommandProfile('logs', ['--profile', 'work', '--profile', 'headless'], {}))
    expect(error.exit).toBe(EXIT.usage)
    expect(error.message).toBe('delorun logs: --profile is given more than once with different names ("work", "headless"); give one profile')
    expect(refusal(() => selectCommandProfile('plugin', ['--profile=work', '--profile', 'home'], {})).message).toContain('different names')
  })

  it('accepts one name given once or repeated, takes DELO_PROFILE without --profile, and reads nothing after --', () => {
    expect(selectCommandProfile('plugin', ['--profile', 'work', 'add', 'x', '--profile=work'], {})).toBe('work')
    expect(selectCommandProfile('plugin', ['list'], { DELO_PROFILE: 'work' })).toBe('work')
    expect(selectCommandProfile('plugin', ['list'], {})).toBe('default')
    expect(profileOptionValues(['--profile', 'a', '--', '--profile', 'headless'])).toEqual(['a'])
    expect(profileOptionValues(['--profile'])).toEqual([''])
    expect(refusal(() => selectCommandProfile('plugin', ['--profile'], {})).message).toContain('is not a profile name')
  })
})

describe('delorun plugin and delorun logs', () => {
  it('reserved-profile-refused: refuse a reserved or mismatched --profile before anything runs', async () => {
    for (const argv of [['plugin', '--profile', 'headless', 'add', 'x'], ['plugin', '--profile', 'Headless', 'list'], ['logs', '--profile', 'work', '--profile', 'headless'], ['logs', '--profile=com1']]) {
      let printed = ''
      const exit = await main(argv, { env: {}, stdout: () => undefined, stderr: (text) => { printed += text } })
      expect(exit, argv.join(' ')).toBe(EXIT.usage)
      expect(printed).toMatch(/is reserved|different names/u)
    }
  })
})
