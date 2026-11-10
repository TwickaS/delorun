/**
 * The customisation document of contract C8: `customisation.json`. It is a
 * closed schema — a row kind the format does not define is refused, a field a
 * row kind does not define is refused, and a value is data: a string, a number
 * a boolean or null. An archive never causes an evaluation: every decoded
 * string is refused when its first non-space character is `!` or when it
 * carries `!!`, the document's text is scanned for `!!js` before it is parsed
 * as a second layer, and an `insert` row is refused before any row is applied.
 * A row of a denied kind — a sandbox mode, a credential reference, a reach row,
 * an egress — is refused, so an archive cannot change any of them.
 *
 * @module @delo/archive/customisation
 */
import {
  ARCHIVE_CUSTOMISATION_SCHEMA_VERSION,
  ARCHIVE_DENIED_ROW_KINDS,
  ARCHIVE_ROW_KINDS,
  type ArchiveCustomisation,
  type ArchiveCustomisationRow,
  type ArchiveRowKind,
} from '@delo/contract-archive-and-trash'
import { hasControlCharacter } from './text.ts'
import { ArchiveError } from './errors.ts'
import { CUSTOMISATION_PATH } from './manifest.ts'

/** The fields one customisation row defines and no others. */
const ROW_FIELDS = ['kind', 'target', 'values'] as const

/**
 * A `!!js` tag in the document's text, which names an expression to evaluate. It is the second layer: a tag written
 * with a JSON escape (`"\u0021\u0021js"`) appears only in the decoded value, which {@link requireNoExpression} checks.
 */
const EXPRESSION_TAG = /!!js/u

/** A YAML tag at the start of a decoded string, past any leading space, which is how an expression reaches a document. */
const DECODED_TAG = /^\s*!/u

/** A `!!` tag anywhere in a decoded string, which is what an expression is written with. */
const DECODED_TAG_ANYWHERE = '!!'

/** One row of the diff a person sees before the customisation is applied. */
export interface CustomisationDiffRow {
  /** The row's kind, from the schema's admitted kinds. */
  readonly kind: ArchiveRowKind
  /** The row's target: a bundle package, a profile row, a preset, a skill, a theme or a plugin. */
  readonly target: string
}

/**
 * Parse and validate one `customisation.json`.
 * @param bytes - the bytes of the document.
 * @returns the validated customisation.
 * @throws ArchiveError `ARCHIVE_EXPRESSION_REFUSED` for a `!!js` expression or an `insert` row, `ARCHIVE_UNSUPPORTED_VERSION` for another schema version, `ARCHIVE_SCHEMA_INVALID` for a document or a field the schema does not define, and `ARCHIVE_DENIED_ROW` for a row of a denied kind.
 */
