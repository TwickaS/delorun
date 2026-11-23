/**
 * The signing command's checks of its inputs beyond the rebuild: the release tag's SSH signature against the
 * allowed-signers file, the release commit's place on the release branch, the install scripts as zero-length
 * placeholders, and each npm package's packed tarball against the draft's integrity, name and version. Every key is a
 * throwaway key generated in the test, and every repository a temporary one.
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { tarStream } from '@delorun/release-formats/archive/tar'
import { logEntryName, verifyEntryBody } from '@delorun/release-formats/log/bundle'
import { entryBody, readEntryRequest } from '@delorun/release-formats/log/entry'
import { entryKeyId } from '@delorun/release-formats/log/entry-keys'
import { publicKeyEntry } from '@delorun/release-formats/sign/envelope'
import { INSTALL_SCRIPT_REFUSAL } from '../../src/sign/release.ts'
import { npmIntegrity, npmTarballName, packedManifest } from '../../src/sign/npm-package.ts'
import { ALLOWED_SIGNERS_PATH, signerLines } from '../../src/sign/source.ts'
import { REPO, scratch } from '../support.ts'
import { listedEntryKey, packedPackage, releaseFixture, RELEASE_BRANCH, rootFile, tagSigner, VERSION, type ReleaseFixture } from './fixture.ts'

const MANIFEST = `delorun-${VERSION}.manifest.json`
const TAG = `v${VERSION}`

/** Each case builds a fixture release, which a loaded host slows. */
const FIXTURE_TIMEOUT = { timeout: 60_000 }

/**
 * Assert that signing refused with a message and wrote nothing into the release directory.
 * @param fixture - the fixture release.
 * @param before - the release directory's file names before signing.
 * @param result - the signing result.
 * @param message - text the refusal holds.
 */
function refusedWithoutWriting(fixture: ReleaseFixture, before: readonly string[], result: { status: number | null, stderr: string }, message: string): void {
  expect(result.stderr).toContain(message)
  expect(result.status).toBe(1)
  expect(readdirSync(fixture.release).sort()).toEqual(before)
  expect(existsSync(join(fixture.release, MANIFEST))).toBe(false)
}

/**
 * Replace a field of the manifest draft.
 * @param fixture - the fixture release.
 * @param edit - changes the parsed draft in place.
 */
function editDraft(fixture: ReleaseFixture, edit: (draft: { install: Record<'sh' | 'ps1', { name: string, length: number, sha256: string }>, npm: Array<{ name: string, version: string, integrity: string }> }) => void): void {
  const path = join(fixture.release, 'manifest-draft.json')
  const draft = JSON.parse(readFileSync(path, 'utf8')) as Parameters<typeof edit>[0]
  edit(draft)
  writeFileSync(path, `${JSON.stringify(draft, undefined, 2)}\n`)
}

/**
 * Move the release tag to a new tag object.
 * @param fixture - the fixture release.
 * @param args - the `git tag` arguments after `-f`, ending with the tag's name.
 * @param signingKey - the SSH key that signs it, when the arguments sign.
 */
