/**
 * The log-entry keys and logs a trusted root lists (contracts C2 and C18), against the client's offline bundle check and
 * its online check: an entry verifies only when its type is listed and implemented, its key is the listed key of that
 * type and valid for the release, its digest is the type's, and its signature verifies with that key; a root without
 * the list or without `logs` verifies no release; and a bundle's checkpoint verifies only in a log the root lists, with
 * a listed witness's cosignature.
 */
import { createHash, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it } from 'vitest'
import type { LogEntryKey, RootMetadata, SemanticVersion } from '@delorun/contract-release-manifest'
import { verifyBundle } from '../src/bundle.ts'
import { ReleaseLogRefusalError, type ReleaseLogRefusal } from '../src/errors.ts'
import { checkOnline } from '../src/online.ts'
import { COSIGNED_AT, entryBody, FixtureLog, FixtureTransport, FixtureWitness, MANIFEST, scenario, VERSION, type Scenario } from './fixtures.ts'

const NAME = 'delorun-0.1.0.manifest.json'
const SHA256 = createHash('sha256').update(MANIFEST).digest('hex')

/**
 * A new throwaway ECDSA P-256 key.
 * @returns the private key.
 */
function ecdsaKey(): KeyObject {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
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
  return { keyDetails, public: createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64'), status, ...lastRelease === undefined ? {} : { lastRelease: brandString<SemanticVersion>(lastRelease) } }
}

/** What an ECDSA entry may vary. */
interface EcdsaEntry {
  /** The key that signs. */
  readonly signer: KeyObject
  /** The key the entry names, when it is not the signer's. */
  readonly verifier?: KeyObject
  /** The digest algorithm; `SHA2_256` by default. */
  readonly algorithm?: string
  /** The key details; ECDSA P-256 by default. */
  readonly keyDetails?: string
}

/**
 * Append an ECDSA P-256 entry over the manifest to the fixture's log and return its bundle.
 * @param fixture - the fixture.
 * @param entry - what the entry carries.
 * @returns the bundle.
 */
function ecdsaBundle(fixture: Scenario, entry: EcdsaEntry): ReturnType<FixtureLog['bundle']> {
  const index = fixture.log.append(entryBody({
    manifest: MANIFEST,
    signer: entry.signer,
    ...entry.verifier === undefined ? {} : { verifier: entry.verifier },
    algorithm: entry.algorithm ?? 'SHA2_256',
    digest: createHash(entry.algorithm === 'SHA2_512' ? 'sha512' : 'sha256').update(MANIFEST).digest('base64'),
    keyDetails: entry.keyDetails ?? 'PKIX_ECDSA_P256_SHA_256',
    signature: sign('sha256', MANIFEST, { key: entry.signer, dsaEncoding: 'der' }),
  }))
  return fixture.log.bundle(index, NAME, SHA256, fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT))
}

/**
 * The refusal one verification makes.
 * @param root - the trusted root.
 * @param bundle - the bundle.
 * @param version - the release's version.
 * @returns the refusal, or `undefined` when it verified.
 */
function refusal(root: RootMetadata, bundle: ReturnType<FixtureLog['bundle']>, version = VERSION): ReleaseLogRefusal | undefined {
  try {
    verifyBundle(root, version, MANIFEST, version === VERSION ? bundle : { ...bundle, manifest: { ...bundle.manifest, name: `delorun-${version}.manifest.json` } })
  } catch (error) {
    if (error instanceof ReleaseLogRefusalError) return error.refusal
    throw error
  }
  return undefined
}

describe('a root without logEntryKeys or logs', () => {
  it('c18-root-without-log-trust-refused: verifies no release, not even an Ed25519ph entry by its targets key', () => {
    const fixture = scenario()
    expect(refusal(fixture.root, fixture.bundle)).toBeUndefined()
    const { logEntryKeys, ...noKeys } = fixture.root
    expect(logEntryKeys).toBeDefined()
    expect(refusal(noKeys, fixture.bundle)).toBe('entry-key-untrusted')
    expect(refusal(noKeys, ecdsaBundle(fixture, { signer: ecdsaKey() }))).toBe('entry-key-untrusted')
    const { logs, ...noLogs } = fixture.root
    expect(logs).toEqual([fixture.root.log])
    expect(refusal(noLogs, fixture.bundle)).toBe('log-origin-untrusted')
  })
})

