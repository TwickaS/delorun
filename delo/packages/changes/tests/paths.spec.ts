import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isChangesError } from '../src/errors.ts'
import { activeDirectory, migrationPath, pluginSlug, profileChangesDirectory } from '../src/paths.ts'

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