function retag(fixture: ReleaseFixture, args: readonly string[], signingKey?: string): void {
  const config = signingKey === undefined ? [] : ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${signingKey}`]
  fixture.git([...config, 'tag', '-f', ...args])
}

describe('signing checks the release tag', FIXTURE_TIMEOUT, () => {
  it('sign-release-refuses-unsigned-tag: refuses an annotated tag without a signature, and a lightweight tag', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const before = readdirSync(fixture.release).sort()
    retag(fixture, ['-a', '-m', `release ${VERSION}`, TAG])
    refusedWithoutWriting(fixture, before, await fixture.sign(), `signing refuses: the tag ${TAG} carries no SSH signature`)
    retag(fixture, [TAG])
    refusedWithoutWriting(fixture, before, await fixture.sign(), `signing refuses: the tag ${TAG} is a lightweight tag, which carries no signature`)
  })

  it('sign-release-refuses-unlisted-signer: refuses a tag signed by a key the allowed-signers file does not list', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const before = readdirSync(fixture.release).sort()
    const stranger = tagSigner(scratch(test), 'stranger')
    retag(fixture, ['-s', '-m', `release ${VERSION}`, TAG], stranger.key)
    refusedWithoutWriting(fixture, before, await fixture.sign(), `signing refuses: the signature of tag ${TAG} does not verify with a key the allowed-signers file delorun/release/allowed-signers on the release branch ${RELEASE_BRANCH} lists`)
  })

  it('sign-release-refuses-empty-allowed-signers: the committed allowed-signers file lists no key, so signing refuses every tag', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const before = readdirSync(fixture.release).sort()
    const committed = readFileSync(join(REPO, ALLOWED_SIGNERS_PATH), 'utf8')
    expect(signerLines(committed)).toBe(0)
    fixture.commitReleaseFile('allowed-signers', committed)
    refusedWithoutWriting(fixture, before, await fixture.sign(), `signing refuses: the allowed-signers file delorun/release/allowed-signers on the release branch ${RELEASE_BRANCH} lists no signer key, so no release tag verifies`)
    fixture.commitReleaseFile('allowed-signers', undefined)
    refusedWithoutWriting(fixture, before, await fixture.sign(), `signing refuses: the release branch ${RELEASE_BRANCH} holds no delorun/release/allowed-signers`)
  })

  it('sign-release-reads-allowed-signers-from-the-release-branch: a signer added only in the working tree does not verify', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const before = readdirSync(fixture.release).sort()
    const stranger = tagSigner(scratch(test), 'stranger')
    retag(fixture, ['-s', '-m', `release ${VERSION}`, TAG], stranger.key)
    writeFileSync(join(fixture.repo, ALLOWED_SIGNERS_PATH), `${fixture.allowedSigners}${stranger.allowed}`)
    refusedWithoutWriting(fixture, before, await fixture.sign(), `signing refuses: the signature of tag ${TAG} does not verify`)
  })

  it('sign-release-refuses-retargeted-tag: refuses a signed tag object made for another tag name', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const before = readdirSync(fixture.release).sort()
    fixture.git(['-c', 'gpg.format=ssh', '-c', `user.signingkey=${fixture.signer.key}`, 'tag', '-s', '-m', 'release 0.0.9', 'v0.0.9'])
    fixture.git(['update-ref', `refs/tags/${TAG}`, fixture.git(['rev-parse', 'refs/tags/v0.0.9'])])
    refusedWithoutWriting(fixture, before, await fixture.sign(), `signing refuses: the tag object at refs/tags/${TAG} was made for the tag "v0.0.9", not ${TAG}`)
  })

  it('sign-release-accepts-listed-signer: signs when a key the allowed-signers file lists signed the tag', async (test) => {
    const fixture = await releaseFixture(test)
    const second = tagSigner(scratch(test), 'second-signer')
    fixture.commitReleaseFile('allowed-signers', `${fixture.allowedSigners}${second.allowed}`)
    retag(fixture, ['-s', '-m', `release ${VERSION}`, TAG], second.key)
    expect(fixture.record().status).toBe(0)
    const result = await fixture.sign()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(existsSync(join(fixture.release, MANIFEST))).toBe(true)
  })
})

describe('signing checks the targets key against the production-keys registry', FIXTURE_TIMEOUT, () => {
  it('sign-release-refuses-unlisted-production-key: refuses a targets key the registry does not list, and every key while the registry is empty', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const before = readdirSync(fixture.release).sort()
    const keyid = publicKeyEntry(fixture.keys.targets).keyid
    fixture.commitReleaseFile('production-keys.json', readFileSync(join(REPO, 'delorun', 'release', 'production-keys.json'), 'utf8'))
    refusedWithoutWriting(fixture, before, await fixture.sign(), `signing refuses: delorun/release/production-keys.json on the release branch ${RELEASE_BRANCH} lists no production key`)
    fixture.commitReleaseFile('production-keys.json', `${JSON.stringify({ schema: 'delorun.production-keys/1', roots: [], keyids: ['0'.repeat(64)] })}\n`)
    refusedWithoutWriting(fixture, before, await fixture.sign(), `signing refuses: the targets key ${keyid} is not a production key`)
  })
})

describe('signing writes a log entry request per listed log-entry key', FIXTURE_TIMEOUT, () => {
  const ECDSA = 'PKIX_ECDSA_P256_SHA_256'

  /**
   * A root that lists an ECDSA P-256 key first and the targets key as Ed25519ph second, and a registry listing both.
   * @param fixture - the release fixture.
   * @param registered - whether the registry lists the ECDSA key.
   * @returns the ECDSA key and the root file.
   */
  function rotated(fixture: ReleaseFixture, registered: boolean): { ecdsa: KeyObject, root: ReturnType<typeof rootFile> } {
    const ecdsa = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
    const root = rootFile(fixture.keys, { logEntryKeys: [listedEntryKey(ECDSA, ecdsa), listedEntryKey('PKIX_ED25519_PH', fixture.keys.targets)] })
    const keyids = [publicKeyEntry(fixture.keys.targets).keyid, ...registered ? [entryKeyId(ecdsa)] : []]
    fixture.commitReleaseFile('production-keys.json', `${JSON.stringify({ schema: 'delorun.production-keys/1', roots: [], keyids })}\n`)
    return { ecdsa, root }
  }

  it('sign-release-entry-per-listed-key: writes the ECDSA request first and the Ed25519ph one second, in the root\'s order, each verifying under the root', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const { ecdsa, root } = rotated(fixture, true)
    expect((await fixture.sign(undefined, { roots: [root.bytes], logEntryKeys: [{ keyDetails: ECDSA, key: ecdsa }] })).status).toBe(0)
    const manifest = readFileSync(join(fixture.release, MANIFEST))
    const requests = [logEntryName(VERSION), logEntryName(VERSION, 1)].map(name => readEntryRequest(readFileSync(join(fixture.release, name))))
    expect(requests.map(request => request.hashedRekordRequestV002.signature.verifier.keyDetails)).toEqual([ECDSA, 'PKIX_ED25519_PH'])
    for (const request of requests) verifyEntryBody(root.metadata, manifest, VERSION, entryBody(request))
    expect(existsSync(join(fixture.release, logEntryName(VERSION, 2)))).toBe(false)
  })

  it('sign-release-refuses-unlisted-log-entry-key: refuses an ECDSA log-entry key the production-keys registry does not list, before writing anything', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const before = readdirSync(fixture.release).sort()
    const { ecdsa, root } = rotated(fixture, false)
    refusedWithoutWriting(fixture, before, await fixture.sign(undefined, { roots: [root.bytes], logEntryKeys: [{ keyDetails: ECDSA, key: ecdsa }] }), `signing refuses: the ${ECDSA} log-entry key ${entryKeyId(ecdsa)} is not a production key`)
  })

  it('refuses a root that lists none of the keys it holds, and roots that do not verify', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const before = readdirSync(fixture.release).sort()
    const ecdsa = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
    const onlyEcdsa = rootFile(fixture.keys, { logEntryKeys: [listedEntryKey(ECDSA, ecdsa)] })
    refusedWithoutWriting(fixture, before, await fixture.sign(undefined, { roots: [onlyEcdsa.bytes] }), 'signing refuses: root 1 lists neither a --log-entry-key nor the targets key as an active log-entry key')
    refusedWithoutWriting(fixture, before, await fixture.sign(undefined, { roots: [rootFile(fixture.keys, {}, [generateKeyPairSync('ed25519').privateKey]).bytes] }), 'signing refuses: the --root files do not verify')
  })
})

describe('signing checks the release branch', FIXTURE_TIMEOUT, () => {
  it('sign-release-refuses-commit-off-release-branch: refuses a release commit on a side branch, and signs once the release branch holds it', async (test) => {
    const fixture = await releaseFixture(test, { earlier: [{ version: '0.0.9' }] })
    expect(fixture.record().status).toBe(0)
    const before = readdirSync(fixture.release).sort()
    fixture.git(['branch', 'release', 'v0.0.9'])
    refusedWithoutWriting(fixture, before, await fixture.sign({}, { releaseBranch: 'release' }), `signing refuses: the release commit ${fixture.commit} is not on the release branch release`)
    refusedWithoutWriting(fixture, before, await fixture.sign({}, { releaseBranch: 'origin/main' }), 'signing refuses: the release branch origin/main names no commit')
    refusedWithoutWriting(fixture, before, await fixture.sign({}, { releaseBranch: '--all' }), 'signing refuses: the release branch "--all" is not a branch name')
    fixture.git(['branch', '-f', 'release', fixture.commit])
    const signed = await fixture.sign({}, { releaseBranch: 'release' })
    expect(signed.stderr).toBe('')
    expect(signed.status).toBe(0)
  })
})

describe('signing checks the install scripts', FIXTURE_TIMEOUT, () => {
  it('sign-release-refuses-install-script: refuses an install.sh or install.ps1 that is not a zero-length placeholder', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const before = readdirSync(fixture.release).sort()
    for (const [key, name] of [['sh', 'install.sh'], ['ps1', 'install.ps1']] as const) {
      const original = readFileSync(join(fixture.release, 'manifest-draft.json'))
      const script = Buffer.from('echo installing\n')
      writeFileSync(join(fixture.release, name), script)
      editDraft(fixture, (draft) => { draft.install[key] = { name, length: script.byteLength, sha256: createHash('sha256').update(script).digest('hex') } })
      refusedWithoutWriting(fixture, before, await fixture.sign(), `signing refuses: the draft's ${name} is ${name} of ${String(script.byteLength)} bytes, but ${INSTALL_SCRIPT_REFUSAL}`)
      writeFileSync(join(fixture.release, name), '')
      writeFileSync(join(fixture.release, 'manifest-draft.json'), original)
    }
  })
})

