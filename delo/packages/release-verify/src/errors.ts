/**
 * The refusals of contract C18's release-log verification, and their relation to the contract's own reason codes
 * (`ReleaseLogFailure` of `@delo/contract-release-log`). Every refusal is a verifiable failure: the state a release
 * records is `failed`, the CLI start stops in every verification mode (R5), and `delorun verify` fails.
 *
 * The contract's codes name the five verification steps and the online consistency check. Two refusals a client must
 * make have no contract code yet — a bundle that does not read at all, and a stored checkpoint record that does not
 * read — so {@link contractFailureOf} answers `undefined` for them and {@link ReleaseLogRefusal} names them instead.
 *
 * @module @delo/release-verify/errors
 */
import type { ReleaseLogFailure } from '@delo/contract-release-log'

/** Every refusal this package makes, in the order of contract C18's verification steps. */
export const RELEASE_LOG_REFUSALS = [
  /** The bundle file is larger than {@link RELEASE_LOG_BUNDLE_SIZE_LIMIT}, so it is refused before parsing. */
  'bundle-too-large',
  /** The bundle is not strict JSON or does not match the bundle schema: an unknown field, a missing part, a wrong type. */
  'bundle-malformed',
  /** The bundle covers another manifest than the file the client verified under contract C2 (step 1). */
  'manifest-digest-mismatch',
  /** The entry body is not a Rekor v2 `hashedrekord` entry with a SHA-512 digest, or its body is not base64 JSON. */
  'entry-malformed',
  /** The entry's `kind`, `apiVersion` or `keyDetails` is not the release log's: a pure Ed25519 entry is refused. */
  'entry-type-refused',
  /** The entry's verifier key is not a targets key that is valid for the release (step 2, the identity check). */
  'entry-key-untrusted',
  /** The entry's Ed25519ph signature over the manifest does not verify (step 2, the signature check). */
  'entry-signature-invalid',
  /** The inclusion proof does not reproduce the bundle's root hash at the entry's index (step 3). */
  'inclusion-proof-invalid',
  /** The checkpoint does not parse as a signed note over a checkpoint body (step 4). */
  'checkpoint-malformed',
  /** The checkpoint names another origin than the trusted root's log, or another tree than the proof (step 4, R6). */
  'log-origin-untrusted',
  /** The checkpoint has no valid signature from the log key the trusted root names (step 4, R6). */
  'log-signature-invalid',
  /** Fewer than the trusted root's threshold of distinct listed witnesses cosigned the checkpoint (step 5, R2). */
  'witness-cosignature-missing',
  /** The stored checkpoint record does not parse, so there is no verified tree to be consistent with (R7). */
  'stored-checkpoint-invalid',
  /** The latest checkpoint's tree is smaller than the stored one, or than the bundle's (R7). */
  'checkpoint-rolled-back',
  /** The consistency proof from the bundle's or the stored checkpoint to the latest one does not verify (R7). */
  'consistency-proof-invalid',
  /**
   * The record of the checks this client made does not read. Not a verification failure: the client has no record, so
   * the next check starts from the bundle's own checkpoint.
   */
  'check-state-invalid',
] as const

/** One refusal of {@link RELEASE_LOG_REFUSALS}. */
export type ReleaseLogRefusal = (typeof RELEASE_LOG_REFUSALS)[number]

/**
 * The contract's reason code for a refusal, when the contract names one. `undefined` for the two refusals the
 * contract's `ReleaseLogFailure` union does not carry yet: a bundle or a stored checkpoint that does not read.
 * @param refusal - the refusal.
 * @returns the contract's code, or `undefined` when it has none.
 */
export function contractFailureOf(refusal: ReleaseLogRefusal): ReleaseLogFailure | undefined {
  return CONTRACT_FAILURES[refusal]
}

const CONTRACT_FAILURES: Readonly<Record<ReleaseLogRefusal, ReleaseLogFailure | undefined>> = {
  'bundle-too-large': undefined,
  'bundle-malformed': undefined,
  'manifest-digest-mismatch': 'manifest-digest-mismatch',
  'entry-malformed': undefined,
  // Contract C18 refuses an entry whose signature is not Ed25519ph by a valid targets key, which is the class the
  // denial test `c18-pure-ed25519-entry-refused` shows.
  'entry-type-refused': 'entry-signature-invalid',
  'entry-key-untrusted': 'entry-signature-invalid',
  'entry-signature-invalid': 'entry-signature-invalid',
  'inclusion-proof-invalid': 'inclusion-proof-invalid',
  'checkpoint-malformed': 'log-signature-invalid',
  'log-origin-untrusted': 'log-signature-invalid',
  'log-signature-invalid': 'log-signature-invalid',
  'witness-cosignature-missing': 'witness-cosignature-missing',
  'stored-checkpoint-invalid': undefined,
  'checkpoint-rolled-back': 'checkpoint-rolled-back',
  'consistency-proof-invalid': 'consistency-proof-invalid',
  'check-state-invalid': undefined,
}

/**
 * A verifiable failure, as a thrown error: the refusal and the detail a person or the operational log reads. The
 * detail never holds a key, a signature or a manifest byte, only names, counts and digests.
 */
export class ReleaseLogRefusalError extends Error {
  override readonly name = 'ReleaseLogRefusalError'

  /** Which check refused. */
  readonly refusal: ReleaseLogRefusal
  /** What the check saw, in words. */
  readonly detail: string

  /**
   * @param refusal - which check refused.
   * @param detail - what the check saw, in words.
   */
  constructor(refusal: ReleaseLogRefusal, detail: string) {
    super(`${refusal}: ${detail}`)
    this.refusal = refusal
    this.detail = detail
  }
}

/**
 * Build a refusal error.
 * @param refusal - which check refused.
 * @param detail - what the check saw, in words.
 * @returns the error to throw.
 */
export function refuse(refusal: ReleaseLogRefusal, detail: string): ReleaseLogRefusalError {
  return new ReleaseLogRefusalError(refusal, detail)
}
