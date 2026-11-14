/**
 * Contract C18's check with its two records under the home's `trust/`: the verified checkpoint, which the next check
 * proves consistency from, and each release's check state. The `releaseVerification` service, `delorun verify`, the
 * launcher's start and the installer all go through this module, so one format of each record exists.
 *
 * `trust/checkpoint.json` holds the signed record of `checkpoint.ts`. A file in the installer's earlier format, a tree
 * size and a root hash with no signed note, is read as a legacy floor: the online check keeps it only when the log
 * proves it a prefix of the latest checkpoint, and the verified checkpoint then replaces the file. A file that does not
 * read at all sets no floor, and the attempt records a notice saying the floor started again, so a reset is never
 * silent.
 *
 * @module @delorun/release-verify/record
 */
import { z } from 'zod'
import { readStoredCheckpoint, serializeStoredCheckpoint, STORED_CHECKPOINT_SIZE_LIMIT, type StoredCheckpoint } from './checkpoint.ts'
import { ReleaseLogRefusalError } from './errors.ts'
import { parseStrictJson, type JsonValue } from './json.ts'
import type { LegacyCheckpoint } from './online.ts'
import { checkStatePath, checkpointPath } from './paths.ts'
import { checkAtStart, type StartCheckInput, type StartCheckResult } from './start.ts'
import { readCheckState, recorded, serializeCheckState, type RecordedCheck } from './state.ts'
import { readProtectedFile, writeProtectedFile } from './store.ts'

/** The installer's earlier record: exactly a tree size and a root hash. */
const LegacySchema = z.strictObject({ treeSize: z.number().int().min(1), rootHash: z.string().regex(/^[0-9a-f]{64}$/u) })

/** What `trust/checkpoint.json` held. */
export type CheckpointFile =
  /** No file. */
  | { readonly kind: 'absent' }
  /** The signed record. */
  | { readonly kind: 'record', readonly record: StoredCheckpoint }
  /** The installer's earlier format. */
  | { readonly kind: 'legacy', readonly legacy: LegacyCheckpoint }
  /** A file that is neither: it sets no floor. */
  | { readonly kind: 'unreadable', readonly reason: string }

/**
 * Read `trust/checkpoint.json`.
 * @param home - the resolved Delorun home.
 * @returns what it holds.
 * @throws HomeLayoutError `SECRET_FILE_MODE` when the file is a link, another user's or laxer than 0600.
 */
export async function readCheckpointFile(home: string): Promise<CheckpointFile> {
  const bytes = await readProtectedFile(checkpointPath(home))
  if (bytes === undefined) return { kind: 'absent' }
  try {
    return { kind: 'record', record: readStoredCheckpoint(bytes) }
  } catch (error) {
    if (!(error instanceof ReleaseLogRefusalError)) throw error
    let value: JsonValue
    try {
      value = parseStrictJson(bytes, STORED_CHECKPOINT_SIZE_LIMIT, 'stored-checkpoint-invalid', 'stored-checkpoint-invalid')
    } catch {
      // The strict reader refused the file as JSON; the record's own refusal above already says why it does not read.
      return { kind: 'unreadable', reason: error.detail }
    }
    const legacy = LegacySchema.safeParse(value)
    return legacy.success ? { kind: 'legacy', legacy: legacy.data } : { kind: 'unreadable', reason: error.detail }
  }
}

/**
 * The verified checkpoint the client stored, when it holds a signed record that reads.
 * @param home - the resolved Delorun home.
 * @returns the record, or `undefined` when the file is absent, of the earlier format or does not read.
 * @throws HomeLayoutError `SECRET_FILE_MODE` when the file is a link, another user's or laxer than 0600.
 */
export async function readCheckpointRecord(home: string): Promise<StoredCheckpoint | undefined> {
  const file = await readCheckpointFile(home)
  return file.kind === 'record' ? file.record : undefined
}

/**
 * The recorded check states, read from the home.
 * @param home - the resolved Delorun home.
 * @returns one entry per release; empty when the record is absent or does not read.
 * @throws HomeLayoutError `SECRET_FILE_MODE` when the file is a link, another user's or laxer than 0600.
 */
export async function readCheckRecords(home: string): Promise<Map<string, RecordedCheck>> {
  const bytes = await readProtectedFile(checkStatePath(home))
  if (bytes === undefined) return new Map()
  try {
    return readCheckState(bytes)
  } catch (error) {
    if (error instanceof ReleaseLogRefusalError) return new Map()
    throw error
  }
}

/** A start check's input without the stored checkpoints, which {@link checkAndStore} reads itself. */
export type CheckInput = Omit<StartCheckInput, 'stored' | 'legacy'>

/**
 * Run contract C18's start check from the stored checkpoint and store the checkpoint the online check verified,
 * without recording the release's state: an installer records it only once the release is installed.
 * @param home - the resolved Delorun home.
 * @param input - the start check's input.
 * @returns the start check's result, with a notice when the stored floor did not read.
 * @throws HomeLayoutError `SECRET_FILE_MODE` when a record is a link, another user's or laxer than 0600.
 * @throws ReleaseLogInternalError when this client's own code fails during the online check.
 */
export async function checkAndStore(home: string, input: CheckInput): Promise<StartCheckResult> {
  const file = await readCheckpointFile(home)
  const result = await checkAtStart({
    ...input,
    stored: file.kind === 'record' ? file.record : undefined,
    ...file.kind === 'legacy' ? { legacy: file.legacy } : {},
  })
  if (result.checkpoint !== undefined) await writeProtectedFile(checkpointPath(home), serializeStoredCheckpoint(result.checkpoint))
  if (file.kind !== 'unreadable') return result
  const verified = [...(await readCheckRecords(home)).values()].filter(entry => entry.state === 'verified').map(entry => entry.release)
  const earlier = verified.length === 0 ? '' : `, though this home recorded ${verified.join(', ')} as verified`
  const notice = `the stored checkpoint does not read (${file.reason}), so the rollback floor started again from the release's own checkpoint${earlier}`
  return { ...result, notices: [...result.notices ?? [], notice] }
}

/**
 * Record a release's check state from a check's result, keeping every other release's record and the time since which
 * the release has stayed `unchecked`.
 * @param home - the resolved Delorun home.
 * @param version - the release.
 * @param now - Unix seconds of the attempt.
 * @param result - the check's result.
 * @returns the record written.
 * @throws HomeLayoutError `SECRET_FILE_MODE` when the record is a link, another user's or laxer than 0600.
 */
export async function recordResult(home: string, version: string, now: number, result: StartCheckResult): Promise<RecordedCheck> {
  const state = await readCheckRecords(home)
  const findings = {
    ...result.refusal === undefined ? {} : { refusal: result.refusal },
    ...result.detail === undefined ? {} : { detail: result.detail },
    ...result.notices === undefined ? {} : { notices: result.notices },
  }
  const record = recorded(version, result.state, now, findings, state.get(version))
  state.set(version, record)
  await writeProtectedFile(checkStatePath(home), serializeCheckState(state))
  return record
}

/**
 * Run contract C18's start check once, store the verified checkpoint and record the release's state.
 * @param home - the resolved Delorun home.
 * @param input - the start check's input.
 * @returns the start check's result.
 * @throws HomeLayoutError `SECRET_FILE_MODE` when a record is a link, another user's or laxer than 0600.
 * @throws ReleaseLogInternalError when this client's own code fails during the online check.
 */
export async function checkAndRecord(home: string, input: CheckInput): Promise<StartCheckResult> {
  const result = await checkAndStore(home, input)
  await recordResult(home, input.version, input.now, result)
  return result
}
