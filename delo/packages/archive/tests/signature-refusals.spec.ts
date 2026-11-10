/**
 * Proves the signature module refuses a `signature.json` the format does not
 * define, reports a signature that does not verify as an invalid signature, and
 * decides the verified state only from a valid signature by a key the home
 * vouches for or the person confirmed by its key (not by its identifier alone).
 * It also proves a key that is not an Ed25519 public key has no raw encoding.
 */
import { createHash, createPublicKey, createSecretKey } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  archiveOrigin,
  checkArchiveSignature,
  encodePublicKey,
  keyFingerprint,
  parseSignature,
  signManifest,
  verifyArchiveSignature,
} from '../src/index.ts'
import { refusal } from './refusals.ts'
import { makeKey, utf8 } from './support.ts'

/** The manifest bytes every signature in this spec covers. */
const MANIFEST = utf8('{"manifest":true}')

describe('parseSignature', () => {
  it('parses the three fields the format defines', () => {
    const document = { algorithm: 'ed25519', homeKeyId: 'home-key', signature: 'c2ln' }

    expect(parseSignature(utf8(JSON.stringify(document)))).toEqual(document)
  })

  it.each([
    ['text that is not UTF-8', new Uint8Array([0xff, 0xfe])],
    ['text that is not JSON', utf8('not json')],
    ['a JSON array', utf8('[]')],
    ['JSON null', utf8('null')],
    ['a field the format does not define', utf8('{"algorithm":"ed25519","homeKeyId":"k","signature":"s","extra":1}')],
    ['an empty key identifier', utf8('{"algorithm":"ed25519","homeKeyId":"","signature":"s"}')],
    ['a key identifier that is not text', utf8('{"algorithm":"ed25519","homeKeyId":7,"signature":"s"}')],
    ['an empty signature', utf8('{"algorithm":"ed25519","homeKeyId":"k","signature":""}')],
    ['a signature that is not text', utf8('{"algorithm":"ed25519","homeKeyId":"k","signature":7}')],
  ])('refuses %s', (_name, bytes) => {
    expect(refusal(() => parseSignature(bytes)).code).toBe('ARCHIVE_SCHEMA_INVALID')
  })

  it('refuses another algorithm', () => {
    const error = refusal(() => parseSignature(utf8('{"algorithm":"rsa","homeKeyId":"k","signature":"s"}')))

    expect(error.code).toBe('ARCHIVE_UNSUPPORTED_VERSION')
    expect(error.message).toContain('"rsa"')
  })
})

describe('verifyArchiveSignature', () => {
  it('accepts the origin key signature over the manifest bytes', () => {
    const key = makeKey()
    const signature = signManifest(MANIFEST, 'home-key', key.privateKey)

    expect(() => verifyArchiveSignature({ manifestBytes: MANIFEST, origin: { homeKeyId: 'home-key', publicKey: key.publicKey }, signature })).not.toThrow()
  })

  it('refuses a signature that names another home key than the manifest declares', () => {
    const key = makeKey()
    const signature = signManifest(MANIFEST, 'other-key', key.privateKey)

    const error = refusal(() => verifyArchiveSignature({ manifestBytes: MANIFEST, origin: { homeKeyId: 'home-key', publicKey: key.publicKey }, signature }))

    expect(error.code).toBe('ARCHIVE_SIGNATURE_INVALID')
    expect(error.message).toContain('does not declare')
  })

  it('refuses an origin key that is not an Ed25519 public key', () => {
    const signature = signManifest(MANIFEST, 'home-key', makeKey().privateKey)

    const error = refusal(() => verifyArchiveSignature({ manifestBytes: MANIFEST, origin: { homeKeyId: 'home-key', publicKey: 'AAAA' }, signature }))

    expect(error.code).toBe('ARCHIVE_SIGNATURE_INVALID')
    expect(error.message).toContain('not an Ed25519 public key')
  })

  it.each([
    ['empty', ''],
    ['too short', 'YWJj'],
  ])('refuses a signature that is %s', (_name, encoded) => {
    const key = makeKey()

    const error = refusal(() => verifyArchiveSignature({
      manifestBytes: MANIFEST,
      origin: { homeKeyId: 'home-key', publicKey: key.publicKey },
      signature: { algorithm: 'ed25519', homeKeyId: 'home-key', signature: encoded },
    }))

    expect(error.code).toBe('ARCHIVE_SIGNATURE_INVALID')
  })

  it('refuses a signature over other bytes than the manifest', () => {
    const key = makeKey()
    const signature = signManifest(utf8('{"manifest":false}'), 'home-key', key.privateKey)

    const error = refusal(() => verifyArchiveSignature({ manifestBytes: MANIFEST, origin: { homeKeyId: 'home-key', publicKey: key.publicKey }, signature }))

    expect(error.message).toContain('does not verify')
  })
})

