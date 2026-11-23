/**
 * Types and fixed values of contract C2, the release manifest and signature
 * (`delorun/docs/contracts/c02-release-manifest.md`). Every signed release file uses
 * {@link SignedEnvelope}; the page states the verification order, freshness and
 * rollback rules, key rotation and the checks before signing.
 *
 * @module @delorun/contract-release-manifest
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Lowercase hex SHA-256 of a key's 32-byte raw Ed25519 public key. */
export type KeyId = Branded<'delorun.release.KeyId'>

/** Lowercase hex SHA-256 digest, 64 characters. */
export type Sha256Hex = Branded<'delorun.release.Sha256Hex'>

/** Standard base64 SHA-512 digest with padding, as electron-updater compares it. */
export type Sha512Base64 = Branded<'delorun.release.Sha512Base64'>

/** npm integrity string of a tarball, `sha512-<base64>`. */
export type NpmIntegrity = Branded<'delorun.release.NpmIntegrity'>

/** OCI digest, `sha256:<64 lowercase hex>`. */
export type OciDigest = Branded<'delorun.release.OciDigest'>

/** Semantic version string without a leading `v`; prereleases allowed. */
export type SemanticVersion = Branded<'delorun.release.SemanticVersion'>

/** RFC 3339 UTC timestamp with a `Z` suffix and whole seconds. */
export type UtcTimestamp = Branded<'delorun.release.UtcTimestamp'>

/** GitHub Advisory Database id, `GHSA-xxxx-xxxx-xxxx`. */
export type AdvisoryId = Branded<'delorun.release.AdvisoryId'>

/** The two release channels. */
export type ReleaseChannel = 'stable' | 'beta'

/** The release channels in display order. */
export const RELEASE_CHANNELS: readonly ReleaseChannel[] = ['stable', 'beta']

/** Runtime closure platforms: Node's `process.platform` and `process.arch` joined by a hyphen. */
export type RuntimePlatform = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64' | 'win32-x64'

/** Every runtime closure platform a release can publish; each release's manifest lists the ones it does. */
export const RUNTIME_PLATFORMS: readonly RuntimePlatform[] = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64']

/** Desktop installer platforms. */
export type DesktopPlatform = 'mac-arm64' | 'mac-x64' | 'win-x64'

/** Every desktop platform a release publishes. */
export const DESKTOP_PLATFORMS: readonly DesktopPlatform[] = ['mac-arm64', 'mac-x64', 'win-x64']

/** Platforms of the S2 and S3 images, as OCI names them. */
export type ImagePlatform = 'linux/amd64' | 'linux/arm64'

/** The `schema` values of every signed release file, one per file kind and major version. */
export const RELEASE_SCHEMAS = {
  root: 'delorun.release-root/1',
  timestamp: 'delorun.release-timestamp/1',
  manifest: 'delorun.release-manifest/1',
  files: 'delorun.release-files/1',
  rebuild: 'delorun.release-rebuild/1',
  packs: 'delorun.release-packs/1',
} as const

/** One signature over the RFC 8785 canonical bytes of an envelope's `signed` value. */
export interface EnvelopeSignature {
  /** The signing key's id. */
  readonly keyid: KeyId
  /** Pure Ed25519 signature (RFC 8032), standard base64 with padding. */
  readonly sig: string
}

/**
 * A signed release or catalogue file. It verifies when signatures from distinct keys of the
 * role's current key set reach the role's threshold; unknown keys are ignored and readers refuse
 * unknown fields in `signed`, duplicate JSON keys and files above their size limit.
 */
export interface SignedEnvelope<T> {
  /** The signed content; its `schema` field names the file kind and major version. */
  readonly signed: T
  /** Signatures over the canonical bytes of `signed`. */
  readonly signatures: readonly EnvelopeSignature[]
}

/** A file named by its bytes. */
export interface FileRef {
  /**
   * The file name on the release or metadata host: one path segment of letters, digits, `.`, `_`, `+` and `-`, never
   * `.` or `..`, matching `^[A-Za-z0-9._+-]+$`, so a reference names a file in the release directory and no other.
   */
  readonly name: string
  /** Length in bytes. */
  readonly length: number
  /** SHA-256 of the file's bytes. */
  readonly sha256: Sha256Hex
}