describe('signing checks the npm packages', FIXTURE_TIMEOUT, () => {
  it('sign-release-refuses-npm-integrity-mismatch: refuses a packed tarball whose bytes are not the draft\'s integrity, one with another name or version, and a missing one', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const before = readdirSync(fixture.release).sort()
    const tarballName = npmTarballName('delorun', VERSION)
    const path = join(fixture.release, tarballName)
    const other = await packedPackage('delorun', '0.1.1')
    writeFileSync(path, other)
    const listed = (JSON.parse(readFileSync(join(fixture.release, 'manifest-draft.json'), 'utf8')) as { npm: Array<{ integrity: string }> }).npm[0]!.integrity
    refusedWithoutWriting(fixture, before, await fixture.sign(), `signing refuses: the packed tarball ${tarballName} has the integrity ${npmIntegrity(other)}, not the ${listed} the draft lists for delorun@${VERSION}`)
    editDraft(fixture, (draft) => { draft.npm[0]!.integrity = npmIntegrity(other) })
    refusedWithoutWriting(fixture, before, await fixture.sign(), `signing refuses: the packed tarball ${tarballName} holds the package "delorun" at version "0.1.1", not delorun@${VERSION}`)
    const renamed = await packedPackage('delorun-evil', VERSION)
    writeFileSync(path, renamed)
    editDraft(fixture, (draft) => { draft.npm[0]!.integrity = npmIntegrity(renamed) })
    refusedWithoutWriting(fixture, before, await fixture.sign(), `holds the package "delorun-evil" at version "${VERSION}"`)
    rmSync(path)
    refusedWithoutWriting(fixture, before.filter(name => name !== tarballName), await fixture.sign(), `signing refuses: the draft lists the npm package delorun@${VERSION}, but its packed tarball ${tarballName} does not read`)
    editDraft(fixture, (draft) => { draft.npm[0]!.name = '../delorun' })
    refusedWithoutWriting(fixture, before.filter(name => name !== tarballName), await fixture.sign(), 'signing refuses: the draft\'s npm package name "../delorun" is not an npm package name')
  })
})

