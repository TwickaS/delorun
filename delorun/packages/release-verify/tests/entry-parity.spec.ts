/**
 * One denial table for contract C18 step 2, run against both verifiers of a log entry: the client's
 * (`verifyEntryIdentity` after `readEntryBody`) and the signing tool's (`verifyEntryBody` of release-formats), so the
 * tool never submits an entry a client would refuse and a client never accepts one the tool's rule refuses. Every key
 * is a throwaway one.
 */
import { createHash, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it } from 'vitest'
import type { LogEntryKey, RootMetadata, SemanticVersion } from '@delorun/contract-release-manifest'
import { verifyEntryBody } from '@delorun/release-formats/log/bundle'
import { signLogEntry } from '@delorun/release-formats/log/entry-keys'
import { readEntryBody, verifyEntryIdentity } from '../src/entry.ts'
import { scenario } from './fixtures.ts'

const MANIFEST = Buffer.from('{"signed":{"schema":"delorun.release-manifest/1","version":"0.2.0"},"signatures":[]}\n')
const VERSION = '0.2.0'
const ECDSA = 'PKIX_ECDSA_P256_SHA_256'
const ED25519PH = 'PKIX_ED25519_PH'

const targets = generateKeyPairSync('ed25519').privateKey
const ecdsa = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
const otherEcdsa = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey

/**
 * A key's DER SubjectPublicKeyInfo.
 * @param key - the key.
 * @returns the bytes.
 */
function spki(key: KeyObject): Buffer {
  return createPublicKey(key).export({ format: 'der', type: 'spki' })
}

/**
 * The compressed-point SubjectPublicKeyInfo of a P-256 key: the same key as {@link spki}'s, in other bytes.
 * @param key - the key.
 * @returns the bytes.
 */
function compressedSpki(key: KeyObject): Buffer {
  const jwk = createPublicKey(key).export({ format: 'jwk' })
  const y = Buffer.from(jwk.y!, 'base64url')
  return Buffer.concat([Buffer.from('3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex'), Buffer.from([0x02 | (y[31]! & 1)]), Buffer.from(jwk.x!, 'base64url')])
}

/**
 * A log-entry key as a root lists it.
 * @param keyDetails - the entry key type.
 * @param key - the key.
 * @param status - its status.
 * @param lastRelease - a retired key's last release.
 * @returns the entry.
 */
function listed(keyDetails: string, key: KeyObject, status: LogEntryKey['status'] = 'active', lastRelease?: string): LogEntryKey {
  return { keyDetails, public: spki(key).toString('base64'), status, ...lastRelease === undefined ? {} : { lastRelease: brandString<SemanticVersion>(lastRelease) } }
}

/** What an entry body carries. */
interface Entry {
  readonly keyDetails: string
  readonly algorithm: 'SHA2_256' | 'SHA2_512'
  readonly publicKey: Buffer
  readonly signature: Buffer
}

/**
 * A Rekor v2 entry body over {@link MANIFEST}.
 * @param entry - its key details, digest algorithm, public key and signature.
 * @returns the body's bytes.
 */
function body(entry: Entry): Buffer {
  const digest = createHash(entry.algorithm === 'SHA2_512' ? 'sha512' : 'sha256').update(MANIFEST).digest('base64')
  return Buffer.from(JSON.stringify({ apiVersion: '0.0.2', kind: 'hashedrekord', spec: { hashedRekordV002: { data: { algorithm: entry.algorithm, digest }, signature: { content: entry.signature.toString('base64'), verifier: { publicKey: { rawBytes: entry.publicKey.toString('base64') }, keyDetails: entry.keyDetails } } } } }))
}

/** A valid ECDSA P-256 entry by a key. */
const ecdsaEntry = (key: KeyObject): Entry => ({ keyDetails: ECDSA, algorithm: 'SHA2_256', publicKey: spki(key), signature: signLogEntry(ECDSA, key, MANIFEST) })

/** A valid Ed25519ph entry by the targets key. */
const ed25519phEntry: Entry = { keyDetails: ED25519PH, algorithm: 'SHA2_512', publicKey: spki(targets), signature: signLogEntry(ED25519PH, targets, MANIFEST) }

const BOTH = [listed(ECDSA, ecdsa), listed(ED25519PH, targets)]

/** One row: the root's `logEntryKeys` (`undefined` for a root without them), the entry, and the expected outcome. */
const TABLE: ReadonlyArray<readonly [string, readonly LogEntryKey[] | undefined, Entry, 'verifies' | 'refused']> = [
  ['an ECDSA entry by the listed key', BOTH, ecdsaEntry(ecdsa), 'verifies'],
  ['an Ed25519ph entry by the listed targets key', BOTH, ed25519phEntry, 'verifies'],
  ['a revoked key', [listed(ECDSA, ecdsa, 'revoked'), listed(ED25519PH, targets)], ecdsaEntry(ecdsa), 'refused'],
  ['a key retired before the release', [listed(ECDSA, ecdsa, 'retired', '0.1.0'), listed(ED25519PH, targets)], ecdsaEntry(ecdsa), 'refused'],
  ['a type the root does not list', [listed(ECDSA, ecdsa)], ed25519phEntry, 'refused'],
  ['a type no verifier implements', BOTH, { ...ed25519phEntry, keyDetails: 'PKIX_ED25519', signature: sign(null, MANIFEST, targets) }, 'refused'],
  ['a root without logEntryKeys', undefined, ecdsaEntry(ecdsa), 'refused'],
  ['another key of a listed type', [listed(ECDSA, ecdsa)], ecdsaEntry(otherEcdsa), 'refused'],
  ['a raw 64-byte r || s signature by the listed key', BOTH, { ...ecdsaEntry(ecdsa), signature: sign('sha256', MANIFEST, { key: ecdsa, dsaEncoding: 'ieee-p1363' }) }, 'refused'],
  ['a signature over SHA-256(manifest) instead of the manifest bytes', BOTH, { ...ecdsaEntry(ecdsa), signature: sign('sha256', createHash('sha256').update(MANIFEST).digest(), { key: ecdsa, dsaEncoding: 'der' }) }, 'refused'],
  ['the listed key\'s compressed-point SPKI', BOTH, { ...ecdsaEntry(ecdsa), publicKey: compressedSpki(ecdsa) }, 'refused'],
]

/**
 * The outcome of one verifier.
 * @param verify - the verifier.
 * @returns `verifies` or `refused`.
 */
function outcome(verify: () => unknown): 'verifies' | 'refused' {
  try {
    verify()
    return 'verifies'
  } catch (_refused) {
    // Each verifier refuses by throwing its own refusal error.
    return 'refused'
  }
}

describe('c18-entry-verifier-parity: both log-entry verifiers give the same outcome on one denial table', () => {
  it.each(TABLE)('%s', (_name, logEntryKeys, entry, expected) => {
    const { logEntryKeys: _dropped, ...bare } = scenario().root
    const root: RootMetadata = logEntryKeys === undefined ? bare : { ...bare, logEntryKeys }
    const bytes = body(entry)
    expect(outcome(() => verifyEntryIdentity(root, VERSION, MANIFEST, readEntryBody(bytes)))).toBe(expected)
    expect(outcome(() => verifyEntryBody(root, MANIFEST, VERSION, bytes))).toBe(expected)
  })

  it('reads the compressed-point SPKI as the same key, so only the byte comparison refuses it', () => {
    const fromCompressed = createPublicKey({ key: compressedSpki(ecdsa), format: 'der', type: 'spki' })
    expect(fromCompressed.equals(createPublicKey(ecdsa))).toBe(true)
  })
})