export function parseCustomisation(bytes: Uint8Array): ArchiveCustomisation {
  const text = decode(bytes)
  if (EXPRESSION_TAG.test(text)) {
    throw new ArchiveError('ARCHIVE_EXPRESSION_REFUSED', `${CUSTOMISATION_PATH} holds a !!js expression, which an archive never evaluates`)
  }
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${CUSTOMISATION_PATH} is not UTF-8 JSON`)
  }
  requireNoExpression(document, CUSTOMISATION_PATH)
  const fields = requireObject(document, CUSTOMISATION_PATH)
  const unknown = Object.keys(fields).filter(key => key !== 'schemaVersion' && key !== 'rows')
  if (unknown.length > 0) {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${CUSTOMISATION_PATH} carries the field ${JSON.stringify(unknown[0])}, which the schema does not define`)
  }
  if (fields.schemaVersion !== ARCHIVE_CUSTOMISATION_SCHEMA_VERSION) {
    throw new ArchiveError(
      'ARCHIVE_UNSUPPORTED_VERSION',
      `the customisation declares schema version ${JSON.stringify(fields.schemaVersion)}, and this reader reads version ${String(ARCHIVE_CUSTOMISATION_SCHEMA_VERSION)}`,
    )
  }
  if (!Array.isArray(fields.rows)) {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${CUSTOMISATION_PATH} rows is not a JSON array`)
  }
  return { schemaVersion: ARCHIVE_CUSTOMISATION_SCHEMA_VERSION, rows: fields.rows.map((row, index) => parseRow(row, index)) }
}

/**
 * The diff a person sees before a customisation is applied: one row per entry
 * of the document, with its kind and its target, in the document's order.
 * Nothing is applied before the person has seen this diff.
 * @param customisation - the validated customisation.
 * @returns the diff rows.
 */
export function customisationDiff(customisation: ArchiveCustomisation): CustomisationDiffRow[] {
  return customisation.rows.map(row => ({ kind: row.kind, target: row.target }))
}

/**
 * Parse one customisation row.
 * @param value - the parsed row.
 * @param index - the row's position, for the refusal's message.
 * @returns the row.
 * @throws ArchiveError `ARCHIVE_EXPRESSION_REFUSED` for an `insert` row, `ARCHIVE_DENIED_ROW` for a denied kind, and `ARCHIVE_SCHEMA_INVALID` for an unknown kind, a field the schema does not define, or a value that is not data.
 */
function parseRow(value: unknown, index: number): ArchiveCustomisationRow {
  const where = `${CUSTOMISATION_PATH} rows[${String(index)}]`
  const fields = requireObject(value, where)
  // An insert row merges a fragment into another document, which is an evaluation, so it is refused before any field is read.
  if (Object.hasOwn(fields, 'insert')) {
    throw new ArchiveError('ARCHIVE_EXPRESSION_REFUSED', `${where} is an insert row, which an archive never applies`)
  }
  const unknown = Object.keys(fields).filter(key => !(ROW_FIELDS as readonly string[]).includes(key))
  if (unknown.length > 0) {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} carries the field ${JSON.stringify(unknown[0])}, which the schema does not define`)
  }
  const kind = requireText(fields.kind, `${where} kind`)
  if ((ARCHIVE_DENIED_ROW_KINDS as readonly string[]).includes(kind)) {
    throw new ArchiveError('ARCHIVE_DENIED_ROW', `${where} is a ${kind} row, which an archive may never set`)
  }
  if (!(ARCHIVE_ROW_KINDS as readonly string[]).includes(kind)) {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} carries the kind ${JSON.stringify(kind)}, which the schema does not define`)
  }
  const target = requireText(fields.target, `${where} target`)
  return { kind: kind as ArchiveRowKind, target, values: requireValues(fields.values, `${where} values`) }
}

/**
 * Refuse any decoded string an expression could be read from: one whose first non-space character is `!`, which a
 * YAML reader takes as a tag, or one that carries `!!`. The document's text is scanned before it is parsed as well,
 * but an escaped tag (`"\u0021\u0021js process.exit(1)"`) reads as `!!js process.exit(1)` only once the value is
 * decoded, so the decoded values are the check of record and the text scan is the second layer.
 * @param value - the parsed value.
 * @param where - the value's name, for the refusal's message.
 * @throws ArchiveError `ARCHIVE_EXPRESSION_REFUSED` for a string that reads as a tag or an expression.
 */
function requireNoExpression(value: unknown, where: string): void {
  if (typeof value === 'string') {
    if (DECODED_TAG.test(value) || value.includes(DECODED_TAG_ANYWHERE)) {
      throw new ArchiveError('ARCHIVE_EXPRESSION_REFUSED', `${where} carries a string that reads as a tag or an expression, and an archive never evaluates one`)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) requireNoExpression(item, where)
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, item] of Object.entries(value)) {
    requireNoExpression(key, where)
    requireNoExpression(item, where)
  }
}

/**
 * Require a row's values to be data: a string, a number, a boolean or null, with no object, no array and no
 * expression-bearing string, which {@link requireNoExpression} refuses for the whole document.
 * @param value - the parsed `values` field.
 * @param where - the field's name, for the refusal's message.
 * @returns the values.
 * @throws ArchiveError `ARCHIVE_SCHEMA_INVALID` for a value that is not data.
 */
function requireValues(value: unknown, where: string): Record<string, string | number | boolean | null> {
  const fields = requireObject(value, where)
  const values: Record<string, string | number | boolean | null> = {}
  for (const [key, item] of Object.entries(fields)) {
    if (item === null || typeof item === 'number' || typeof item === 'boolean' || typeof item === 'string') {
      values[key] = item
      continue
    }
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} ${JSON.stringify(key)} is not a string, a number, a boolean or null`)
  }
  return values
}

/**
 * Decode a document's bytes as UTF-8.
 * @param bytes - the bytes of the document.
 * @returns the text.
 * @throws ArchiveError `ARCHIVE_SCHEMA_INVALID` when the document is not UTF-8.
 */
function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${CUSTOMISATION_PATH} is not UTF-8`)
  }
}

/**
 * Require a parsed value to be a JSON object.
 * @param value - the parsed value.
 * @param where - the value's name, for the refusal's message.
 * @returns the object's fields.
 * @throws ArchiveError `ARCHIVE_SCHEMA_INVALID` when the value is not an object.
 */
function requireObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} is not a JSON object`)
  }
  return value as Record<string, unknown>
}

/**
 * Require a parsed value to be a non-empty string.
 * @param value - the parsed value.
 * @param where - the value's name, for the refusal's message.
 * @returns the string.
 * @throws ArchiveError `ARCHIVE_SCHEMA_INVALID` when the value is not a non-empty string or holds a control character.
 */
function requireText(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} is not a non-empty string`)
  }
  if (hasControlCharacter(value)) {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} holds a control character, which an archive's text may not carry`)
  }
  return value
}
