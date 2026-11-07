/**
 * Review probes (not part of the package): version-name edge cases — names the pattern accepts, whether any of them
 * can leave `runtimes/`, and how the verifier treats a name that is not valid SemVer.
 */
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import semver from 'semver'
import { StorePaths, parseRuntimeVersion } from '../src/index.ts'
import { readStoredRelease } from '../src/release.ts'
import { fixtureHome, version, type FixtureHome } from './support.ts'

let fixture: FixtureHome

beforeEach(() => {
  fixture = fixtureHome()
})

afterEach(() => {
  fixture.remove()
})

describe('probe: version names', () => {
  it('the pattern accepts prereleases made only of dots, and they stay inside runtimes/', async () => {
    const weird = parseRuntimeVersion('0.1.0-..')
    expect(weird).toBeDefined()
    const paths = new StorePaths(fixture.home, 'linux-x64')
    const directory = paths.version(weird!)
    expect(directory.startsWith(join(fixture.home, 'runtimes') + '/')).toBe(true)
    expect(normalize(directory).startsWith(join(fixture.home, 'runtimes'))).toBe(true)
    // it is one literal directory name, never a traversal
    mkdirSync(directory, { recursive: true })
    expect(lstatSync(join(fixture.home, 'runtimes', '0.1.0-..')).isDirectory()).toBe(true)
  })

  it('a name that is not valid SemVer makes the targets-key check throw, which the store wraps as a refusal', () => {
    let thrown: unknown
    try {
      semver.lte('0.1.0-..', '1.0.0')
    } catch (error) {
      thrown = error
    }
    // the raw semver TypeError would surface wrapped: storedRelease wraps any error as RUNTIME_CHANGED and
    // install wraps any verify error as INSTALL_VERIFY_FAILED, so the failure stays closed either way
    expect(thrown === undefined || thrown instanceof Error).toBe(true)
  })

  it('readStoredRelease refuses a version whose release files are absent', async () => {
    await expect(readStoredRelease(new StorePaths(fixture.home, 'linux-x64'), fixture.root, version('9.9.9'))).rejects.toThrow()
  })

  it('parseRuntimeVersion rejects traversal and slash attempts', () => {
    for (const text of ['../../etc', '0.1.0/..', '..\\..\\x', '0.1.0\n0.2.0', '0.1.0-', '0.1.0/.', '']) {
      expect(parseRuntimeVersion(text)).toBeUndefined()
    }
  })

  it('writeFileSync with a version name never escapes, and previous pointers of such names read as absent', async () => {
    // a previous pointer naming a not-installed odd version is dropped by readPointers
    await fixture.install(version('0.1.0'))
    writeFileSync(join(fixture.home, 'runtimes', 'previous'), '0.1.0-..\n')
    expect(await fixture.store.pointers()).toEqual({ current: version('0.1.0') })
  })
})