/** A desktop file, which electron-updater also checks by SHA-512. */
export interface DesktopFileRef extends FileRef {
  /** SHA-512 of the file's bytes. */
  readonly sha512: Sha512Base64
}

/** Key roles of the root metadata. */
export type KeyRole = 'root' | 'targets' | 'timestamp' | 'catalogue'

/** A public key the root metadata lists. */
export interface PublicKey {
  /** The only algorithm. */
  readonly algorithm: 'ed25519'
  /** The 32-byte raw public key, standard base64. */
  readonly public: string
}

/** The keys and threshold of the root, timestamp or catalogue role. */
export interface RoleKeys {
  /** The role's current keys. */
  readonly keyids: readonly KeyId[]
  /** Distinct valid signatures needed. */
  readonly threshold: number
}

/**
 * A targets key's status. `active` signs new releases (exactly one is active); `retired`
 * verifies only manifests whose version is at most `lastRelease`; `revoked` verifies nothing.
 */
export type TargetsKeyStatus = 'active' | 'retired' | 'revoked'

/** One targets key entry. */
export interface TargetsKey {
  /** The key's id. */
  readonly keyid: KeyId
  /** What the key may still verify. */
  readonly status: TargetsKeyStatus
  /** For a `retired` key, the last Delorun version it signed. */
  readonly lastRelease?: SemanticVersion
}

/** The targets role. */
export interface TargetsRole {
  /** Every targets key with its status. */
  readonly keys: readonly TargetsKey[]
  /** Distinct valid signatures needed. */
  readonly threshold: number
}

/** The release log's checkpoint identity (contract C18). */
export interface LogIdentity {
  /** The checkpoint origin line. */
  readonly origin: string
  /** The checkpoint verifier key in signed-note verifier format. */
  readonly vkey: string
}

/** A log a root lists in `logs` (contract C18). */
export interface ListedLog extends LogIdentity {
  /**
   * For a log other than the root's current `log`, the last Delorun version whose bundle may be in it: a bundle of a
   * later release in that log is refused, so only the current log takes new releases. Every other listed log carries
   * it; the current log carries none.
   */
  readonly lastRelease?: SemanticVersion
}

/** One witness verifier key (contract C18). */
export interface WitnessKey {
  /** The witness's name, as its verifier key names it. */
  readonly name: string
  /** The cosignature verifier key in signed-note verifier format. */
  readonly vkey: string
}

/** The witnesses whose cosignatures clients accept, and how many must cosign. */
export interface WitnessSet {
  /** Accepted witness keys. */
  readonly keys: readonly WitnessKey[]
  /** Distinct listed witnesses that must cosign a checkpoint. */
  readonly threshold: number
}

/**
 * A log-entry key's status, as a targets key's: `active` signs new log entries, `retired` verifies only the entries of
 * releases at most `lastRelease`, and `revoked` verifies nothing.
 */
export type LogEntryKeyStatus = 'active' | 'retired' | 'revoked'

/**
 * One key the root trusts to sign release log entries (contract C18), with the entry key type it signs under. The key
 * signs log entries only: it is not in {@link RootMetadata.keys}, so no role can sign a metadata envelope with it.
 */
export interface LogEntryKey {
  /** The Rekor v2 `keyDetails` an entry signed by this key carries, such as `PKIX_ED25519_PH`. */
  readonly keyDetails: string
  /** The public key, base64 DER (PKIX SubjectPublicKeyInfo), byte for byte as a log entry's verifier carries it. */
  readonly public: string
  /** What the key may still verify. */
  readonly status: LogEntryKeyStatus
  /** For a `retired` key, the last Delorun version whose entry it signed. */
  readonly lastRelease?: SemanticVersion
}