describe('a root with logEntryKeys', () => {
  it('verifies an entry of each listed type by its listed key', () => {
    const fixture = scenario()
    const ecdsa = ecdsaKey()
    const root = { ...fixture.root, logEntryKeys: [listed('PKIX_ED25519_PH', fixture.keys.targets), listed('PKIX_ECDSA_P256_SHA_256', ecdsa)] }
    expect(refusal(root, fixture.bundle)).toBeUndefined()
    expect(refusal(root, ecdsaBundle(fixture, { signer: ecdsa }))).toBeUndefined()
  })

  it('c18-listed-entries-only: a root that lists only an ECDSA key refuses an Ed25519ph entry by its targets key', () => {
    const fixture = scenario()
    const ecdsaOnly = { ...fixture.root, logEntryKeys: [listed('PKIX_ECDSA_P256_SHA_256', ecdsaKey())] }
    expect(refusal(ecdsaOnly, fixture.bundle)).toBe('entry-type-refused')
  })

  it('c18-unlisted-entry-type-refused: refuses an entry whose type the root does not list, whatever its signature', () => {
    const fixture = scenario()
    const ecdsa = ecdsaKey()
    const edOnly = { ...fixture.root, logEntryKeys: [listed('PKIX_ED25519_PH', fixture.keys.targets)] }
    expect(refusal(edOnly, ecdsaBundle(fixture, { signer: ecdsa }))).toBe('entry-type-refused')
    const ecdsaOnly = { ...fixture.root, logEntryKeys: [listed('PKIX_ECDSA_P256_SHA_256', ecdsa)] }
    expect(refusal(ecdsaOnly, fixture.bundle)).toBe('entry-type-refused')
  })

  it('refuses a listed type this client does not implement', () => {
    const fixture = scenario()
    const ecdsa = ecdsaKey()
    const root = { ...fixture.root, logEntryKeys: [listed('PKIX_ED25519_PH', fixture.keys.targets), listed('PKIX_FUTURE_TYPE', ecdsa)] }
    expect(refusal(root, ecdsaBundle(fixture, { signer: ecdsa, keyDetails: 'PKIX_FUTURE_TYPE' }))).toBe('entry-type-refused')
  })

  it('c18-listed-type-other-key-refused: refuses an entry of a listed type by a key the root does not list', () => {
    const fixture = scenario()
    const ecdsa = ecdsaKey()
    const other = ecdsaKey()
    const root = { ...fixture.root, logEntryKeys: [listed('PKIX_ED25519_PH', fixture.keys.targets), listed('PKIX_ECDSA_P256_SHA_256', ecdsa)] }
    expect(refusal(root, ecdsaBundle(fixture, { signer: other }))).toBe('entry-key-untrusted')
    // The listed key named, another key's signature: the signature does not verify with the listed key.
    expect(refusal(root, ecdsaBundle(fixture, { signer: other, verifier: ecdsa }))).toBe('entry-signature-invalid')
    // An Ed25519ph entry by a key that is no listed Ed25519ph key, though the root lists it as a targets key.
    const listedOther = { ...fixture.root, logEntryKeys: [listed('PKIX_ED25519_PH', fixture.keys.other)] }
    expect(refusal(listedOther, fixture.bundle)).toBe('entry-key-untrusted')
  })

  it('c18-revoked-entry-key-refused: refuses a revoked key for every release, an old one too, whatever lastRelease says', () => {
    const fixture = scenario()
    const ecdsa = ecdsaKey()
    const bundle = ecdsaBundle(fixture, { signer: ecdsa })
    const ed = listed('PKIX_ED25519_PH', fixture.keys.targets)
    const revoked = { ...fixture.root, logEntryKeys: [ed, { ...listed('PKIX_ECDSA_P256_SHA_256', ecdsa, 'revoked'), lastRelease: brandString<SemanticVersion>('9.9.9') }] }
    expect(refusal(revoked, bundle)).toBe('entry-key-untrusted')
    expect(refusal(revoked, bundle, '0.0.1')).toBe('entry-key-untrusted')
  })

  it('c18-retired-entry-key-by-signed-version: keeps a retired key to its last release, read from the signed manifest\'s version', () => {
    const fixture = scenario()
    const ecdsa = ecdsaKey()
    const bundle = ecdsaBundle(fixture, { signer: ecdsa })
    const retired = { ...fixture.root, logEntryKeys: [listed('PKIX_ED25519_PH', fixture.keys.targets), listed('PKIX_ECDSA_P256_SHA_256', ecdsa, 'retired', VERSION)] }
    expect(refusal(retired, bundle)).toBeUndefined()
    expect(refusal(retired, bundle, '0.2.0')).toBe('entry-key-untrusted')
    // A bundle that claims the old release for the 0.2.0 manifest: the version is the signed manifest's, never the bundle's.
    expect(bundle.manifest.name).toBe(NAME)
    let claimed: ReleaseLogRefusal | undefined
    try {
      verifyBundle(retired, '0.2.0', MANIFEST, bundle)
    } catch (error) {
      if (!(error instanceof ReleaseLogRefusalError)) throw error
      claimed = error.refusal
    }
    expect(claimed).toBe('manifest-digest-mismatch')
  })

  it('refuses an entry whose digest algorithm is not its type\'s, and one whose digest is another file\'s', () => {
    const fixture = scenario()
    const ecdsa = ecdsaKey()
    const root = { ...fixture.root, logEntryKeys: [listed('PKIX_ECDSA_P256_SHA_256', ecdsa)] }
    expect(refusal(root, ecdsaBundle(fixture, { signer: ecdsa, algorithm: 'SHA2_512' }))).toBe('entry-type-refused')
    const index = fixture.log.append(entryBody({ manifest: MANIFEST, signer: ecdsa, algorithm: 'SHA2_256', digest: createHash('sha256').update('another file').digest('base64'), keyDetails: 'PKIX_ECDSA_P256_SHA_256', signature: sign('sha256', MANIFEST, { key: ecdsa, dsaEncoding: 'der' }) }))
    const bundle = fixture.log.bundle(index, NAME, SHA256, fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT))
    expect(refusal(root, bundle)).toBe('manifest-digest-mismatch')
  })
})

