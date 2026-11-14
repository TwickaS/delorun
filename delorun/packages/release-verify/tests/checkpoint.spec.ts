/**
 * The verified checkpoint a client stores at contract C1's `trust/checkpoint.json`: it must be the checkpoint its note
 * holds, so a record cannot name a tree the witnesses never saw, and it never moves backwards (R7).
 */
import { describe, expect, it } from 'vitest'
import {
  advanceCheckpoint,
  readStoredCheckpoint,
  serializeStoredCheckpoint,
  storedCheckpoint,
  STORED_CHECKPOINT_SCHEMA,
  STORED_CHECKPOINT_SIZE_LIMIT,
} from '../src/checkpoint.ts'
import { ReleaseLogRefusalError } from '../src/errors.ts'
import { checkpointPath, checkStatePath, RELEASE_LOG_STATE_FILE } from '../src/paths.ts'
import { scenario } from './fixtures.ts'

/**
 * The refusal one read or advance makes.
 * @param run - the read.
 * @returns the refusal's name, or `undefined` when it read.
 */
function refusalOf(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    if (error instanceof ReleaseLogRefusalError) return error.refusal
    throw error
  }
}

describe('the stored checkpoint record', () => {
  it('round-trips the checkpoint the online check verified', () => {
    const fixture = scenario()
    const note = fixture.witness.cosign(fixture.log.checkpoint(), 1_793_981_700)
    const record = storedCheckpoint(fixture.log.origin, fixture.log.size, fixture.log.rootHash, note, 1_793_981_760)
    expect(record.schema).toBe(STORED_CHECKPOINT_SCHEMA)
    const read = readStoredCheckpoint(Buffer.from(serializeStoredCheckpoint(record)))
    expect(read).toEqual(record)
  })

  it('refuses a record whose note names another tree than the record does', () => {
    const fixture = scenario()
    const note = fixture.witness.cosign(fixture.log.checkpoint(), 1_793_981_700)
    const record = storedCheckpoint(fixture.log.origin, fixture.log.size, fixture.log.rootHash, note, 1_793_981_760)
    for (const changed of [{ ...record, treeSize: 4 }, { ...record, rootHash: '0'.repeat(64) }, { ...record, origin: 'log.example.test/another' }]) {
      expect(refusalOf(() => readStoredCheckpoint(Buffer.from(serializeStoredCheckpoint(changed))))).toBe('stored-checkpoint-invalid')
    }
  })

  it('refuses a record that is not JSON, does not match the schema, or holds no signed note', () => {
    expect(refusalOf(() => readStoredCheckpoint(Buffer.from('{')))).toBe('stored-checkpoint-invalid')
    expect(refusalOf(() => readStoredCheckpoint(Buffer.from(JSON.stringify({ schema: STORED_CHECKPOINT_SCHEMA }))))).toBe('stored-checkpoint-invalid')
    const fixture = scenario()
    const unsigned = storedCheckpoint(fixture.log.origin, fixture.log.size, fixture.log.rootHash, 'no signature block', 1)
    expect(refusalOf(() => readStoredCheckpoint(Buffer.from(serializeStoredCheckpoint(unsigned))))).toBe('stored-checkpoint-invalid')
  })

  it('refuses a record above its size limit', () => {
    const fixture = scenario()
    const note = fixture.witness.cosign(fixture.log.checkpoint(), 1_793_981_700)
    const text = serializeStoredCheckpoint(storedCheckpoint(fixture.log.origin, fixture.log.size, fixture.log.rootHash, note, 1))
    expect(refusalOf(() => readStoredCheckpoint(Buffer.from(`${text}${' '.repeat(STORED_CHECKPOINT_SIZE_LIMIT)}`)))).toBe('stored-checkpoint-invalid')
  })
})

describe('the record never moves backwards (R7)', () => {
  const fixture = scenario()
  const note = fixture.witness.cosign(fixture.log.checkpoint(), 1_793_981_700)
  const held = storedCheckpoint(fixture.log.origin, 5, Buffer.alloc(32, 1), note, 1)
  const larger = storedCheckpoint(fixture.log.origin, 6, Buffer.alloc(32, 2), note, 2)

  it('takes the first checkpoint a client verifies', () => {
    expect(advanceCheckpoint(undefined, held)).toBe(held)
  })

  it('advances to a larger tree', () => {
    expect(advanceCheckpoint(held, larger)).toBe(larger)
  })

  it('keeps a checkpoint that repeats the stored tree', () => {
    expect(advanceCheckpoint(held, { ...held, verifiedAt: 9 })).toMatchObject({ treeSize: 5, verifiedAt: 9 })
  })

  it('refuses a smaller tree, and another root hash at the stored size', () => {
    expect(refusalOf(() => advanceCheckpoint(held, { ...held, treeSize: 4 }))).toBe('checkpoint-rolled-back')
    expect(refusalOf(() => advanceCheckpoint(held, { ...held, rootHash: '1'.repeat(64) }))).toBe('checkpoint-rolled-back')
  })
})

describe('the two records\' paths', () => {
  it('keeps the checkpoint at contract C1\'s trust/checkpoint.json and the state beside it', () => {
    expect(checkpointPath('/home/person/.delorun')).toBe('/home/person/.delorun/trust/checkpoint.json')
    expect(checkStatePath('/home/person/.delorun')).toBe('/home/person/.delorun/trust/release-log.json')
    expect(RELEASE_LOG_STATE_FILE).toBe('trust/release-log.json')
  })
})