/** `root/<n>.root.json`: every role's keys, signed by the root role. */
export interface RootMetadata {
  /** Always {@link RELEASE_SCHEMAS}.root. */
  readonly schema: typeof RELEASE_SCHEMAS.root
  /** Root version; each rotation adds exactly 1, and the new version is signed by the previous and its own root threshold. */
  readonly version: number
  /** When it was signed. */
  readonly issued: UtcTimestamp
  /** At most {@link ROOT_MAX_LIFETIME_DAYS} after `issued`. */
  readonly expires: UtcTimestamp
  /** Every key any role names. */
  readonly keys: Readonly<Record<KeyId, PublicKey>>
  /** Role keys and thresholds. */
  readonly roles: {
    readonly root: RoleKeys
    readonly targets: TargetsRole
    readonly timestamp: RoleKeys
    readonly catalogue: RoleKeys
  }
  /** The release log's identity: the log new releases are logged in and the online check reads. */
  readonly log: LogIdentity
  /**
   * Every log whose checkpoints verify a release's bundle, `log` among them, so a release logged in an earlier log
   * (such as a previous Rekor shard) still verifies after a rotation moves `log`, up to that log's `lastRelease`. A root
   * without it trusts no log; it is optional only so that the root chain can read `1.root.json`, which predates it.
   */
  readonly logs?: readonly ListedLog[]
  /**
   * The keys trusted to sign release log entries, each with its entry key type, in the order the signing tool tries
   * them. A root without it verifies no release; it is optional only so that the root chain can read `1.root.json`.
   */
  readonly logEntryKeys?: readonly LogEntryKey[]
  /** The witnesses clients require. */
  readonly witnesses: WitnessSet
}

/** One channel's current release in the timestamp metadata. */
export interface ChannelPointer {
  /** The channel's current Delorun version. */
  readonly release: SemanticVersion
  /** That release's manifest file. */
  readonly manifest: FileRef
}

/** `timestamp.json`: freshness of each channel's current manifest, signed by the timestamp role. */
export interface TimestampMetadata {
  /** Always {@link RELEASE_SCHEMAS}.timestamp. */
  readonly schema: typeof RELEASE_SCHEMAS.timestamp
  /** Adds 1 at every signing; clients refuse a lower value than the one they stored. */
  readonly version: number
  /** When it was signed. */
  readonly issued: UtcTimestamp
  /** Exactly {@link TIMESTAMP_LIFETIME_SECONDS} after `issued`. */
  readonly expires: UtcTimestamp
  /** The newest root version and its file digest. */
  readonly root: { readonly version: number, readonly sha256: Sha256Hex }
  /** Each channel's current release. */
  readonly channels: Readonly<Record<ReleaseChannel, ChannelPointer>>
}

/** A runtime closure archive and its file list. */
export interface RuntimeArtifacts {
  /** `delorun-<version>-<platform>.tar.gz`, or `.zip` for `win32-x64`. */
  readonly archive: FileRef
  /** `delorun-<version>-<platform>.files.json`. */
  readonly files: FileRef
}

/** The desktop files of one platform. */
export interface DesktopArtifacts {
  /** The installer: `.dmg` on macOS, the NSIS `.exe` on Windows. */
  readonly installer: DesktopFileRef
  /** The file electron-updater applies: the `.zip` on macOS, the installer on Windows. */
  readonly update: DesktopFileRef
  /** electron-updater's block map of the update file. */
  readonly blockmap: FileRef
}

/** An S2 or S3 image by digest. */
export interface ImageRef {
  /** The image repository; contract C9 names the registry. */
  readonly repository: string
  /** The OCI image index digest. */
  readonly index: OciDigest
  /** The per-platform manifest digests. */
  readonly platforms: Readonly<Record<ImagePlatform, OciDigest>>
  /** The release file holding the seccomp profile the image's containers run under; without it, the engine's default profile. */
  readonly seccomp?: FileRef
}

/** One npm package of the release. */
export interface NpmPackageRef {
  /** `delorun` or `create-delorun`. */
  readonly name: string
  /** Its version, equal to the release's. */
  readonly version: SemanticVersion
  /** The tarball's integrity. */
  readonly integrity: NpmIntegrity
}

/** One builder whose rebuild matched. */
export interface RebuildBuilder {
  /** The builder's name. */
  readonly name: string
  /** Always false for a rebuild signing accepts. */
  readonly ci: false
}