describe('the logs a root lists', () => {
  /**
   * A fixture whose manifest entry is in a second log with its own key, the shard a release was logged in before a
   * rotation moved `log`.
   * @returns the fixture, the earlier log and the bundle in it.
   */
  function earlierShard(): { fixture: Scenario, earlier: FixtureLog, bundle: ReturnType<FixtureLog['bundle']> } {
    const fixture = scenario()
    const earlier = new (class extends FixtureLog {
      override readonly origin = 'earlier.example.test'
    })()
    const index = earlier.submit(MANIFEST, fixture.keys.targets)
    return { fixture, earlier, bundle: earlier.bundle(index, NAME, SHA256, fixture.witness.cosign(earlier.checkpoint(), COSIGNED_AT)) }
  }

  it('c18-unlisted-log-origin-refused: refuses a checkpoint of a log the root does not list', () => {
    const { fixture, bundle } = earlierShard()
    expect(refusal(fixture.root, bundle)).toBe('log-origin-untrusted')
  })

  it('verifies a bundle of an earlier log the root lists, with that log\'s key and not another\'s', () => {
    const { fixture, earlier, bundle } = earlierShard()
    const root = { ...fixture.root, logs: [fixture.root.log, { origin: earlier.origin, vkey: earlier.vkey }] }
    expect(refusal(root, bundle)).toBeUndefined()
    expect(refusal(root, fixture.bundle)).toBeUndefined()
    const wrongKey = { ...fixture.root, logs: [fixture.root.log, { origin: earlier.origin, vkey: fixture.log.vkey }] }
    expect(refusal(wrongKey, bundle)).not.toBeUndefined()
  })

  it('c18-listed-log-needs-witness: refuses a checkpoint of a listed log that no listed witness cosigned', () => {
    const { fixture, earlier } = earlierShard()
    const root = { ...fixture.root, logs: [fixture.root.log, { origin: earlier.origin, vkey: earlier.vkey }] }
    const index = earlier.submit(MANIFEST, fixture.keys.targets)
    expect(refusal(root, earlier.bundle(index, NAME, SHA256, earlier.checkpoint()))).toBe('witness-cosignature-missing')
    const stranger = new FixtureWitness(fixture.witness.name)
    expect(refusal(root, earlier.bundle(index, NAME, SHA256, stranger.cosign(earlier.checkpoint(), COSIGNED_AT)))).toBe('witness-cosignature-missing')
  })

  it('leaves a release of an earlier log unchecked online, without asking the current log for a proof', async () => {
    const { fixture, earlier, bundle } = earlierShard()
    const root = { ...fixture.root, logs: [fixture.root.log, { origin: earlier.origin, vkey: earlier.vkey }] }
    const verified = verifyBundle(root, VERSION, MANIFEST, bundle)
    const transport = new FixtureTransport()
    transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
    const verdict = await checkOnline({ root, bundle: verified, stored: undefined, transport, now: COSIGNED_AT + 60 })
    expect(verdict).toMatchObject({ ok: false, kind: 'unreachable' })
    expect(transport.asked).toEqual([])
  })
})
