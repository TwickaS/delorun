/**
 * The offline verification of a release-log bundle (contract C18, `Verifying a bundle`): the five steps against the
 * client's own trusted root, and every refusal each step makes — a wrong manifest, an entry of another type or by
 * another key, a signature that does not verify, a proof or a checkpoint that does not hold, a cosignature the root's
 * witnesses did not make, an untrusted root, and a bundle or note that does not read at all. Each case removes one
 * check, so a spec fails whenever that check goes away.
 */
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { verifyLogEntry } from '@delorun/release-formats/log/entry-keys'
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it } from 'vitest'
import { RELEASE_LOG_BUNDLE_SIZE_LIMIT, type ReleaseLogBundle } from '@delorun/contract-release-log'
import type { SemanticVersion, Sha256Hex } from '@delorun/contract-release-manifest'
import { BundleSchema, checkBundle, readBundle, verifyBundle } from '../src/bundle.ts'
import { RELEASE_LOG_REFUSALS, ReleaseLogRefusalError, type ReleaseLogRefusal } from '../src/errors.ts'
import { checkpointBody, parseCheckpoint, parseVerifierKey, splitNote, verifySignature } from '../src/note.ts'
import {
  COSIGNED_AT,
  entryBody,
  FixtureLog,
  FixtureWitness,
  inclusionProof,
  MANIFEST,
  NOTE_COSIGNATURE,
  NOTE_SIGNATURE,
  rawPublic,
  scenario,
  rootMetadata,
  signatureLine,
  throwawayKeys,
  treeRoot,
  verifierKey,
  VERSION,
  type Scenario,
} from './fixtures.ts'

const SHA256 = createHash('sha256').update(MANIFEST).digest('hex')

/**
 * Whether an Ed25519ph signature verifies as a log entry's does.
 * @param raw - the 32-byte raw public key.
 * @param message - the signed bytes.
 * @param signature - the signature.
 * @returns whether it verifies.
 */
function verifyEd25519ph(raw: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' })
  return verifyLogEntry('PKIX_ED25519_PH', key, message, signature)
}

/**
 * The refusal one verification makes.
 * @param run - the verification.
 * @returns the refusal's name, or `undefined` when it verified.
 */
function refusalOf(run: () => unknown): ReleaseLogRefusal | undefined {
  try {
    run()
  } catch (error) {
    if (error instanceof ReleaseLogRefusalError) return error.refusal
    throw error
  }
  return undefined
}

/**
 * Verify a bundle of the standard fixture, with the fields a case replaces.
 * @param fixture - the fixture.
 * @param bundle - the bundle to verify; the fixture's own by default.
 * @param manifest - the manifest the client verified; the fixture's by default.
 * @returns the refusal, or `undefined` when it verified.
 */
function refusal(fixture: Scenario, bundle: ReleaseLogBundle = fixture.bundle, manifest: Uint8Array = MANIFEST): ReleaseLogRefusal | undefined {
  return refusalOf(() => verifyBundle(fixture.root, VERSION, manifest, bundle))
}

describe('the bundle schema', () => {
  it('accepts the bundle the log serves and refuses an unknown field', () => {
    const fixture = scenario()
    expect(BundleSchema.safeParse(fixture.bundle).success).toBe(true)
    expect(BundleSchema.safeParse({ ...fixture.bundle, extra: 1 }).success).toBe(false)
  })

  it('refuses a bundle above the size limit before parsing it', () => {
    const fixture = scenario()
    const padded = Buffer.from(`${JSON.stringify(fixture.bundle)}${' '.repeat(RELEASE_LOG_BUNDLE_SIZE_LIMIT)}`)
    expect(refusalOf(() => readBundle(padded))).toBe('bundle-too-large')
  })

  it('refuses a file that is not strict JSON, and one that reads one key twice', () => {
    const fixture = scenario()
    const text = JSON.stringify(fixture.bundle)
    expect(refusalOf(() => readBundle(Buffer.from('{')))).toBe('bundle-malformed')
    expect(refusalOf(() => readBundle(Buffer.from(text.replace('{"schema"', '{"schema":"delorun.release-log-bundle/1","schema"'))))).toBe('bundle-malformed')
  })

  it('refuses a bundle with a missing part or another schema', () => {
    const fixture = scenario()
    const { inclusion: _inclusion, ...withoutInclusion } = fixture.bundle
    expect(refusalOf(() => readBundle(Buffer.from(JSON.stringify(withoutInclusion))))).toBe('bundle-malformed')
    expect(refusalOf(() => readBundle(Buffer.from(JSON.stringify({ ...fixture.bundle, schema: 'delorun.release-log-bundle/2' }))))).toBe('bundle-malformed')
  })
})