describe('reading a packed npm package', () => {
  it('names a tarball as npm pack does, and reads the package.json of a tarball npm pack wrote', (test) => {
    expect(npmTarballName('delorun', '0.1.0')).toBe('delorun-0.1.0.tgz')
    expect(npmTarballName('@delorun/create', '0.1.0')).toBe('delorun-create-0.1.0.tgz')
    const directory = scratch(test)
    const stage = join(directory, 'package')
    mkdirSync(join(stage, 'dist'), { recursive: true })
    writeFileSync(join(stage, 'package.json'), `${JSON.stringify({ name: 'delorun', version: '0.1.0', bin: { delorun: 'dist/bin.js' } })}\n`)
    writeFileSync(join(stage, 'dist', 'bin.js'), '#!/usr/bin/env node\n')
    const packed = spawnSync('npm', ['pack', '--pack-destination', directory, '--silent', '--ignore-scripts'], { cwd: stage, encoding: 'utf8', timeout: 60_000 })
    expect(packed.status, packed.stderr).toBe(0)
    const manifest = JSON.parse(packedManifest(readFileSync(join(directory, 'delorun-0.1.0.tgz'))).toString('utf8')) as { name: string, version: string }
    expect(manifest).toMatchObject({ name: 'delorun', version: '0.1.0' })
  })

  it('refuses a tarball with two package.json files, none, a link, or a broken header', async () => {
    const tarball = async (paths: readonly string[]): Promise<Buffer> => {
      const chunks: Buffer[] = []
      for await (const chunk of tarStream(paths.map(path => ({ path, mode: '0644' as const, data: Buffer.from('{}') })), 0)) chunks.push(chunk)
      return Buffer.concat(chunks)
    }
    /** Change the header at an offset and write its checksum again. */
    const rewrite = (tar: Buffer, offset: number, edit: (header: Buffer) => void): void => {
      const header = tar.subarray(offset, offset + 512)
      edit(header)
      header.fill(0x20, 148, 156)
      const sum = header.reduce((total, byte) => total + byte, 0)
      header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
    }
    const none = await tarball(['package/a.json'])
    expect(() => packedManifest(gzipSync(none))).toThrow('holds 0 package/package.json files, not one')
    const twice = await tarball(['package/a.json', 'package/package.json'])
    rewrite(twice, 0, (header) => { header.fill(0, 0, 100).write('package/package.json', 0, 'utf8') })
    expect(() => packedManifest(gzipSync(twice))).toThrow('holds 2 package/package.json files, not one')
    const link = await tarball(['package/package.json'])
    link[156] = '2'.charCodeAt(0)
    expect(() => packedManifest(gzipSync(link))).toThrow('a tar header checksum does not match')
    rewrite(link, 0, () => undefined)
    expect(() => packedManifest(gzipSync(link))).toThrow('has type "2", which a packed package does not hold')
    expect(() => packedManifest(gzipSync(Buffer.alloc(100)))).toThrow('ends inside a header')
  })
})
