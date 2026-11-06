/**
 * Client verification of signed release files (contract C2's `c02-refuses-expired-timestamp` and
 * `c02-refuses-replayed-manifest`, with the tampered archive, replayed timestamp, key-role, rotation and file-format
 * refusals around them), over throwaway keys generated in the test.
 */
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { RootMetadata, TimestampMetadata } from '@delo/contract-release-manifest'
import { semanticVersion } from '../../src/brands.ts'
import { publicKeyEntry, signEnvelope } from '../../src/sign/envelope.ts'
import { canonicalJson, parseStrictJson, toJsonValue } from '../../src/sign/json.ts'
import { nextTimestamp } from '../../src/sign/timestamp.ts'
import { adoptNextRoot, checkFileRef, readTrustedRoot, verifyChannelManifest, verifySignedManifest, verifyTimestamp } from '../../src/sign/verify.ts'
import { manifestContent, rootFile, throwawayKeys, type Keys } from './fixture.ts'

const ISSUED = Date.parse('2026-11-06T12:00:00Z') / 1000

function envelopeBytes(signed: object, keys: Parameters<typeof signEnvelope>[1]): Buffer {
  return Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(signed), signatures: [] }, keys), undefined, 2)}\n`)
}

interface Published {
  readonly keys: Keys
  readonly root: { metadata: RootMetadata, bytes: Buffer }
  readonly archive: Buffer
  readonly manifestBytes: Buffer
  readonly timestamp: { metadata: TimestampMetadata, bytes: Buffer }
}

function publish(version = '0.1.0', keys: Keys = throwawayKeys()): Published {
  const root = rootFile(keys)
  const archive = Buffer.from(`runtime archive ${version}`)
  const manifestBytes = envelopeBytes(manifestContent(version, archive), [keys.targets])
  const metadata = nextTimestamp(root, undefined, { channel: 'stable', name: `delorun-${version}.manifest.json`, bytes: manifestBytes }, ISSUED)
  return { keys, root, archive, manifestBytes, timestamp: { metadata, bytes: envelopeBytes(metadata, [keys.timestamp]) } }
}

describe('release verification', () => {
  it('verifies the channel manifest with the targets key and each file against it', () => {
    const release = publish()
    const timestamp = verifyTimestamp(release.root.metadata, release.timestamp.bytes, ISSUED + 60)
    const verified = verifyChannelManifest(release.root.metadata, timestamp, 'stable', release.manifestBytes)
    expect(verified.version).toBe('0.1.0')
    expect(() => checkFileRef(verified.runtime['linux-x64'].archive, release.archive)).not.toThrow()
  })

  it('refuses a tampered archive', () => {
    const release = publish()
    const verified = verifySignedManifest(release.root.metadata, release.manifestBytes)
    const tampered = Buffer.from(release.archive)
    tampered.writeUInt8(tampered.readUInt8(0) ^ 1, 0)
    expect(() => checkFileRef(verified.runtime['linux-x64'].archive, tampered)).toThrow(/has SHA-256 [0-9a-f]{64}; signed metadata lists/u)
    expect(() => checkFileRef(verified.runtime['linux-x64'].archive, Buffer.concat([release.archive, Buffer.from('x')]))).toThrow(/bytes; signed metadata lists/u)
  })

  it('refuses timestamp metadata one second past its expiry, naming the expiry and the local clock', () => {
    const release = publish()
    const expires = Date.parse(release.timestamp.metadata.expires) / 1000
    expect(() => verifyTimestamp(release.root.metadata, release.timestamp.bytes, expires)).not.toThrow()
    expect(() => verifyTimestamp(release.root.metadata, release.timestamp.bytes, expires + 1))
      .toThrow(`timestamp 1 expired at ${release.timestamp.metadata.expires}; this machine's clock reads ${new Date((expires + 1) * 1000).toISOString().replace('.000Z', 'Z')}`)
  })

  it('refuses a validly signed older manifest that the fresh timestamp does not name', () => {
    const keys = throwawayKeys()
    const older = publish('0.1.0', keys)
    const newer = publish('0.2.0', keys)
    const timestamp = verifyTimestamp(newer.root.metadata, newer.timestamp.bytes, ISSUED + 60)
    expect(verifySignedManifest(newer.root.metadata, older.manifestBytes).version).toBe('0.1.0')
    expect(() => verifyChannelManifest(newer.root.metadata, timestamp, 'stable', older.manifestBytes)).toThrow(/is not the stable channel's current manifest/u)
  })

  it('refuses a replayed timestamp with a lower version, and a different file with the stored version', () => {
    const release = publish()
    const second = nextTimestamp(release.root, release.timestamp.metadata, undefined, ISSUED + 86_400)
    const secondBytes = envelopeBytes(second, [release.keys.timestamp])
    expect(() => verifyTimestamp(release.root.metadata, release.timestamp.bytes, ISSUED + 90_000, { version: 2, bytes: secondBytes })).toThrow(/version 1 is lower than the stored version 2/u)
    const resigned = envelopeBytes({ ...second, issued: second.issued }, [release.keys.timestamp, generateKeyPairSync('ed25519').privateKey])
    expect(() => verifyTimestamp(release.root.metadata, resigned, ISSUED + 90_000, { version: 2, bytes: secondBytes })).toThrow(/differs from the stored file/u)
  })

  it('refuses a manifest signed by a key outside the targets role, a timestamp signed by the targets key, and a revoked targets key', () => {
    const release = publish()
    const outsider = envelopeBytes(manifestContent('0.1.0', release.archive), [release.keys.timestamp])
    expect(() => verifySignedManifest(release.root.metadata, outsider)).toThrow(/0 valid signatures/u)
    expect(() => verifyTimestamp(release.root.metadata, envelopeBytes(release.timestamp.metadata, [release.keys.targets]), ISSUED)).toThrow(/0 valid signatures/u)
    const targetsId = publicKeyEntry(release.keys.targets).keyid
    const revoked = rootFile(release.keys, { roles: { ...release.root.metadata.roles, targets: { keys: [{ keyid: targetsId, status: 'revoked' }], threshold: 1 } } }).metadata
    expect(() => verifySignedManifest(revoked, release.manifestBytes)).toThrow(/0 valid signatures/u)
    const retired = rootFile(release.keys, { roles: { ...release.root.metadata.roles, targets: { keys: [{ keyid: targetsId, status: 'retired', lastRelease: semanticVersion('0.1.0') }], threshold: 1 } } }).metadata
    expect(verifySignedManifest(retired, release.manifestBytes).version).toBe('0.1.0')
    expect(() => verifySignedManifest(retired, envelopeBytes(manifestContent('0.1.1', release.archive), [release.keys.targets]))).toThrow(/0 valid signatures/u)
  })

  it('adopts the next root only when both the previous and its own root keys sign it', () => {
    const keys = throwawayKeys()
    const first = rootFile(keys)
    const trusted = readTrustedRoot(first.bytes)
    const newRoot = generateKeyPairSync('ed25519').privateKey
    const rotated: Keys = { ...keys, root: newRoot }
    const both = rootFile(rotated, { version: 2 }, [keys.root, newRoot])
    expect(adoptNextRoot(trusted, both.bytes).version).toBe(2)
    expect(() => adoptNextRoot(trusted, rootFile(rotated, { version: 2 }, [newRoot]).bytes)).toThrow(/previous root's keys/u)
    expect(() => adoptNextRoot(trusted, rootFile(rotated, { version: 2 }, [keys.root]).bytes)).toThrow(/root 2 has 0 valid signatures/u)
    expect(() => adoptNextRoot(trusted, rootFile(rotated, { version: 3 }, [keys.root, newRoot]).bytes)).toThrow(/does not follow/u)
  })

  it('refuses a signed file with a duplicate key, an unknown field or an unknown schema', () => {
    const release = publish()
    const text = release.manifestBytes.toString('utf8')
    expect(() => verifySignedManifest(release.root.metadata, Buffer.from(text.replace('"channel": "stable",', '"channel": "stable",\n    "channel": "beta",')))).toThrow(/duplicate key "channel"/u)
    expect(() => verifySignedManifest(release.root.metadata, envelopeBytes({ ...manifestContent('0.1.0', release.archive), extra: true }, [release.keys.targets]))).toThrow(/extra/u)
    expect(() => verifySignedManifest(release.root.metadata, envelopeBytes({ ...manifestContent('0.1.0', release.archive), schema: 'delo.release-manifest/2' }, [release.keys.targets]))).toThrow(/schema/u)
  })
})

describe('canonical JSON', () => {
  it('sorts members by UTF-16 code units and drops whitespace, as RFC 8785 states', () => {
    const value = parseStrictJson(Buffer.from('{"b": [1, 2e3, "\\u00e9"], "a": {"\\u20ac": 1, "\\ud83d\\ude00": 2, "z": null}}'), 1024)
    expect(canonicalJson(value)).toBe('{"a":{"z":null,"€":1,"😀":2},"b":[1,2000,"é"]}')
  })
})