describe('a bundle that verifies', () => {
  it('names the tree, the root hash and the newest cosigning time of the checkpoint that verified', () => {
    const fixture = scenario()
    const verified = verifyBundle(fixture.root, VERSION, MANIFEST, fixture.bundle)
    expect(verified.treeSize).toBe(3)
    expect(verified.rootHash.toString('hex')).toBe(fixture.log.rootHash.toString('hex'))
    expect(verified.cosigned).toBe(COSIGNED_AT)
    expect(verified.checkpoint.origin).toBe(fixture.log.origin)
  })

  it('reads the bundle from its bytes, and answers a verdict instead of throwing', () => {
    const fixture = scenario()
    const bytes = Buffer.from(JSON.stringify(fixture.bundle))
    expect(readBundle(bytes).manifest.sha256).toBe(SHA256)
    expect(checkBundle(fixture.root, VERSION, MANIFEST, bytes)).toMatchObject({ ok: true })
    expect(checkBundle(fixture.root, VERSION, Buffer.from('another manifest'), bytes)).toMatchObject({ ok: false, refusal: 'manifest-digest-mismatch' })
  })
})

describe('step 1: the bundle covers the manifest the client verified', () => {
  it('c18-entry-for-other-manifest-refused: refuses a bundle that covers another manifest file', () => {
    const fixture = scenario()
    const other = brandString<Sha256Hex>(createHash('sha256').update('another manifest').digest('hex'))
    expect(refusal(fixture, { ...fixture.bundle, manifest: { ...fixture.bundle.manifest, sha256: other } })).toBe('manifest-digest-mismatch')
  })

  it('refuses a valid entry for another manifest file than the one the client verified', () => {
    const fixture = scenario()
    expect(refusal(fixture, fixture.bundle, Buffer.from('another manifest'))).toBe('manifest-digest-mismatch')
  })

  it('refuses a bundle that names another file than the release\'s manifest file', () => {
    const fixture = scenario()
    expect(refusal(fixture, { ...fixture.bundle, manifest: { ...fixture.bundle.manifest, name: 'delorun-0.2.0.manifest.json' } })).toBe('manifest-digest-mismatch')
    expect(refusal(fixture, { ...fixture.bundle, manifest: { ...fixture.bundle.manifest, name: '../delorun-0.1.0.manifest.json' } })).toBe('manifest-digest-mismatch')
  })

  it('refuses an entry whose hashedrekord names another digest, though its signature covers the manifest', () => {
    const fixture = scenario()
    const log = fixture.log
    const index = log.append(entryBody({ manifest: MANIFEST, signer: fixture.keys.targets, digest: createHash('sha512').update('other bytes').digest('base64') }))
    const bundle = log.bundle(index, 'delorun-0.1.0.manifest.json', SHA256, fixture.witness.cosign(log.checkpoint(), COSIGNED_AT))
    expect(refusal(fixture, bundle)).toBe('manifest-digest-mismatch')
  })
})

describe('step 2: the entry is the manifest\'s, signed by a log-entry key the root lists', () => {
  it('refuses an entry by a key the root does not list as a log-entry key, which is the identity check', () => {
    const fixture = scenario()
    const log = fixture.log
    const index = log.append(entryBody({ manifest: MANIFEST, signer: fixture.keys.other }))
    const bundle = log.bundle(index, 'delorun-0.1.0.manifest.json', SHA256, fixture.witness.cosign(log.checkpoint(), COSIGNED_AT))
    expect(refusal(fixture, bundle)).toBe('entry-key-untrusted')
  })

  it('verifies the entry with the listed log-entry key alone, whatever key the targets role names', () => {
    const fixture = scenario()
    const revoked = fixture.root.roles.targets.keys.map(key => ({ ...key, status: 'revoked' as const }))
    const root = { ...fixture.root, roles: { ...fixture.root.roles, targets: { keys: revoked, threshold: 1 } } }
    expect(refusalOf(() => verifyBundle(root, VERSION, MANIFEST, fixture.bundle))).toBeUndefined()
  })

  it('refuses an entry whose Ed25519ph signature does not verify with the listed key', () => {
    const fixture = scenario()
    const log = fixture.log
    const forged = entryBody({ manifest: MANIFEST, signer: fixture.keys.targets })
    const index = log.append(entryBody({ manifest: MANIFEST, signer: fixture.keys.targets, signature: createHash('sha512').update(forged).digest() }))
    const bundle = log.bundle(index, 'delorun-0.1.0.manifest.json', SHA256, fixture.witness.cosign(log.checkpoint(), COSIGNED_AT))
    expect(refusal(fixture, bundle)).toBe('entry-signature-invalid')
  })

  it('refuses a version or a retired last release that is not a semantic version, instead of raising a TypeError', () => {
    const fixture = scenario()
    const listed = fixture.root.logEntryKeys![0]!
    const retired = { ...fixture.root, logEntryKeys: [{ ...listed, status: 'retired' as const, lastRelease: brandString<SemanticVersion>('v1.2') }] }
    expect(refusalOf(() => verifyBundle(retired, VERSION, MANIFEST, fixture.bundle))).toBe('entry-key-untrusted')
    expect(refusalOf(() => verifyBundle(fixture.root, 'v0.1', MANIFEST, fixture.bundle))).toBe('entry-key-untrusted')
    // The same refusals as a verdict, which is what a start records as `failed` instead of propagating an error.
    const bytes = Buffer.from(JSON.stringify(fixture.bundle))
    expect(checkBundle(retired, VERSION, MANIFEST, bytes)).toMatchObject({ ok: false, refusal: 'entry-key-untrusted' })
    expect(checkBundle(fixture.root, 'v0.1', MANIFEST, bytes)).toMatchObject({ ok: false, refusal: 'entry-key-untrusted' })
  })
})

