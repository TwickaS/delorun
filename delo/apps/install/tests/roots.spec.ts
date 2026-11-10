/**
 * The roots a launcher ships: the only roots a start, an install and the runtime's own updates and rollbacks trust.
 * They must exist, be consecutive versions, and form a chain in which each root is signed by the root before it as well
 * as by its own keys; a directory that fails any of this refuses instead of trusting what it cannot prove. The stored
 * root is trusted only through them.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isInstallError, type InstallErrorCode } from '../src/errors.ts'
import { readAnchoredRoot, readShippedRoots } from '../src/roots.ts'
import { writeStoredRootChain, writeTrustedRoot } from '../src/state.ts'
import { fixtureKeys, fixtureRelease, nextRoot } from './support.ts'

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
  return refusalOf(readShippedRoots(join(directory, 'roots')), code)
}

/**
 * Expect a read to refuse.
 * @param read - the read.
 * @param code - the expected code.
 * @returns the refusal's detail.
 */
async function refusalOf(read: Promise<unknown>, code: InstallErrorCode): Promise<string> {
  const error: unknown = await read.then(() => undefined, (failure: unknown) => failure)
  expect(isInstallError(error, code), error instanceof Error ? error.message : String(error)).toBe(true)
  return (error as { detail: string }).detail
}

describe('the roots a package ships', () => {
  it('reads a chain of consecutive roots, oldest first', async () => {
    const fixture = await fixtureRelease()
    const second = nextRoot(fixture.rootMetadata, fixture.keys, [fixture.keys.root])
    const roots = await readShippedRoots(join(await packageWith({ '1.root.json': fixture.roots[0]!, '2.root.json': second }), 'roots'))
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
    expect(await refusal(await packageWith({ '1.root.json': fixture.roots[0]!, '3.root.json': third }), 'INSTALL_VERIFY_FAILED')).toContain('holds root 3 without root 2')
  })

  it('refuses a root that the root before it did not sign, though its own keys verify it', async () => {
    const fixture = await fixtureRelease()
    const stranger = fixtureKeys()
    const forged = nextRoot(fixture.rootMetadata, fixture.keys, [stranger.root])
    expect(await refusal(await packageWith({ '1.root.json': fixture.roots[0]!, '2.root.json': forged }), 'INSTALL_VERIFY_FAILED')).toContain('are not a chain')
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

describe('the stored root, anchored on the shipped roots', () => {
  /**
   * A temporary Delo home whose `trust/` holds a stored root and, when given, the chain an install walked.
   * @param stored - `trust/root.json`'s bytes, or `undefined` for none.
   * @param walked - the chain's root files.
   * @returns the home.
   */
  async function homeWith(stored: Uint8Array | undefined, walked: readonly Uint8Array[] = []): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'delo-anchored-root-'))
    directories.push(home)
    if (stored !== undefined) await writeTrustedRoot(home, stored)
    await writeStoredRootChain(home, walked)
    return home
  }

  it('trusts a stored root the launcher ships, and a newer one only through the chain an install walked', async () => {
    const fixture = await fixtureRelease()
    expect((await readAnchoredRoot(await homeWith(fixture.roots[0]!), fixture.roots)).metadata.version).toBe(1)
    const second = nextRoot(fixture.rootMetadata, fixture.keys, [fixture.keys.root])
    expect((await readAnchoredRoot(await homeWith(second, [fixture.roots[0]!, second]), fixture.roots)).metadata.version).toBe(2)
  })

  it('refuses a stored root no shipped root leads to, a home with no stored root, and a launcher that ships none', async () => {
    const fixture = await fixtureRelease()
    const stranger = await fixtureRelease()
    expect(await refusalOf(readAnchoredRoot(await homeWith(stranger.roots[0]!), fixture.roots), 'INSTALL_VERIFY_FAILED')).toContain('not the root this launcher ships')
    const second = nextRoot(fixture.rootMetadata, fixture.keys, [fixture.keys.root])
    expect(await refusalOf(readAnchoredRoot(await homeWith(second), fixture.roots), 'INSTALL_VERIFY_FAILED')).toContain('holds no root of that version')
    expect(await refusalOf(readAnchoredRoot(await homeWith(undefined), fixture.roots), 'NO_TRUSTED_ROOT')).toContain('no trusted release root is stored')
    expect(await refusalOf(readAnchoredRoot(await homeWith(fixture.roots[0]!), []), 'NO_TRUSTED_ROOT')).toContain('ships no root')
  })
})
