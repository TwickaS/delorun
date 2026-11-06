/**
 * The signing command's refusals (contract C2's `c02-signing-refuses-without-rebuild`, `c02-signing-refuses-ci-rebuild`
 * and `c02-rebuild-difference-blocks-signing`) and a signing that passes them, whose manifest and file lists verify
 * with the targets key. Every key is a throwaway key generated in the test.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RUNTIME_PLATFORMS } from '@delo/contract-release-manifest'
import { REQUIRED_SOURCE } from '../../src/rebuild/record.ts'
import { checkFileRef, verifyFileList, verifySignedManifest } from '../../src/sign/verify.ts'
import { writeTree } from '../support.ts'
import { releaseFixture, rootFile, VERSION } from './fixture.ts'

const MANIFEST = `delorun-${VERSION}.manifest.json`
const RECORD = `delorun-${VERSION}.rebuild.json`

function refusal(stderr: string): void {
  expect(stderr).toContain(REQUIRED_SOURCE)
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
    for (const platform of RUNTIME_PLATFORMS) {
      verifyFileList(root, manifest, platform, readFileSync(join(fixture.release, manifest.runtime[platform].files.name)))
      checkFileRef(manifest.runtime[platform].archive, readFileSync(join(fixture.release, manifest.runtime[platform].archive.name)))
    }
  })

  it('refuses without a rebuild record, naming the required source, and writes nothing', async (test) => {
    const fixture = await releaseFixture(test)
    const result = fixture.sign()
    refusal(result.stderr)
    expect(result.stderr).toContain(`no rebuild record ${RECORD} exists`)
    expect(result.status).toBe(1)
    expect(existsSync(join(fixture.release, MANIFEST))).toBe(false)
  })

  it('refuses a record that says it was made in CI', async (test) => {
    const fixture = await releaseFixture(test)
    expect(fixture.record().status).toBe(0)
    const path = join(fixture.release, RECORD)
    writeFileSync(path, readFileSync(path, 'utf8').replace('"ci": false', '"ci": true'))
    const result = fixture.sign()
    refusal(result.stderr)
    expect(result.stderr).toContain('says it was made in CI')
    expect(result.status).toBe(1)
  })

  it('refuses to sign, and to record, with GITHUB_ACTIONS or CI set', async (test) => {
    const fixture = await releaseFixture(test)
    const recorded = fixture.run('record-rebuild.ts', ['--version', VERSION, '--release', fixture.release, '--rebuild', fixture.rebuild, '--builder', 'ci', '--compared-with', 'run'], { CI: 'true' })
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
    const path = join(fixture.release, RECORD)
    writeFileSync(path, readFileSync(path, 'utf8').replace(fixture.commit, 'f'.repeat(40)))
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
    const recorded = fixture.record()
    expect(recorded.stdout).toContain('differs: delorun-0.1.0-linux-x64.tar.gz: app/lib/bin.js: content differs')
    expect(recorded.status).toBe(1)
    const result = fixture.sign()
    refusal(result.stderr)
    expect(result.stderr).toContain('comparison found a difference')
    const path = join(fixture.release, RECORD)
    writeFileSync(path, readFileSync(path, 'utf8').replace('"comparison": "difference"', '"comparison": "match"'))
    const forged = fixture.sign()
    refusal(forged.stderr)
    expect(forged.stderr).toContain('compare-rebuild finds')
    expect(forged.status).toBe(1)
    expect(existsSync(join(fixture.release, MANIFEST))).toBe(false)
  })
})