describe('the entry body a log accepted', () => {
  it('c18-pure-ed25519-entry-refused: refuses an entry with PKIX_ED25519 key details', () => {
    const fixture = scenario()
    const log = fixture.log
    const index = log.append(entryBody({ manifest: MANIFEST, signer: fixture.keys.targets, keyDetails: 'PKIX_ED25519' }))
    const bundle = log.bundle(index, 'delorun-0.1.0.manifest.json', SHA256, fixture.witness.cosign(log.checkpoint(), COSIGNED_AT))
    expect(refusal(fixture, bundle)).toBe('entry-type-refused')
  })

  it('refuses another kind or another api version than Rekor v2\'s hashedrekord', () => {
    const fixture = scenario()
    const log = fixture.log
    const kinded = log.append(entryBody({ manifest: MANIFEST, signer: fixture.keys.targets, kind: 'intoto' }))
    const versioned = log.append(entryBody({ manifest: MANIFEST, signer: fixture.keys.targets, apiVersion: '0.0.1' }))
    for (const index of [kinded, versioned]) {
      const bundle = log.bundle(index, 'delorun-0.1.0.manifest.json', SHA256, fixture.witness.cosign(log.checkpoint(), COSIGNED_AT))
      expect(refusal(fixture, bundle)).toBe('entry-type-refused')
    }
  })

  it('refuses a digest algorithm other than SHA2_512, which Ed25519ph prehashes with', () => {
    const fixture = scenario()
    const log = fixture.log
    const index = log.append(entryBody({ manifest: MANIFEST, signer: fixture.keys.targets, algorithm: 'SHA2_256' }))
    const bundle = log.bundle(index, 'delorun-0.1.0.manifest.json', SHA256, fixture.witness.cosign(log.checkpoint(), COSIGNED_AT))
    expect(refusal(fixture, bundle)).toBe('entry-type-refused')
  })

  it('refuses a malformed transparency entry: no JSON, another shape, a base64 body that is not base64', () => {
    const fixture = scenario()
    const log = fixture.log
    const notJson = log.append(Buffer.from('not json'))
    const notHashedRekord = log.append(Buffer.from(JSON.stringify({ apiVersion: '0.0.2', kind: 'hashedrekord', spec: {} })))
    for (const index of [notJson, notHashedRekord]) {
      const bundle = log.bundle(index, 'delorun-0.1.0.manifest.json', SHA256, fixture.witness.cosign(log.checkpoint(), COSIGNED_AT))
      expect(refusal(fixture, bundle)).toBe('entry-malformed')
    }
    const good = fixture.bundle
    expect(refusal(fixture, { ...good, entry: { ...good.entry, body: 'not base64!' } })).toBe('entry-malformed')
  })

  it('refuses an entry whose verifier key is not a PKIX Ed25519 key', () => {
    const fixture = scenario()
    const log = fixture.log
    const index = log.append(entryBody({ manifest: MANIFEST, signer: fixture.keys.targets, verifier: fixture.keys.other }))
    const body = JSON.parse(log.body(index).toString('utf8')) as { spec: { hashedRekordV002: { signature: { verifier: { publicKey: { rawBytes: string } } } } } }
    body.spec.hashedRekordV002.signature.verifier.publicKey.rawBytes = Buffer.from('not a public key').toString('base64')
    const replaced = log.append(Buffer.from(JSON.stringify(body)))
    const bundle = log.bundle(replaced, 'delorun-0.1.0.manifest.json', SHA256, fixture.witness.cosign(log.checkpoint(), COSIGNED_AT))
    expect(refusal(fixture, bundle)).toBe('entry-key-untrusted')
  })
})

