/**
 * Timestamp metadata (contract C2): the online timestamp key re-signs it every 24 hours and at each release, naming
 * each channel's current manifest by digest. The signer keeps state that the release workflow protects and the
 * metadata host never serves: the root it trusts and the last timestamp it signed, with its bytes. Every signing
 * starts from that root and from that timestamp, which no caller supplies, so a genuine but older timestamp and its
 * manifests cannot roll a channel back; only the first signing, requested explicitly, has no previous timestamp. A
 * channel names a manifest only after it verifies with the newest root's targets keys; the stable channel names a
 * stable release, the beta channel a beta or stable release; and no channel moves to a lower version, or to another
 * manifest of the version it names unless that manifest's signed content is the same apart from `published` and the
 * named one no longer verifies, or the signed content is identical and only signatures differ.
 *
 * @module @delo/release/sign/timestamp
 */
import { createHash } from 'node:crypto'
import {
  RELEASE_CHANNELS,
  RELEASE_FILE_SIZE_LIMITS,
  RELEASE_SCHEMAS,
  TIMESTAMP_LIFETIME_SECONDS,
  type ChannelPointer,
  type FileRef,
  type ReleaseChannel,
  type Sha256Hex,
  type TimestampMetadata,
  type UtcTimestamp,
} from '@delo/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import semver from 'semver'
import { z } from 'zod'
import { sha256Hex } from '@delo/release-formats/brands'
import { canonicalJson, parseStrictJson, type JsonValue } from '@delo/release-formats/sign/json'
import { readEnvelope } from '@delo/release-formats/sign/schemas'
import { channelAccepts, verifySignedManifest, verifyTimestamp, type TrustedRoot } from '@delo/release-formats/sign/verify'

/** A manifest file a channel names. */
export interface ManifestFile {
  /** The manifest file's name. */
  readonly name: string
  /** The manifest file's bytes. */
  readonly bytes: Uint8Array
}

