/**
 * The release-log bundle (contract C18's `c18-missing-witness-fails-verify`, with the unlisted-witness, inclusion,
 * other-manifest, entry-format and log-signature refusals around it), against a local log stand-in and a local
 * witness stand-in with throwaway keys generated in the test.
 */
import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ReleaseLogBundle } from '@delorun/contract-release-log'
import { sha256Hex } from '@delorun/release-formats/brands'
import { LogVerificationError, verifyBundle } from '@delorun/release-formats/log/bundle'
import { entryRequest, readEntryRequest, signEd25519ph, verifyEd25519ph } from '@delorun/release-formats/log/entry'
import { consistencyProof, leafHash, treeRoot, verifyConsistency } from '@delorun/release-formats/log/merkle'
import { parseVerifier, splitNote, verifySignature } from '@delorun/release-formats/log/note'
import { canonicalJson } from '@delorun/release-formats/sign/json'
import { rootFile, throwawayKeys, type Keys } from '../sign/fixture.ts'
import { LogStandIn, WitnessStandIn } from './standin.ts'

const MANIFEST = Buffer.from('{"signed":{"schema":"delorun.release-manifest/1"},"signatures":[]}\n')

function setup(keys: Keys = throwawayKeys()): { keys: Keys, log: LogStandIn, witness: WitnessStandIn, root: ReturnType<typeof rootFile>['metadata'], bundle: (note?: (checkpoint: string) => string, manifest?: Buffer) => ReleaseLogBundle } {
  const log = new LogStandIn()
  const witness = new WitnessStandIn()
  const root = rootFile(keys, { log: { origin: log.origin, vkey: log.vkey }, witnesses: { keys: [{ name: witness.name, vkey: witness.vkey }], threshold: 1 } }).metadata
  log.append(Buffer.from('an earlier entry'))
  const bundle = (note: (checkpoint: string) => string = checkpoint => witness.cosign(checkpoint, 1_793_981_700), manifest: Buffer = MANIFEST): ReleaseLogBundle => {
    const digest = createHash('sha256').update(manifest).digest('hex')
    const index = log.submit(entryRequest(manifest, keys.targets))
    log.append(Buffer.from('a later entry'))
    return log.bundle(index, { name: 'delorun-0.1.0.manifest.json', sha256: sha256Hex(digest) }, note(log.checkpoint()))
  }
  return { keys, log, witness, root, bundle }
}

const DIGEST = createHash('sha256').update(MANIFEST).digest('hex')
const SHA512 = createHash('sha512').update(MANIFEST).digest('base64')

