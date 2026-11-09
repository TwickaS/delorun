/**
 * The verified checkpoint a client stores, at contract C1's `trust/checkpoint.json` (C18, `Consistency with the current
 * log`): the latest checkpoint whose log signature, witness cosignatures and consistency proof verified. The online
 * check proves consistency from it at the next start, so the record never moves backwards — a smaller or another tree
 * is refused (R7) — and it carries the signed note so the next check starts from what the witnesses saw.
 *
 * The record is trusted by file mode, not by a signature of its own: it is written at mode 0600 under the home's 0700
 * `trust/` directory (contract C1), and its note is checked to be the tree the record names, so a record that reads is
 * one this client wrote or one written with the home's permissions. Whoever can write the file can set the floor the
 * online check proves from, and that is the home's protection rather than this module's. A record that does not read is
 * no record: the caller starts from the bundle's own checkpoint instead.
 *
 * @module @delo/release-verify/checkpoint
 */
import { z } from 'zod'
import { refuse, ReleaseLogRefusalError } from './errors.ts'
import { parseStrictJson } from './json.ts'
import { parseCheckpoint, splitNote, type Checkpoint } from './note.ts'

/** The `schema` value of the stored checkpoint record. */
export const STORED_CHECKPOINT_SCHEMA = 'delo.release-log-checkpoint/1'

/** The size limit of the stored record: a checkpoint note and its facts fit well inside it. */
export const STORED_CHECKPOINT_SIZE_LIMIT = 16 * 1024

/** The stored verified checkpoint. */
export interface StoredCheckpoint {
  /** Always {@link STORED_CHECKPOINT_SCHEMA}. */
  readonly schema: typeof STORED_CHECKPOINT_SCHEMA
  /** The log's origin line, which the trusted root names. */
  readonly origin: string
  /** The tree size that verified. */
  readonly treeSize: number
  /** The tree's root hash, lowercase hex. */
  readonly rootHash: string
  /** The signed checkpoint note, with the log signature and the witness cosignatures that verified. */
  readonly checkpoint: string
  /** Unix seconds at which the online check verified it. */
  readonly verifiedAt: number
}

const StoredSchema = z.strictObject({
  schema: z.literal(STORED_CHECKPOINT_SCHEMA),
  origin: z.string().min(1),
  treeSize: z.number().int().min(1),
  rootHash: z.string().regex(/^[0-9a-f]{64}$/u),
  checkpoint: z.string().min(1),
  verifiedAt: z.number().int().min(0),
})

/**
 * Read a stored checkpoint record.
 * @param bytes - the file's bytes.
 * @returns the record.
 * @throws ReleaseLogRefusalError `stored-checkpoint-invalid` when the record is above its limit, is not strict JSON, does
 * not match {@link StoredCheckpoint}, or its note is not the checkpoint it records.
 */
export function readStoredCheckpoint(bytes: Uint8Array): StoredCheckpoint {
  const parsed = StoredSchema.safeParse(parseStrictJson(bytes, STORED_CHECKPOINT_SIZE_LIMIT, 'stored-checkpoint-invalid', 'stored-checkpoint-invalid'))
  if (!parsed.success) throw refuse('stored-checkpoint-invalid', `the stored checkpoint does not match its schema: ${z.prettifyError(parsed.error).replaceAll('\n', '; ')}`)
  let checkpoint: Checkpoint
  try {
    checkpoint = parseCheckpoint(splitNote(parsed.data.checkpoint).body)
  } catch (error) {
    if (error instanceof ReleaseLogRefusalError) throw refuse('stored-checkpoint-invalid', `the stored checkpoint's note does not read (${error.refusal}): ${error.detail}`)
    throw error
  }
  if (checkpoint.origin !== parsed.data.origin || checkpoint.size !== parsed.data.treeSize || checkpoint.rootHash.toString('hex') !== parsed.data.rootHash) {
    throw refuse('stored-checkpoint-invalid', 'the stored record and the checkpoint note it holds name different trees')
  }
  return parsed.data
}

/**
 * Write a stored checkpoint record.
 * @param record - the record.
 * @returns the file's text, ending with a newline.
 */
export function serializeStoredCheckpoint(record: StoredCheckpoint): string {
  return `${JSON.stringify(record, null, 2)}\n`
}

/**
 * The record of a checkpoint that verified now.
 * @param origin - the log's origin line.
 * @param treeSize - the tree size.
 * @param rootHash - the tree's root hash.
 * @param note - the signed checkpoint note that verified.
 * @param now - Unix seconds at which it verified.
 * @returns the record.
 */
export function storedCheckpoint(origin: string, treeSize: number, rootHash: Uint8Array, note: string, now: number): StoredCheckpoint {
  return { schema: STORED_CHECKPOINT_SCHEMA, origin, treeSize, rootHash: Buffer.from(rootHash).toString('hex'), checkpoint: note, verifiedAt: now }
}

/**
 * The record to keep after a check, refusing to move backwards: a tree smaller than the stored one, or the same size
 * with another root hash, is a rollback (R7).
 * @param stored - the record the client holds, when it holds one.
 * @param next - the record the online check verified.
 * @returns the record to store.
 * @throws ReleaseLogRefusalError `checkpoint-rolled-back` when `next` is smaller than `stored` or the same size with
 * another root hash.
 */
export function advanceCheckpoint(stored: StoredCheckpoint | undefined, next: StoredCheckpoint): StoredCheckpoint {
  if (stored === undefined) return next
  if (next.treeSize < stored.treeSize) throw refuse('checkpoint-rolled-back', `the latest checkpoint is tree size ${String(next.treeSize)}, below the stored ${String(stored.treeSize)}`)
  if (next.treeSize === stored.treeSize && next.rootHash !== stored.rootHash) {
    throw refuse('checkpoint-rolled-back', `tree size ${String(next.treeSize)} has root hash ${next.rootHash}, not the stored ${stored.rootHash}`)
  }
  return next
}