describe('step 3: the inclusion proof reproduces the root hash', () => {
  it('c18-wrong-inclusion-proof-refused: refuses a proof whose hash is not the entry\'s sibling', () => {
    const fixture = scenario()
    const tampered: ReleaseLogBundle = { ...fixture.bundle, inclusion: { ...fixture.bundle.inclusion, hashes: fixture.bundle.inclusion.hashes.map(() => '0'.repeat(64)) } }
    expect(refusal(fixture, tampered)).toBe('inclusion-proof-invalid')
  })

  it('refuses an inclusion proof filed at another index than the entry\'s', () => {
    const fixture = scenario()
    expect(refusal(fixture, { ...fixture.bundle, inclusion: { ...fixture.bundle.inclusion, logIndex: 0 } })).toBe('inclusion-proof-invalid')
  })

  it('refuses a tree size below the entry\'s index', () => {
    const fixture = scenario()
    expect(refusal(fixture, { ...fixture.bundle, inclusion: { ...fixture.bundle.inclusion, treeSize: 1 } })).toBe('inclusion-proof-invalid')
  })
})

describe('step 4: the checkpoint names the proof\'s tree, signed by the log key the root carries', () => {
  it('refuses a checkpoint of another log origin', () => {
    const fixture = scenario()
    const stranger = new FixtureWitness('other.example.test')
    const note = fixture.log.checkpoint().replace(fixture.log.origin, 'log.example.test/another')
    expect(refusal(fixture, { ...fixture.bundle, checkpoint: stranger.cosign(note, COSIGNED_AT) })).toBe('log-origin-untrusted')
  })

  it('refuses a checkpoint that names another tree than the inclusion proof', () => {
    const fixture = scenario()
    const other = Buffer.alloc(32, 7).toString('base64')
    const body = `${fixture.log.origin}\n3\n${other}\n`
    const note = `${body}\n${signatureLine(fixture.log.origin, NOTE_SIGNATURE, fixture.log.key, body)}`
    expect(refusal(fixture, { ...fixture.bundle, checkpoint: fixture.witness.cosign(note, COSIGNED_AT) })).toBe('log-origin-untrusted')
  })

  it('refuses a checkpoint the root\'s log key did not sign', () => {
    const fixture = scenario()
    const body = fixture.log.checkpoint().slice(0, fixture.log.checkpoint().lastIndexOf('\n\n') + 1)
    const forged = `${body}\n${signatureLine(fixture.log.origin, NOTE_SIGNATURE, fixture.keys.other, body)}`
    expect(refusal(fixture, { ...fixture.bundle, checkpoint: fixture.witness.cosign(forged, COSIGNED_AT) })).toBe('log-signature-invalid')
  })

  it('refuses a checkpoint that is not a signed note at all', () => {
    const fixture = scenario()
    expect(refusal(fixture, { ...fixture.bundle, checkpoint: `${fixture.log.origin}\n3\n${fixture.log.rootHash.toString('base64')}\n` })).toBe('checkpoint-malformed')
    expect(refusal(fixture, { ...fixture.bundle, checkpoint: `${fixture.log.origin}\n3\nnot base64\n\n— a b\n` })).toBe('checkpoint-malformed')
  })
})

