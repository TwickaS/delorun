/**
 * Client verification of signed release files (contract C2's `c02-refuses-expired-timestamp` and
 * `c02-refuses-replayed-manifest`, with the tampered archive, replayed timestamp, root lifetime, key-role, rotation,
 * channel and file-format refusals around them), and the timestamp signer's checks of what it carries forward, over
 * throwaway keys generated in the test.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { RELEASE_SCHEMAS, type ReleaseChannel, type ReleaseManifest, type TimestampMetadata, type UtcTimestamp } from '@delo/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { semanticVersion, sha256Hex } from '@delo/release-formats/brands'
import { publicKeyEntry, signEnvelope, signedBytes } from '@delo/release-formats/sign/envelope'
import { canonicalJson, parseStrictJson, toJsonValue } from '@delo/release-formats/sign/json'
import { ManifestSchema } from '@delo/release-formats/sign/schemas'
import { initialState, nextTimestamp, stateAfter, type ManifestFile, type TimestampRequest, type TimestampState } from '../../src/sign/timestamp.ts'
import { checkFileRef, trustRootChain, verifyChannelManifest, verifyFileList, verifySignedManifest, verifyTimestamp, type TrustedRoot } from '@delo/release-formats/sign/verify'
import { manifestContent, rootFile, throwawayKeys, type Keys } from './fixture.ts'

const ISSUED = Date.parse('2026-11-06T12:00:00Z') / 1000
const DAY = 86_400

function envelopeBytes(signed: object, keys: Parameters<typeof signEnvelope>[1]): Buffer {
  return Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(signed), signatures: [] }, keys), undefined, 2)}\n`)
}

function utc(seconds: number): UtcTimestamp {
  return brandString<UtcTimestamp>(`${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`)
}

function manifestFile(keys: Keys, version: string, channel: ReleaseChannel = 'stable', archive = Buffer.from(`runtime archive ${version}`)): ManifestFile & { readonly bytes: Buffer } {
  return { name: `delorun-${version}.manifest.json`, bytes: envelopeBytes({ ...manifestContent(version, archive), channel }, [keys.targets]) }
}

function trusted(bytes: Uint8Array, now = ISSUED): TrustedRoot {
  return trustRootChain([bytes], now).at(-1)!
}

interface Published {
  readonly keys: Keys
  readonly root: TrustedRoot
  /** The signer's state after the first timestamp. */
  readonly state: TimestampState
  readonly archive: Buffer
  readonly manifestBytes: Buffer
  readonly timestamp: { metadata: TimestampMetadata, bytes: Buffer }
}

function publish(version = '0.1.0', keys: Keys = throwawayKeys()): Published {
  const root = trusted(rootFile(keys).bytes)
  const archive = Buffer.from(`runtime archive ${version}`)
  const manifest = manifestFile(keys, version, 'stable', archive)
  const metadata = nextTimestamp({ state: initialState(root), roots: [root], first: true, manifests: { stable: manifest, beta: manifest }, replaced: [], now: ISSUED })
  const bytes = envelopeBytes(metadata, [keys.timestamp])
  return { keys, root, state: stateAfter(root, bytes, metadata.version), archive, manifestBytes: manifest.bytes, timestamp: { metadata, bytes } }
}

/** The next timestamp after a published one, as the signer's state allows. */
function continueFrom(release: Published, manifests: TimestampRequest['manifests'], now: number, overrides: Partial<TimestampRequest> = {}): TimestampMetadata {
  return nextTimestamp({ state: release.state, roots: [release.root], first: false, manifests, replaced: [], now, ...overrides })
}

