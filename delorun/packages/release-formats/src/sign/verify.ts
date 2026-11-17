/**
 * Client verification of contract C2's signed release files, in the order the contract states: the trusted root and
 * its rotations, the timestamp's signature, expiry and version, the channel's manifest by the timestamp's digest and
 * the targets signature, then each release file by the manifest's length and SHA-256. The release tooling runs it
 * on what it signs before publishing; the installers, the runtime store and the desktop updater apply the same
 * rules.
 *
 * @module @delorun/release-formats/sign/verify
 */
import { createHash } from 'node:crypto'
import {
  CLOCK_TOLERANCE_SECONDS,
  ROOT_MAX_LIFETIME_DAYS,
  TIMESTAMP_LIFETIME_SECONDS,
  type FileRef,
  type ReleaseChannel,
  type ReleaseManifest,
  type RootMetadata,
  type RuntimeFileList,
  type RuntimePlatform,
  type Sha256Hex,
  type SignedEnvelope,
  type TimestampMetadata,
} from '@delorun/contract-release-manifest'
import semver from 'semver'
import { sha256Hex } from '../brands.ts'
import { validSigners, verifyingKey, type VerifyingKey } from './envelope.ts'
import type { JsonValue } from './json.ts'
import { readEnvelope, type EnvelopeKinds, type ReadEnvelope } from './schemas.ts'

/** Why verification refused a file. */
export class VerificationError extends Error {
  override readonly name = 'VerificationError'
}

function seconds(timestamp: string): number {
  return Date.parse(timestamp) / 1000
}

function roleKeys(root: RootMetadata, keyids: readonly string[]): VerifyingKey[] {
  return keyids.map((keyid) => {
    const entry = root.keys[keyid as keyof typeof root.keys]
    if (entry === undefined) throw new VerificationError(`root ${String(root.version)} names key ${keyid} without listing it`)
    return verifyingKey(keyid, entry)
  })
}

function requireThreshold(what: string, envelope: SignedEnvelope<JsonValue>, keys: readonly VerifyingKey[], threshold: number): void {
  const signers = validSigners(envelope, keys)
  if (signers.size < threshold) throw new VerificationError(`${what} has ${String(signers.size)} valid signatures from its role's keys; ${String(threshold)} are required`)
}

function asJson<T>(envelope: ReadEnvelope<T>): SignedEnvelope<JsonValue> {
  return { signed: envelope.signedJson, signatures: envelope.signatures }
}

/** A root the client trusts, with the SHA-256 of its file, which timestamp metadata names. */
export interface TrustedRoot {
  /** The root metadata. */
  readonly metadata: RootMetadata
  /** SHA-256 of the root file's bytes. */
  readonly sha256: Sha256Hex
}

/** A span in seconds as the largest whole unit with its remainder, such as `1 hour 5 minutes`. */
function formatGap(gap: number): string {
  const whole = Math.max(1, Math.round(gap))
  const parts: string[] = []
  for (const [unit, size] of [['day', 86_400], ['hour', 3_600], ['minute', 60], ['second', 1]] as const) {
    const count = Math.floor(whole / size) % (unit === 'day' ? Infinity : unit === 'hour' ? 24 : 60)
    if (count > 0) parts.push(`${String(count)} ${unit}${count === 1 ? '' : 's'}`)
  }
  return parts.slice(0, 2).join(' ')
}

function utcText(now: number): string {
  return new Date(now * 1000).toISOString().replace('.000Z', 'Z')
}

/**
 * Read a root file signed by its own root threshold, issued before it expires and within the lifetime limit. It does
 * not read the clock; {@link trustRootChain} checks the newest root's expiry.
 * @param bytes - the root file.
 * @returns the root and its file digest.
 * @throws VerificationError when the file does not read or verify, or its dates are out of order or beyond the
 * lifetime limit.
 */
