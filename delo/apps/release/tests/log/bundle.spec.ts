/**
 * The release-log bundle (contract C18's `c18-missing-witness-fails-verify`, with the unlisted-witness, inclusion,
 * other-manifest and log-signature refusals around it), against a local log stand-in and a local witness stand-in
 * with throwaway keys generated in the test.
 */
import { createHash, createPublicKey, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ReleaseLogBundle } from '@delo/contract-release-log'
import { sha256Hex } from '../../src/brands.ts'
import { hashedRekordBody, LogVerificationError, verifyBundle } from '../../src/log/bundle.ts'
import { consistencyProof, leafHash, treeRoot, verifyConsistency } from '../../src/log/merkle.ts'
import { rootFile, throwawayKeys, type Keys } from '../sign/fixture.ts'
import { LogStandIn, WitnessStandIn } from './standin.ts'

const MANIFEST = Buffer.from('{"signed":{"schema":"delo.release-manifest/1"},"signatures":[]}\n')

function setup(keys: Keys = throwawayKeys()): { log: LogStandIn, witness: WitnessStandIn, root: ReturnType<typeof rootFile>['metadata'], bundle: (note?: (checkpoint: string) => string, manifest?: Buffer) => ReleaseLogBundle } {
  const log = new LogStandIn()
  const witness = new WitnessStandIn()
  const root = rootFile(keys, { log: { origin: log.origin, vkey: log.vkey }, witnesses: { keys: [{ name: witness.name, vkey: witness.vkey }], threshold: 1 } }).metadata
  log.append(Buffer.from('an earlier entry'))
  const bundle = (note: (checkpoint: string) => string = checkpoint => witness.cosign(checkpoint, 1_793_981_700), manifest: Buffer = MANIFEST): ReleaseLogBundle => {
    const pem = createPublicKey(keys.targets).export({ format: 'pem', type: 'spki' }).toString()
    const digest = createHash('sha256').update(manifest).digest('hex')
    const index = log.append(hashedRekordBody(digest, sign(null, manifest, keys.targets), pem))
    log.append(Buffer.from('a later entry'))
    return log.bundle(index, { name: 'delorun-0.1.0.manifest.json', sha256: sha256Hex(digest) }, note(log.checkpoint()))
  }
  return { log, witness, root, bundle }
}

function failure(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    if (error instanceof LogVerificationError) return error.failure
    throw error
  }
  return undefined
}

describe('release-log bundle', () => {
  it('verifies an entry signed by the targets key, included in a checkpoint the log signed and a listed witness cosigned', () => {
    const { root, bundle } = setup()
    const verified = verifyBundle(root, MANIFEST, '0.1.0', bundle())
    expect(verified.treeSize).toBe(3)
    expect(verified.cosigned).toBe(1_793_981_700)
  })

  it('refuses a checkpoint without a witness cosignature, whatever its log signature says', () => {
    const { root, bundle } = setup()
    expect(failure(() => verifyBundle(root, MANIFEST, '0.1.0', bundle(checkpoint => checkpoint)))).toBe('witness-cosignature-missing')
  })

  it('does not count a cosignature from a witness the root does not list', () => {
    const { root, bundle } = setup()
    const stranger = new WitnessStandIn('witness.example.test')
    expect(failure(() => verifyBundle(root, MANIFEST, '0.1.0', bundle(checkpoint => stranger.cosign(checkpoint, 1_793_981_700))))).toBe('witness-cosignature-missing')
  })

  it('refuses an inclusion proof that does not reproduce the root hash', () => {
    const { root, bundle } = setup()
    const good = bundle()
    const tampered = { ...good, inclusion: { ...good.inclusion, hashes: good.inclusion.hashes.map((hash, index) => (index === 0 ? '0'.repeat(64) : hash)) } }
    expect(failure(() => verifyBundle(root, MANIFEST, '0.1.0', tampered))).toBe('inclusion-proof-invalid')
  })

  it('refuses a valid entry for another manifest', () => {
    const { root, bundle } = setup()
    expect(failure(() => verifyBundle(root, Buffer.from('another manifest'), '0.1.0', bundle()))).toBe('manifest-digest-mismatch')
  })

  it('refuses an entry signed by a key outside the targets role', () => {
    const keys = throwawayKeys()
    const { root, bundle } = setup({ ...keys, targets: keys.timestamp })
    const trusted = rootFile(keys, { log: root.log, witnesses: root.witnesses }).metadata
    expect(failure(() => verifyBundle(trusted, MANIFEST, '0.1.0', bundle()))).toBe('entry-signature-invalid')
  })

  it('refuses a checkpoint the log key did not sign', () => {
    const { root, bundle, witness } = setup()
    const other = new LogStandIn()
    const good = bundle()
    const forged = other.checkpoint().replace(other.origin, root.log.origin)
    expect(failure(() => verifyBundle(root, MANIFEST, '0.1.0', { ...good, checkpoint: witness.cosign(forged, 1) }))).toBe('log-signature-invalid')
  })
})

describe('RFC 6962 proofs', () => {
  it('verifies consistency between every pair of tree sizes up to 9 and refuses a wrong root', () => {
    const leaves = Array.from({ length: 9 }, (_, index) => leafHash(Buffer.from(String(index))))
    for (let size2 = 1; size2 <= 9; size2++) {
      for (let size1 = 1; size1 <= size2; size1++) {
        const proof = consistencyProof(size1, leaves.slice(0, size2))
        expect(verifyConsistency(size1, size2, treeRoot(leaves.slice(0, size1)), treeRoot(leaves.slice(0, size2)), proof)).toBe(true)
        if (size1 < size2) expect(verifyConsistency(size1, size2, treeRoot(leaves.slice(1, size1 + 1)), treeRoot(leaves.slice(0, size2)), proof)).toBe(false)
      }
    }
  })
})
