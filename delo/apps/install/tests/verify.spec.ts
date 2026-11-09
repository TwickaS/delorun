/**
 * Contract C2's step 5 over a file on disk, and the root a start anchors on: a file of the right length whose bytes
 * differ is refused only by its SHA-256, the way an in-place edit of an archive is, and a stored root that is not the
 * root the launcher ships for its version is refused rather than trusted.
 */
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isInstallError, type InstallError } from '../src/errors.ts'
import { verifyDownloadedFile, verifyStoredRoot } from '../src/verify.ts'
import { fileRef, fixtureRelease, sha256 } from './support.ts'

let directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })))
  directories = []
})

/**
 * A temporary directory a spec writes a file into.
 * @returns its path.
 */
async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'delo-install-verify-'))
  directories.push(directory)
  return directory
}

/**
 * Expect a check to refuse with a code.
 * @param check - the check.
 * @param code - the expected code.
 * @returns the refusal.
 */
async function refusal(check: Promise<unknown>, code: InstallError['code']): Promise<InstallError> {
  const error: unknown = await check.then(() => undefined, (failure: unknown) => failure)
  expect(isInstallError(error, code), error instanceof Error ? error.message : String(error)).toBe(true)
  return error as InstallError
}

describe('a downloaded file whose length matches its signed reference', () => {
  it('is refused only by its SHA-256 when one byte is flipped in place', async () => {
    const fixture = await fixtureRelease()
    const directory = await scratch()
    const path = join(directory, `delorun-${String(fixture.manifest.version)}-${fixture.platform}.tar.gz`)
    await writeFile(path, fixture.archive)
    const ref = fileRef(`delorun-${String(fixture.manifest.version)}-${fixture.platform}.tar.gz`, fixture.archive)
    await expect(verifyDownloadedFile(ref, path)).resolves.toEqual({ length: fixture.archive.byteLength, sha256: sha256(fixture.archive) })

    // One byte, in place: the file keeps the length the manifest lists, so the length check passes and only the
    // digest can refuse it.
    const handle = await open(path, 'r+')
    try {
      const byte = Buffer.alloc(1)
      await handle.read(byte, 0, 1, 0)
      byte[0] = byte[0]! ^ 0xff
      await handle.write(byte, 0, 1, 0)
    } finally {
      await handle.close()
    }

    const error = await refusal(verifyDownloadedFile(ref, path), 'INSTALL_VERIFY_FAILED')
    expect(error.detail).toContain('SHA-256')
    expect(error.detail).not.toContain('bytes')
    expect(error.source).toBe(ref.name)
  })

  it('is refused by its length when a byte is added, before its digest is considered', async () => {
    const fixture = await fixtureRelease()
    const directory = await scratch()
    const path = join(directory, 'delorun-archive.tar.gz')
    await writeFile(path, Buffer.concat([fixture.archive, Buffer.from('extra')]))
    const error = await refusal(verifyDownloadedFile(fileRef('delorun-archive.tar.gz', fixture.archive), path), 'INSTALL_VERIFY_FAILED')
    expect(error.detail).toContain('bytes')
  })
})

describe('the root a start anchors on', () => {
  it('trusts the stored root when it is the root the launcher ships for its version', async () => {
    const fixture = await fixtureRelease()
    const stored = verifyStoredRoot({ stored: fixture.roots[0]!, shipped: fixture.roots, source: '/home/.delo/trust/root.json' })
    expect(stored.metadata.version).toBe(fixture.rootMetadata.version)
  })

  it('refuses a stored root of a shipped version whose keys and roles differ', async () => {
    const shipped = await fixtureRelease()
    const unrelated = await fixtureRelease()
    const path = '/home/.delo/trust/root.json'
    const error = await refusal(Promise.resolve().then(() => verifyStoredRoot({ stored: unrelated.roots[0]!, shipped: shipped.roots, source: path })), 'INSTALL_VERIFY_FAILED')
    expect(error.source).toBe(path)
    expect(error.detail).toContain('keys or roles differ')
  })
})