describe('step 5: the root\'s threshold of listed witnesses cosigned', () => {
  it('c18-missing-witness-fails-verify: refuses a checkpoint without a witness cosignature, whatever its log signature says', () => {
    const fixture = scenario()
    expect(refusal(fixture, { ...fixture.bundle, checkpoint: fixture.log.checkpoint() })).toBe('witness-cosignature-missing')
  })

  it('c18-unlisted-witness-refused: does not count a cosignature from a witness the root does not list', () => {
    const fixture = scenario()
    const stranger = new FixtureWitness('witness.example.test')
    expect(refusal(fixture, { ...fixture.bundle, checkpoint: stranger.cosign(fixture.log.checkpoint(), COSIGNED_AT) })).toBe('witness-cosignature-missing')
  })

  it('counts one witness once, however many cosignatures it adds', () => {
    const fixture = scenario()
    const root = { ...fixture.root, witnesses: { keys: [{ name: fixture.witness.name, vkey: fixture.witness.vkey }], threshold: 2 } }
    const twice = fixture.witness.cosign(fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT), COSIGNED_AT + 1)
    expect(refusalOf(() => verifyBundle(root, VERSION, MANIFEST, { ...fixture.bundle, checkpoint: twice }))).toBe('witness-cosignature-missing')
  })

  it('requires one cosignature whatever threshold the root carries, and reads a finite cosigning time', () => {
    const fixture = scenario()
    const zero = { ...fixture.root, witnesses: { ...fixture.root.witnesses, threshold: 0 } }
    // A threshold of 0 would satisfy `0 < 0`, and the newest cosigning time of no cosignature is `-Infinity`, which the
    // online check reads as infinitely old; the contract's client value is 1, so the unsigned checkpoint is refused.
    expect(refusalOf(() => verifyBundle(zero, VERSION, MANIFEST, { ...fixture.bundle, checkpoint: fixture.log.checkpoint() }))).toBe('witness-cosignature-missing')
    expect(verifyBundle(zero, VERSION, MANIFEST, fixture.bundle).cosigned).toBe(COSIGNED_AT)
  })

  it('does not count a cosignature by another key wearing a listed witness\'s name', () => {
    const fixture = scenario()
    const impostor = { name: fixture.witness.name, vkey: verifierKey(fixture.witness.name, NOTE_COSIGNATURE, fixture.keys.stranger) }
    const root = { ...fixture.root, witnesses: { keys: [impostor], threshold: 1 } }
    expect(refusalOf(() => verifyBundle(root, VERSION, MANIFEST, fixture.bundle))).toBe('witness-cosignature-missing')
  })
})

describe('the trusted root', () => {
  it('refuses a root whose log key is not in signed-note verifier format', () => {
    const fixture = scenario()
    const log = { origin: fixture.log.origin, vkey: 'not a verifier key' }
    const root = { ...fixture.root, log, logs: [log] }
    expect(refusalOf(() => verifyBundle(root, VERSION, MANIFEST, fixture.bundle))).toBe('log-origin-untrusted')
  })

  it('refuses a root whose log key is not a 32-byte Ed25519 note key', () => {
    const fixture = scenario()
    const log = { origin: fixture.log.origin, vkey: `${fixture.log.origin}+00000000+AQ==` }
    const root = { ...fixture.root, log, logs: [log] }
    expect(refusalOf(() => verifyBundle(root, VERSION, MANIFEST, fixture.bundle))).toBe('log-origin-untrusted')
  })

  it('refuses a root whose witness key hash is not the hash of its key', () => {
    const fixture = scenario()
    const vkey = fixture.witness.vkey.replace(/\+([0-9a-f]{8})\+/u, '+00000000+')
    const root = { ...fixture.root, witnesses: { keys: [{ name: fixture.witness.name, vkey }], threshold: 1 } }
    expect(refusalOf(() => verifyBundle(root, VERSION, MANIFEST, fixture.bundle))).toBe('log-origin-untrusted')
  })
})

describe('the refusals', () => {
  it('names every refusal this client makes, in the contract\'s order', () => {
    expect(RELEASE_LOG_REFUSALS).toContain('entry-signature-invalid')
    expect(RELEASE_LOG_REFUSALS).toContain('witness-cosignature-missing')
    expect(RELEASE_LOG_REFUSALS.indexOf('manifest-digest-mismatch')).toBeLessThan(RELEASE_LOG_REFUSALS.indexOf('entry-signature-invalid'))
  })

  it('carries a verifier key a trusted root can name for the log and every witness', () => {
    const fixture = scenario()
    expect(verifierKey(fixture.log.origin, NOTE_SIGNATURE, fixture.log.key)).toBe(fixture.log.vkey)
  })
})

/**
 * A bundle of an entry body the fixture log accepted, at the log's current tree.
 * @param fixture - the fixture.
 * @param body - the entry body's bytes.
 * @returns the bundle, with a cosigned checkpoint.
 */
function committed(fixture: Scenario, body: Buffer): ReleaseLogBundle {
  const index = fixture.log.append(body)
  return fixture.log.bundle(index, 'delorun-0.1.0.manifest.json', SHA256, fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT))
}