export function readRoot(bytes: Uint8Array): TrustedRoot {
  const envelope = readEnvelope('root', bytes)
  const root = envelope.signed
  const lifetime = seconds(root.expires) - seconds(root.issued)
  if (lifetime <= 0) throw new VerificationError(`root ${String(root.version)} expires at ${root.expires}, not after it was issued at ${root.issued}`)
  if (lifetime > ROOT_MAX_LIFETIME_DAYS * 86_400) throw new VerificationError(`root ${String(root.version)} expires more than ${String(ROOT_MAX_LIFETIME_DAYS)} days after it was issued`)
  requireThreshold(`root ${String(root.version)}`, asJson(envelope), roleKeys(root, root.roles.root.keyids), root.roles.root.threshold)
  return { metadata: root, sha256: sha256Hex(createHash('sha256').update(bytes).digest('hex')) }
}

/**
 * Read the root version after a trusted one: exactly one above it, verifying with the trusted root's threshold and
 * with its own.
 * @param trusted - the newest root trusted so far.
 * @param bytes - the next root file.
 * @returns the next root.
 * @throws VerificationError on a version gap, a missing threshold, or dates out of order or beyond the limit.
 */
function adoptRoot(trusted: TrustedRoot, bytes: Uint8Array): TrustedRoot {
  const envelope = readEnvelope('root', bytes)
  const next = envelope.signed
  const previous = trusted.metadata
  if (next.version !== previous.version + 1) throw new VerificationError(`root ${String(next.version)} does not follow the trusted root ${String(previous.version)}`)
  requireThreshold(`root ${String(next.version)} (previous root's keys)`, asJson(envelope), roleKeys(previous, previous.roles.root.keyids), previous.roles.root.threshold)
  return readRoot(bytes)
}

/**
 * Walk a chain of root files, each signed by the trusted root's root role and by its own, and by no other: the first
 * as the caller holds it, such as the root embedded at build time, each later one exactly the next version. It does not
 * read the clock, so a start check can hold a stored root to the walk without refusing an expired one.
 * @param files - the root files, oldest first; the first is the root the caller already trusts.
 * @returns every root of the chain, oldest first.
 * @throws VerificationError when a file does not verify, a version is skipped, or a root's dates are out of order or
 *   beyond the lifetime limit.
 */
export function walkRootChain(files: readonly Uint8Array[]): TrustedRoot[] {
  if (files.length === 0) throw new VerificationError('no root file to trust')
  const chain = [readRoot(files[0]!)]
  for (const bytes of files.slice(1)) chain.push(adoptRoot(chain.at(-1)!, bytes))
  return chain
}

/**
 * Trust a chain of root files: the first as the caller holds it, such as the root embedded at build time, each later
 * one as the next version, and the newest checked against the clock, as installs and updates require.
 * @param files - the root files, oldest first; the first is the root the caller already trusts.
 * @param now - the clock in Unix seconds, which the newest root must not be past.
 * @returns every root of the chain, oldest first.
 * @throws VerificationError when a file does not verify, a version is skipped, or the newest root has expired.
 */
export function trustRootChain(files: readonly Uint8Array[], now: number): TrustedRoot[] {
  const chain = walkRootChain(files)
  const newest = chain.at(-1)!.metadata
  if (now > seconds(newest.expires) + CLOCK_TOLERANCE_SECONDS) {
    throw new VerificationError(`root ${String(newest.version)} expired at ${newest.expires}; this machine's clock reads ${utcText(now)}. A newer root must verify before installs and updates`)
  }
  return chain
}

/** What a client stored from its last verified timestamp. */
export interface StoredTimestamp {
  /** The highest timestamp version verified. */
  readonly version: number
  /** That timestamp file's bytes. */
  readonly bytes: Uint8Array
}

/**
 * Verify timestamp metadata.
 * @param root - the trusted root, at the version and with the file digest the timestamp names.
 * @param bytes - the timestamp file.
 * @param now - the client's clock, in Unix seconds.
 * @param stored - the last verified timestamp, when the client has one.
 * @param options - `allowExpired` admits a timestamp past its expiry, for the signer reading the previous timestamp;
 * clients never set it.
 * @returns the timestamp metadata.
 * @throws VerificationError on a bad signature, a lifetime other than 3 days, an issue time after `now`, an expired or
 * replayed timestamp, or a root version or digest other than the trusted root's.
 */
