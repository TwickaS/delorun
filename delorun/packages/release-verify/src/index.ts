/**
 * Delorun's release-log verification, the client side of contract C18 (`delorun/docs/contracts/c18-release-log.md`). An
 * installed release ships a release-log bundle beside its manifest: the Rekor v2 `hashedrekord` entry of the manifest
 * file, the entry's RFC 6962 inclusion proof, and a checkpoint the log signed and a witness of the public witness
 * network cosigned. This package verifies that bundle offline against the keys of the client's own trusted root,
 * proves consistency with the log's latest checkpoint online, keeps the verified checkpoint and the check state of each
 * installed release, and answers what a start does: go on, go on with a warning that names the unchecked release, or
 * stop.
 *
 * The online check takes a {@link ReleaseLogTransport}; {@link tilesTransport} is the one over an injected `fetch` and
 * the log's tlog-tiles, so the specs drive every answer from recorded fixtures and no module here reaches the network
 * on its own. The package never signs: nothing here can mint a checkpoint or an entry.
 *
 * @module @delorun/release-verify
 */
export { BundleSchema, checkBundle, checkPacksBundle, readBundle, verifyBundle, type BundleVerdict, type SignedDocument, type VerifiedBundle } from './bundle.ts'
export {
  advanceCheckpoint,
  readStoredCheckpoint,
  serializeStoredCheckpoint,
  storedCheckpoint,
  STORED_CHECKPOINT_SCHEMA,
  STORED_CHECKPOINT_SIZE_LIMIT,
  type StoredCheckpoint,
} from './checkpoint.ts'
export { EntryBodySchema, readEntryBody, requireReleaseVersion, verifyEntryIdentity, type ReadEntry } from './entry.ts'
export {
  contractFailureOf,
  refuse,
  RELEASE_LOG_REFUSALS,
  ReleaseLogRefusalError,
  type ReleaseLogRefusal,
} from './errors.ts'
export { parseStrictJson, type JsonValue } from './json.ts'
export { logContradictionDescriber, logUnreachableDescriber, RELEASE_VERIFY_DESCRIBERS, releaseLogInternalDescriber, releaseLogRefusalDescriber } from './refusal.ts'
export { isPowerOfTwo, leafHash, nodeHash, rootFromInclusionProof, verifyConsistencyProof } from './merkle.ts'
export {
  checkpointBody,
  NOTE_COSIGNATURE,
  NOTE_SIGNATURE,
  parseCheckpoint,
  parseVerifierKey,
  splitNote,
  trustedLogKeys,
  verifySignature,
  type Checkpoint,
  type NoteSignature,
  type NoteVerifier,
  type TrustedLogKeys,
} from './note.ts'
export {
  checkOnline,
  COSIGNATURE_CLOCK_SKEW_SECONDS,
  LogContradictionError,
  LogUnreachableError,
  ONLINE_CHECK_DEADLINE_SECONDS,
  ReleaseLogInternalError,
  storedCheckpointSigned,
  type LegacyCheckpoint,
  type OnlineCheckInput,
  type OnlineVerdict,
  type ReleaseLogTransport,
} from './online.ts'
export { checkStatePath, checkpointPath, RELEASE_LOG_STATE_FILE } from './paths.ts'
export { checkAndRecord, checkAndStore, readCheckpointFile, readCheckpointRecord, readCheckRecords, recordResult, type CheckInput, type CheckpointFile } from './record.ts'
export { ReleaseVerification, type ReleaseVerificationOptions, type RetryTimers } from './service.ts'
export { checkAtStart, INTEGRITY_MODE_SETTING, onlineCheckEnabled, uncheckedWarning, type StartCheckInput, type StartCheckResult } from './start.ts'
export { readCheckState, recorded, type AttemptFindings, RELEASE_LOG_STATE_SCHEMA, RELEASE_LOG_STATE_SIZE_LIMIT, serializeCheckState, type RecordedCheck } from './state.ts'
export { readProtectedFile, writeProtectedFile } from './store.ts'
export { CHECKPOINT_SIZE_LIMIT, logEndpoints, MAX_REDIRECTS, RELEASE_LOG_API_PREFIX, tilesTransport, type Fetch, type LogEndpoints, type TilesTransportOptions } from './transport.ts'
