/**
 * Timestamp metadata (contract C2): the online timestamp key re-signs it every 24 hours and at each release, naming
 * each channel's current manifest by digest. Every signing reads the previous timestamp only after it verifies with
 * the root it names, and names a manifest for each channel only after that manifest verifies with the newest root's
 * targets keys. A new timestamp's version is one above the previous one's, it expires exactly 3 days after it is
 * issued, the stable channel names a stable release, the beta channel a beta or stable release, and no channel moves
 * to a lower version or to another manifest of the version it names.
 *
 * @module @delo/release/sign/timestamp
 */
import { createHash } from 'node:crypto'
import {
  RELEASE_CHANNELS,
  RELEASE_SCHEMAS,
  TIMESTAMP_LIFETIME_SECONDS,
  type ChannelPointer,
  type FileRef,
  type ReleaseChannel,
  type TimestampMetadata,
  type UtcTimestamp,
} from '@delo/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import semver from 'semver'
import { sha256Hex } from '../brands.ts'
import { readEnvelope } from './schemas.ts'
import { channelAccepts, verifySignedManifest, verifyTimestamp, type TrustedRoot } from './verify.ts'

/** A manifest file a channel names. */
export interface ManifestFile {
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
 * Verify the previous timestamp with the root it names, which may be older than the newest root after a rotation.
 * @param roots - the verified root chain, oldest first.
 * @param bytes - the previous timestamp file.
 * @param now - the signing time, in Unix seconds.
 * @returns the previous timestamp.
 * @throws Error when the timestamp names a root outside the chain or does not verify with it; an expired timestamp
 * verifies.
 */
function verifyPrevious(roots: readonly TrustedRoot[], bytes: Uint8Array, now: number): TimestampMetadata {
  const named = readEnvelope('timestamp', bytes).signed.root.version
  const root = roots.find(candidate => candidate.metadata.version === named)
  if (root === undefined) throw new Error(`the previous timestamp names root ${String(named)}, which is not among the roots passed`)
  return verifyTimestamp(root, bytes, now, undefined, { allowExpired: true })
}

/**
 * The next timestamp's content.
 * @param roots - the verified root chain, oldest first; the newest signs nothing here but names the targets keys.
 * @param previous - the previous timestamp file, absent only for the first timestamp.
 * @param manifests - the manifest file each channel names.
 * @param now - the signing time, in Unix seconds.
 * @returns the content to sign.
 * @throws Error when the previous timestamp does not verify, a manifest does not verify with the newest root's targets
 * keys or is on a channel the timestamp channel may not name, or a channel would move to a lower version or to another
 * manifest of the same version.
 */
export function nextTimestamp(roots: readonly TrustedRoot[], previous: Uint8Array | undefined, manifests: Readonly<Record<ReleaseChannel, ManifestFile>>, now: number): TimestampMetadata {
  const root = roots.at(-1)
  if (root === undefined) throw new Error('no root to sign the timestamp under')
  const issued = Math.floor(now)
  const before = previous === undefined ? undefined : verifyPrevious(roots, previous, issued)
  const channels: Partial<Record<ReleaseChannel, ChannelPointer>> = {}
  for (const channel of RELEASE_CHANNELS) {
    const file = manifests[channel]
    const manifest = verifySignedManifest(root.metadata, file.bytes)
    if (!channelAccepts(channel, manifest.channel)) throw new Error(`${file.name} is a ${manifest.channel} release, which the ${channel} channel does not name`)
    const pointer = { release: manifest.version, manifest: fileRef(file.name, file.bytes) }
    const last = before?.channels[channel]
    if (last !== undefined) {
      if (semver.lt(pointer.release, last.release)) throw new Error(`the ${channel} channel would move back from ${last.release} to ${pointer.release}`)
      if (pointer.release === last.release && (pointer.manifest.sha256 !== last.manifest.sha256 || pointer.manifest.name !== last.manifest.name)) {
        throw new Error(`the ${channel} channel names release ${last.release} by ${last.manifest.name} ${last.manifest.sha256}; ${file.name} is another manifest of that release`)
      }
    }
    channels[channel] = pointer
  }
  return {
    schema: RELEASE_SCHEMAS.timestamp,
    version: (before?.version ?? 0) + 1,
    issued: utc(issued),
    expires: utc(issued + TIMESTAMP_LIFETIME_SECONDS),
    root: { version: root.metadata.version, sha256: root.sha256 },
    channels: { stable: channels.stable!, beta: channels.beta! },
  }
}
