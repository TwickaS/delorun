/**
 * The signing command's refusals (contract C2's `c02-signing-refuses-without-rebuild`, `c02-signing-refuses-ci-rebuild`
 * and `c02-rebuild-difference-blocks-signing`, with the record origin, comparison coverage, recipe and draft
 * refusals around them) and a signing that passes them, whose manifest and file lists verify with the targets key.
 * Every key is a throwaway key generated in the test.
 */
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RUNTIME_PLATFORMS } from '@delo/contract-release-manifest'
import { attestationText } from '../../src/rebuild/attestation.ts'
import { outputRefs, REQUIRED_SOURCE } from '../../src/rebuild/record.ts'
import { checkFileRef, verifyFileList, verifySignedManifest } from '../../src/sign/verify.ts'
import { writeTree } from '../support.ts'
import { COMMITTED_COMPILER, releaseFixture, rootFile, VERSION, type ReleaseFixture } from './fixture.ts'

const MANIFEST = `delorun-${VERSION}.manifest.json`
const RECORD = `delorun-${VERSION}.rebuild.json`

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
    const result = fixture.sign()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const root = rootFile(fixture.keys).metadata
    const manifest = verifySignedManifest(root, readFileSync(join(fixture.release, MANIFEST)))
    expect(manifest.rebuild.builders).toEqual([{ name: 'fixture-holder', ci: false }])
    expect(manifest.source.commit).toBe(fixture.commit)
    expect(manifest.rebuild.record.name).toBe(RECORD)
    expect(() => checkFileRef(manifest.rebuild.record, readFileSync(join(fixture.release, RECORD)))).not.toThrow()
    expect(readFileSync(join(fixture.release, RECORD))).toEqual(readFileSync(fixture.recordPath))
    expect((JSON.parse(readFileSync(fixture.recordPath, 'utf8')) as { toolchain: { compiler: string } }).toolchain.compiler).toBe(COMMITTED_COMPILER)
    for (const platform of RUNTIME_PLATFORMS) {
      verifyFileList(root, manifest, platform, readFileSync(join(fixture.release, manifest.runtime[platform].files.name)))
      checkFileRef(manifest.runtime[platform].archive, readFileSync(join(fixture.release, manifest.runtime[platform].archive.name)))
    }
  })

  it('refuses without a rebuild record, naming the required source, and writes nothing', async (test) => {
    const fixture = await releaseFixture(test)
    const result = fixture.sign()
    refusal(result.stderr)
    expect(result.stderr).toContain(`no rebuild record exists at ${fixture.recordPath}`)
    expect(result.status).toBe(1)
    expect(existsSync(join(fixture.release, MANIFEST))).toBe(false)
  })

  it('refuses a record that says it was made in CI', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    writeFileSync(fixture.recordPath, readFileSync(fixture.recordPath, 'utf8').replace('"ci": false', '"ci": true'))
    const result = fixture.sign()
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
    const result = fixture.sign({ GITHUB_ACTIONS: 'true' })
    refusal(result.stderr)
    expect(result.stderr).toContain('GITHUB_ACTIONS is set')
    expect(result.status).toBe(1)
  })

  it('refuses when the local rebuild output does not reproduce the record\'s digests', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    writeFileSync(join(fixture.rebuild, `delorun-${VERSION}-linux-x64.files.json`), '{}\n')
    const result = fixture.sign()
    refusal(result.stderr)
    expect(result.stderr).toContain('do not reproduce the digests the rebuild record lists')
    expect(result.status).toBe(1)
  })

  it('refuses when the rebuild output directory is not on this machine', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    rmSync(fixture.rebuild, { recursive: true })
    const result = fixture.sign()
    refusal(result.stderr)
    expect(result.stderr).toContain('is not a directory on this machine')
  })

  it('refuses when the record\'s commit is not the commit the tag names', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    writeFileSync(fixture.recordPath, readFileSync(fixture.recordPath, 'utf8').replace(fixture.commit, 'f'.repeat(40)))
    const result = fixture.sign()
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
    const result = fixture.sign()
    refusal(result.stderr)
    expect(result.stderr).toContain('comparison found a difference')
    writeFileSync(fixture.recordPath, readFileSync(fixture.recordPath, 'utf8').replace('"comparison": "difference"', '"comparison": "match"'))
    const forged = fixture.sign()
    refusal(forged.stderr)
    expect(forged.stderr).toContain('compare-rebuild finds')
    expect(forged.status).toBe(1)
    expect(existsSync(join(fixture.release, MANIFEST))).toBe(false)
  })

  it('refuses a release directory that holds a rebuild record, and a record or rebuild output inside the release directory', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    copyFileSync(fixture.recordPath, join(fixture.release, RECORD))
    const carried = fixture.sign()
    refusal(carried.stderr)
    refusedWithoutWriting(fixture, carried, `the release workflow's files hold ${RECORD}; the rebuild record comes from the holder's own rebuild (--record)`)
    rmSync(join(fixture.release, RECORD))
    copyFileSync(fixture.recordPath, join(fixture.release, 'holder.json'))
    refusedWithoutWriting(fixture, fixture.sign({}, { record: join(fixture.release, 'holder.json') }), 'lies in the release directory')
    rmSync(join(fixture.release, 'holder.json'))
    refusedWithoutWriting(fixture, fixture.sign({}, { rebuild: fixture.release }), 'is the release directory or inside it')
    const inside = join(fixture.release, 'rebuild')
    renameSync(fixture.rebuild, inside)
    refusedWithoutWriting(fixture, fixture.sign({}, { rebuild: inside }), 'is the release directory or inside it')
  })

  it('refuses a draft that names another file, or another platform\'s file, as a platform\'s runtime', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    copyFileSync(join(fixture.release, `delorun-${VERSION}-linux-x64.tar.gz`), join(fixture.release, 'evil.tar.gz'))
    editDraft(fixture, (draft) => { draft.runtime['linux-x64']!.archive.name = 'evil.tar.gz' })
    refusedWithoutWriting(fixture, fixture.sign(), `the draft names evil.tar.gz and delorun-${VERSION}-linux-x64.files.json for linux-x64; a release's linux-x64 runtime is delorun-${VERSION}-linux-x64.tar.gz`)
    editDraft(fixture, (draft) => {
      const [x64, arm64] = [draft.runtime['linux-x64']!, draft.runtime['linux-arm64']!]
      draft.runtime['linux-x64'] = arm64
      draft.runtime['linux-arm64'] = x64
    })
    refusedWithoutWriting(fixture, fixture.sign(), `the draft names delorun-${VERSION}-linux-arm64.tar.gz and delorun-${VERSION}-linux-arm64.files.json for linux-x64`)
  })

  it('refuses a rebuild that lacks a platform, and a record of no outputs over an empty rebuild', async (test) => {
    const fixture = await releaseFixture(test)
    const archive = join(fixture.rebuild, `delorun-${VERSION}-linux-arm64.tar.gz`)
    const aside = join(fixture.rebuild, '..', 'aside.tar.gz')
    renameSync(archive, aside)
    const partial = fixture.record()
    expect(partial.stderr).toContain(`lacks delorun-${VERSION}-linux-arm64.tar.gz; rebuild every platform's runtime`)
    expect(partial.status).toBe(2)
    renameSync(aside, archive)
    expect(fixture.record().status).toBe(0)
    rmSync(archive)
    editRecord(fixture, record => ({ ...record, outputs: (record.outputs as Array<{ name: string }>).filter(output => !output.name.endsWith('linux-arm64.tar.gz')) }))
    refusedWithoutWriting(fixture, fixture.sign(), `the rebuild output lacks delorun-${VERSION}-linux-arm64.tar.gz; the comparison covers every runtime archive and file list`)
    const empty = join(fixture.rebuild, '..', 'empty')
    mkdirSync(empty)
    editRecord(fixture, record => ({ ...record, outputs: [] }))
    const result = fixture.sign({}, { rebuild: empty })
    refusal(result.stderr)
    refusedWithoutWriting(fixture, result, `the rebuild output lacks delorun-${VERSION}-linux-x64.tar.gz, delorun-${VERSION}-linux-x64.files.json`)
  })

  it('refuses a record whose recipe digest or toolchain is not the recipe committed at the release', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const original = readFileSync(fixture.recordPath, 'utf8')
    editRecord(fixture, record => ({ ...record, recipe: '0'.repeat(64) }))
    refusedWithoutWriting(fixture, fixture.sign(), `the rebuild record's recipe digest is not the recipe at ${fixture.commit}`)
    for (const field of ['node', 'pnpm', 'compiler', 'linker']) {
      writeFileSync(fixture.recordPath, original)
      editRecord(fixture, record => ({ ...record, toolchain: { ...(record.toolchain as Record<string, string>), [field]: 'other' } }))
      refusedWithoutWriting(fixture, fixture.sign(), `is not the toolchain pinned at ${fixture.commit}`)
    }
  })

  it('refuses a release file whose bytes differ from the draft\'s reference', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const script = join(fixture.release, 'install.sh')
    writeFileSync(script, readFileSync(script, 'utf8').toUpperCase())
    refusedWithoutWriting(fixture, fixture.sign(), 'install.sh does not match install.sh in the draft')
  })

  it('refuses without the rebuild attestation, or with one another key made or that covers another build', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const missing = fixture.sign({}, { attestation: join(fixture.rebuild, '..', 'none.json') })
    refusal(missing.stderr)
    refusedWithoutWriting(fixture, missing, 'no rebuild attestation exists at')
    const outputs = await outputRefs(fixture.rebuild)
    const other = join(fixture.rebuild, '..', 'other.json')
    writeFileSync(other, attestationText(randomBytes(32), { version: VERSION, commit: fixture.commit, outputs }))
    refusedWithoutWriting(fixture, fixture.sign({}, { attestation: other }), 'its HMAC does not verify with this machine\'s attestation key')
    writeFileSync(other, attestationText(fixture.attestationKey, { version: VERSION, commit: 'e'.repeat(40), outputs }))
    refusedWithoutWriting(fixture, fixture.sign({}, { attestation: other }), `it attests ${VERSION} at ${'e'.repeat(40)}, not ${VERSION} at ${fixture.commit}`)
    writeFileSync(other, attestationText(fixture.attestationKey, { version: VERSION, commit: fixture.commit, outputs: outputs.slice(1) }))
    refusedWithoutWriting(fixture, fixture.sign({}, { attestation: other }), 'it attests other output files than the rebuild directory holds')
    const forged = JSON.parse(readFileSync(fixture.attestationPath, 'utf8')) as { hmac: string }
    writeFileSync(other, JSON.stringify({ ...forged, hmac: '0'.repeat(64) }))
    refusedWithoutWriting(fixture, fixture.sign({}, { attestation: other }), 'its HMAC does not verify')
    copyFileSync(fixture.attestationPath, join(fixture.rebuild, '..', 'release', 'attestation.json'))
    refusedWithoutWriting(fixture, fixture.sign({}, { attestation: join(fixture.release, 'attestation.json') }), 'lies in the release or rebuild directory')
  })

  it('changes nothing in the release directory when writing a signed file fails', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const list = join(fixture.release, `delorun-${VERSION}-linux-x64.files.json`)
    const before = readFileSync(list)
    mkdirSync(join(fixture.release, `${MANIFEST}.signing`))
    const result = fixture.sign()
    refusedWithoutWriting(fixture, result, 'writing the signed files failed, and nothing was changed')
    expect(readFileSync(list)).toEqual(before)
    expect(existsSync(join(fixture.release, RECORD))).toBe(false)
    expect(existsSync(`${list}.signing`)).toBe(false)
  })
})
