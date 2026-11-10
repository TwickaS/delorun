/**
 * The roots a launcher ships: the only roots a start and an install trust. They must exist, be consecutive versions,
 * and form a chain in which each root is signed by the root before it as well as by its own keys; a package that fails
 * any of this refuses every install instead of trusting what it cannot prove.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isInstallError, type InstallErrorCode } from '@delo/install'
import { readEmbeddedRoots } from '../src/root.ts'
import { fixtureKeys, fixtureRelease, nextRoot } from '../../install/tests/support.ts'

let directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })))
  directories = []
})

/**
 * A package directory whose `roots/` holds the given files.
 * @param files - file name to content.
 * @returns the package directory.
 */
async function packageWith(files: Readonly<Record<string, Uint8Array | string>>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'delo-launcher-roots-'))
  directories.push(directory)
  await mkdir(join(directory, 'roots'))
  for (const [name, content] of Object.entries(files)) await writeFile(join(directory, 'roots', name), content)
  return directory
}

/**
 * Expect reading the roots to refuse.
 * @param directory - the package directory.
 * @param code - the expected code.
 * @returns the refusal's detail.
 */
async function refusal(directory: string, code: InstallErrorCode): Promise<string> {
  const error: unknown = await readEmbeddedRoots(directory).then(() => undefined, (failure: unknown) => failure)
  expect(isInstallError(error, code), error instanceof Error ? error.message : String(error)).toBe(true)
  return (error as { detail: string }).detail
}

describe('the roots a package ships', () => {
  it('reads a chain of consecutive roots, oldest first', async () => {
    const fixture = await fixtureRelease()
    const second = nextRoot(fixture.rootMetadata, fixture.keys, [fixture.keys.root])
    const roots = await readEmbeddedRoots(await packageWith({ '1.root.json': fixture.roots[0]!, '2.root.json': second }))
    expect(roots.map(Buffer.from)).toEqual([Buffer.from(fixture.roots[0]!), second])
  })

  it('refuses a package with no roots directory, a roots path that is not a directory, or no root file in it', async () => {
    const missing = await mkdtemp(join(tmpdir(), 'delo-launcher-roots-'))
    directories.push(missing)
    expect(await refusal(missing, 'NO_TRUSTED_ROOT')).toContain('holds no release root')
    const file = await mkdtemp(join(tmpdir(), 'delo-launcher-roots-'))
    directories.push(file)
    await writeFile(join(file, 'roots'), 'in the way')
    expect(await refusal(file, 'NO_TRUSTED_ROOT')).toContain('cannot be read')
    expect(await refusal(await packageWith({ 'notes.txt': 'not a root' }), 'NO_TRUSTED_ROOT')).toContain('holds no <n>.root.json file')
  })

  it('refuses roots that skip a version', async () => {
    const fixture = await fixtureRelease()
    const third = nextRoot({ ...fixture.rootMetadata, version: 2 }, fixture.keys, [fixture.keys.root])
    expect(await refusal(await packageWith({ '1.root.json': fixture.roots[0]!, '3.root.json': third }), 'INSTALL_VERIFY_FAILED')).toContain('ships root 3 without root 2')
  })

  it('refuses a root that the root before it did not sign, though its own keys verify it', async () => {
    const fixture = await fixtureRelease()
    const stranger = fixtureKeys()
    const forged = nextRoot(fixture.rootMetadata, fixture.keys, [stranger.root])
    expect(await refusal(await packageWith({ '1.root.json': fixture.roots[0]!, '2.root.json': forged }), 'INSTALL_VERIFY_FAILED')).toContain('the roots this launcher ships are not a chain')
  })

  it('refuses a root that does not verify at all', async () => {
    expect(await refusal(await packageWith({ '1.root.json': '{"signed":{},"signatures":[]}' }), 'INSTALL_VERIFY_FAILED')).toContain('are not a chain')
  })

  it('refuses a root file whose name gives another version than the root holds', async () => {
    const fixture = await fixtureRelease()
    const second = nextRoot(fixture.rootMetadata, fixture.keys, [fixture.keys.root])
    expect(await refusal(await packageWith({ '1.root.json': second }), 'INSTALL_VERIFY_FAILED')).toContain('names version 2 and not 1')
  })
})