export function verifyTimestamp(root: TrustedRoot, bytes: Uint8Array, now: number, stored?: StoredTimestamp, options: { readonly allowExpired?: boolean } = {}): TimestampMetadata {
  const envelope = readEnvelope('timestamp', bytes)
  const timestamp = envelope.signed
  const keys = root.metadata.roles.timestamp
  requireThreshold('timestamp', asJson(envelope), roleKeys(root.metadata, keys.keyids), keys.threshold)
  if (seconds(timestamp.expires) - seconds(timestamp.issued) !== TIMESTAMP_LIFETIME_SECONDS) throw new VerificationError(`timestamp ${String(timestamp.version)} does not expire exactly ${String(TIMESTAMP_LIFETIME_SECONDS)} seconds after it was issued`)
  if (seconds(timestamp.issued) > now + CLOCK_TOLERANCE_SECONDS) throw new VerificationError(`timestamp ${String(timestamp.version)} was issued at ${timestamp.issued}, ${formatGap(seconds(timestamp.issued) - now)} after this machine's clock, which reads ${utcText(now)}. Check that the computer's clock and time zone are right`)
  if (options.allowExpired !== true && now > seconds(timestamp.expires) + CLOCK_TOLERANCE_SECONDS) {
    throw new VerificationError(`timestamp ${String(timestamp.version)} expired at ${timestamp.expires}; this machine's clock reads ${utcText(now)}`)
  }
  if (stored !== undefined) {
    if (timestamp.version < stored.version) throw new VerificationError(`timestamp version ${String(timestamp.version)} is lower than the stored version ${String(stored.version)}`)
    if (timestamp.version === stored.version && !Buffer.from(bytes).equals(Buffer.from(stored.bytes))) throw new VerificationError(`timestamp version ${String(timestamp.version)} differs from the stored file of the same version`)
  }
  if (timestamp.root.version !== root.metadata.version) throw new VerificationError(`timestamp names root ${String(timestamp.root.version)}, but root ${String(root.metadata.version)} is trusted; adopt the newer root first`)
  if (timestamp.root.sha256 !== root.sha256) throw new VerificationError(`timestamp names root ${String(timestamp.root.version)} with SHA-256 ${timestamp.root.sha256}, not the trusted root file's ${root.sha256}`)
  return timestamp
}

/**
 * Check bytes against a file reference.
 * @param ref - the reference from signed metadata.
 * @param bytes - the file's bytes.
 * @throws VerificationError when the length or SHA-256 differs.
 */
export function checkFileRef(ref: FileRef, bytes: Uint8Array): void {
  if (bytes.byteLength !== ref.length) throw new VerificationError(`${ref.name} has ${String(bytes.byteLength)} bytes; signed metadata lists ${String(ref.length)}`)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== ref.sha256) throw new VerificationError(`${ref.name} has SHA-256 ${sha256}; signed metadata lists ${ref.sha256}`)
}

/**
 * The targets keys that may verify a release: the active key, and each retired key whose last release is at or above
 * the release's version. A revoked key verifies nothing.
 * @param root - the trusted root.
 * @param version - the release's version.
 * @returns the keys.
 */
export function targetsKeysFor(root: RootMetadata, version: string): VerifyingKey[] {
  const allowed = root.roles.targets.keys.filter(key => key.status === 'active'
    || (key.status === 'retired' && key.lastRelease !== undefined && semver.lte(version, key.lastRelease)))
  return roleKeys(root, allowed.map(key => key.keyid))
}

/**
 * Verify a signed file of the targets role.
 * @param root - the trusted root.
 * @param what - the file's description in a refusal.
 * @param envelope - the envelope.
 * @param version - the release's version.
 * @throws VerificationError when the targets threshold is not reached.
 */
function requireTargets(root: RootMetadata, what: string, envelope: SignedEnvelope<JsonValue>, version: string): void {
  requireThreshold(what, envelope, targetsKeysFor(root, version), root.roles.targets.threshold)
}

/**
 * Whether a timestamp channel may name a release published on a given channel: the stable channel names only stable
 * releases, and the beta channel names beta and stable releases.
 * @param channel - the timestamp's channel.
 * @param published - the manifest's `channel`.
 * @returns true when the channel may name the release.
 */
export function channelAccepts(channel: ReleaseChannel, published: ReleaseChannel): boolean {
  return published === channel || (channel === 'beta' && published === 'stable')
}

