/**
 * Proves the customisation parser accepts rows of the admitted kinds with data
 * values and refuses every other document with its exact code: text that is
 * not UTF-8 JSON or not an object, an unknown field, another schema version, a
 * row that is not an object, an insert row, a denied or unknown row kind, a row
 * without a target, and values that are not strings, numbers, booleans or null.
 */
import { describe, expect, it } from 'vitest'
import { ARCHIVE_CUSTOMISATION_SCHEMA_VERSION, ARCHIVE_DENIED_ROW_KINDS } from '@delo/contract-archive-and-trash'
import { customisationDiff, parseCustomisation } from '../src/index.ts'
import { refusal } from './refusals.ts'
import { utf8 } from './support.ts'

/**
 * One document, from the rows a spec writes as JSON text.
 * @param rows - the `rows` value, as JSON text.
 * @param version - the schema version the document declares.
 * @returns the document's bytes.
 */
function document(rows: string, version: number = ARCHIVE_CUSTOMISATION_SCHEMA_VERSION): Uint8Array {
  return utf8(`{"schemaVersion":${String(version)},"rows":${rows}}`)
}

describe('a well-formed customisation', () => {
  it('parses data values and lists one diff row per row in document order', () => {
    const parsed = parseCustomisation(document('[{"kind":"theme","target":"studio","values":{"a":"x","b":1,"c":true,"d":null}},{"kind":"skill","target":"review","values":{}}]'))

    expect(parsed.rows[0]!.values).toEqual({ a: 'x', b: 1, c: true, d: null })
    expect(customisationDiff(parsed)).toEqual([{ kind: 'theme', target: 'studio' }, { kind: 'skill', target: 'review' }])
  })
})

describe('a customisation document', () => {
  it.each([
    ['text that is not UTF-8', new Uint8Array([0xff, 0xfe])],
    ['text that is not JSON', utf8('not json')],
    ['a JSON array', utf8('[]')],
    ['JSON null', utf8('null')],
    ['a field the schema does not define', utf8(`{"schemaVersion":${String(ARCHIVE_CUSTOMISATION_SCHEMA_VERSION)},"rows":[],"extra":1}`)],
    ['rows that are not an array', document('{}')],
  ])('is refused as %s', (_name, bytes) => {
    expect(refusal(() => parseCustomisation(bytes)).code).toBe('ARCHIVE_SCHEMA_INVALID')
  })

  it('is refused when it declares another schema version', () => {
    expect(refusal(() => parseCustomisation(document('[]', ARCHIVE_CUSTOMISATION_SCHEMA_VERSION + 1))).code).toBe('ARCHIVE_UNSUPPORTED_VERSION')
  })
})

describe('a customisation row', () => {
  it.each([
    ['is not an object', '7'],
    ['carries a field the schema does not define', '{"kind":"theme","target":"t","values":{},"extra":1}'],
    ['has no kind', '{"target":"t","values":{}}'],
    ['has an unknown kind', '{"kind":"script","target":"t","values":{}}'],
    ['has no target', '{"kind":"theme","values":{}}'],
    ['has values that are not an object', '{"kind":"theme","target":"t","values":[]}'],
    ['has a value that is an object', '{"kind":"theme","target":"t","values":{"a":{"b":1}}}'],
    ['has a value that is an array', '{"kind":"theme","target":"t","values":{"a":[1]}}'],
  ])('is refused when it %s', (_name, row) => {
    expect(refusal(() => parseCustomisation(document(`[${row}]`))).code).toBe('ARCHIVE_SCHEMA_INVALID')
  })

  it('is refused as an expression when it is an insert row', () => {
    const error = refusal(() => parseCustomisation(document('[{"insert":{},"kind":"theme","target":"t","values":{}}]')))

    expect(error.code).toBe('ARCHIVE_EXPRESSION_REFUSED')
    expect(error.message).toContain('insert row')
  })

  it.each(ARCHIVE_DENIED_ROW_KINDS)('is refused when it sets a %s', kind => {
    const error = refusal(() => parseCustomisation(document(`[{"kind":"${kind}","target":"t","values":{}}]`)))

    expect(error.code).toBe('ARCHIVE_DENIED_ROW')
  })
})
