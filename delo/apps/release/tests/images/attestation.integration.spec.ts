/**
 * The image build's handling of the targets-key holder's attestation: it extends only an attestation that verifies
 * with the holder's key and covers exactly the closure build's files, keeps its commit, and refuses a copied
 * directory before Docker runs.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RUNTIME_PLATFORMS } from '@delo/contract-release-manifest'
import { archiveClosure } from '../../src/closure/archive-closure.ts'
import { attestationText, extendAttestation, readAttestation } from '../../src/rebuild/attestation.ts'
import { outputRefs } from '../../src/rebuild/record.ts'
import { runEntry, scratch, writeTree } from '../support.ts'

const COMMIT = 'c'.repeat(40)

async function closureOutput(directory: string): Promise<string> {
  const out = join(directory, 'out')
  mkdirSync(out, { recursive: true })
  for (const platform of RUNTIME_PLATFORMS) {
    writeTree(join(directory, `stage-${platform}`), { 'app/package.json': '{}\n', 'app/pnpm-lock.yaml': "lockfileVersion: '9.0'\n" })
    await archiveClosure({ stage: join(directory, `stage-${platform}`), outDir: out, version: '0.1.0', platform, epoch: 1_793_981_656, pins: undefined })
  }
  writeFileSync(join(out, 'delorun-0.1.0.spdx.json'), '{"before":"images"}\n')
  return out
}

describe('the image build\'s attestation', { timeout: 60_000 }, () => {
  it('extends a verified attestation with the images file and the rewritten SBOM, keeping its commit', async (test) => {
    const directory = scratch(test)
    const out = await closureOutput(directory)
    const key = randomBytes(32)
    const prior = readAttestation(key, Buffer.from(attestationText(key, { version: '0.1.0', commit: COMMIT, outputs: await outputRefs(out) })))
    writeFileSync(join(out, 'delorun-0.1.0.images.json'), '{}\n')
    writeFileSync(join(out, 'delorun-0.1.0.spdx.json'), '{"with":"images"}\n')
    const extended = extendAttestation(prior, await outputRefs(out), ['delorun-0.1.0.images.json', 'delorun-0.1.0.spdx.json'])
    expect(extended.commit).toBe(COMMIT)
    expect(extended.outputs.map(ref => ref.name)).toContain('delorun-0.1.0.images.json')
  })

  it('refuses an attestation another key made, an archive changed after it, and a file it neither covers nor adds', async (test) => {
    const directory = scratch(test)
    const out = await closureOutput(directory)
    const key = randomBytes(32)
    const text = attestationText(key, { version: '0.1.0', commit: COMMIT, outputs: await outputRefs(out) })
    expect(() => readAttestation(randomBytes(32), Buffer.from(text))).toThrow('the attestation\'s HMAC does not verify with this machine\'s attestation key')
    const forged = JSON.parse(text) as { commit: string }
    expect(() => readAttestation(key, Buffer.from(JSON.stringify({ ...forged, commit: 'd'.repeat(40) })))).toThrow(/HMAC does not verify/u)
    const prior = readAttestation(key, Buffer.from(text))
    const archive = join(out, 'delorun-0.1.0-linux-x64.tar.gz')
    writeFileSync(archive, Buffer.concat([readFileSync(archive), Buffer.from('x')]))
    const changedOutputs = await outputRefs(out)
    expect(() => extendAttestation(prior, changedOutputs, ['delorun-0.1.0.images.json'])).toThrow('delorun-0.1.0-linux-x64.tar.gz is not the file the attestation covers')
    const fresh = await closureOutput(join(directory, 'fresh'))
    const freshPrior = readAttestation(key, Buffer.from(attestationText(key, { version: '0.1.0', commit: COMMIT, outputs: await outputRefs(fresh) })))
    writeFileSync(join(fresh, 'extra.bin'), 'x')
    const withExtra = await outputRefs(fresh)
    expect(() => extendAttestation(freshPrior, withExtra, ['delorun-0.1.0.images.json'])).toThrow('extra.bin is neither attested nor written by this step')
  })

  it('refuses, before running Docker, a copied output directory whose attestation this key did not make', async (test) => {
    const directory = scratch(test)
    const out = await closureOutput(directory)
    const keyPath = join(directory, 'attestation.key')
    writeFileSync(keyPath, randomBytes(32), { mode: 0o600 })
    chmodSync(keyPath, 0o600)
    const attestation = join(directory, 'attestation.json')
    writeFileSync(attestation, attestationText(randomBytes(32), { version: '0.1.0', commit: COMMIT, outputs: await outputRefs(out) }))
    const copied = join(directory, 'copied.json')
    copyFileSync(attestation, copied)
    const result = runEntry('build-images.ts', ['--version', '0.1.0', '--out', out, '--oci', join(directory, 'oci'), '--attestation-key', keyPath, '--attestation', copied], { PATH: dirname(process.execPath) })
    expect(result.stderr).toContain('the attestation\'s HMAC does not verify with this machine\'s attestation key')
    expect(result.status).toBe(1)
  })
})
