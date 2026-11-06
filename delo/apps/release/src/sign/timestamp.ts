/**
 * Timestamp metadata (contract C2): the online timestamp key re-signs it every 24 hours and at each release, naming
 * each channel's current manifest by digest. A new timestamp's version is one above the previous one's; it expires
 * exactly 3 days after it is issued; and a channel moves to a manifest only after that manifest verifies with the
 * targets keys of the root the timestamp names.
 *
 * @module @delo/release/sign/timestamp
 */
import { createHash } from 'node:crypto'
import {
  RELEASE_SCHEMAS,
  TIMESTAMP_LIFETIME_SECONDS,
  type ChannelPointer,
  type FileRef,
  type ReleaseChannel,
  type RootMetadata,
  type TimestampMetadata,
  type UtcTimestamp,
} from '@delo/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { sha256Hex } from '../brands.ts'
import { verifySignedManifest } from './verify.ts'

/** A manifest a channel moves to. */
export interface ChannelRelease {
  /** The channel. */
  readonly channel: ReleaseChannel
  /** The manifest file's name. */
  readonly name: string
  /** The manifest file's bytes. */
  readonly bytes: Uint8Array
}

function utc(seconds: number): UtcTimestamp {
  return brandString<UtcTimestamp>(`${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`)
}

function fileRef(name: string, bytes: Uint8Array): FileRef {
  return { name, length: bytes.byteLength, sha256: sha256Hex(createHash('sha256').update(bytes).digest('hex')) }
}

/**
 * The next timestamp's content.
 * @param root - the newest root and its file's bytes.
 * @param previous - the previous timestamp, absent for the first one.
 * @param release - the manifest a channel moves to, absent for a scheduled re-signing.
 * @param now - the signing time, in Unix seconds.
 * @returns the content to sign.
 * @throws Error when the release's manifest does not verify with the root's targets keys, names another channel, or
 * a first timestamp has no release for both channels.
 */
export function nextTimestamp(root: { readonly metadata: RootMetadata, readonly bytes: Uint8Array }, previous: TimestampMetadata | undefined, release: ChannelRelease | undefined, now: number): TimestampMetadata {
  const issued = Math.floor(now)
  const channels: Partial<Record<ReleaseChannel, ChannelPointer>> = { ...previous?.channels }
  if (release !== undefined) {
    const manifest = verifySignedManifest(root.metadata, release.bytes)
    if (manifest.channel !== release.channel) throw new Error(`${release.name} is a ${manifest.channel} release, not ${release.channel}`)
    const pointer = { release: manifest.version, manifest: fileRef(release.name, release.bytes) }
    channels[release.channel] = pointer
    if (previous === undefined) channels[release.channel === 'stable' ? 'beta' : 'stable'] = pointer
  }
  if (channels.stable === undefined || channels.beta === undefined) throw new Error('the first timestamp needs a release to name')
  return {
    schema: RELEASE_SCHEMAS.timestamp,
    version: (previous?.version ?? 0) + 1,
    issued: utc(issued),
    expires: utc(issued + TIMESTAMP_LIFETIME_SECONDS),
    root: { version: root.metadata.version, sha256: sha256Hex(createHash('sha256').update(root.bytes).digest('hex')) },
    channels: { stable: channels.stable, beta: channels.beta },
  }
}