const digest = z.string().regex(/^[0-9a-f]{64}$/u).transform(value => sha256Hex(value))
const counted = z.strictObject({ version: z.number().int().min(1), sha256: digest })
const base64 = z.string().max(Math.ceil(RELEASE_FILE_SIZE_LIMITS.timestamp / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/u)

/** The timestamp signer's state: the root it trusts and the last timestamp it signed, absent before the first. */
export const TimestampStateSchema = z.strictObject({
  schema: z.literal('delo.release-timestamp-state/1'),
  root: counted,
  timestamp: counted.extend({ file: base64 }).nullable(),
})

/** {@link TimestampStateSchema}'s parsed value. */
export interface TimestampState {
  /** The schema id. */
  readonly schema: 'delo.release-timestamp-state/1'
  /** The newest root the signer trusts, by version and file digest. */
  readonly root: { readonly version: number, readonly sha256: Sha256Hex }
  /** The last timestamp signed: its version, file digest and file as base64; `null` before the first. */
  readonly timestamp: { readonly version: number, readonly sha256: Sha256Hex, readonly file: string } | null
}

/**
 * Read the signer's state file.
 * @param bytes - the file's bytes.
 * @returns the state.
 * @throws Error when the file is not strict JSON of the state schema.
 */
export function readTimestampState(bytes: Uint8Array): TimestampState {
  const parsed = TimestampStateSchema.safeParse(parseStrictJson(bytes, 4 * RELEASE_FILE_SIZE_LIMITS.timestamp))
  if (!parsed.success) throw new Error(`timestamp state: ${z.prettifyError(parsed.error).replaceAll('\n', '; ')}`)
  return parsed.data
}

function sha256Of(bytes: Uint8Array): Sha256Hex {
  return sha256Hex(createHash('sha256').update(bytes).digest('hex'))
}

/**
 * The state before the first timestamp, anchored to the root the owner trusts.
 * @param root - that root.
 * @returns the state.
 */
export function initialState(root: TrustedRoot): TimestampState {
  return { schema: 'delo.release-timestamp-state/1', root: { version: root.metadata.version, sha256: root.sha256 }, timestamp: null }
}

/**
 * The state after a signing.
 * @param root - the newest root, which the new timestamp names.
 * @param timestamp - the new timestamp file.
 * @param version - its version.
 * @returns the state.
 */
export function stateAfter(root: TrustedRoot, timestamp: Uint8Array, version: number): TimestampState {
  return { schema: 'delo.release-timestamp-state/1', root: { version: root.metadata.version, sha256: root.sha256 }, timestamp: { version, sha256: sha256Of(timestamp), file: Buffer.from(timestamp).toString('base64') } }
}

function utc(seconds: number): UtcTimestamp {
  return brandString<UtcTimestamp>(`${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`)
}

function fileRef(name: string, bytes: Uint8Array): FileRef {
  return { name, length: bytes.byteLength, sha256: sha256Of(bytes) }
}

/** What the next timestamp is signed from. */
export interface TimestampRequest {
  /** The signer's state. */
  readonly state: TimestampState
  /** The verified root chain, oldest first; the first must be the state's root. */
  readonly roots: readonly TrustedRoot[]
  /** Whether this is the first signing, which the state must allow; otherwise it continues from the state's timestamp. */
  readonly first: boolean
  /** The manifest file each channel names. */
  readonly manifests: Readonly<Record<ReleaseChannel, ManifestFile>>
  /** Manifests the previous timestamp names that a re-signed manifest of the same release replaces. */
  readonly replaced: readonly ManifestFile[]
  /** The signing time, in Unix seconds. */
  readonly now: number
}

/**
 * Verify the previous timestamp the state holds, signed under the root it names, which may be older than the newest
 * root after a rotation.
 * @param request - the request.
 * @returns the previous timestamp, or `undefined` for the first signing.
 * @throws Error when the first-signing request does not match the state, or the state's timestamp does not match its
 * digest and version or does not verify.
 */
function verifyPrevious(request: TimestampRequest): TimestampMetadata | undefined {
  const last = request.state.timestamp
  if (request.first) {
    if (last !== null) throw new Error(`the state records timestamp ${String(last.version)} as the last signed; continue from it instead of signing a first timestamp`)
    return undefined
  }
  if (last === null) throw new Error('the state records no timestamp yet; sign the first timestamp with --first')
  const bytes = Buffer.from(last.file, 'base64')
  const actual = sha256Of(bytes)
  if (actual !== last.sha256) throw new Error(`the state's last timestamp has SHA-256 ${actual}, not the ${last.sha256} it records`)
  const named = readEnvelope('timestamp', bytes).signed.root.version
  const root = request.roots.find(candidate => candidate.metadata.version === named)
  if (root === undefined) throw new Error(`the previous timestamp names root ${String(named)}, which is not among the roots passed`)
  const previous = verifyTimestamp(root, bytes, request.now, undefined, { allowExpired: true })
  if (previous.version !== last.version) throw new Error(`the state's last timestamp is version ${String(previous.version)}, not the ${String(last.version)} it records`)
  return previous
}

/**
 * A manifest's signed content without `published`, which a re-signing may change, in RFC 8785 form.
 * @param bytes - the manifest file.
 * @returns the canonical text.
 */
function contentApartFromPublished(bytes: Uint8Array): string {
  const signed = readEnvelope('manifest', bytes).signedJson
  if (signed === null || typeof signed !== 'object' || Array.isArray(signed)) throw new Error('the manifest\'s signed content is not an object')
  const { published: _published, ...rest } = signed as { readonly [key: string]: JsonValue }
  return canonicalJson(rest)
}

/**
 * Whether a manifest may replace the one a channel names for the same release. The replaced file must be the one
 * named, and the signed content must be the same: either identical, so only signatures differ, or the same apart
 * from `published` while the named manifest no longer verifies with the newest root's targets keys, as after a
 * targets-key rotation, which re-signs offered manifests without changing them.
 * @param root - the newest root.
 * @param named - the pointer the previous timestamp holds.
 * @param file - the new manifest file.
 * @param replaced - the files offered as the named manifest.
 * @returns why the replacement is allowed, or `undefined` when it is not.
 */
function replacementAllowed(root: TrustedRoot, named: ChannelPointer, file: ManifestFile, replaced: readonly ManifestFile[]): string | undefined {
  const old = replaced.find(candidate => sha256Of(candidate.bytes) === named.manifest.sha256 && candidate.bytes.byteLength === named.manifest.length)
  if (old === undefined) return undefined
  if (canonicalJson(readEnvelope('manifest', old.bytes).signedJson) === canonicalJson(readEnvelope('manifest', file.bytes).signedJson)) return 'only signatures differ'
  if (contentApartFromPublished(old.bytes) !== contentApartFromPublished(file.bytes)) return undefined
  try {
    verifySignedManifest(root.metadata, old.bytes)
  } catch {
    // The named manifest no longer verifies with the newest root's targets keys, so its re-signing replaces it.
    return 'the named manifest no longer verifies, and only `published` and signatures differ'
  }
  return undefined
}

/**
 * The next timestamp's content.
 * @param request - the state, roots, first-signing flag, manifests and time.
 * @returns the content to sign.
 * @throws Error when the first root is not the state's, the previous timestamp is not the state's last or does not
 * verify, a manifest does not verify with the newest root's targets keys or is on a channel the timestamp channel may
 * not name, or a channel would move to a lower version or to another manifest of the same version that may not
 * replace the named one.
 */
export function nextTimestamp(request: TimestampRequest): TimestampMetadata {
  const anchor = request.roots[0]
  const root = request.roots.at(-1)
  if (anchor === undefined || root === undefined) throw new Error('no root to sign the timestamp under')
  const trusted = request.state.root
  if (anchor.metadata.version !== trusted.version || anchor.sha256 !== trusted.sha256) {
    throw new Error(`the first root passed is root ${String(anchor.metadata.version)} with SHA-256 ${anchor.sha256}; the state trusts root ${String(trusted.version)} with SHA-256 ${trusted.sha256}`)
  }
  const issued = Math.floor(request.now)
  const before = verifyPrevious(request)
  const channels: Partial<Record<ReleaseChannel, ChannelPointer>> = {}
  for (const channel of RELEASE_CHANNELS) {
    const file = request.manifests[channel]
    const manifest = verifySignedManifest(root.metadata, file.bytes)
    if (!channelAccepts(channel, manifest.channel)) throw new Error(`${file.name} is a ${manifest.channel} release, which the ${channel} channel does not name`)
    const pointer = { release: manifest.version, manifest: fileRef(file.name, file.bytes) }
    const last = before?.channels[channel]
    if (last !== undefined) {
      if (semver.lt(pointer.release, last.release)) throw new Error(`the ${channel} channel would move back from ${last.release} to ${pointer.release}`)
      const sameFile = pointer.manifest.sha256 === last.manifest.sha256 && pointer.manifest.name === last.manifest.name
      if (pointer.release === last.release && !sameFile && replacementAllowed(root, last, file, request.replaced) === undefined) {
        throw new Error(`the ${channel} channel names release ${last.release} by ${last.manifest.name} ${last.manifest.sha256}; ${file.name} is another manifest of that release, which replaces it only when it differs from the named manifest, passed with --replaced, in signatures alone, or also in published once the named one no longer verifies`)
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
