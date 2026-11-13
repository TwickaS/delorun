/**
 * The record of a start check the launcher hands to the runtime in `DELO_START_CHECK`: the record reads back exactly, and anything that is not exactly a record reads as none.
 */
import { describe, expect, it } from 'vitest'
import { parseStartCheckHandoff, START_CHECK_SCHEMA, startCheckHandoffText, type StartCheckHandoff } from '../src/index.ts'

const RECORD: StartCheckHandoff = {
  schema: START_CHECK_SCHEMA,
  release: '0.1.0',
  at: 1_800_000_000_000,
  full: false,
  hashed: 12,
  files: 35_287,
  fullCheckAt: 1_799_000_000_000,
  launcher: { version: '0.1.0', path: '/usr/lib/node_modules/delorun' },
}

describe('the start-check record', () => {
  it('reads back what the launcher wrote', () => {
    expect(parseStartCheckHandoff(startCheckHandoffText(RECORD))).toEqual(RECORD)
    const unknown = { ...RECORD, fullCheckAt: null, launcher: { version: null, path: '/launcher' } }
    expect(parseStartCheckHandoff(startCheckHandoffText(unknown))).toEqual(unknown)
  })

  it.each<[string, string | undefined]>([
    ['unset', undefined],
    ['empty', ''],
    ['not JSON', 'not json'],
    ['a list', '[]'],
    ['null', 'null'],
    ['of another schema', JSON.stringify({ ...RECORD, schema: 'delo.start-check/2' })],
    ['with an extra field', JSON.stringify({ ...RECORD, extra: 1 })],
    ['without a field', JSON.stringify({ ...RECORD, full: undefined })],
    ['with a time that is not whole', JSON.stringify({ ...RECORD, at: 1.5 })],
    ['with a negative count', JSON.stringify({ ...RECORD, hashed: -1 })],
    ['with more hashed files than listed ones', JSON.stringify({ ...RECORD, hashed: 35_288 })],
    ['with a full pass time that is text', JSON.stringify({ ...RECORD, fullCheckAt: '1' })],
    ['with a launcher that is not an object', JSON.stringify({ ...RECORD, launcher: 'x' })],
    ['with a launcher path that is not text', JSON.stringify({ ...RECORD, launcher: { version: null, path: 1 } })],
    ['with a launcher version that is a number', JSON.stringify({ ...RECORD, launcher: { version: 1, path: '/x' } })],
    ['with an extra launcher field', JSON.stringify({ ...RECORD, launcher: { ...RECORD.launcher, extra: 1 } })],
  ])('reads a value that is %s as no record', (_case, text) => {
    expect(parseStartCheckHandoff(text)).toBeUndefined()
  })
})
