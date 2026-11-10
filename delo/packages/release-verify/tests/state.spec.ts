/**
 * The check state contract C18 keeps per installed release: the record a start writes and `delorun status` reads. A
 * record this client cannot read is refused as a whole, so the next check runs as the first one, and each refusal keeps
 * the contract's failure class when the contract names one.
 */
import { describe, expect, it } from 'vitest'
import { contractFailureOf, RELEASE_LOG_REFUSALS, ReleaseLogRefusalError } from '../src/errors.ts'
import {
  readCheckState,
  recorded,
  RELEASE_LOG_STATE_SCHEMA,
  serializeCheckState,
  type RecordedCheck,
} from '../src/state.ts'

/**
 * The refusal one read makes.
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
  return undefined
}

describe('the record of one attempt', () => {
  it('records a state that is not a failure without a failure class', () => {
    expect(recorded('0.1.0', 'verified', 1_793_981_700)).toEqual({ release: '0.1.0', state: 'verified', lastAttempt: 1_793_981_700 })
  })

  it('records the contract\'s failure class beside the finer refusal this client made', () => {
    const entry: RecordedCheck = recorded('0.1.0', 'failed', 1_793_981_700, { refusal: 'entry-key-untrusted', detail: 'the entry is signed by no targets key' })
    expect(entry.failure).toBe('entry-signature-invalid')
    expect(entry.refusal).toBe('entry-key-untrusted')
    expect(entry.detail).toContain('targets key')
  })

  it('records no failure class for a refusal the contract does not name', () => {
    for (const refusal of RELEASE_LOG_REFUSALS) {
      const entry = recorded('0.1.0', 'failed', 1, { refusal, detail: 'detail' })
      expect(entry.failure).toBe(contractFailureOf(refusal))
      if (contractFailureOf(refusal) === undefined) expect(entry.failure).toBeUndefined()
    }
  })
})

describe('how long a release has stayed unchecked', () => {
  it('starts the time at the first unchecked attempt and keeps it while the release stays unchecked', () => {
    const first = recorded('0.1.0', 'unchecked', 100, { detail: 'the log did not answer' })
    expect(first).toMatchObject({ state: 'unchecked', uncheckedSince: 100, detail: 'the log did not answer' })
    expect(recorded('0.1.0', 'unchecked', 200, {}, first).uncheckedSince).toBe(100)
    // A record written before the field existed counts from its last attempt.
    const { uncheckedSince: _since, ...older } = first
    expect(recorded('0.1.0', 'unchecked', 300, {}, older).uncheckedSince).toBe(100)
    expect(recorded('0.1.0', 'unchecked', 400, {}, recorded('0.1.0', 'verified', 350)).uncheckedSince).toBe(400)
    expect(recorded('0.1.0', 'verified', 500, {}, first).uncheckedSince).toBeUndefined()
  })

  it('keeps the notices an attempt made, and round-trips them', () => {
    const entry = recorded('0.1.0', 'verified', 1, { notices: ['the stored floor was replaced'] })
    expect(entry.notices).toEqual(['the stored floor was replaced'])
    expect(recorded('0.1.0', 'verified', 1, { notices: [] }).notices).toBeUndefined()
    const read = readCheckState(Buffer.from(serializeCheckState(new Map([['0.1.0', entry], ['0.2.0', recorded('0.2.0', 'unchecked', 7)]]))))
    expect(read.get('0.1.0')?.notices).toEqual(['the stored floor was replaced'])
    expect(read.get('0.2.0')?.uncheckedSince).toBe(7)
  })
})

describe('the state record', () => {
  const alpha = recorded('0.1.0', 'verified', 1_793_981_700)
  const beta = recorded('0.2.0', 'failed', 1_793_981_800, { refusal: 'witness-cosignature-missing', detail: 'one cosignature, two required' })

  it('round-trips the records, sorted by release, with a trailing newline', () => {
    const text = serializeCheckState(new Map([['0.2.0', beta], ['0.1.0', alpha]]))
    expect(text.endsWith('\n')).toBe(true)
    expect(text.indexOf('"0.1.0"')).toBeLessThan(text.indexOf('"0.2.0"'))
    const read = readCheckState(Buffer.from(text))
    expect(read.get('0.1.0')).toEqual(alpha)
    expect(read.get('0.2.0')).toEqual(beta)
  })

  it('writes the schema the record names', () => {
    expect(JSON.parse(serializeCheckState(new Map()))).toEqual({ schema: RELEASE_LOG_STATE_SCHEMA, releases: {} })
  })
})

describe('a state record this client cannot trust', () => {
  const valid = serializeCheckState(new Map([['0.1.0', recorded('0.1.0', 'verified', 1)]]))

  it('refuses a file that is not JSON, and one that is not UTF-8', () => {
    expect(refusalOf(() => readCheckState(Buffer.from('{')))).toBe('check-state-invalid')
    expect(refusalOf(() => readCheckState(Buffer.from([0xff, 0xfe])))).toBe('check-state-invalid')
  })

  it('refuses an unknown field, an unknown state and a refusal this client never makes', () => {
    expect(refusalOf(() => readCheckState(Buffer.from(JSON.stringify({ schema: RELEASE_LOG_STATE_SCHEMA, releases: {}, extra: 1 }))))).toBe('check-state-invalid')
    expect(refusalOf(() => readCheckState(Buffer.from(JSON.stringify({ schema: RELEASE_LOG_STATE_SCHEMA, releases: { '0.1.0': { release: '0.1.0', state: 'unknown', lastAttempt: 1 } } }))))).toBe('check-state-invalid')
    expect(refusalOf(() => readCheckState(Buffer.from(JSON.stringify({ schema: RELEASE_LOG_STATE_SCHEMA, releases: { '0.1.0': { release: '0.1.0', state: 'failed', refusal: 'not-a-refusal', lastAttempt: 1 } } }))))).toBe('check-state-invalid')
  })

  it('refuses a file that reads one key twice', () => {
    const doubled = valid.replace('"releases"', '"releases":{},"releases"')
    expect(refusalOf(() => readCheckState(Buffer.from(doubled)))).toBe('check-state-invalid')
  })

  it('refuses a record above its size limit', () => {
    const padded = `${valid}${' '.repeat(32 * 1024)}`
    expect(refusalOf(() => readCheckState(Buffer.from(padded)))).toBe('check-state-invalid')
  })
})
