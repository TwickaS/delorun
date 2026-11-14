import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isChangesError } from '../src/errors.ts'
import { activeCopiesEntry, activeDirectory, migrationPath, pluginSlug, profileChangesDirectory } from '../src/paths.ts'

const HOME = '/home/person/.delo'

describe('a plugin\'s active directory', () => {
  it('is the package name as one segment under active/', () => {
    expect(pluginSlug('plug')).toBe('plug')
    expect(activeDirectory(HOME, 'default', '@scope/plug')).toBe(join(profileChangesDirectory(HOME, 'default'), 'active', '@scope+plug'))
    expect(migrationPath(HOME)).toBe(join(HOME, 'changes', 'migration.json'))
  })

  it('refuses a name that is not a package name before any path is built from it', () => {
    for (const name of ['..', '../outside', '@scope/../../outside', '@scope/a/b', 'a/b', '@scope/', '', 'Upper', '.hidden', `${'a'}\u0000`]) {
      let refused: unknown
      try {
        activeDirectory(HOME, 'default', name)
      } catch (error) {
        refused = error
      }
      expect(isChangesError(refused) && refused.code, JSON.stringify(name)).toBe('NOT_LINKED')
    }
  })
})

describe('a profile\'s directories', () => {
  it('are built from a valid profile name only', () => {
    expect(profileChangesDirectory(HOME, 'work-2')).toBe(join(HOME, 'changes', 'profiles', 'work-2'))
    expect(activeCopiesEntry('work-2')).toBe(join('changes', 'profiles', 'work-2', 'active'))
  })

  it('accept a reserved name, since `delorun headless` keeps the headless profile\'s changes', () => {
    expect(profileChangesDirectory(HOME, 'headless')).toBe(join(HOME, 'changes', 'profiles', 'headless'))
    expect(activeCopiesEntry('headless')).toBe(join('changes', 'profiles', 'headless', 'active'))
  })

  it('refuse a name that is not a profile name before any path is built from it', () => {
    for (const name of ['../../secrets', '/abs', 'a/b', '']) {
      let profileRefused: unknown
      let entryRefused: unknown
      try {
        profileChangesDirectory(HOME, name)
      } catch (error) {
        profileRefused = error
      }
      try {
        activeCopiesEntry(name)
      } catch (error) {
        entryRefused = error
      }
      expect(isChangesError(profileRefused) && profileRefused.code, `profileChangesDirectory ${JSON.stringify(name)}`).toBe('INVALID_REQUEST')
      expect(isChangesError(entryRefused) && entryRefused.code, `activeCopiesEntry ${JSON.stringify(name)}`).toBe('INVALID_REQUEST')
    }
  })
})
