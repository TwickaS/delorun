/**
 * The offline verification of a release-log bundle (contract C18, `Verifying a bundle`): the five steps against the
 * client's own trusted root, and every refusal each step makes — a wrong manifest, an entry of another type or by
 * another key, a signature that does not verify, a proof or a checkpoint that does not hold, a cosignature the root's
 * witnesses did not make, an untrusted root, and a bundle or note that does not read at all. Each case removes one
 * check, so a spec fails whenever that check goes away.
 */
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it } from 'vitest'
import { RELEASE_LOG_BUNDLE_SIZE_LIMIT, type ReleaseLogBundle } from '@delo/contract-release-log'
import type { SemanticVersion, Sha256Hex } from '@delo/contract-release-manifest'
import { BundleSchema, checkBundle, readBundle, verifyBundle } from '../src/bundle.ts'
import { RELEASE_LOG_REFUSALS, ReleaseLogRefusalError, type ReleaseLogRefusal } from '../src/errors.ts'
import { keyIdOf } from '../src/entry.ts'
import {
  COSIGNED_AT,
  entryBody,
  FixtureWitness,
  MANIFEST,
  NOTE_COSIGNATURE,
  NOTE_SIGNATURE,
  rawPublic,
  scenario,
  signatureLine,
  verifierKey,
  VERSION,
  type Scenario,
} from './fixtures.ts'

const SHA256 = createHash('sha256').update(MANIFEST).digest('hex')

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
    expect(refusalOf(() => readBundle(Buffer.from(text.replace('{"schema"', '{"schema":"delo.release-log-bundle/1","schema"'))))).toBe('bundle-malformed')
  })

  it('refuses a bundle with a missing part or another schema', () => {
    const fixture = scenario()
    const { inclusion: _inclusion, ...withoutInclusion } = fixture.bundle
    expect(refusalOf(() => readBundle(Buffer.from(JSON.stringify(withoutInclusion))))).toBe('bundle-malformed')
    expect(refusalOf(() => readBundle(Buffer.from(JSON.stringify({ ...fixture.bundle, schema: 'delo.release-log-bundle/2' }))))).toBe('bundle-malformed')
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

  it('refuses an entry whose hashedrekord names another digest, though its signature covers the manifest', () => {
    const fixture = scenario()
    const log = fixture.log
    const index = log.append(entryBody({ manifest: MANIFEST, signer: fixture.keys.targets, digest: createHash('sha512').update('other bytes').digest('base64') }))
    const bundle = log.bundle(index, 'delorun-0.1.0.manifest.json', SHA256, fixture.witness.cosign(log.checkpoint(), COSIGNED_AT))
    expect(refusal(fixture, bundle)).toBe('manifest-digest-mismatch')
  })
})

describe('step 2: the entry is the manifest\'s, signed by a trusted targets key', () => {
  it('refuses an entry by a key the root does not list as a targets key, which is the identity check', () => {
    const fixture = scenario()
    const log = fixture.log
    const index = log.append(entryBody({ manifest: MANIFEST, signer: fixture.keys.other }))
    const bundle = log.bundle(index, 'delorun-0.1.0.manifest.json', SHA256, fixture.witness.cosign(log.checkpoint(), COSIGNED_AT))
    expect(refusal(fixture, bundle)).toBe('entry-key-untrusted')
  })

  it('refuses an entry signed by a targets key the root lists under another key\'s id', () => {
    const fixture = scenario()
    const root = { ...fixture.root, roles: { ...fixture.root.roles, targets: { keys: [{ keyid: keyIdOf(rawPublic(fixture.keys.other)), status: 'active' as const }], threshold: 1 } } }
    expect(refusalOf(() => verifyBundle(root, VERSION, MANIFEST, fixture.bundle))).toBe('entry-key-untrusted')
  })

  it('refuses an entry whose Ed25519ph signature does not verify with the targets key', () => {
    const fixture = scenario()
    const log = fixture.log
    const forged = entryBody({ manifest: MANIFEST, signer: fixture.keys.targets })
    const index = log.append(entryBody({ manifest: MANIFEST, signer: fixture.keys.targets, signature: createHash('sha512').update(forged).digest() }))
    const bundle = log.bundle(index, 'delorun-0.1.0.manifest.json', SHA256, fixture.witness.cosign(log.checkpoint(), COSIGNED_AT))
    expect(refusal(fixture, bundle)).toBe('entry-signature-invalid')
  })

  it('refuses a revoked targets key, and keeps a retired key to its last release', () => {
    const fixture = scenario()
    const id = keyIdOf(rawPublic(fixture.keys.targets))
    const revoked = { ...fixture.root, roles: { ...fixture.root.roles, targets: { keys: [{ keyid: id, status: 'revoked' as const }], threshold: 1 } } }
    expect(refusalOf(() => verifyBundle(revoked, VERSION, MANIFEST, fixture.bundle))).toBe('entry-key-untrusted')
    const retired = { ...fixture.root, roles: { ...fixture.root.roles, targets: { keys: [{ keyid: id, status: 'retired' as const, lastRelease: brandString<SemanticVersion>(VERSION) }], threshold: 1 } } }
    expect(refusalOf(() => verifyBundle(retired, VERSION, MANIFEST, fixture.bundle))).toBeUndefined()
    expect(refusalOf(() => verifyBundle(retired, '0.2.0', MANIFEST, fixture.bundle))).toBe('entry-key-untrusted')
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
    const root = { ...fixture.root, log: { origin: fixture.log.origin, vkey: 'not a verifier key' } }
    expect(refusalOf(() => verifyBundle(root, VERSION, MANIFEST, fixture.bundle))).toBe('log-origin-untrusted')
  })

  it('refuses a root whose log key is not a 32-byte Ed25519 note key', () => {
    const fixture = scenario()
    const root = { ...fixture.root, log: { origin: fixture.log.origin, vkey: `${fixture.log.origin}+00000000+AQ==` } }
    expect(refusalOf(() => verifyBundle(root, VERSION, MANIFEST, fixture.bundle))).toBe('log-origin-untrusted')
  })

  it('refuses a root whose witness key hash is not the hash of its key', () => {
    const fixture = scenario()
    const vkey = fixture.witness.vkey.replace(/\+([0-9a-f]{8})\+/u, '+00000000+')
    const root = { ...fixture.root, witnesses: { keys: [{ name: fixture.witness.name, vkey }], threshold: 1 } }
    expect(refusalOf(() => verifyBundle(root, VERSION, MANIFEST, fixture.bundle))).toBe('log-origin-untrusted')
  })

  it('refuses a root whose targets key is not 32-byte base64', () => {
    const fixture = scenario()
    const root = { ...fixture.root, keys: { ...fixture.root.keys, [keyIdOf(rawPublic(fixture.keys.targets)).toString()]: { algorithm: 'ed25519' as const, public: 'short' } } }
    expect(refusalOf(() => verifyBundle(root, VERSION, MANIFEST, fixture.bundle))).toBe('entry-key-untrusted')
  })

  it('refuses a root that names a targets key it does not list', () => {
    const fixture = scenario()
    const absent = { ...fixture.root, keys: Object.fromEntries(Object.entries(fixture.root.keys).filter(([id]) => id !== keyIdOf(rawPublic(fixture.keys.targets)).toString())) }
    expect(refusalOf(() => verifyBundle(absent, VERSION, MANIFEST, fixture.bundle))).toBe('entry-key-untrusted')
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