describe('checkArchiveSignature', () => {
  const key = makeKey()
  const origin = { homeKeyId: 'home-key', publicKey: key.publicKey }
  const signature = signManifest(MANIFEST, 'home-key', key.privateKey)

  it('reports an archive without a signature as unverified', () => {
    expect(checkArchiveSignature({ manifestBytes: MANIFEST, origin })).toEqual({ state: 'unverified', reason: 'absent' })
  })

  it('reports a signature that does not verify as unverified, whatever the home trusts', () => {
    const forged = signManifest(MANIFEST, 'home-key', makeKey().privateKey)

    expect(checkArchiveSignature({ manifestBytes: MANIFEST, origin, signature: forged, trustedPublicKeys: [key.publicKey] }))
      .toEqual({ state: 'unverified', reason: 'signature-invalid' })
  })

  it('reports a valid signature by a key nobody vouches for as unverified', () => {
    expect(checkArchiveSignature({ manifestBytes: MANIFEST, origin, signature })).toEqual({ state: 'unverified', reason: 'key-not-trusted' })
  })

  it('reports a valid signature by a key the home vouches for as verified', () => {
    expect(checkArchiveSignature({ manifestBytes: MANIFEST, origin, signature, trustedPublicKeys: [key.publicKey] })).toEqual({ state: 'verified' })
  })

  it('reports a valid signature by the key the person confirmed as verified, with or without the identifier', () => {
    expect(checkArchiveSignature({ manifestBytes: MANIFEST, origin, signature, confirmedPublicKey: key.publicKey })).toEqual({ state: 'verified' })
    expect(checkArchiveSignature({ manifestBytes: MANIFEST, origin, signature, confirmedPublicKey: key.publicKey, confirmedHomeKeyId: 'home-key' })).toEqual({ state: 'verified' })
  })

  it('does not accept a confirmation of the key under another identifier', () => {
    expect(checkArchiveSignature({ manifestBytes: MANIFEST, origin, signature, confirmedPublicKey: key.publicKey, confirmedHomeKeyId: 'other-key' }))
      .toEqual({ state: 'unverified', reason: 'key-not-trusted' })
  })

  it('does not accept a confirmation of the identifier alone', () => {
    expect(checkArchiveSignature({ manifestBytes: MANIFEST, origin, signature, confirmedHomeKeyId: 'home-key' }))
      .toEqual({ state: 'unverified', reason: 'key-not-trusted' })
  })
})

describe('key encodings', () => {
  it('refuses a key that has no raw Ed25519 form', () => {
    expect(() => encodePublicKey(createSecretKey(Buffer.alloc(32)))).toThrow('not an Ed25519 public key')
  })

  it('builds an origin from an identifier and a public key', () => {
    const key = makeKey()

    expect(archiveOrigin('home-key', createPublicKey(key.privateKey))).toEqual({ homeKeyId: 'home-key', publicKey: key.publicKey })
  })

  it('fingerprints the raw public key with SHA-256 in base64url', () => {
    const key = makeKey()

    expect(keyFingerprint(key.publicKey)).toBe(createHash('sha256').update(Buffer.from(key.publicKey, 'base64url')).digest('base64url'))
  })
})