/** `delorun-<version>.manifest.json`: everything in one release, signed by the targets role. It carries no expiry. */
export interface ReleaseManifest {
  /** Always {@link RELEASE_SCHEMAS}.manifest. */
  readonly schema: typeof RELEASE_SCHEMAS.manifest
  /** Delorun's version of this release. */
  readonly version: SemanticVersion
  /** The `@deepseek-ai/dsh-app-boot` version in the release (contract C17). */
  readonly dsh: SemanticVersion
  /** The channel the release is published on. */
  readonly channel: ReleaseChannel
  /** The tagged source. */
  readonly source: {
    /** The public repository URL, {@link RELEASE_REPOSITORY_URL}. */
    readonly repository: string
    /** `v<version>`. */
    readonly tag: string
    /** The 40-hex commit the tag names. */
    readonly commit: string
  }
  /** When the targets key signed it. */
  readonly published: UtcTimestamp
  /**
   * Runtime closures per platform: exactly the platforms the release publishes, at least one. A platform without an
   * entry is not in this release, and a client on it installs nothing.
   */
  readonly runtime: Readonly<Partial<Record<RuntimePlatform, RuntimeArtifacts>>>
  /** Desktop files per platform; absent from a release that publishes none. */
  readonly desktop?: Readonly<Record<DesktopPlatform, DesktopArtifacts>>
  /** The Docker images contract C9 runs; absent from a release that publishes none. */
  readonly images?: { readonly s2: ImageRef, readonly s3: ImageRef }
  /** The release's SPDX 2.3 JSON SBOM. */
  readonly sbom: FileRef & { readonly format: 'SPDX-2.3+json' }
  /** The release's npm packages. */
  readonly npm: readonly NpmPackageRef[]
  /** The install scripts; absent from a release that publishes none. */
  readonly install?: { readonly sh: FileRef, readonly ps1: FileRef }
  /** The rebuild record and who rebuilt. */
  readonly rebuild: { readonly record: FileRef, readonly builders: readonly RebuildBuilder[] }
  /** The advisory check's report and every accepted advisory. */
  readonly advisories: { readonly report: FileRef, readonly accepted: readonly AdvisoryId[] }
  /**
   * Whether the release is marked as a security fix. Signing always writes it; a reader treats an absent value, which
   * only a manifest signed before the field existed holds, as false.
   */
  readonly security?: boolean
  /**
   * The release's one-line summary, valid by {@link isValidSummary}. Signing always writes it; a reader treats
   * an absent value as no summary.
   */
  readonly summary?: string
  /**
   * The release notes, a plain-text file in the release directory that {@link isValidNotes} accepts and whose length
   * is at most {@link RELEASE_FILE_SIZE_LIMITS}`.notes`. A reader treats an absent value as no notes. A reader older
   * than this field refuses a manifest that carries it, so a release signs it only after the readers in use know it.
   */
  readonly notes?: FileRef
}

/** The most Unicode code points a release summary holds. */
export const RELEASE_SUMMARY_MAX_LENGTH = 200

/**
 * {@link isValidSummary}'s rule. The `u` flag reads a surrogate pair as one code point and a lone surrogate as a code
 * point of category Cs, which the class refuses; no `g` or `y` flag keeps `test` stateless.
 */