describe('release verification', () => {
  it('accepts an image seccomp profile named by one path segment and refuses one named by a path', () => {
    const content = manifestContent('0.1.0', Buffer.from('x'))
    const seccomp = { name: 'delorun-0.1.0.s2.seccomp.json', length: 1, sha256: 'a'.repeat(64) }
    const withProfile = (name: string): unknown => ({ ...content, images: { ...content.images, s2: { ...content.images.s2, seccomp: { ...seccomp, name } } } })
    expect(ManifestSchema.safeParse(withProfile(seccomp.name)).success).toBe(true)
    expect(ManifestSchema.safeParse(withProfile('profiles/s2.json')).success).toBe(false)
    expect(ManifestSchema.safeParse(withProfile('..')).success).toBe(false)
  })

  it('verifies the channel manifest with the targets key and each file against it', () => {
    const release = publish()
    const timestamp = verifyTimestamp(release.root, release.timestamp.bytes, ISSUED + 60)
    const verified = verifyChannelManifest(release.root.metadata, timestamp, 'stable', release.manifestBytes)
    expect(verified.version).toBe('0.1.0')
    expect(() => checkFileRef(verified.runtime['linux-x64']!.archive, release.archive)).not.toThrow()
  })

  it('refuses a tampered archive', () => {
    const release = publish()
    const verified = verifySignedManifest(release.root.metadata, release.manifestBytes)
    const tampered = Buffer.from(release.archive)
    tampered.writeUInt8(tampered.readUInt8(0) ^ 1, 0)
    expect(() => checkFileRef(verified.runtime['linux-x64']!.archive, tampered)).toThrow(/has SHA-256 [0-9a-f]{64}; signed metadata lists/u)
    expect(() => checkFileRef(verified.runtime['linux-x64']!.archive, Buffer.concat([release.archive, Buffer.from('x')]))).toThrow(/bytes; signed metadata lists/u)
  })

  it('refuses timestamp metadata one second past its expiry, naming the expiry and the local clock', () => {
    const release = publish()
    const expires = Date.parse(release.timestamp.metadata.expires) / 1000
    expect(() => verifyTimestamp(release.root, release.timestamp.bytes, expires)).not.toThrow()
    expect(() => verifyTimestamp(release.root, release.timestamp.bytes, expires + 1))
      .toThrow(`timestamp 1 expired at ${release.timestamp.metadata.expires}; this machine's clock reads ${new Date((expires + 1) * 1000).toISOString().replace('.000Z', 'Z')}`)
  })

  it('refuses timestamp metadata issued after the local clock, or living other than 3 days', () => {
    const release = publish()
    expect(() => verifyTimestamp(release.root, release.timestamp.bytes, ISSUED - 1)).toThrow(/was issued at 2026-11-06T12:00:00Z, 1 second after this machine's clock.*Check that the computer's clock/u)
    expect(() => verifyTimestamp(release.root, release.timestamp.bytes, ISSUED - 3_900)).toThrow(/1 hour 5 minutes after this machine's clock/u)
    const longer = envelopeBytes({ ...release.timestamp.metadata, expires: utc(ISSUED + 4 * DAY) }, [release.keys.timestamp])
    expect(() => verifyTimestamp(release.root, longer, ISSUED + 60)).toThrow(/does not expire exactly 259200 seconds after it was issued/u)
  })

  it('refuses timestamp metadata that names another root version, or another file of the trusted root version', () => {
    const release = publish()
    const newer = envelopeBytes({ ...release.timestamp.metadata, root: { version: 2, sha256: release.root.sha256 } }, [release.keys.timestamp])
    expect(() => verifyTimestamp(release.root, newer, ISSUED + 60)).toThrow(/names root 2, but root 1 is trusted; adopt the newer root first/u)
    const other = sha256Hex('0'.repeat(64))
    const forged = envelopeBytes({ ...release.timestamp.metadata, root: { version: 1, sha256: other } }, [release.keys.timestamp])
    expect(() => verifyTimestamp(release.root, forged, ISSUED + 60)).toThrow(`timestamp names root 1 with SHA-256 ${other}, not the trusted root file's ${release.root.sha256}`)
  })

  it('refuses a validly signed older manifest that the fresh timestamp does not name', () => {
    const keys = throwawayKeys()
    const older = publish('0.1.0', keys)
    const newer = publish('0.2.0', keys)
    const timestamp = verifyTimestamp(newer.root, newer.timestamp.bytes, ISSUED + 60)
    expect(verifySignedManifest(newer.root.metadata, older.manifestBytes).version).toBe('0.1.0')
    expect(() => verifyChannelManifest(newer.root.metadata, timestamp, 'stable', older.manifestBytes)).toThrow(/is not the stable channel's current manifest/u)
  })

  it('refuses a manifest whose release or channel differs from the timestamp entry naming it, and offers a stable release on beta', () => {
    const release = publish()
    const pointer = release.timestamp.metadata.channels.stable
    const renamed: TimestampMetadata = { ...release.timestamp.metadata, channels: { stable: { ...pointer, release: semanticVersion('0.2.0') }, beta: pointer } }
    expect(() => verifyChannelManifest(release.root.metadata, renamed, 'stable', release.manifestBytes)).toThrow('the manifest is release 0.1.0 on stable, not 0.2.0 on stable')
    const beta = manifestFile(release.keys, '0.1.0', 'beta')
    const betaPointer = { release: semanticVersion('0.1.0'), manifest: { name: beta.name, length: beta.bytes.byteLength, sha256: sha256Hex(createHash('sha256').update(beta.bytes).digest('hex')) } }
    const onStable: TimestampMetadata = { ...release.timestamp.metadata, channels: { stable: betaPointer, beta: betaPointer } }
    expect(() => verifyChannelManifest(release.root.metadata, onStable, 'stable', beta.bytes)).toThrow('the manifest is release 0.1.0 on beta, not 0.1.0 on stable')
    expect(verifyChannelManifest(release.root.metadata, onStable, 'beta', beta.bytes).channel).toBe('beta')
    expect(verifyChannelManifest(release.root.metadata, release.timestamp.metadata, 'beta', release.manifestBytes).channel).toBe('stable')
  })

  it('refuses a file list for another platform or release, though the targets key signed it', () => {
    const release = publish()
    const list = (version: string, platform: string): Buffer => envelopeBytes({ schema: RELEASE_SCHEMAS.files, version, platform, files: [] }, [release.keys.targets])
    const withList = (bytes: Buffer): ReleaseManifest => {
      const content = manifestContent('0.1.0', release.archive)
      const files = { name: 'delorun-0.1.0-linux-x64.files.json', length: bytes.byteLength, sha256: sha256Hex(createHash('sha256').update(bytes).digest('hex')) }
      return { ...content, runtime: { ...content.runtime, 'linux-x64': { ...content.runtime['linux-x64']!, files } } }
    }
    const own = list('0.1.0', 'linux-x64')
    expect(verifyFileList(release.root.metadata, withList(own), 'linux-x64', own).platform).toBe('linux-x64')
    const arm = list('0.1.0', 'linux-arm64')
    expect(() => verifyFileList(release.root.metadata, withList(arm), 'linux-x64', arm)).toThrow('the file list is for 0.1.0 linux-arm64, not 0.1.0 linux-x64')
    const older = list('0.0.9', 'linux-x64')
    expect(() => verifyFileList(release.root.metadata, withList(older), 'linux-x64', older)).toThrow('the file list is for 0.0.9 linux-x64, not 0.1.0 linux-x64')
  })

  it('refuses a replayed timestamp with a lower version, and a different file with the stored version', () => {
    const release = publish()
    const manifest = { name: 'delorun-0.1.0.manifest.json', bytes: release.manifestBytes }
    const second = continueFrom(release, { stable: manifest, beta: manifest }, ISSUED + DAY)
    const secondBytes = envelopeBytes(second, [release.keys.timestamp])
    expect(() => verifyTimestamp(release.root, release.timestamp.bytes, ISSUED + DAY + 60, { version: 2, bytes: secondBytes })).toThrow(/version 1 is lower than the stored version 2/u)
    const resigned = envelopeBytes(second, [release.keys.timestamp, generateKeyPairSync('ed25519').privateKey])
    expect(() => verifyTimestamp(release.root, resigned, ISSUED + DAY + 60, { version: 2, bytes: secondBytes })).toThrow(/differs from the stored file/u)
  })

  it('refuses a manifest signed by a key outside the targets role, a timestamp signed by the targets key, and a revoked targets key', () => {
    const release = publish()
    const outsider = envelopeBytes(manifestContent('0.1.0', release.archive), [release.keys.timestamp])
    expect(() => verifySignedManifest(release.root.metadata, outsider)).toThrow(/0 valid signatures/u)
    expect(() => verifyTimestamp(release.root, envelopeBytes(release.timestamp.metadata, [release.keys.targets]), ISSUED)).toThrow(/0 valid signatures/u)
    const targetsId = publicKeyEntry(release.keys.targets).keyid
    const successor = publicKeyEntry(generateKeyPairSync('ed25519').privateKey)
    const revoked = rootFile(release.keys, {
      keys: { ...release.root.metadata.keys, [successor.keyid]: successor.entry },
      roles: { ...release.root.metadata.roles, targets: { keys: [{ keyid: targetsId, status: 'revoked' }, { keyid: successor.keyid, status: 'active' }], threshold: 1 } },
    }).metadata
    expect(() => verifySignedManifest(revoked, release.manifestBytes)).toThrow(/0 valid signatures/u)
    const retired = rootFile(release.keys, { roles: { ...release.root.metadata.roles, targets: { keys: [{ keyid: targetsId, status: 'retired', lastRelease: semanticVersion('0.1.0') }], threshold: 1 } } }).metadata
    expect(verifySignedManifest(retired, release.manifestBytes).version).toBe('0.1.0')
    expect(() => verifySignedManifest(retired, envelopeBytes(manifestContent('0.1.1', release.archive), [release.keys.targets]))).toThrow(/0 valid signatures/u)
  })

  it('refuses a key that root metadata lists under an id other than its public key\'s SHA-256', () => {
    const keys = throwawayKeys()
    const { metadata } = rootFile(keys)
    const targetsId = publicKeyEntry(keys.targets).keyid
    const swapped = { ...metadata, keys: { ...metadata.keys, [targetsId]: publicKeyEntry(keys.timestamp).entry } }
    const content = toJsonValue(manifestContent('0.1.0', Buffer.from('archive')))
    const forged = Buffer.from(JSON.stringify({ signed: content, signatures: [{ keyid: targetsId, sig: sign(null, signedBytes(content), keys.timestamp).toString('base64') }] }))
    expect(() => verifySignedManifest(swapped, forged)).toThrow(`key ${targetsId} is listed under an id that is not the SHA-256 of its public key`)
  })

  it('adopts the next root only when both the previous and its own root keys sign it', () => {
    const keys = throwawayKeys()
    const first = rootFile(keys)
    const newRoot = generateKeyPairSync('ed25519').privateKey
    const rotated: Keys = { ...keys, root: newRoot }
    const chain = (next: Buffer): TrustedRoot[] => trustRootChain([first.bytes, next], ISSUED)
    expect(chain(rootFile(rotated, { version: 2 }, [keys.root, newRoot]).bytes).at(-1)!.metadata.version).toBe(2)
    expect(() => chain(rootFile(rotated, { version: 2 }, [newRoot]).bytes)).toThrow(/previous root's keys/u)
    expect(() => chain(rootFile(rotated, { version: 2 }, [keys.root]).bytes)).toThrow(/root 2 has 0 valid signatures/u)
    expect(() => chain(rootFile(rotated, { version: 3 }, [keys.root, newRoot]).bytes)).toThrow(/does not follow/u)
  })

  it('refuses a root past its expiry, one expiring before it was issued, and one living longer than 365 days', () => {
    const keys = throwawayKeys()
    const { bytes, metadata } = rootFile(keys)
    const expires = Date.parse(metadata.expires) / 1000
    expect(trusted(bytes, expires).metadata.version).toBe(1)
    expect(() => trusted(bytes, expires + 1)).toThrow(`root 1 expired at ${metadata.expires}; this machine's clock reads ${utc(expires + 1)}. A newer root must verify before installs and updates`)
    expect(() => trustRootChain([bytes, rootFile(keys, { version: 2 }).bytes], expires + 1)).toThrow(/root 2 expired/u)
    expect(trustRootChain([bytes, rootFile(keys, { version: 2, expires: utc(expires + DAY) }).bytes], expires + 1).map(root => root.metadata.version)).toEqual([1, 2])
    expect(() => trusted(rootFile(keys, { expires: metadata.issued }).bytes)).toThrow(`root 1 expires at ${metadata.issued}, not after it was issued at ${metadata.issued}`)
    const issued = Date.parse(metadata.issued) / 1000
    expect(trusted(rootFile(keys, { expires: utc(issued + 365 * DAY) }).bytes).metadata.version).toBe(1)
    expect(() => trusted(rootFile(keys, { expires: utc(issued + 365 * DAY + 1) }).bytes)).toThrow('root 1 expires more than 365 days after it was issued')
  })

  it('refuses a root that gives one key two roles, or does not have exactly one active targets key', () => {
    const keys = throwawayKeys()
    const { metadata } = rootFile(keys)
    const targetsId = publicKeyEntry(keys.targets).keyid
    const shared = rootFile(keys, { roles: { ...metadata.roles, timestamp: { keyids: [targetsId], threshold: 1 } } })
    expect(() => trusted(shared.bytes)).toThrow(`key ${targetsId} is already in role targets; each key holds one role`)
    const extra = publicKeyEntry(generateKeyPairSync('ed25519').privateKey).keyid
    const twoActive = rootFile(keys, { roles: { ...metadata.roles, targets: { keys: [{ keyid: targetsId, status: 'active' }, { keyid: extra, status: 'active' }], threshold: 1 } } })
    expect(() => trusted(twoActive.bytes)).toThrow('2 targets keys are active; exactly one must be')
    const noneActive = rootFile(keys, { roles: { ...metadata.roles, targets: { keys: [{ keyid: targetsId, status: 'retired', lastRelease: semanticVersion('0.1.0') }], threshold: 1 } } })
    expect(() => trusted(noneActive.bytes)).toThrow('0 targets keys are active; exactly one must be')
  })

  it('refuses a signed file with a duplicate key, an unknown field or an unknown schema', () => {
    const release = publish()
    const text = release.manifestBytes.toString('utf8')
    expect(() => verifySignedManifest(release.root.metadata, Buffer.from(text.replace('"channel": "stable",', '"channel": "stable",\n    "channel": "beta",')))).toThrow(/duplicate key "channel"/u)
    expect(() => verifySignedManifest(release.root.metadata, envelopeBytes({ ...manifestContent('0.1.0', release.archive), extra: true }, [release.keys.targets]))).toThrow(/extra/u)
    expect(() => verifySignedManifest(release.root.metadata, envelopeBytes({ ...manifestContent('0.1.0', release.archive), schema: 'delo.release-manifest/2' }, [release.keys.targets]))).toThrow(/schema/u)
  })

  it('accepts a manifest that lists some platforms, and refuses one that lists none', () => {
    const release = publish()
    const content = manifestContent('0.1.0', release.archive)
    const linux = { 'linux-x64': content.runtime['linux-x64'] }
    expect(Object.keys(verifySignedManifest(release.root.metadata, envelopeBytes({ ...content, runtime: linux }, [release.keys.targets])).runtime)).toEqual(['linux-x64'])
    expect(() => verifySignedManifest(release.root.metadata, envelopeBytes({ ...content, runtime: {} }, [release.keys.targets]))).toThrow(/a release publishes the runtime of at least one platform/u)
  })

  it('reads a manifest naming a platform this reader does not know and drops that platform', () => {
    const release = publish()
    const content = manifestContent('0.1.0', release.archive)
    const future = envelopeBytes({ ...content, runtime: { ...content.runtime, 'win32-arm64': content.runtime['linux-x64'] } }, [release.keys.targets])
    const manifest = verifySignedManifest(release.root.metadata, future)
    expect(Object.keys(manifest.runtime).sort()).toEqual(Object.keys(content.runtime).sort())
    const only = envelopeBytes({ ...content, runtime: { 'win32-arm64': content.runtime['linux-x64'] } }, [release.keys.targets])
    expect(() => verifySignedManifest(release.root.metadata, only)).toThrow(/a release publishes the runtime of at least one platform/u)
  })

  it('reads a timestamp naming a channel this reader does not know and drops that channel', () => {
    const release = publish()
    const metadata = release.timestamp.metadata
    const future = envelopeBytes({ ...metadata, channels: { ...metadata.channels, nightly: metadata.channels.stable } }, [release.keys.timestamp])
    const read = verifyTimestamp(release.root, future, ISSUED + 60)
    expect(Object.keys(read.channels).sort()).toEqual(['beta', 'stable'])
  })

  it('reads a manifest without desktop, images or install, and still refuses a top-level unknown field', () => {
    const release = publish()
    const { desktop: _desktop, images: _images, install: _install, ...bare } = manifestContent('0.1.0', release.archive)
    const manifest = verifySignedManifest(release.root.metadata, envelopeBytes(bare, [release.keys.targets]))
    expect([manifest.desktop, manifest.images, manifest.install]).toEqual([undefined, undefined, undefined])
    expect(() => verifySignedManifest(release.root.metadata, envelopeBytes({ ...bare, extra: true }, [release.keys.targets]))).toThrow(/extra/u)
  })

  it('refuses a tolerated field that is tampered with after signing', () => {
    const release = publish()
    const content = manifestContent('0.1.0', release.archive)
    const signed = envelopeBytes({ ...content, runtime: { ...content.runtime, 'win32-arm64': content.runtime['linux-x64'] } }, [release.keys.targets])
    const tampered = Buffer.from(signed.toString('utf8').replace('win32-arm64', 'win32-ia32'))
    expect(() => verifySignedManifest(release.root.metadata, tampered)).toThrow(/signature|threshold|verif/iu)
    const channels = release.timestamp.metadata.channels
    const stamp = envelopeBytes({ ...release.timestamp.metadata, channels: { ...channels, nightly: channels.stable } }, [release.keys.timestamp])
    expect(() => verifyTimestamp(release.root, Buffer.from(stamp.toString('utf8').replace('nightly', 'weekly')), ISSUED + 60)).toThrow(/signature|threshold|verif/iu)
  })

  it.each(['../delorun-0.1.0-linux-x64.tar.gz', 'release/delorun.tar.gz', '..', '.', 'a\\b', ''])('refuses the file name %j, which is not one path segment', (name) => {
    const release = publish()
    const content = manifestContent('0.1.0', release.archive)
    const escaping = { ...content, sbom: { ...content.sbom, name } }
    expect(() => verifySignedManifest(release.root.metadata, envelopeBytes(escaping, [release.keys.targets]))).toThrow(/manifest file: .*sbom\.name/u)
  })
})

describe('timestamp signing', () => {
  const later = ISSUED + DAY

  it('names the stable release on both channels at first, and refuses a beta release on the stable channel', () => {
    const release = publish()
    expect(release.timestamp.metadata.channels.beta).toEqual(release.timestamp.metadata.channels.stable)
    const beta = manifestFile(release.keys, '0.2.0-beta.1', 'beta')
    expect(() => continueFrom(release, { stable: beta, beta }, later)).toThrow(`${beta.name} is a beta release, which the stable channel does not name`)
    const stable = { name: 'delorun-0.1.0.manifest.json', bytes: release.manifestBytes }
    expect(continueFrom(release, { stable, beta }, later).channels.beta.release).toBe('0.2.0-beta.1')
  })

  it('continues only from the last timestamp the state holds, so an older genuine timestamp cannot roll a channel back', () => {
    const release = publish('0.1.0')
    const older = { name: 'delorun-0.1.0.manifest.json', bytes: release.manifestBytes }
    const newer = manifestFile(release.keys, '0.2.0')
    const second = continueFrom(release, { stable: newer, beta: newer }, later)
    const secondBytes = envelopeBytes(second, [release.keys.timestamp])
    const state = stateAfter(release.root, secondBytes, second.version)
    expect(Buffer.from(state.timestamp!.file, 'base64')).toEqual(secondBytes)
    const request = { state, roots: [release.root], first: false, manifests: { stable: newer, beta: newer }, replaced: [], now: later + DAY }
    expect(() => nextTimestamp({ ...request, manifests: { stable: older, beta: older } })).toThrow('the stable channel would move back from 0.2.0 to 0.1.0')
    expect(() => nextTimestamp({ ...request, first: true })).toThrow('the state records timestamp 2 as the last signed; continue from it instead of signing a first timestamp')
    expect(() => nextTimestamp({ ...request, state: initialState(release.root) })).toThrow('the state records no timestamp yet; sign the first timestamp with --first')
    const swapped = { ...state, timestamp: { ...state.timestamp!, file: release.state.timestamp!.file } }
    expect(() => nextTimestamp({ ...request, state: swapped, manifests: { stable: older, beta: older } })).toThrow(`the state's last timestamp has SHA-256 ${release.state.timestamp!.sha256}, not the ${state.timestamp!.sha256} it records`)
    const relabelled = { ...release.state, timestamp: { ...release.state.timestamp!, version: 2 } }
    expect(() => nextTimestamp({ ...request, state: relabelled, manifests: { stable: older, beta: older } })).toThrow('the state\'s last timestamp is version 1, not the 2 it records')
    expect(nextTimestamp(request).version).toBe(3)
  })

  it('refuses a root chain that does not start at the root the state trusts, including for the first timestamp', () => {
    const release = publish()
    const stranger = trusted(rootFile(throwawayKeys()).bytes)
    const manifest = { name: 'delorun-0.1.0.manifest.json', bytes: release.manifestBytes }
    expect(() => nextTimestamp({ state: initialState(release.root), roots: [stranger], first: true, manifests: { stable: manifest, beta: manifest }, replaced: [], now: ISSUED }))
      .toThrow(`the first root passed is root 1 with SHA-256 ${stranger.sha256}; the state trusts root 1 with SHA-256 ${release.root.sha256}`)
  })

  it('verifies the recorded previous timestamp with the timestamp key, and reads it after it expired', () => {
    const release = publish()
    const stable = { name: 'delorun-0.1.0.manifest.json', bytes: release.manifestBytes }
    const manifests = { stable, beta: stable }
    const forged = envelopeBytes({ ...release.timestamp.metadata, version: 41 }, [generateKeyPairSync('ed25519').privateKey])
    expect(() => continueFrom(release, manifests, later, { state: stateAfter(release.root, forged, 41), first: false })).toThrow(/timestamp has 0 valid signatures/u)
    expect(continueFrom(release, manifests, ISSUED + 30 * DAY).version).toBe(2)
  })

  it('reads the previous timestamp under the root it names after a rotation, then continues from the new root', () => {
    const keys = throwawayKeys()
    const release = publish('0.1.0', keys)
    const newTimestamp = generateKeyPairSync('ed25519').privateKey
    const second = trustRootChain([rootFile(keys).bytes, rootFile({ ...keys, timestamp: newTimestamp }, { version: 2 }, [keys.root]).bytes], ISSUED).at(-1)!
    const stable = { name: 'delorun-0.1.0.manifest.json', bytes: release.manifestBytes }
    const next = continueFrom(release, { stable, beta: stable }, later, { roots: [release.root, second] })
    expect(next.root).toEqual({ version: 2, sha256: second.sha256 })
    expect(() => continueFrom(release, { stable, beta: stable }, later, { roots: [second] })).toThrow(`the first root passed is root 2 with SHA-256 ${second.sha256}; the state trusts root 1`)
    const nextBytes = envelopeBytes(next, [newTimestamp])
    expect(nextTimestamp({ state: stateAfter(second, nextBytes, 2), roots: [second], first: false, manifests: { stable, beta: stable }, replaced: [], now: later + DAY }).version).toBe(3)
  })

  it('refuses to move a channel back to a lower release, or to another manifest of the release it names', () => {
    const keys = throwawayKeys()
    const root = trusted(rootFile(keys).bytes)
    const newer = manifestFile(keys, '0.2.0')
    const firstContent = nextTimestamp({ state: initialState(root), roots: [root], first: true, manifests: { stable: newer, beta: newer }, replaced: [], now: ISSUED })
    const first = envelopeBytes(firstContent, [keys.timestamp])
    const request = { state: stateAfter(root, first, 1), roots: [root], first: false, replaced: [], now: later }
    const older = manifestFile(keys, '0.1.0')
    expect(() => nextTimestamp({ ...request, manifests: { stable: older, beta: newer } })).toThrow('the stable channel would move back from 0.2.0 to 0.1.0')
    expect(() => nextTimestamp({ ...request, manifests: { stable: newer, beta: older } })).toThrow('the beta channel would move back from 0.2.0 to 0.1.0')
    const resigned = manifestFile(keys, '0.2.0', 'stable', Buffer.from('another archive'))
    expect(() => nextTimestamp({ ...request, manifests: { stable: resigned, beta: newer } })).toThrow(/the stable channel names release 0\.2\.0 by delorun-0\.2\.0\.manifest\.json [0-9a-f]{64}; delorun-0\.2\.0\.manifest\.json is another manifest of that release/u)
    expect(() => nextTimestamp({ ...request, manifests: { stable: resigned, beta: newer }, replaced: [newer] })).toThrow(/is another manifest of that release/u)
    const sameContent = { name: newer.name, bytes: envelopeBytes(manifestContent('0.2.0', Buffer.from('runtime archive 0.2.0')), [keys.targets, generateKeyPairSync('ed25519').privateKey]) }
    expect(nextTimestamp({ ...request, manifests: { stable: sameContent, beta: newer }, replaced: [newer] }).channels.stable.manifest.sha256).toBe(sha256Hex(createHash('sha256').update(sameContent.bytes).digest('hex')))
    expect(nextTimestamp({ ...request, manifests: { stable: newer, beta: newer } }).version).toBe(2)
  })

  it('names a release re-signed after a targets-key rotation in place of the manifest the revoked key signed, but not one whose content changed', () => {
    const keys = throwawayKeys()
    const release = publish('0.1.0', keys)
    const successor = generateKeyPairSync('ed25519').privateKey
    const revoked = publicKeyEntry(keys.targets)
    const next = publicKeyEntry(successor)
    const rootTwo = rootFile({ ...keys, targets: successor }, {
      version: 2,
      keys: { ...rootFile({ ...keys, targets: successor }).metadata.keys, [revoked.keyid]: revoked.entry },
      roles: { ...release.root.metadata.roles, targets: { keys: [{ keyid: revoked.keyid, status: 'revoked' }, { keyid: next.keyid, status: 'active' }], threshold: 1 } },
    }, [keys.root])
    const roots = trustRootChain([rootFile(keys).bytes, rootTwo.bytes], later)
    const old = { name: 'delorun-0.1.0.manifest.json', bytes: release.manifestBytes }
    const resigned = { name: old.name, bytes: envelopeBytes({ ...manifestContent('0.1.0', release.archive), published: '2026-11-07T09:00:00Z' }, [successor]) }
    const manifests = { stable: resigned, beta: resigned }
    expect(() => continueFrom(release, manifests, later, { roots })).toThrow(/is another manifest of that release/u)
    const timestamp = continueFrom(release, manifests, later, { roots, replaced: [old] })
    expect(timestamp.channels.stable.release).toBe('0.1.0')
    expect(timestamp.root.version).toBe(2)
    const changed = { name: old.name, bytes: envelopeBytes({ ...manifestContent('0.1.0', Buffer.from('another archive')), published: '2026-11-07T09:00:00Z' }, [successor]) }
    expect(() => continueFrom(release, { stable: changed, beta: changed }, later, { roots, replaced: [old] })).toThrow(/is another manifest of that release/u)
  })
})

describe('canonical JSON', () => {
  it('sorts members by UTF-16 code units and drops whitespace, as RFC 8785 states', () => {
    const value = parseStrictJson(Buffer.from('{"b": [1, 2e3, "\\u00e9"], "a": {"\\u20ac": 1, "\\ud83d\\ude00": 2, "z": null}}'), 1024)
    expect(canonicalJson(value)).toBe('{"a":{"z":null,"€":1,"😀":2},"b":[1,2000,"é"]}')
  })
})