describe('the leaf is the entry body\'s exact bytes', () => {
  it('refuses the same body pretty-printed, because the log committed other bytes', () => {
    const fixture = scenario()
    const compact = fixture.log.body(fixture.bundle.entry.logIndex)
    const pretty = Buffer.from(JSON.stringify(JSON.parse(compact.toString('utf8')), null, 2))
    // The pretty body reads and its signature still verifies; only the leaf it hashes to differs.
    expect(refusal(fixture, { ...fixture.bundle, entry: { ...fixture.bundle.entry, body: pretty.toString('base64') } })).toBe('inclusion-proof-invalid')
  })

  it('verifies the pretty-printed body when the log committed exactly those bytes', () => {
    const fixture = scenario()
    const pretty = Buffer.from(JSON.stringify(JSON.parse(fixture.log.body(fixture.bundle.entry.logIndex).toString('utf8')), null, 2))
    expect(refusal(fixture, committed(fixture, pretty))).toBeUndefined()
  })

  it('refuses an extra field in an entry body the log accepted', () => {
    const fixture = scenario()
    const body = JSON.parse(fixture.log.body(fixture.bundle.entry.logIndex).toString('utf8')) as Record<string, unknown>
    expect(refusal(fixture, committed(fixture, Buffer.from(JSON.stringify({ ...body, extra: 1 }))))).toBe('entry-malformed')
  })

  it('refuses a removed field in an entry body the log accepted', () => {
    const fixture = scenario()
    const body = JSON.parse(fixture.log.body(fixture.bundle.entry.logIndex).toString('utf8')) as { spec: { hashedRekordV002: { signature: { verifier: { keyDetails?: string } } } } }
    delete body.spec.hashedRekordV002.signature.verifier.keyDetails
    expect(refusal(fixture, committed(fixture, Buffer.from(JSON.stringify(body))))).toBe('entry-malformed')
  })

  it('fixes the digest algorithm and the key details: no other hash, no pure Ed25519, no `none`', () => {
    const fixture = scenario()
    for (const [algorithm, keyDetails] of [['NONE', 'PKIX_ED25519_PH'], ['ED25519', 'PKIX_ED25519_PH'], ['SHA2_512', 'PKIX_ED25519'], ['SHA2_512', 'none']] as const) {
      const bundle = committed(fixture, entryBody({ manifest: MANIFEST, signer: fixture.keys.targets, algorithm, keyDetails }))
      expect(refusal(fixture, bundle), `${algorithm} with ${keyDetails}`).toBe('entry-type-refused')
    }
  })

  it('refuses another key\'s valid signature under the listed key\'s identity', () => {
    const fixture = scenario()
    const foreign = JSON.parse(entryBody({ manifest: MANIFEST, signer: fixture.keys.other }).toString('utf8')) as { spec: { hashedRekordV002: { signature: { content: string } } } }
    const mixed = entryBody({ manifest: MANIFEST, signer: fixture.keys.targets, signature: Buffer.from(foreign.spec.hashedRekordV002.signature.content, 'base64') })
    expect(refusal(fixture, committed(fixture, mixed))).toBe('entry-signature-invalid')
  })
})

describe('the entry signature is RFC 8032 Ed25519ph', () => {
  it('verifies the RFC 8032 §7.3 test vector, and refuses it over another message', () => {
    const seed = Buffer.from('833fe62409237b9d62ec77587520911e9a759cec1d19755b7da901b96dca3d42', 'hex')
    const publicKey = Buffer.from('ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf', 'hex')
    const signature = Buffer.from('98a70222f0b8121aa9d30f813d683f809e462b469c7ff87639499bb94e6dae4131f85042463c2a355a2003d062adf5aaa10b8c61e636062aaad11c2a26083406', 'hex')
    // The vector's key pair is consistent: the RFC's secret key derives the RFC's public key.
    const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed])
    const derived = createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x
    expect(Buffer.from(derived!, 'base64url').equals(publicKey)).toBe(true)
    expect(verifyEd25519ph(publicKey, Buffer.from('abc'), signature)).toBe(true)
    expect(verifyEd25519ph(publicKey, Buffer.from('abd'), signature)).toBe(false)
    expect(verifyEd25519ph(publicKey, Buffer.from('abc'), Buffer.alloc(3))).toBe(false)
  })
})