const RELEASE_SUMMARY_PATTERN = /^(?!\s)(?!.*\s$)(?=.{1,200}$)[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+$/u

/**
 * Whether a text is a valid release summary: 1 to {@link RELEASE_SUMMARY_MAX_LENGTH} Unicode code points (a surrogate
 * pair counts once), no control (Cc), format (Cf), line separator (Zl) or paragraph separator (Zp) character, no lone
 * UTF-16 surrogate (a high surrogate not followed by a low one, or a low one not preceded by a high one), and no
 * whitespace at either end, so it is never blank. Terminals and the studio print the summary, so it carries no line
 * break, terminal escape, bidirectional override or text that is not valid Unicode.
 * @param text - the candidate summary.
 * @returns true when the text is a valid summary.
 */
export function isValidSummary(text: string): boolean {
  return RELEASE_SUMMARY_PATTERN.test(text)
}

/** Mode of a runtime file. */
export type RuntimeFileMode = '0644' | '0755'

/** One regular file of an extracted runtime archive. */
export interface RuntimeFile {
  /** Relative, `/`-separated, normalised path inside the installation. */
  readonly path: string
  /** Length in bytes. */
  readonly length: number
  /** SHA-256 of its bytes. */
  readonly sha256: Sha256Hex
  /** Its mode. */
  readonly mode: RuntimeFileMode
}

/** `delorun-<version>-<platform>.files.json`: every file of one archive, signed by the targets role. */
export interface RuntimeFileList {
  /** Always {@link RELEASE_SCHEMAS}.files. */
  readonly schema: typeof RELEASE_SCHEMAS.files
  /** The release. */
  readonly version: SemanticVersion
  /** The platform. */
  readonly platform: RuntimePlatform
  /** Exactly the archive's entries; a missing, changed or extra file fails the start check. */
  readonly files: readonly RuntimeFile[]
}

/** One file of a pack variant. */
export type PackFile = RuntimeFile

/**
 * A dependency a pack needs but Delorun's files never carry: its package comes from the npm registry and is checked
 * against `sha512`, which the targets key signed. It exists for packages whose licence forbids redistribution.
 */
export interface PackExternal {
  /** The npm package name. */
  readonly name: string
  /** The exact version. */
  readonly version: SemanticVersion
  /** The official tarball URL on `https://registry.npmjs.org/`. */
  readonly url: string
  /** The tarball's standard base64 SHA-512 (the lockfile's integrity at cut time). */
  readonly sha512: Sha512Base64
  /** The tarball's length in bytes; the panel shows the real size before it starts. */
  readonly length: number
}

/** One platform's variant of a pack. */
export interface PackVariant {
  /** The pack archive on the release channel (`.tar.gz`), by name, length and digests. */
  readonly archive: FileRef & { readonly sha512: Sha512Base64 }
  /** Every regular file of the archive, as a runtime file list holds them. */
  readonly files: readonly PackFile[]
  /** Dependencies fetched from npm instead of shipped, for this platform. */
  readonly external: readonly PackExternal[]
  /** Package names this platform's base runtime provides; the install links them into the pack. */
  readonly peers: readonly string[]
}

/** One pack: a plugin package that is not in the default install. */
export interface PackEntry {
  /** The package name. */
  readonly name: string
  /** The package version. */
  readonly version: SemanticVersion
  /** Whether Plugins labels it experimental. */
  readonly experimental: boolean
  /** The variant per platform, or `any` for a pack with no native code. */
  readonly variants: Readonly<Partial<Record<RuntimePlatform | 'any', PackVariant>>>
}

/**
 * `delorun-<version>.packs.json`: the packs of one release, in the targets-signed envelope. It is a separate file so
 * that readers of the manifest never meet it; it names the manifest it belongs to by SHA-256.
 */
export interface ReleasePacks {
  /** Always {@link RELEASE_SCHEMAS}.packs. */
  readonly schema: typeof RELEASE_SCHEMAS.packs
  /** The release. */
  readonly version: SemanticVersion
  /** SHA-256 of the release's manifest file, which binds this file to that release. */
  readonly manifest: Sha256Hex
  /** The packs, by name. */
  readonly packs: readonly PackEntry[]
}

/** `delorun-<version>.rebuild.json`: the targets-key holder's rebuild, which signing requires. */
export interface RebuildRecord {
  /** Always {@link RELEASE_SCHEMAS}.rebuild. */
  readonly schema: typeof RELEASE_SCHEMAS.rebuild
  /** The release rebuilt. */
  readonly version: SemanticVersion
  /** The commit rebuilt; signing refuses one that differs from the tag's. */
  readonly commit: string
  /** SHA-256 of the recipe files used. */
  readonly recipe: Sha256Hex
  /** Who rebuilt; signing refuses `ci: true`. */
  readonly builder: { readonly name: string, readonly ci: boolean }
  /** Toolchain versions used. */
  readonly toolchain: { readonly node: string, readonly pnpm: string, readonly compiler: string, readonly linker: string }
  /** Every output file's digest, which signing recomputes from the local output directory. */
  readonly outputs: readonly FileRef[]
  /** The release workflow run the rebuild was compared against. */
  readonly comparedWith: string
  /** The comparison's result; signing refuses anything but `match`. */
  readonly comparison: 'match' | 'difference'
}

/** One entry of `delorun/release/advisory-acceptances.yaml`. */
export interface AdvisoryAcceptance {
  /** The GHSA id. */
  readonly advisory: AdvisoryId
  /** The npm package name. */
  readonly package: string
  /** Semantic-version range of locked versions covered. */
  readonly range: string
  /** Why the release may ship with it. */
  readonly reason: string
  /** GitHub login of the approving maintainer, a CODEOWNERS owner of `delorun/release/`. */
  readonly approver: string
  /** The last Delorun version covered; a later release fails the check. */
  readonly lapsesAfter: SemanticVersion
  /** The date the entry was added, `YYYY-MM-DD`, which the release notes show. */
  readonly added: string
}

/** The parsed acceptances file. Unknown fields fail the advisory check. */
export interface AdvisoryAcceptances {
  /** Every reviewed acceptance. */
  readonly acceptances: readonly AdvisoryAcceptance[]
}

/** Repository path of the advisory acceptances file. */
export const ADVISORY_ACCEPTANCES_PATH = 'delorun/release/advisory-acceptances.yaml'

/** The advisory feed: npm's bulk advisory API over the GitHub Advisory Database. */
export const ADVISORY_FEED_URL = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk'

/** Delorun's public repository: its `v<version>` tags and GitHub releases are the releases, and its release workflow publishes to npm. */
export const RELEASE_REPOSITORY_URL = 'https://github.com/twickas/delorun'

/** Host of the release metadata (`root/<n>.root.json`, `timestamp.json`). */
export const RELEASE_METADATA_ORIGIN = 'https://releases.delorun.com'

/** The spare host that serves every release file, metadata included, when {@link RELEASE_METADATA_ORIGIN} fails. */
export const RELEASE_SPARE_ORIGIN = 'https://releases.delo.run'

/** Timestamp metadata lifetime: 3 days. */
export const TIMESTAMP_LIFETIME_SECONDS = 259_200

/** Interval at which the release workflow re-signs the timestamp metadata: 24 hours. */
export const TIMESTAMP_RESIGN_INTERVAL_SECONDS = 86_400

/** Maximum root metadata lifetime. */
export const ROOT_MAX_LIFETIME_DAYS = 365

/** Days before root expiry by which the next root version is signed. */
export const ROOT_RENEWAL_LEAD_DAYS = 30

/** Clock tolerance applied to every expiry. */
export const CLOCK_TOLERANCE_SECONDS = 0

/** Previous releases the desktop update cache keeps. */
export const DESKTOP_CACHED_PREVIOUS_RELEASES = 1

/** Per-request timeout for release metadata and release files. */
export const METADATA_REQUEST_TIMEOUT_SECONDS = 30

/** The most bytes one pack archive, or one external npm tarball, may have: the signed length is capped here. */
export const PACK_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024

/** An npm package name (lower case, optionally scoped), the only form a pack, a peer or an external may carry. */
export const NPM_PACKAGE_NAME_PATTERN = '^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$'

/** Size limits in bytes, applied before parsing. */
export const RELEASE_FILE_SIZE_LIMITS = {
  root: 64 * 1024,
  timestamp: 16 * 1024,
  manifest: 1024 * 1024,
  files: 32 * 1024 * 1024,
  rebuild: 1024 * 1024,
  packs: 8 * 1024 * 1024,
  advisories: 8 * 1024 * 1024,
  notes: 64 * 1024,
} as const

/**
 * {@link isValidNotes}'s rule: no control character except line feed and tab, no format (Cf, which holds the
 * bidirectional overrides), line separator (Zl), paragraph separator (Zp) or lone surrogate. The `u` flag reads a
 * surrogate pair as one code point.
 */
const RELEASE_NOTES_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u

/**
 * Whether bytes are valid release notes: well-formed UTF-8 of 1 to {@link RELEASE_FILE_SIZE_LIMITS}`.notes` bytes
 * whose text holds no character the studio could use to change how the text reads. Line feeds and tabs are allowed.
 * Carriage returns are not.
 * @param bytes - the notes file's bytes.
 * @returns true when the bytes are valid notes.
 */
export function isValidNotes(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0 || bytes.byteLength > RELEASE_FILE_SIZE_LIMITS.notes) return false
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch (_notUtf8) {
    // Not well-formed UTF-8: not notes.
    return false
  }
  return !RELEASE_NOTES_FORBIDDEN.test(text.replaceAll(/[\n\t]/gu, ''))
}
