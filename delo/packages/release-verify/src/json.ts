/**
 * JSON as this client reads contract C18's files: one strict reader that refuses duplicate object keys, which
 * `JSON.parse` silently resolves to the last value, refuses text that is not UTF-8 JSON, refuses nesting deeper than
 * 64 levels, and applies a size limit before it parses anything. A bundle that reads two ways would let a bundle
 * verify one way here and another way in the tool that wrote it.
 *
 * @module @delo/release-verify/json
 */
import { refuse, type ReleaseLogRefusal } from './errors.ts'

/** A JSON value. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }

/** The deepest nesting the reader admits. */
const MAX_DEPTH = 64

const LITERAL = /true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/uy

const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/uy

/** Reads one JSON text, refusing duplicate keys and deep nesting. */
class StrictReader {
  private index = 0

  /** The text to read. */
  private readonly text: string
  /** The refusal a malformed text makes. */
  private readonly refusal: ReleaseLogRefusal

  /**
   * @param text - the text to read.
   * @param refusal - the refusal a malformed text makes.
   */
  constructor(text: string, refusal: ReleaseLogRefusal) {
    this.text = text
    this.refusal = refusal
  }

  /**
   * Read the text's single value.
   * @returns the value.
   * @throws ReleaseLogRefusalError when the text is malformed.
   */
  read(): JsonValue {
    const value = this.value(0)
    this.space()
    if (this.index !== this.text.length) this.fail('text after the JSON value')
    return value
  }

  private fail(what: string): never {
    throw refuse(this.refusal, `the JSON is malformed: ${what}`)
  }

  private space(): void {
    while (this.index < this.text.length && ' \t\n\r'.includes(this.text[this.index]!)) this.index++
  }

  private value(depth: number): JsonValue {
    if (depth > MAX_DEPTH) this.fail(`nesting deeper than ${String(MAX_DEPTH)} levels`)
    this.space()
    const char = this.text[this.index]
    if (char === '{') return this.object(depth)
    if (char === '[') return this.array(depth)
    if (char === '"') return this.string()
    LITERAL.lastIndex = this.index
    const literal = LITERAL.exec(this.text)
    if (literal === null) this.fail('an unexpected character')
    this.index += literal[0].length
    return JSON.parse(literal[0]) as JsonValue
  }

  private string(): string {
    STRING.lastIndex = this.index
    const match = STRING.exec(this.text)
    if (match === null) this.fail('a malformed string')
    this.index += match[0].length
    return JSON.parse(match[0]) as string
  }

  private array(depth: number): JsonValue[] {
    this.index++
    const items: JsonValue[] = []
    this.space()
    if (this.text[this.index] === ']') {
      this.index++
      return items
    }
    for (;;) {
      items.push(this.value(depth + 1))
      this.space()
      const char = this.text[this.index++]
      if (char === ']') return items
      if (char !== ',') this.fail('a missing comma in an array')
    }
  }

  private object(depth: number): { [key: string]: JsonValue } {
    this.index++
    const record: { [key: string]: JsonValue } = {}
    const seen = new Set<string>()
    this.space()
    if (this.text[this.index] === '}') {
      this.index++
      return record
    }
    for (;;) {
      this.space()
      if (this.text[this.index] !== '"') this.fail('an object key that is not a string')
      const key = this.string()
      if (seen.has(key)) this.fail(`a duplicate key ${JSON.stringify(key)}`)
      seen.add(key)
      this.space()
      if (this.text[this.index++] !== ':') this.fail('a missing colon')
      Object.defineProperty(record, key, { value: this.value(depth + 1), enumerable: true, writable: true, configurable: true })
      this.space()
      const char = this.text[this.index++]
      if (char === '}') return record
      if (char !== ',') this.fail('a missing comma in an object')
    }
  }
}

/**
 * Parse UTF-8 JSON bytes strictly.
 * @param bytes - the file's bytes.
 * @param limit - the most bytes the file may hold, checked before parsing.
 * @param tooLarge - the refusal a file above `limit` makes.
 * @param malformed - the refusal a text that is not UTF-8 JSON makes, whatever is wrong with it.
 * @returns the value.
 * @throws ReleaseLogRefusalError when the file exceeds its limit, is not UTF-8 JSON, holds a duplicate key or nests too
 * deeply.
 */
export function parseStrictJson(bytes: Uint8Array, limit: number, tooLarge: ReleaseLogRefusal, malformed: ReleaseLogRefusal): JsonValue {
  if (bytes.byteLength > limit) throw refuse(tooLarge, `the file has ${String(bytes.byteLength)} bytes, above its limit of ${String(limit)}`)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    throw refuse(malformed, 'the file is not UTF-8')
  }
  return new StrictReader(text, malformed).read()
}