describe('the inclusion proof\'s length and tree', () => {
  it('refuses an empty proof at a tree size above one', () => {
    const fixture = scenario()
    expect(refusal(fixture, { ...fixture.bundle, inclusion: { ...fixture.bundle.inclusion, hashes: [] } })).toBe('inclusion-proof-invalid')
  })

  it('verifies a one-leaf tree with no proof, whose root is the leaf hash itself', () => {
    const keys = throwawayKeys()
    const log = new FixtureLog()
    const witness = new FixtureWitness()
    const index = log.submit(MANIFEST, keys.targets)
    const bundle = log.bundle(index, 'delorun-0.1.0.manifest.json', SHA256, witness.cosign(log.checkpoint(), COSIGNED_AT))
    expect(bundle.inclusion.hashes).toEqual([])
    const verified = verifyBundle(rootMetadata(keys, log, [witness]), VERSION, MANIFEST, bundle)
    expect(verified.treeSize).toBe(1)
    expect(verified.rootHash.equals(createHash('sha256').update(Buffer.of(0x00)).update(log.body(index)).digest())).toBe(true)
  })

  it('refuses a proof of another leaf', () => {
    const fixture = scenario()
    const other = inclusionProof(0, fixture.log.leafHashes).map(hash => hash.toString('hex'))
    expect(refusal(fixture, { ...fixture.bundle, inclusion: { ...fixture.bundle.inclusion, hashes: other } })).toBe('inclusion-proof-invalid')
  })

  it('refuses a proof that holds at another tree size than the bundle names', () => {
    const fixture = scenario()
    const twoRoot = treeRoot(fixture.log.leafHashes.slice(0, 2))
    const bundle: ReleaseLogBundle = {
      ...fixture.bundle,
      inclusion: { ...fixture.bundle.inclusion, treeSize: 2, rootHash: twoRoot.toString('hex'), hashes: inclusionProof(1, fixture.log.leafHashes).map(hash => hash.toString('hex')) },
      checkpoint: fixture.witness.cosign(fixture.log.note(2), COSIGNED_AT),
    }
    expect(refusal(fixture, bundle)).toBe('inclusion-proof-invalid')
  })
})

describe('the keys a checkpoint is signed with', () => {
  it('refuses a checkpoint that carries a witness cosignature and no log signature', () => {
    const fixture = scenario()
    const body = `${fixture.log.origin}\n3\n${fixture.log.rootHash.toString('base64')}\n`
    const witnessOnly = `${body}\n${signatureLine(fixture.witness.name, NOTE_COSIGNATURE, fixture.witness.key, body, COSIGNED_AT)}`
    expect(refusal(fixture, { ...fixture.bundle, checkpoint: witnessOnly })).toBe('log-signature-invalid')
  })

  it('refuses a root that names a witness\'s cosignature key as the log key', () => {
    const fixture = scenario()
    const log = { origin: fixture.log.origin, vkey: fixture.witness.vkey }
    const root = { ...fixture.root, log, logs: [log] }
    expect(refusalOf(() => verifyBundle(root, VERSION, MANIFEST, fixture.bundle))).toBe('log-origin-untrusted')
  })

  it('refuses every checkpoint under a root that lists no witness', () => {
    const fixture = scenario()
    const root = { ...fixture.root, witnesses: { keys: [], threshold: 1 } }
    expect(refusalOf(() => verifyBundle(root, VERSION, MANIFEST, fixture.bundle))).toBe('witness-cosignature-missing')
  })
})

describe('the witnesses a root lists', () => {
  it('refuses a root that lists one witness key twice, under two names, which would count one witness as two', () => {
    const fixture = scenario()
    const raw = fixture.witness.vkey.split('+')[2]!
    const again = verifierKey('another-name.example.test', NOTE_COSIGNATURE, fixture.witness.key)
    expect(again.split('+')[2]).toBe(raw)
    const root = { ...fixture.root, witnesses: { keys: [{ name: fixture.witness.name, vkey: fixture.witness.vkey }, { name: 'another-name.example.test', vkey: again }], threshold: 2 } }
    expect(refusalOf(() => verifyBundle(root, VERSION, MANIFEST, fixture.bundle))).toBe('log-origin-untrusted')
  })

  it('refuses a root that lists a checkpoint signature key as a witness', () => {
    const fixture = scenario()
    const root = { ...fixture.root, witnesses: { keys: [{ name: fixture.witness.name, vkey: verifierKey(fixture.witness.name, NOTE_SIGNATURE, fixture.witness.key) }], threshold: 1 } }
    expect(refusalOf(() => verifyBundle(root, VERSION, MANIFEST, fixture.bundle))).toBe('log-origin-untrusted')
  })

  it('does not count a valid cosignature under a line whose key hash is not the listed key\'s', () => {
    const fixture = scenario()
    const cosigned = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
    const lines = cosigned.split('\n')
    const [dash, name, encoded] = lines.at(-2)!.split(' ')
    const bytes = Buffer.from(encoded!, 'base64')
    bytes[0] = bytes[0]! ^ 0xff
    lines[lines.length - 2] = `${dash!} ${name!} ${bytes.toString('base64')}`
    // C2SP signed notes bind a line to a key by name and key hash; the signature bytes alone do not select a key.
    expect(refusal(fixture, { ...fixture.bundle, checkpoint: lines.join('\n') })).toBe('witness-cosignature-missing')
  })
})

