/**
 * The signing command's refusals (contract C2's `c02-signing-refuses-without-rebuild`, `c02-signing-refuses-ci-rebuild`
 * and `c02-rebuild-difference-blocks-signing`, with the record origin, comparison coverage, recipe and draft
 * refusals around them) and a signing that passes them, whose manifest and file lists verify with the targets key.
 * Every key is a throwaway key generated in the test.
 */
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from '@delorun/release-formats/brands'
import { buildPackArchive } from '@delorun/release-formats/packs/archive'
import { logEntryName, verifyBundle } from '@delorun/release-formats/log/bundle'
import { readEntryRequest } from '@delorun/release-formats/log/entry'
import { attestationText } from '../../src/rebuild/attestation.ts'
import { outputRefs, REQUIRED_SOURCE } from '../../src/rebuild/record.ts'
import { LogStandIn, WitnessStandIn } from '../log/standin.ts'
import { checkFileRef, verifyFileList, verifySignedManifest } from '@delorun/release-formats/sign/verify'
import { writeTree } from '../support.ts'
import { DESKTOP_PLATFORMS } from '@delorun/contract-release-manifest'
import { COMMITTED_BASE_DIGEST, COMMITTED_COMPILER, PLATFORMS, RELEASE_BRANCH, releaseFixture, rootFile, VERSION, type ReleaseFixture } from './fixture.ts'

const MANIFEST = `delorun-${VERSION}.manifest.json`
const RECORD = `delorun-${VERSION}.rebuild.json`

/**
 * Write the fixture's root file beside its release directory, as `--root` takes it.
 * @param fixture - the fixture.
 * @returns the root file's path.
 */
function rootPath(fixture: ReleaseFixture): string {
  const path = join(fixture.release, '..', 'root.json')
  writeFileSync(path, rootFile(fixture.keys).bytes)
  return path
}

function refusal(stderr: string): void {
  expect(stderr).toContain(REQUIRED_SOURCE)
}

function editRecord(fixture: ReleaseFixture, edit: (record: Record<string, unknown>) => Record<string, unknown>): void {
  writeFileSync(fixture.recordPath, `${JSON.stringify(edit(JSON.parse(readFileSync(fixture.recordPath, 'utf8')) as Record<string, unknown>), undefined, 2)}\n`)
}

function editDraft(fixture: ReleaseFixture, edit: (draft: { runtime: Record<string, { archive: { name: string }, files: { name: string } }>, install: { sh: { name: string } } }) => void): void {
  const path = join(fixture.release, 'manifest-draft.json')
  const draft = JSON.parse(readFileSync(path, 'utf8')) as Parameters<typeof edit>[0]
  edit(draft)
  writeFileSync(path, `${JSON.stringify(draft, undefined, 2)}\n`)
}

function editDraftFields(fixture: ReleaseFixture, edit: (draft: Record<string, unknown>) => void): void {
  const path = join(fixture.release, 'manifest-draft.json')
  const draft = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  edit(draft)
  writeFileSync(path, `${JSON.stringify(draft, undefined, 2)}\n`)
}

function refusedWithoutWriting(fixture: ReleaseFixture, result: { status: number | null, stderr: string }, message: string): void {
  expect(result.stderr).toContain(message)
  expect(result.status).toBe(1)
  expect(existsSync(join(fixture.release, MANIFEST))).toBe(false)
}

/** Each case builds fixture releases or runs a command as a child process, which a loaded host slows. */
const CHILD_PROCESS_TIMEOUT = { timeout: 60_000 }

