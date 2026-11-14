/**
 * The specs of `customisation.json`'s expression refusal (contract C8): a value is data, and an archive never causes an
 * evaluation. The document's text is scanned for `!!js`, and the values a JSON reader decodes are refused when a
 * string's first non-space character is `!` or when it carries `!!`, so a tag written with a JSON escape — which the
 * text scan cannot see — is refused after it is decoded. Each spec fails when the check it covers is removed: the
 * escaped expression, the escaped tag past a leading space, the escaped `!!` inside a string and the escaped tag in a
 * key all pass the text scan, and the last one proves the scan still runs before the document is parsed.
 */
import { describe, expect, it } from 'vitest'
import { ARCHIVE_CUSTOMISATION_SCHEMA_VERSION } from '@delorun/contract-archive-and-trash'
import { ArchiveError, parseCustomisation } from '../src/index.ts'
import { utf8 } from './support.ts'

/**
 * One `customisation.json`, from row text a spec writes the escapes into: a template literal decodes `\u0021` before
 * the parser sees it, so a spec that needs the JSON reader to decode a tag writes `\\u0021`.
 * @param rows - the rows, as JSON text.
 * @returns the document's bytes.
 */
function document(rows: string): Uint8Array {
  return utf8(`{"schemaVersion":${String(ARCHIVE_CUSTOMISATION_SCHEMA_VERSION)},"rows":[${rows}]}`)
}

/**
 * One row whose `values` a spec writes as JSON text.
 * @param values - the `values` object, as JSON text.
 * @returns the row's text.
 */
function themeRow(values: string): string {
  return `{"kind":"theme","target":"studio","values":${values}}`
}

/**
 * Expect one document to be refused as an expression.
 * @param bytes - the document.
 * @returns the refusal.
 */
function refusal(bytes: Uint8Array): ArchiveError {
  try {
    parseCustomisation(bytes)
  } catch (error: unknown) {
    if (error instanceof ArchiveError) {
      expect(error.code).toBe('ARCHIVE_EXPRESSION_REFUSED')
      return error
    }
    throw error
  }
  throw new Error('the document was accepted, and it carries an expression')
}

describe('a customisation document whose values are data', () => {
  it('is accepted, with every value the row defines', () => {
    const parsed = parseCustomisation(document(themeRow('{"accent":"#123456","size":12,"enabled":true,"fallback":null}')))
    expect(parsed.rows).toEqual([{ kind: 'theme', target: 'studio', values: { accent: '#123456', size: 12, enabled: true, fallback: null } }])
  })

  it('accepts a value that carries one `!`, which is text and not a tag', () => {
    const parsed = parseCustomisation(document(themeRow('{"caption":"hello! welcome_to_delorun"}')))
    expect(parsed.rows[0]?.values).toEqual({ caption: 'hello! welcome_to_delorun' })
  })
})

describe('a customisation document whose decoded strings read as expressions', () => {
  it('refuses a `!!js` expression written with JSON escapes, which the document text does not show', () => {
    const error = refusal(document(themeRow('{"css":"\\u0021\\u0021js process.exit(1)"}')))
    expect(error.message).toContain('expression')
  })

  it('refuses a tag whose `!` follows a leading space', () => {
    refusal(document(themeRow('{"css":" \\u0021ref delorun"}')))
  })

  it('refuses a `!!` that does not start the string', () => {
    refusal(document(themeRow('{"css":"delorun \\u0021\\u0021js process.exit(1)"}')))
  })

  it('refuses a tag decoded into a key, not only into a value', () => {
    refusal(document(themeRow('{"\\u0021ref":"delorun"}')))
  })
})

describe('the text scan that runs before the document is parsed', () => {
  it('refuses `!!js` in text that is not JSON at all', () => {
    const error = refusal(utf8('!!js process.exit(1)'))
    expect(error.message).toContain('!!js')
  })
})
