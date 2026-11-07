/**
 * Types and fixed values of contract C18, the release log and witness
 * (`delo/docs/contracts/c18-release-log.md`). Every release manifest has a Rekor v2 `hashedrekord`
 * entry signed with Ed25519ph by the targets key;
 * {@link ReleaseLogBundle} carries it with its inclusion proof and a witnessed checkpoint,
 * and {@link ReleaseLogCheckState} is what clients record per installed release.
 *
 * @module @delo/contract-release-log
 */

import type { Sha256Hex, SemanticVersion } from '@delo/contract-release-manifest'

/** The `schema` value of the release-log bundle. */
export const RELEASE_LOG_BUNDLE_SCHEMA = 'delo.release-log-bundle/1'

/** The Rekor entry type of every release manifest entry. */
export const RELEASE_LOG_ENTRY_TYPE = 'hashedrekord'

/** The entry body's `apiVersion`: Rekor v2's `hashedrekord` v0.0.2. */
export const RELEASE_LOG_ENTRY_API_VERSION = '0.0.2'

/** The entry's `keyDetails`: Ed25519ph (RFC 8032, empty context) over the manifest file's bytes. */
export const RELEASE_LOG_ENTRY_KEY_DETAILS = 'PKIX_ED25519_PH'

/** The entry's digest algorithm, the hash Ed25519ph prehashes with: SHA-512 of the manifest file's bytes. */
export const RELEASE_LOG_ENTRY_DIGEST_ALGORITHM = 'SHA2_512'

/** The signature and its verifier, as Rekor v2's `Signature` message serializes them in JSON. */
export interface HashedRekordSignature {
  /** Base64 Ed25519ph signature over the manifest file's bytes. */
  readonly content: string
  readonly verifier: {
    /** Base64 DER (PKIX SubjectPublicKeyInfo) of the targets public key. */
    readonly publicKey: { readonly rawBytes: string }
    /** Always {@link RELEASE_LOG_ENTRY_KEY_DETAILS}. */
    readonly keyDetails: typeof RELEASE_LOG_ENTRY_KEY_DETAILS
  }
}

/** `delorun-<version>.manifest.entry.json`: the request the release workflow submits to Rekor v2's `/api/v2/log/entries`. */
export interface HashedRekordRequest {
  readonly hashedRekordRequestV002: {
    /** Base64 SHA-512 of the manifest file's bytes. */
    readonly digest: string
    readonly signature: HashedRekordSignature
  }
}

/** The log entry body Rekor v2 builds from a {@link HashedRekordRequest}; the log's leaf is its RFC 8785 serialization. */
export interface HashedRekordBody {
  readonly apiVersion: typeof RELEASE_LOG_ENTRY_API_VERSION
  readonly kind: typeof RELEASE_LOG_ENTRY_TYPE
  readonly spec: {
    readonly hashedRekordV002: {
      /** The request's digest with its algorithm. */
      readonly data: { readonly algorithm: typeof RELEASE_LOG_ENTRY_DIGEST_ALGORITHM, readonly digest: string }
      readonly signature: HashedRekordSignature
    }
  }
}

/** The manifest file a bundle covers. */
export interface BundleManifestRef {
  /** `delorun-<version>.manifest.json`. */
  readonly name: string
  /** SHA-256 of the whole manifest file. */
  readonly sha256: Sha256Hex
}

/** The log entry as Rekor returned it. */
export interface BundleEntry {
  /** The entry's index in the log. */
  readonly logIndex: number
  /** The log's integration time in Unix seconds; Rekor v2 records none and returns 0. */
  readonly integratedTime: number
  /** Base64 RFC 8785 serialization of the {@link HashedRekordBody}. */
  readonly body: string
}

/** RFC 6962 inclusion proof of the entry's leaf. */
export interface InclusionProof {
  /** The leaf's index. */
  readonly logIndex: number
  /** The tree size the proof is against. */
  readonly treeSize: number
  /** The tree's root hash, lowercase hex. */
  readonly rootHash: string
  /** The audit path, lowercase hex, at most {@link MAX_PROOF_HASHES} entries. */
  readonly hashes: readonly string[]
}

/** `delorun-<version>.manifest.log.json`: unsigned; each part carries its own signature. */
export interface ReleaseLogBundle {
  /** Always {@link RELEASE_LOG_BUNDLE_SCHEMA}. */
  readonly schema: typeof RELEASE_LOG_BUNDLE_SCHEMA
  /** The manifest file covered. */
  readonly manifest: BundleManifestRef
  /** The entry. */
  readonly entry: BundleEntry
  /** The entry's inclusion proof. */
  readonly inclusion: InclusionProof
  /** C2SP signed-note checkpoint for the proof's tree, with the log's signature and at least the threshold of witness cosignature lines. */
  readonly checkpoint: string
}

/**
 * A release's log check state. `verified`: the bundle verifies and the online consistency check
 * passed at least once. `unchecked`: the online check has not passed because the log or the
 * distributor was unreachable or the latest witnessed checkpoint was too old; not a failure.
 * `failed`: a signature, cosignature, inclusion or consistency check failed verifiably.
 */
export type ReleaseLogCheckState = 'verified' | 'unchecked' | 'failed'

/** Why a check failed; each is a verifiable failure. */
export type ReleaseLogFailure =
  | 'manifest-digest-mismatch'
  | 'entry-signature-invalid'
  | 'inclusion-proof-invalid'
  | 'log-signature-invalid'
  | 'witness-cosignature-missing'
  | 'consistency-proof-invalid'
  | 'checkpoint-rolled-back'

/** The stored check result for one installed release. */
export interface ReleaseLogCheck {
  /** The release. */
  readonly release: SemanticVersion
  /** Its state. */
  readonly state: ReleaseLogCheckState
  /** Present when `state` is `failed`. */
  readonly failure?: ReleaseLogFailure
  /** Unix seconds of the last online check attempt. */
  readonly lastAttempt: number
}

/** Distinct listed witnesses that must cosign a checkpoint; the root metadata carries the value clients use. */
export const WITNESS_THRESHOLD = 1

/** Maximum age of the latest witnessed checkpoint's newest cosignature for the online check: 24 hours. */
export const MAX_WITNESSED_CHECKPOINT_AGE_SECONDS = 86_400

/** Interval between online check attempts while a release is `unchecked`: 15 minutes. */
export const UNCHECKED_RETRY_INTERVAL_SECONDS = 900

/** Size limit of a bundle before parsing: 64 KiB. */
export const RELEASE_LOG_BUNDLE_SIZE_LIMIT = 64 * 1024

/** Maximum hashes in an inclusion or consistency proof. */
export const MAX_PROOF_HASHES = 64

/** Request timeout to the log and the checkpoint distributor. */
export const RELEASE_LOG_REQUEST_TIMEOUT_SECONDS = 30