/**
 * Verify the channel's current manifest: its bytes must be the file the fresh timestamp names, and the targets
 * threshold must sign it. A validly signed older manifest that the timestamp does not name is refused.
 * @param root - the trusted root.
 * @param timestamp - the verified timestamp.
 * @param channel - the client's channel.
 * @param bytes - the manifest file.
 * @returns the manifest.
 * @throws VerificationError when the file is not the timestamp's, the signature fails or the manifest names another
 * release or channel.
 */
export function verifyChannelManifest(root: RootMetadata, timestamp: TimestampMetadata, channel: ReleaseChannel, bytes: Uint8Array): ReleaseManifest {
  const pointer = timestamp.channels[channel]
  try {
    checkFileRef(pointer.manifest, bytes)
  } catch (error) {
    throw new VerificationError(`the manifest is not the ${channel} channel's current manifest (${pointer.manifest.name}): ${(error as Error).message}`, { cause: error })
  }
  const manifest = verifySignedManifest(root, bytes)
  if (manifest.version !== pointer.release || !channelAccepts(channel, manifest.channel)) throw new VerificationError(`the manifest is release ${manifest.version} on ${manifest.channel}, not ${pointer.release} on ${channel}`)
  return manifest
}

/**
 * Verify a manifest's targets signature, without freshness; a rollback the person requests uses this with the log
 * check of contract C18.
 * @param root - the trusted root.
 * @param bytes - the manifest file.
 * @returns the manifest.
 * @throws VerificationError when the targets threshold is not reached.
 */
export function verifySignedManifest(root: RootMetadata, bytes: Uint8Array): ReleaseManifest {
  const envelope = readEnvelope('manifest', bytes)
  requireTargets(root, `manifest ${envelope.signed.version}`, asJson(envelope), envelope.signed.version)
  return envelope.signed
}

/**
 * Verify a platform's runtime file list against the manifest.
 * @param root - the trusted root.
 * @param manifest - the verified manifest.
 * @param platform - the platform.
 * @param bytes - the file list.
 * @returns the list.
 * @throws VerificationError when the manifest lists no runtime for the platform, the bytes differ from the manifest's
 * reference, the signature fails or the list names another release or platform.
 */
export function verifyFileList(root: RootMetadata, manifest: ReleaseManifest, platform: RuntimePlatform, bytes: Uint8Array): RuntimeFileList {
  const artifacts = manifest.runtime[platform]
  if (artifacts === undefined) throw new VerificationError(`release ${manifest.version} publishes no runtime for ${platform}: the platform is not in this release`)
  checkFileRef(artifacts.files, bytes)
  const envelope = readEnvelope('files', bytes)
  requireTargets(root, `file list ${platform}`, asJson(envelope), manifest.version)
  if (envelope.signed.version !== manifest.version || envelope.signed.platform !== platform) throw new VerificationError(`the file list is for ${envelope.signed.version} ${envelope.signed.platform}, not ${manifest.version} ${platform}`)
  return envelope.signed
}

/**
 * Verify a release's packs document against the manifest it belongs to. The manifest is parsed and verified here from
 * its bytes, so a caller cannot pair a verified manifest with other bytes.
 * @param root - the trusted root.
 * @param manifestBytes - the manifest file's bytes, whose SHA-256 the document names.
 * @param bytes - the packs file.
 * @returns the packs.
 * @throws VerificationError when a signature fails, or the document names another release or another manifest.
 */
export function verifyPacks(root: RootMetadata, manifestBytes: Uint8Array, bytes: Uint8Array): EnvelopeKinds['packs'] {
  const manifest = verifySignedManifest(root, manifestBytes)
  const envelope = readEnvelope('packs', bytes)
  requireTargets(root, `packs ${envelope.signed.version}`, asJson(envelope), manifest.version)
  if (envelope.signed.version !== manifest.version) throw new VerificationError(`the packs file is for ${envelope.signed.version}, not ${manifest.version}`)
  const digest = createHash('sha256').update(manifestBytes).digest('hex')
  if (envelope.signed.manifest !== digest) throw new VerificationError(`the packs file belongs to the manifest with SHA-256 ${envelope.signed.manifest}, not ${digest}`)
  return envelope.signed
}