/** An entry body with the given fields, serialized the way Rekor v2 serializes one. */
function body(key: KeyObject, fields: { digest?: string, algorithm?: string, signature: Buffer, keyDetails: string, rawBytes?: Buffer }): Buffer {
  const rawBytes = fields.rawBytes ?? createPublicKey(key).export({ format: 'der', type: 'spki' })
  return Buffer.from(canonicalJson({
    apiVersion: '0.0.2',
    kind: 'hashedrekord',
    spec: { hashedRekordV002: { data: { algorithm: fields.algorithm ?? 'SHA2_512', digest: fields.digest ?? SHA512 }, signature: { content: fields.signature.toString('base64'), verifier: { publicKey: { rawBytes: rawBytes.toString('base64') }, keyDetails: fields.keyDetails } } } },
  }))
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

/**
 * The refusal a bundle verification raises.
 * @param run - the verification.
 * @returns the refusal.
 */
function refusal(run: () => unknown): LogVerificationError {
  try {
    run()
  } catch (error) {
    if (error instanceof LogVerificationError) return error
    throw error
  }
  throw new Error('the bundle verified, and the spec expected a refusal')
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

describe('release-log bundle checks, each on its own', () => {
  it('refuses a bundle that names another manifest digest than the manifest verified', () => {
    const { root, bundle } = setup()
    const good = bundle()
    expect(failure(() => verifyBundle(root, MANIFEST, '0.1.0', { ...good, manifest: { ...good.manifest, sha256: sha256Hex('0'.repeat(64)) } }))).toBe('manifest-digest-mismatch')
  })

  it('refuses an entry whose hashedrekord names another digest, though its signature covers the manifest', () => {
    const { keys, log, witness, root } = setup()
    const index = log.append(body(keys.targets, { digest: createHash('sha512').update('other bytes').digest('base64'), signature: signEd25519ph(keys.targets, MANIFEST), keyDetails: 'PKIX_ED25519_PH' }))
    const bundle = log.bundle(index, { name: 'delorun-0.1.0.manifest.json', sha256: sha256Hex(DIGEST) }, witness.cosign(log.checkpoint(), 1_793_981_700))
    expect(failure(() => verifyBundle(root, MANIFEST, '0.1.0', bundle))).toBe('manifest-digest-mismatch')
  })

  it('refuses an entry whose digest is the manifest\'s SHA-512 under another algorithm name', () => {
    const { keys, log, witness, root } = setup()
    const index = log.append(body(keys.targets, { algorithm: 'SHA2_256', signature: signEd25519ph(keys.targets, MANIFEST), keyDetails: 'PKIX_ED25519_PH' }))
    const bundle = log.bundle(index, { name: 'delorun-0.1.0.manifest.json', sha256: sha256Hex(DIGEST) }, witness.cosign(log.checkpoint(), 1_793_981_700))
    expect(failure(() => verifyBundle(root, MANIFEST, '0.1.0', bundle))).toBe('manifest-digest-mismatch')
  })

  it('refuses an entry carrying the targets key with a signature over other bytes', () => {
    const { keys, log, witness, root } = setup()
    const index = log.append(body(keys.targets, { signature: signEd25519ph(keys.targets, Buffer.from('other bytes')), keyDetails: 'PKIX_ED25519_PH' }))
    const bundle = log.bundle(index, { name: 'delorun-0.1.0.manifest.json', sha256: sha256Hex(DIGEST) }, witness.cosign(log.checkpoint(), 1_793_981_700))
    expect(failure(() => verifyBundle(root, MANIFEST, '0.1.0', bundle))).toBe('entry-signature-invalid')
  })

  it('refuses a pure-Ed25519 entry, which the log would not accept and the verifier does not either', () => {
    const { keys, log, witness, root } = setup()
    const index = log.append(body(keys.targets, { signature: sign(null, MANIFEST, keys.targets), keyDetails: 'PKIX_ED25519' }))
    const bundle = log.bundle(index, { name: 'delorun-0.1.0.manifest.json', sha256: sha256Hex(DIGEST) }, witness.cosign(log.checkpoint(), 1_793_981_700))
    expect(failure(() => verifyBundle(root, MANIFEST, '0.1.0', bundle))).toBe('entry-signature-invalid')
    const pure = { hashedRekordRequestV002: { digest: SHA512, signature: { content: sign(null, MANIFEST, keys.targets).toString('base64'), verifier: { publicKey: { rawBytes: '' }, keyDetails: 'PKIX_ED25519' } } } }
    expect(() => readEntryRequest(Buffer.from(JSON.stringify(pure)))).toThrow(/key details PKIX_ED25519 are not an entry key type this client implements/u)
  })

  it('refuses an Ed25519ph signature under key details other than PKIX_ED25519_PH', () => {
    const { keys, log, witness, root } = setup()
    const index = log.append(body(keys.targets, { signature: signEd25519ph(keys.targets, MANIFEST), keyDetails: 'PKIX_ED25519' }))
    const bundle = log.bundle(index, { name: 'delorun-0.1.0.manifest.json', sha256: sha256Hex(DIGEST) }, witness.cosign(log.checkpoint(), 1_793_981_700))
    expect(failure(() => verifyBundle(root, MANIFEST, '0.1.0', bundle))).toBe('entry-signature-invalid')
  })

  it('refuses a pure Ed25519 signature in an entry that claims Ed25519ph', () => {
    const { keys, log, witness, root } = setup()
    const index = log.append(body(keys.targets, { signature: sign(null, MANIFEST, keys.targets), keyDetails: 'PKIX_ED25519_PH' }))
    const bundle = log.bundle(index, { name: 'delorun-0.1.0.manifest.json', sha256: sha256Hex(DIGEST) }, witness.cosign(log.checkpoint(), 1_793_981_700))
    expect(failure(() => verifyBundle(root, MANIFEST, '0.1.0', bundle))).toBe('entry-signature-invalid')
  })

  it('refuses an entry whose verifier key does not parse, as a key the root does not list', () => {
    const { keys, log, witness, root } = setup()
    const index = log.append(body(keys.targets, { signature: signEd25519ph(keys.targets, MANIFEST), keyDetails: 'PKIX_ED25519_PH', rawBytes: Buffer.from('not a spki key') }))
    const bundle = log.bundle(index, { name: 'delorun-0.1.0.manifest.json', sha256: sha256Hex(DIGEST) }, witness.cosign(log.checkpoint(), 1_793_981_700))
    const error = refusal(() => verifyBundle(root, MANIFEST, '0.1.0', bundle))
    expect(error.failure).toBe('entry-signature-invalid')
    expect(error.message).toContain('which the trusted root does not list')
  })

  it('refuses an entry body with a field Rekor v2\'s hashedrekord v0.0.2 does not have', () => {
    const { keys, log, witness, root } = setup()
    const extended = JSON.parse(body(keys.targets, { signature: signEd25519ph(keys.targets, MANIFEST), keyDetails: 'PKIX_ED25519_PH' }).toString('utf8')) as { spec: { hashedRekordV002: Record<string, unknown> } }
    extended.spec.hashedRekordV002.note = 'extra'
    const index = log.append(Buffer.from(JSON.stringify(extended)))
    const bundle = log.bundle(index, { name: 'delorun-0.1.0.manifest.json', sha256: sha256Hex(DIGEST) }, witness.cosign(log.checkpoint(), 1_793_981_700))
    expect(failure(() => verifyBundle(root, MANIFEST, '0.1.0', bundle))).toBe('manifest-digest-mismatch')
  })

  it('refuses a signed, cosigned checkpoint of another tree size than the inclusion proof', () => {
    const { log, witness, root, bundle } = setup()
    const good = bundle()
    log.append(Buffer.from('an entry after the proof'))
    expect(failure(() => verifyBundle(root, MANIFEST, '0.1.0', { ...good, checkpoint: witness.cosign(log.checkpoint(), 1_793_981_700) }))).toBe('log-signature-invalid')
  })

  it('refuses a checkpoint that only a witness signed', () => {
    const { log, root, bundle } = setup()
    const good = bundle()
    const withoutLog = good.checkpoint.split('\n').filter(line => !line.startsWith(`— ${log.origin} `)).join('\n')
    expect(withoutLog).not.toBe(good.checkpoint)
    expect(failure(() => verifyBundle(root, MANIFEST, '0.1.0', { ...good, checkpoint: withoutLog }))).toBe('log-signature-invalid')
  })

  it('does not accept a valid signature under a key hash other than the verifier key\'s', () => {
    const { log } = setup()
    const note = splitNote(log.checkpoint())
    const line = note.signatures[0]!
    const verifier = parseVerifier(log.vkey)
    expect(verifySignature(verifier, note.body, line)).toBe(true)
    expect(verifySignature(verifier, note.body, { ...line, keyHash: Buffer.alloc(line.keyHash.byteLength) })).toBe(false)
  })

  it('refuses a bundle that covers the release manifest but names another file', () => {
    const { root, bundle } = setup()
    const good = bundle()
    // The digest is the release's own: only the name says another file, which contract C2 never let the client verify.
    expect(failure(() => verifyBundle(root, MANIFEST, '0.1.0', { ...good, manifest: { ...good.manifest, name: 'delorun-0.1.1.manifest.json' } }))).toBe('manifest-digest-mismatch')
  })

  it('refuses a release version no targets key can be shown valid for, instead of failing on the comparison', () => {
    const { root, bundle } = setup()
    expect(failure(() => verifyBundle(root, MANIFEST, 'not-a-version', bundle()))).toBe('entry-signature-invalid')
  })

  it('requires one listed cosignature even when the trusted root carries no witness threshold', () => {
    const { keys, log, witness, bundle } = setup()
    const root = rootFile(keys, {
      log: { origin: log.origin, vkey: log.vkey },
      witnesses: { keys: [{ name: witness.name, vkey: witness.vkey }], threshold: 0 },
    }).metadata
    const good = bundle()
    const unsigned = good.checkpoint.split('\n').filter(line => !line.startsWith(`— ${witness.name} `)).join('\n')
    expect(failure(() => verifyBundle(root, MANIFEST, '0.1.0', { ...good, checkpoint: unsigned }))).toBe('witness-cosignature-missing')
    expect(verifyBundle(root, MANIFEST, '0.1.0', good).cosigned).toBe(1_793_981_700)
  })
})

describe('the log entry', () => {
  it('is the request Rekor v2 accepts: SHA-512 digest, Ed25519ph signature and the DER public key', () => {
    const keys = throwawayKeys()
    const request = entryRequest(MANIFEST, keys.targets).hashedRekordRequestV002
    expect(request.digest).toBe(SHA512)
    expect(request.signature.verifier.keyDetails).toBe('PKIX_ED25519_PH')
    expect(createPublicKey({ key: Buffer.from(request.signature.verifier.publicKey.rawBytes, 'base64'), format: 'der', type: 'spki' }).equals(createPublicKey(keys.targets))).toBe(true)
    expect(verifyEd25519ph(createPublicKey(keys.targets), MANIFEST, Buffer.from(request.signature.content, 'base64'))).toBe(true)
    expect(createPublicKey(keys.targets).asymmetricKeyType).toBe('ed25519')
  })

  it('signs Ed25519ph as RFC 8032 section 7.3 does', () => {
    const seed = Buffer.from('833fe62409237b9d62ec77587520911e9a759cec1d19755b7da901b96dca3d42', 'hex')
    const key = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: seed.toString('base64url'), x: '7Bcrk61eVjv0kyxw4SRQNMNUZ-8u_U1k6_gZaDRn4r8' }, format: 'jwk' })
    const signature = signEd25519ph(key, Buffer.from('abc'))
    expect(signature.toString('hex')).toBe('98a70222f0b8121aa9d30f813d683f809e462b469c7ff87639499bb94e6dae4131f85042463c2a355a2003d062adf5aaa10b8c61e636062aaad11c2a26083406')
    expect(verifyEd25519ph(createPublicKey(key), Buffer.from('abc'), signature)).toBe(true)
    expect(verifyEd25519ph(createPublicKey(key), Buffer.from('abc'), sign(null, Buffer.from('abc'), key))).toBe(false)
    expect(verifyEd25519ph(createPublicKey(key), Buffer.from('abc'), signature.subarray(1))).toBe(false)
  })

  it('refuses an Ed25519ph signature that only ZIP-215\'s cofactored check accepts', () => {
    // A public key of order 8 with R the identity and S 0 satisfies the cofactored equation for every message, and the
    // cofactorless one only when the challenge is a multiple of 8, which it is not for this message.
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', 'hex').toString('base64url') }, format: 'jwk' })
    const signature = Buffer.concat([Buffer.from(`01${'00'.repeat(31)}`, 'hex'), Buffer.alloc(32)])
    expect(verifyEd25519ph(key, Buffer.from('a'), signature)).toBe(false)
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