describe('a non-canonical entry signature', () => {
  it('is refused, as RFC 8032 requires, though ZIP-215 would accept it', async () => {
    const { ed25519ph } = await import('@noble/curves/ed25519.js')
    // The identity point as the public key, and as R encoded with y = p + 1 instead of 1, with S = 0: under ZIP-215
    // the non-canonical encoding is accepted and the equation holds for any message; RFC 8032 refuses the encoding.
    const identity = Buffer.alloc(32)
    identity[0] = 1
    const nonCanonicalR = Buffer.alloc(32, 0xff)
    nonCanonicalR[0] = 0xee
    nonCanonicalR[31] = 0x7f
    const signature = Buffer.concat([nonCanonicalR, Buffer.alloc(32)])
    expect(ed25519ph.verify(signature, MANIFEST, identity, { zip215: true })).toBe(true)
    expect(verifyEd25519ph(identity, MANIFEST, signature)).toBe(false)
  })

  it('is refused when S is not reduced below the group order', () => {
    const fixture = scenario()
    const body = JSON.parse(fixture.log.body(fixture.bundle.entry.logIndex).toString('utf8')) as { spec: { hashedRekordV002: { signature: { content: string } } } }
    const signature = Buffer.from(body.spec.hashedRekordV002.signature.content, 'base64')
    const order = 2n ** 252n + 27742317777372353535851937790883648493n
    let s = 0n
    for (let at = 63; at >= 32; at--) s = (s << 8n) | BigInt(signature[at]!)
    let unreduced = s + order
    const raised = Buffer.from(signature)
    for (let at = 32; at < 64; at++) {
      raised[at] = Number(unreduced & 0xffn)
      unreduced >>= 8n
    }
    expect(verifyEd25519ph(rawPublic(fixture.keys.targets), MANIFEST, signature)).toBe(true)
    expect(verifyEd25519ph(rawPublic(fixture.keys.targets), MANIFEST, raised)).toBe(false)
  })
})

describe('a checkpoint body', () => {
  it('is an origin line, a tree size and a root hash, as the client writes and reads it', () => {
    const fixture = scenario()
    expect(checkpointBody(fixture.log.origin, 3, fixture.log.rootHash)).toBe(`${fixture.log.origin}\n3\n${fixture.log.rootHash.toString('base64')}\n`)
    for (const body of [`${fixture.log.origin}\n`, '\n3\nAAAA\n', `${fixture.log.origin}\nthree\nAAAA\n`, `${fixture.log.origin}\n3`]) {
      const note = `${body}\n${signatureLine(fixture.log.origin, NOTE_SIGNATURE, fixture.log.key, body)}`
      expect(refusal(fixture, { ...fixture.bundle, checkpoint: fixture.witness.cosign(note, COSIGNED_AT) }), JSON.stringify(body)).toBe('checkpoint-malformed')
    }
  })
})

describe('the signed-note format', () => {
  it('refuses a key of a signature type the log and its witnesses do not use', () => {
    const fixture = scenario()
    expect(refusalOf(() => parseVerifierKey(verifierKey('other.example.test', 0x02, fixture.keys.other)))).toBe('log-origin-untrusted')
  })

  it('refuses a signature line that is not one, and a root hash in base64 that is not canonical', () => {
    const fixture = scenario()
    expect(refusalOf(() => splitNote(`${fixture.log.origin}\n3\nAAAA\n\nnot a signature line\n`))).toBe('checkpoint-malformed')
    const canonical = fixture.log.rootHash.toString('base64')
    // The last character of 32 bytes in base64 carries four padding bits; setting one keeps the bytes and breaks the form.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const loose = `${canonical.slice(0, 42)}${alphabet[alphabet.indexOf(canonical[42]!) ^ 1]!}=`
    expect(Buffer.from(loose, 'base64').equals(fixture.log.rootHash)).toBe(true)
    expect(Buffer.from(loose, 'base64').byteLength).toBe(32)
    expect(refusalOf(() => parseCheckpoint(`${fixture.log.origin}\n3\n${loose}\n`))).toBe('checkpoint-malformed')
  })

  it('does not count a cosignature line of the wrong length', () => {
    const fixture = scenario()
    const body = `${fixture.log.origin}\n3\n${fixture.log.rootHash.toString('base64')}\n`
    const verifier = parseVerifierKey(fixture.witness.vkey)
    expect(verifySignature(verifier, body, { name: verifier.name, keyHash: verifier.keyHash, signature: Buffer.alloc(64) })).toBe(false)
  })
})
