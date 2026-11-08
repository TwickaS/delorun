/**
 * Delo's release-log verification, the client side of contract C18 (`delo/docs/contracts/c18-release-log.md`). An
 * installed release ships a release-log bundle beside its manifest: the Rekor v2 `hashedrekord` entry of the manifest
 * file, the entry's RFC 6962 inclusion proof, and a checkpoint the log signed and a witness of the public witness
 * network cosigned. This package verifies that bundle offline against the keys of the client's own trusted root,
 * proves consistency with the log's latest checkpoint online, keeps the verified checkpoint and the check state of each
 * installed release, and answers what a start does: go on, go on with a warning that names the unchecked release, or
 * stop.
 *
 * The package holds no network code. Its online check takes a {@link ReleaseLogTransport}, so the specs drive every
 * answer from recorded fixtures, and the transport the launcher passes is the part contract C18's owner gates. It also
 * never signs: nothing here can mint a checkpoint or an entry.
 *
 * @module @delo/release-verify
 */
export { BundleSchema, checkBundle, readBundle, verifyBundle, type BundleVerdict, type VerifiedBundle } from './bundle.ts'
export {
  advanceCheckpoint,
  readStoredCheckpoint,
  serializeStoredCheckpoint,
  storedCheckpoint,
  STORED_CHECKPOINT_SCHEMA,
  STORED_CHECKPOINT_SIZE_LIMIT,
  type StoredCheckpoint,
} from './checkpoint.ts'
export { EntryBodySchema, keyIdOf, readEntryBody, targetsKeysFor, verifyEd25519ph, verifyEntryIdentity, type ReadEntry } from './entry.ts'
export {
  contractFailureOf,
  refuse,
  RELEASE_LOG_REFUSALS,
  ReleaseLogRefusalError,
  type ReleaseLogRefusal,
} from './errors.ts'
export { parseStrictJson, type JsonValue } from './json.ts'
export { leafHash, nodeHash, rootFromInclusionProof, verifyConsistencyProof } from './merkle.ts'
export {
  checkpointBody,
  NOTE_COSIGNATURE,
  NOTE_SIGNATURE,
  parseCheckpoint,
  parseVerifierKey,
  splitNote,
  verifySignature,
  type Checkpoint,
  type NoteSignature,
  type NoteVerifier,
} from './note.ts'
export { checkOnline, LogUnreachableError, type OnlineCheckInput, type OnlineVerdict, type ReleaseLogTransport } from './online.ts'
export { checkStatePath, checkpointPath, RELEASE_LOG_STATE_FILE } from './paths.ts'
export { ReleaseVerification, type ReleaseVerificationOptions, type RetryTimers } from './service.ts'
export { checkAtStart, INTEGRITY_MODE_SETTING, onlineCheckEnabled, uncheckedWarning, type StartCheckInput, type StartCheckResult } from './start.ts'
export { readCheckState, recorded, RELEASE_LOG_STATE_SCHEMA, RELEASE_LOG_STATE_SIZE_LIMIT, serializeCheckState, type RecordedCheck } from './state.ts'
export { readProtectedFile, writeProtectedFile } from './store.ts'