describe('sign-release', CHILD_PROCESS_TIMEOUT, () => {
  it('signs a release whose rebuild matches, and the manifest and file lists verify with the targets key', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const result = await fixture.sign()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const root = rootFile(fixture.keys).metadata
    const manifest = verifySignedManifest(root, readFileSync(join(fixture.release, MANIFEST)))
    expect(manifest.rebuild.builders).toEqual([{ name: 'fixture-holder', ci: false }])
    expect(manifest.source.commit).toBe(fixture.commit)
    expect(manifest).toMatchObject({ security: false, summary: 'The fixture release.' })
    expect(manifest.rebuild.record.name).toBe(RECORD)
    expect(() => checkFileRef(manifest.rebuild.record, readFileSync(join(fixture.release, RECORD)))).not.toThrow()
    expect(readFileSync(join(fixture.release, RECORD))).toEqual(readFileSync(fixture.recordPath))
    expect((JSON.parse(readFileSync(fixture.recordPath, 'utf8')) as { toolchain: { compiler: string } }).toolchain.compiler).toBe(COMMITTED_COMPILER)
    expect(Object.keys(manifest.runtime)).toEqual([...PLATFORMS])
    for (const platform of PLATFORMS) {
      verifyFileList(root, manifest, platform, readFileSync(join(fixture.release, manifest.runtime[platform]!.files.name)))
      checkFileRef(manifest.runtime[platform]!.archive, readFileSync(join(fixture.release, manifest.runtime[platform]!.archive.name)))
    }
    expect(() => verifyFileList(root, manifest, 'darwin-arm64', Buffer.from('{}'))).toThrow(`release ${VERSION} publishes no runtime for darwin-arm64: the platform is not in this release`)
  })

  it('refuses without a rebuild record, naming the required source, and writes nothing', async (test) => {
    const fixture = await releaseFixture(test)
    const result = await fixture.sign()
    refusal(result.stderr)
    expect(result.stderr).toContain(`no rebuild record exists at ${fixture.recordPath}`)
    expect(result.status).toBe(1)
    expect(existsSync(join(fixture.release, MANIFEST))).toBe(false)
  })

  it('refuses a record that says it was made in CI', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    writeFileSync(fixture.recordPath, readFileSync(fixture.recordPath, 'utf8').replace('"ci": false', '"ci": true'))
    const result = await fixture.sign()
    refusal(result.stderr)
    expect(result.stderr).toContain('says it was made in CI')
    expect(result.status).toBe(1)
  })

  it('refuses to sign, and to record, with GITHUB_ACTIONS or CI set', async (test) => {
    const fixture = await releaseFixture(test)
    const recorded = fixture.run('record-rebuild.ts', ['--version', VERSION, '--release', fixture.release, '--rebuild', fixture.rebuild, '--record', fixture.recordPath, '--builder', 'ci', '--compared-with', 'run'], { CI: 'true' })
    expect(recorded.status).toBe(2)
    refusal(recorded.stderr)
    expect(fixture.record().status).toBe(0)
    const result = await fixture.sign({ GITHUB_ACTIONS: 'true' })
    refusal(result.stderr)
    expect(result.stderr).toContain('GITHUB_ACTIONS is set')
    expect(result.status).toBe(1)
  })

  it('refuses when the local rebuild output does not reproduce the record\'s digests', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    writeFileSync(join(fixture.rebuild, `delorun-${VERSION}-linux-x64.files.json`), '{}\n')
    const result = await fixture.sign()
    refusal(result.stderr)
    expect(result.stderr).toContain('do not reproduce the digests the rebuild record lists')
    expect(result.status).toBe(1)
  })

  it('refuses when the rebuild output directory is not on this machine', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    rmSync(fixture.rebuild, { recursive: true })
    const result = await fixture.sign()
    refusal(result.stderr)
    expect(result.stderr).toContain('is not a directory on this machine')
  })

  it('refuses when the record\'s commit is not the commit the tag names', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    writeFileSync(fixture.recordPath, readFileSync(fixture.recordPath, 'utf8').replace(fixture.commit, 'f'.repeat(40)))
    const result = await fixture.sign()
    refusal(result.stderr)
    expect(result.stderr).toMatch(/commit f{40} differs/u)
  })

  it('records a difference and refuses to sign when the workflow output and the rebuild differ', async (test) => {
    const fixture = await releaseFixture(test)
    const stage = join(fixture.rebuild, '..', 'stage-holder-linux-x64')
    writeTree(stage, { 'app/lib/bin.js': '// changed in the rebuild\n' })
    rmSync(join(fixture.rebuild, `delorun-${VERSION}-linux-x64.tar.gz`))
    rmSync(join(fixture.rebuild, `delorun-${VERSION}-linux-x64.files.json`))
    const { archiveClosure } = await import('../../src/closure/archive-closure.ts')
    await archiveClosure({ stage, outDir: fixture.rebuild, version: VERSION, platform: 'linux-x64', epoch: 1_793_981_656, pins: undefined })
    writeFileSync(fixture.attestationPath, attestationText(fixture.attestationKey, { version: VERSION, commit: fixture.commit, outputs: await outputRefs(fixture.rebuild) }))
    const recorded = fixture.record()
    expect(recorded.stdout).toContain('differs: delorun-0.1.0-linux-x64.tar.gz: app/lib/bin.js: content differs')
    expect(recorded.status).toBe(1)
    const result = await fixture.sign()
    refusal(result.stderr)
    expect(result.stderr).toContain('comparison found a difference')
    writeFileSync(fixture.recordPath, readFileSync(fixture.recordPath, 'utf8').replace('"comparison": "difference"', '"comparison": "match"'))
    const forged = await fixture.sign()
    refusal(forged.stderr)
    expect(forged.stderr).toContain('compare-rebuild finds')
    expect(forged.status).toBe(1)
    expect(existsSync(join(fixture.release, MANIFEST))).toBe(false)
  })

  it('refuses a release directory that holds a rebuild record, and a record or rebuild output inside the release directory', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    copyFileSync(fixture.recordPath, join(fixture.release, RECORD))
    const carried = await fixture.sign()
    refusal(carried.stderr)
    refusedWithoutWriting(fixture, carried, `the release workflow's files hold ${RECORD}; the rebuild record comes from the holder's own rebuild (--record)`)
    rmSync(join(fixture.release, RECORD))
    copyFileSync(fixture.recordPath, join(fixture.release, 'holder.json'))
    refusedWithoutWriting(fixture, await fixture.sign({}, { record: join(fixture.release, 'holder.json') }), 'lies in the release directory')
    rmSync(join(fixture.release, 'holder.json'))
    refusedWithoutWriting(fixture, await fixture.sign({}, { rebuild: fixture.release }), 'is the release directory or inside it')
    const inside = join(fixture.release, 'rebuild')
    renameSync(fixture.rebuild, inside)
    refusedWithoutWriting(fixture, await fixture.sign({}, { rebuild: inside }), 'is the release directory or inside it')
  })

  it('refuses a draft that names another file, or another platform\'s file, as a platform\'s runtime', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    copyFileSync(join(fixture.release, `delorun-${VERSION}-linux-x64.tar.gz`), join(fixture.release, 'evil.tar.gz'))
    editDraft(fixture, (draft) => { draft.runtime['linux-x64']!.archive.name = 'evil.tar.gz' })
    refusedWithoutWriting(fixture, await fixture.sign(), `the draft names evil.tar.gz and delorun-${VERSION}-linux-x64.files.json for linux-x64; a release's linux-x64 runtime is delorun-${VERSION}-linux-x64.tar.gz`)
    editDraft(fixture, (draft) => {
      const [x64, arm64] = [draft.runtime['linux-x64']!, draft.runtime['linux-arm64']!]
      draft.runtime['linux-x64'] = arm64
      draft.runtime['linux-arm64'] = x64
    })
    refusedWithoutWriting(fixture, await fixture.sign(), `the draft names delorun-${VERSION}-linux-arm64.tar.gz and delorun-${VERSION}-linux-arm64.files.json for linux-x64`)
  })

  it('refuses a draft whose source names the private archive repository', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    editDraftFields(fixture, (draft) => {
      draft.source = { repository: 'https://github.com/twickas/delo', tag: `v${VERSION}`, commit: 'c'.repeat(40) }
    })
    refusedWithoutWriting(fixture, await fixture.sign(), `signing refuses: the draft's source must be https://github.com/twickas/delorun at tag v${VERSION}`)
  })

  it('refuses a draft whose runtime platforms are not exactly the release platforms committed at the release', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    editDraft(fixture, (draft) => {
      draft.runtime['darwin-arm64'] = { archive: { ...draft.runtime['linux-x64']!.archive, name: `delorun-${VERSION}-darwin-arm64.tar.gz` }, files: { ...draft.runtime['linux-x64']!.files, name: `delorun-${VERSION}-darwin-arm64.files.json` } }
    })
    refusedWithoutWriting(fixture, await fixture.sign(), `signing refuses: the draft publishes a runtime for linux-x64, linux-arm64, darwin-arm64, but the release platforms closure.json lists at ${fixture.commit} are ${PLATFORMS.join(', ')}`)
    editDraft(fixture, (draft) => {
      delete draft.runtime['darwin-arm64']
      delete draft.runtime['linux-arm64']
    })
    refusedWithoutWriting(fixture, await fixture.sign(), `signing refuses: the draft publishes a runtime for linux-x64, but the release platforms`)
  })

  it('refuses a rebuild that lacks a platform, and a record of no outputs over an empty rebuild', async (test) => {
    const fixture = await releaseFixture(test)
    const archive = join(fixture.rebuild, `delorun-${VERSION}-linux-arm64.tar.gz`)
    const aside = join(fixture.rebuild, '..', 'aside.tar.gz')
    renameSync(archive, aside)
    const partial = fixture.record()
    expect(partial.stderr).toContain(`lacks delorun-${VERSION}-linux-arm64.tar.gz; rebuild every release platform's runtime`)
    expect(partial.status).toBe(2)
    renameSync(aside, archive)
    expect(fixture.record().status).toBe(0)
    rmSync(archive)
    editRecord(fixture, record => ({ ...record, outputs: (record.outputs as Array<{ name: string }>).filter(output => !output.name.endsWith('linux-arm64.tar.gz')) }))
    refusedWithoutWriting(fixture, await fixture.sign(), `the rebuild output lacks delorun-${VERSION}-linux-arm64.tar.gz; the comparison covers every release platform's runtime archive and file list`)
    const empty = join(fixture.rebuild, '..', 'empty')
    mkdirSync(empty)
    editRecord(fixture, record => ({ ...record, outputs: [] }))
    const result = await fixture.sign({}, { rebuild: empty })
    refusal(result.stderr)
    refusedWithoutWriting(fixture, result, `the rebuild output lacks delorun-${VERSION}-linux-x64.tar.gz, delorun-${VERSION}-linux-x64.files.json`)
  })

  it('refuses a record whose recipe digest or toolchain is not the recipe committed at the release', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const original = readFileSync(fixture.recordPath, 'utf8')
    editRecord(fixture, record => ({ ...record, recipe: '0'.repeat(64) }))
    refusedWithoutWriting(fixture, await fixture.sign(), `the rebuild record's recipe digest is not the recipe at ${fixture.commit}`)
    for (const field of ['node', 'pnpm', 'compiler', 'linker']) {
      writeFileSync(fixture.recordPath, original)
      editRecord(fixture, record => ({ ...record, toolchain: { ...(record.toolchain as Record<string, string>), [field]: 'other' } }))
      refusedWithoutWriting(fixture, await fixture.sign(), `is not the toolchain pinned at ${fixture.commit}`)
    }
  })

  it('refuses a release file whose bytes differ from the draft\'s reference', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const installer = `Delorun-${VERSION}-${DESKTOP_PLATFORMS[0]}.installer`
    writeFileSync(join(fixture.release, installer), readFileSync(join(fixture.release, installer), 'utf8').toUpperCase())
    refusedWithoutWriting(fixture, await fixture.sign(), `${installer} does not match desktop.${DESKTOP_PLATFORMS[0]}.installer in the draft`)
  })

  it('refuses a draft whose notes are over the limit or hold a bidirectional override, and signs valid notes into the manifest', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const name = `delorun-${VERSION}.notes.txt`
    const notesPath = join(fixture.release, name)
    const draftNotes = (bytes: Buffer, length = bytes.byteLength) => {
      writeFileSync(notesPath, bytes)
      editDraftFields(fixture, (draft) => { draft.notes = { name, length, sha256: createHash('sha256').update(bytes).digest('hex') } })
    }
    const over = Buffer.alloc(65_537, 'a')
    draftNotes(over)
    refusedWithoutWriting(fixture, await fixture.sign(), 'the manifest draft manifest-draft.json does not read')
    draftNotes(Buffer.from('Fixed \u202Egnirts'))
    refusedWithoutWriting(fixture, await fixture.sign(), `${name} is not valid release notes`)
    const good = Buffer.from('Delorun 0.1.0\n\n- A change.\n')
    draftNotes(good)
    const signed = await fixture.sign()
    expect(signed.status, signed.stderr).toBe(0)
    expect(JSON.parse(readFileSync(join(fixture.release, MANIFEST), 'utf8')).signed.notes).toEqual({ name, length: good.byteLength, sha256: createHash('sha256').update(good).digest('hex') })
  })

  it('refuses without the rebuild attestation, or with one another key made or that covers another build', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const missing = await fixture.sign({}, { attestation: join(fixture.rebuild, '..', 'none.json') })
    refusal(missing.stderr)
    refusedWithoutWriting(fixture, missing, 'no rebuild attestation exists at')
    const outputs = await outputRefs(fixture.rebuild)
    const other = join(fixture.rebuild, '..', 'other.json')
    writeFileSync(other, attestationText(randomBytes(32), { version: VERSION, commit: fixture.commit, outputs }))
    refusedWithoutWriting(fixture, await fixture.sign({}, { attestation: other }), 'its HMAC does not verify with this machine\'s attestation key')
    writeFileSync(other, attestationText(fixture.attestationKey, { version: VERSION, commit: 'e'.repeat(40), outputs }))
    refusedWithoutWriting(fixture, await fixture.sign({}, { attestation: other }), `it attests ${VERSION} at ${'e'.repeat(40)}, not ${VERSION} at ${fixture.commit}`)
    writeFileSync(other, attestationText(fixture.attestationKey, { version: VERSION, commit: fixture.commit, outputs: outputs.slice(1) }))
    refusedWithoutWriting(fixture, await fixture.sign({}, { attestation: other }), 'it attests other output files than the rebuild directory holds')
    const forged = JSON.parse(readFileSync(fixture.attestationPath, 'utf8')) as { hmac: string }
    writeFileSync(other, JSON.stringify({ ...forged, hmac: '0'.repeat(64) }))
    refusedWithoutWriting(fixture, await fixture.sign({}, { attestation: other }), 'its HMAC does not verify')
    copyFileSync(fixture.attestationPath, join(fixture.rebuild, '..', 'release', 'attestation.json'))
    refusedWithoutWriting(fixture, await fixture.sign({}, { attestation: join(fixture.release, 'attestation.json') }), 'lies in the release or rebuild directory')
  })

  it('changes nothing in the release directory when writing a signed file fails', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const list = join(fixture.release, `delorun-${VERSION}-linux-x64.files.json`)
    const before = readFileSync(list)
    mkdirSync(join(fixture.release, `${MANIFEST}.signing`))
    const result = await fixture.sign()
    refusedWithoutWriting(fixture, result, 'writing the signed files failed, and nothing was changed')
    expect(readFileSync(list)).toEqual(before)
    expect(existsSync(join(fixture.release, RECORD))).toBe(false)
    expect(existsSync(`${list}.signing`)).toBe(false)
  })

  it('refuses when the dependency advisory check, run again, finds an advisory without an acceptance', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const result = await fixture.sign({}, { advisories: { 'example-parser': [{ id: 1, url: 'https://github.com/advisories/GHSA-2222-3333-4444', title: 'Parser reads past its buffer', severity: 'low', vulnerable_versions: '<2.0.0' }] } })
    expect(result.stderr).toContain('the dependency advisory check fails: GHSA-2222-3333-4444 (low) affects example-parser@1.2.3')
    expect(result.status).toBe(1)
    expect(existsSync(join(fixture.release, MANIFEST))).toBe(false)
  })

  it('refuses from the command line without a rebuild record, naming the required source', async (test) => {
    const fixture = await releaseFixture(test)
    const args = ['--release', fixture.release, '--rebuild', fixture.rebuild, '--record', fixture.recordPath, '--attestation', fixture.attestationPath, '--attestation-key', fixture.attestationKeyPath, '--key', fixture.keyPath, '--root', rootPath(fixture), '--release-branch', RELEASE_BRANCH]
    const result = fixture.run('sign-release.ts', args)
    refusal(result.stderr)
    expect(result.status).toBe(1)
    const stated = fixture.run('sign-release.ts', [...args, '--first-of-line'])
    refusal(stated.stderr)
    expect(stated.status).toBe(1)
  })

  it('reads the release branch origin/main by default from the command line, and takes no --allowed-signers', async (test) => {
    const fixture = await releaseFixture(test)
    const args = ['--release', fixture.release, '--rebuild', fixture.rebuild, '--record', fixture.recordPath, '--attestation', fixture.attestationPath, '--attestation-key', fixture.attestationKeyPath, '--key', fixture.keyPath, '--root', rootPath(fixture)]
    const branch = fixture.run('sign-release.ts', args)
    expect(branch.stderr).toContain('signing refuses: the release branch origin/main names no commit')
    expect(branch.status).toBe(1)
    const override = fixture.run('sign-release.ts', [...args, '--allowed-signers', join(fixture.repo, 'signers')])
    expect(override.stderr).toContain('--allowed-signers')
    expect(override.status).not.toBe(0)
    expect(existsSync(join(fixture.release, MANIFEST))).toBe(false)
  })

  it('refuses a rebuild without the SBOM, recording or signing', async (test) => {
    const fixture = await releaseFixture(test)
    const sbom = join(fixture.rebuild, `delorun-${VERSION}.spdx.json`)
    const aside = join(fixture.rebuild, '..', 'aside.spdx.json')
    renameSync(sbom, aside)
    const partial = fixture.record()
    expect(partial.stderr).toContain(`lacks delorun-${VERSION}.spdx.json; rebuild every release platform's runtime, the SBOM and the images`)
    expect(partial.status).toBe(2)
    renameSync(aside, sbom)
    expect(fixture.record().status).toBe(0)
    rmSync(sbom)
    editRecord(fixture, record => ({ ...record, outputs: (record.outputs as Array<{ name: string }>).filter(output => !output.name.endsWith('.spdx.json')) }))
    refusedWithoutWriting(fixture, await fixture.sign(), `the rebuild output lacks delorun-${VERSION}.spdx.json; the comparison covers every release platform's runtime archive and file list, the SBOM, the images file, the images' seccomp profiles and every pack the packs file names`)
  })

  it('requires the rebuild to reproduce every pack the release lists, byte for byte', async (test) => {
    const fixture = await releaseFixture(test)
    const built = await buildPackArchive(`delorun-${VERSION}-pack-demo.tar.gz`, [{ path: 'package.json', mode: '0644', data: Buffer.from('{}') }], 1_800_000_000)
    const draft = { schema: 'delorun.release-packs/1', version: VERSION, manifest: '0'.repeat(64), packs: [{ name: 'demo', version: '1.0.0', experimental: false, variants: { any: { ...built.variant, external: [], peers: [] } } }] }
    const packs = `${JSON.stringify({ signed: draft, signatures: [] }, undefined, 2)}\n`
    const archive = `delorun-${VERSION}-pack-demo.tar.gz`
    const file = `delorun-${VERSION}.packs.json`
    writeFileSync(join(fixture.release, file), packs)
    writeFileSync(join(fixture.release, archive), built.bytes)
    const lacking = fixture.record()
    expect(lacking.stderr).toContain(`lacks ${file}, ${archive}`)
    expect(lacking.status).toBe(2)
    writeFileSync(join(fixture.rebuild, file), packs)
    writeFileSync(join(fixture.rebuild, archive), Buffer.concat([built.bytes, Buffer.from('x')]))
    const differing = fixture.record()
    expect(differing.status).not.toBe(0)
    expect(differing.stdout + differing.stderr).toContain(archive)
    // A record of a difference is written, and signing refuses it; the holder rebuilds again.
    rmSync(fixture.recordPath)
    writeFileSync(join(fixture.rebuild, archive), built.bytes)
    const matching = fixture.record()
    expect(matching.stderr).toBe('')
    expect(matching.status).toBe(0)
  })

  it('refuses a draft that names another file as the SBOM', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    copyFileSync(join(fixture.release, `delorun-${VERSION}.spdx.json`), join(fixture.release, 'other.spdx.json'))
    const path = join(fixture.release, 'manifest-draft.json')
    const draft = JSON.parse(readFileSync(path, 'utf8')) as { sbom: { name: string } }
    draft.sbom.name = 'other.spdx.json'
    writeFileSync(path, JSON.stringify(draft))
    refusedWithoutWriting(fixture, await fixture.sign(), `the draft names other.spdx.json as the SBOM; a release's SBOM is delorun-${VERSION}.spdx.json`)
  })

  it('applies the advisory acceptances committed at the release, not an edit in the checkout', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    writeFileSync(join(fixture.repo, 'delorun/release/advisory-acceptances.yaml'), `acceptances:\n  - advisory: GHSA-2222-3333-4444\n    package: example-parser\n    range: '>=1.2.0 <1.2.5'\n    reason: An uncommitted acceptance that signing must not apply.\n    approver: example-maintainer\n    lapsesAfter: 0.3.0\n`)
    const result = await fixture.sign({}, { advisories: { 'example-parser': [{ id: 1, url: 'https://github.com/advisories/GHSA-2222-3333-4444', title: 'Parser reads past its buffer', severity: 'low', vulnerable_versions: '<2.0.0' }] } })
    refusedWithoutWriting(fixture, result, 'the dependency advisory check fails: GHSA-2222-3333-4444 (low) affects example-parser@1.2.3')
  })

  it('refuses a published advisory report that differs from the report signing\'s own check gives', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const path = join(fixture.release, `delorun-${VERSION}.advisories.json`)
    const report = JSON.parse(readFileSync(path, 'utf8')) as { packages: number }
    writeFileSync(path, `${JSON.stringify({ ...report, packages: report.packages + 1 }, undefined, 2)}\n`)
    const draftPath = join(fixture.release, 'manifest-draft.json')
    const draft = JSON.parse(readFileSync(draftPath, 'utf8')) as { advisories: { report: { length: number, sha256: string } } }
    const bytes = readFileSync(path)
    draft.advisories.report = { ...draft.advisories.report, length: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }
    writeFileSync(draftPath, JSON.stringify(draft))
    refusedWithoutWriting(fixture, await fixture.sign(), `the advisory report delorun-${VERSION}.advisories.json is not the report signing's own check gives`)
  })

  it('refuses a draft whose accepted advisories are not the ones the check accepts', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const draftPath = join(fixture.release, 'manifest-draft.json')
    const draft = JSON.parse(readFileSync(draftPath, 'utf8')) as { advisories: { accepted: string[] } }
    draft.advisories.accepted = ['GHSA-2222-3333-4444']
    writeFileSync(draftPath, JSON.stringify(draft))
    refusedWithoutWriting(fixture, await fixture.sign(), 'the draft\'s accepted advisories (GHSA-2222-3333-4444) are not the ones the check accepts (none)')
  })

  it('writes the manifest\'s log entry, which a witnessed checkpoint of the log stand-in includes and the client verifies', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    expect((await fixture.sign()).status).toBe(0)
    const log = new LogStandIn()
    const witness = new WitnessStandIn()
    const root = rootFile(fixture.keys, { log: { origin: log.origin, vkey: log.vkey }, witnesses: { keys: [{ name: witness.name, vkey: witness.vkey }], threshold: 1 } }).metadata
    const manifest = readFileSync(join(fixture.release, MANIFEST))
    const index = log.submit(readEntryRequest(readFileSync(join(fixture.release, logEntryName(VERSION)))))
    const bundle = log.bundle(index, { name: MANIFEST, sha256: sha256Hex(createHash('sha256').update(manifest).digest('hex')) }, witness.cosign(log.checkpoint(), 1_793_981_700))
    expect(verifyBundle(root, manifest, VERSION, bundle).treeSize).toBe(1)
  })

  it('refuses a rebuild without the images file, and a draft whose images are not the compared ones', async (test) => {
    const fixture = await releaseFixture(test)
    const images = join(fixture.rebuild, `delorun-${VERSION}.images.json`)
    const aside = join(fixture.rebuild, '..', 'aside.images.json')
    renameSync(images, aside)
    const partial = fixture.record()
    expect(partial.stderr).toContain(`lacks delorun-${VERSION}.images.json`)
    expect(partial.status).toBe(2)
    renameSync(aside, images)
    expect(fixture.record().status).toBe(0)
    const path = join(fixture.release, 'manifest-draft.json')
    const draft = JSON.parse(readFileSync(path, 'utf8')) as { images: { s3: { index: string } } }
    draft.images.s3.index = `sha256:${'c'.repeat(64)}`
    writeFileSync(path, JSON.stringify(draft))
    refusedWithoutWriting(fixture, await fixture.sign(), `the draft's images are not the images delorun-${VERSION}.images.json records`)
  })

  it('carries each image\'s seccomp profile into the manifest, by its release file', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    expect((await fixture.sign()).status).toBe(0)
    const manifest = JSON.parse(readFileSync(join(fixture.release, `delorun-${VERSION}.manifest.json`), 'utf8')) as { signed: { images: Record<'s2' | 's3', { seccomp: { name: string, length: number } }> } }
    const profile = readFileSync(join(import.meta.dirname, '../../images/seccomp.json'))
    for (const image of ['s2', 's3'] as const) {
      expect(manifest.signed.images[image].seccomp).toEqual({ name: `delorun-${VERSION}.${image}.seccomp.json`, length: profile.byteLength, sha256: createHash('sha256').update(profile).digest('hex') })
      expect(readFileSync(join(fixture.release, `delorun-${VERSION}.${image}.seccomp.json`)).equals(profile)).toBe(true)
    }
  })

  it('refuses a rebuild without a seccomp profile its images list, recording or signing', async (test) => {
    const fixture = await releaseFixture(test)
    const profile = join(fixture.rebuild, `delorun-${VERSION}.s3.seccomp.json`)
    const aside = join(fixture.rebuild, '..', 'aside.seccomp.json')
    renameSync(profile, aside)
    const partial = fixture.record()
    expect(partial.stderr).toContain(`lacks delorun-${VERSION}.s3.seccomp.json`)
    expect(partial.status).toBe(2)
    renameSync(aside, profile)
    expect(fixture.record().status).toBe(0)
    rmSync(profile)
    editRecord(fixture, record => ({ ...record, outputs: (record.outputs as Array<{ name: string }>).filter(output => !output.name.endsWith('.s3.seccomp.json')) }))
    refusedWithoutWriting(fixture, await fixture.sign(), `the rebuild output lacks delorun-${VERSION}.s3.seccomp.json`)
  })

  it('requires, compares and records the licence published beside each seccomp profile', async (test) => {
    const fixture = await releaseFixture(test)
    const licence = join(fixture.rebuild, `delorun-${VERSION}.s2.seccomp.LICENSE`)
    const aside = join(fixture.rebuild, '..', 'aside.LICENSE')
    renameSync(licence, aside)
    const partial = fixture.record()
    expect(partial.stderr).toContain(`lacks delorun-${VERSION}.s2.seccomp.LICENSE`)
    expect(partial.status).toBe(2)
    renameSync(aside, licence)
    writeFileSync(join(fixture.release, `delorun-${VERSION}.s3.seccomp.LICENSE`), 'another licence\n')
    const differing = fixture.record()
    expect(differing.stdout).toContain(`delorun-${VERSION}.s3.seccomp.LICENSE`)
    expect(JSON.parse(readFileSync(fixture.recordPath, 'utf8'))).toMatchObject({ comparison: 'difference' })
    copyFileSync(join(fixture.rebuild, `delorun-${VERSION}.s3.seccomp.LICENSE`), join(fixture.release, `delorun-${VERSION}.s3.seccomp.LICENSE`))
    rmSync(fixture.recordPath, { force: true })
    expect(fixture.record().status).toBe(0)
    expect((await fixture.sign()).status).toBe(0)
    const record = JSON.parse(readFileSync(join(fixture.release, `delorun-${VERSION}.rebuild.json`), 'utf8')) as { outputs: Array<{ name: string, sha256: string }> }
    const published = readFileSync(join(import.meta.dirname, '../../images/seccomp.LICENSE'))
    for (const image of ['s2', 's3']) {
      expect(record.outputs).toContainEqual(expect.objectContaining({ name: `delorun-${VERSION}.${image}.seccomp.LICENSE`, sha256: createHash('sha256').update(published).digest('hex') }))
    }
  })

  it('refuses a seccomp profile whose bytes are not the ones the draft lists, even when the rebuild has the same bytes', async (test) => {
    const fixture = await releaseFixture(test)
    for (const directory of [fixture.release, fixture.rebuild]) writeFileSync(join(directory, `delorun-${VERSION}.s2.seccomp.json`), '{"defaultAction":"SCMP_ACT_ALLOW"}\n')
    writeFileSync(fixture.attestationPath, attestationText(fixture.attestationKey, { version: VERSION, commit: fixture.commit, outputs: await outputRefs(fixture.rebuild) }))
    expect(fixture.record().status).toBe(0)
    refusedWithoutWriting(fixture, await fixture.sign(), `delorun-${VERSION}.s2.seccomp.json does not match images.s2.seccomp in the draft`)
  })

  it('describes the images in the SBOM with the base committed at the release', async (test) => {
    const fixture = await releaseFixture(test)
    expect(readFileSync(join(fixture.release, `delorun-${VERSION}.spdx.json`), 'utf8')).toContain(COMMITTED_BASE_DIGEST)
    expect(fixture.record().status).toBe(0)
    expect((await fixture.sign()).status).toBe(0)
  })

  it('c02-draft-without-notice-fields-refused: signing refuses a draft without security or without summary', async (test) => {
    const fixture = await releaseFixture(test)
    for (const field of ['security', 'summary']) {
      const path = join(fixture.release, 'manifest-draft.json')
      const original = readFileSync(path)
      editDraftFields(fixture, (draft) => { delete draft[field] })
      refusedWithoutWriting(fixture, await fixture.sign(), 'the manifest draft manifest-draft.json does not read')
      writeFileSync(path, original)
    }
  })

  it('c02-summary-control-characters-refused: signing refuses a draft whose summary holds an escape, a newline or a right-to-left override', async (test) => {
    const fixture = await releaseFixture(test)
    for (const summary of ['Fixes \u001b[31mred\u001b[0m text', 'Two\nlines', 'Fixes ‮evil.exe']) {
      editDraftFields(fixture, (draft) => { draft.summary = summary })
      refusedWithoutWriting(fixture, await fixture.sign(), 'a release summary: 1 to 200 characters')
    }
  })

  it('c02-summary-too-long-refused: signing refuses a draft whose summary is longer than 200 characters', async (test) => {
    const fixture = await releaseFixture(test)
    editDraftFields(fixture, (draft) => { draft.summary = 'x'.repeat(201) })
    refusedWithoutWriting(fixture, await fixture.sign(), 'a release summary: 1 to 200 characters')
  })

  it('c02-draft-unknown-platform-refused: signing refuses a draft whose runtime names a misspelt platform, instead of signing it without that platform', async (test) => {
    const fixture = await releaseFixture(test)
    editDraftFields(fixture, (draft) => {
      const runtime = draft.runtime as Record<string, unknown>
      runtime['linux-x65'] = runtime['linux-x64']
    })
    refusedWithoutWriting(fixture, await fixture.sign(), 'the manifest draft manifest-draft.json does not read')
  })

  it('c02-security-not-boolean-refused: signing refuses a draft whose security is not a boolean', async (test) => {
    const fixture = await releaseFixture(test)
    editDraftFields(fixture, (draft) => { draft.security = 'true' })
    refusedWithoutWriting(fixture, await fixture.sign(), 'the manifest draft manifest-draft.json does not read')
  })

  it('patch-rule-allows-equal-patch: a security-fix patch with the earlier release\'s base, formats and interface signs, and the manifest carries the marker', async (test) => {
    const fixture = await releaseFixture(test, { version: '0.1.1', earlier: [{ version: '0.1.0' }] })
    editDraftFields(fixture, (draft) => { Object.assign(draft, { security: true, summary: 'Fixes a crash when a workspace path holds a newline.' }) })
    expect(fixture.record().status).toBe(0)
    const result = await fixture.sign()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const manifest = verifySignedManifest(rootFile(fixture.keys).metadata, readFileSync(join(fixture.release, 'delorun-0.1.1.manifest.json')))
    expect(manifest).toMatchObject({ version: '0.1.1', security: true, summary: 'Fixes a crash when a workspace path holds a newline.' })
  })

  it('patch-rule-skips-new-minor: the first release of a minor signs on a moved upstream base', async (test) => {
    const fixture = await releaseFixture(test, { version: '0.2.0', earlier: [{ version: '0.1.0', dsh: '0.2.1' }, { version: '0.1.1', dsh: '0.2.1' }] })
    expect(fixture.record().status).toBe(0)
    const result = await fixture.sign()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('patch-rule-refuses-patch-without-earlier-release: signing refuses a patch version with no earlier release of its line, and signs it as the first of the line when the holder says so', async (test) => {
    const fixture = await releaseFixture(test, { version: '0.1.3' })
    expect(fixture.record().status).toBe(0)
    const refused = await fixture.sign()
    expect(refused.stderr).toContain('signing refuses: release 0.1.3 is a patch version, but no earlier release of 0.1 is tagged here')
    expect(refused.stderr).toContain('sign with --first-of-line')
    expect(refused.status).toBe(1)
    expect(existsSync(join(fixture.release, 'delorun-0.1.3.manifest.json'))).toBe(false)
    const signed = await fixture.sign({}, { firstOfLine: true })
    expect(signed.stderr).toBe('')
    expect(signed.status).toBe(0)
  })

  it('refuses a patch the patch rule refuses before writing any file', async (test) => {
    const fixture = await releaseFixture(test, { version: '0.1.1', earlier: [{ version: '0.1.0', dsh: '0.2.1' }] })
    expect(fixture.record().status).toBe(0)
    const before = readdirSync(fixture.release).sort()
    const result = await fixture.sign()
    expect(result.stderr).toBe('signing refuses: release 0.1.1 is a patch of 0.1.0 and moves DSH from 0.2.1 to 0.2.2-rc.1; a release that moves the upstream base is at least a minor: release it as 0.2.0')
    expect(result.status).toBe(1)
    expect(readdirSync(fixture.release).sort()).toEqual(before)
  })

  it('patch-rule-refuses-draft-base-mismatch: signing refuses a draft whose dsh is not the app-boot version at the release commit', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    editDraftFields(fixture, (draft) => { draft.dsh = '0.2.3' })
    refusedWithoutWriting(fixture, await fixture.sign(), `the draft's dsh 0.2.3 is not 0.2.2-rc.1, the upstream version packages/boot/app-boot/package.json names at the release commit ${fixture.commit}; draft the release with dsh 0.2.2-rc.1`)
  })
})
