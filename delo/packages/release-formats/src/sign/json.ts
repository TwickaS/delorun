/**
 * JSON as contract C2's signed files use it: the RFC 8785 JSON Canonicalization Scheme serialization that signatures
 * cover, and a strict reader that refuses duplicate object keys, which `JSON.parse` silently resolves to the last
 * value, so a signed file has exactly one reading.
 *
 * @module @delo/release-formats/sign/json
 */

/** A JSON value. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }

const MAX_DEPTH = 64
const LITERAL = /true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/uy
const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/uy
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u

function canonicalString(value: string): string {
  if (LONE_SURROGATE.test(value)) throw new Error('JSON canonicalization refuses a string with a lone surrogate')
  return JSON.stringify(value)
}

/**
 * The RFC 8785 serialization of a value: object members sorted by their names' UTF-16 code units, no whitespace,
 * numbers and strings as ECMAScript serializes them.
 * @param value - a JSON value whose numbers are finite.
 * @returns the canonical text.
 * @throws Error on a non-finite number, a lone surrogate or a value that is not JSON.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JSON canonicalization refuses a non-finite number')
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return canonicalString(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item as JsonValue)).join(',')}]`
  const record = value as { readonly [key: string]: JsonValue }
  const keys = Object.keys(record).sort()
  return `{${keys.map(key => `${canonicalString(key)}:${canonicalJson(record[key]!)}`).join(',')}}`
}

/** Reads one JSON text, refusing duplicate keys and nesting deeper than 64 levels. */
class StrictReader {
  private index = 0

  constructor(private readonly text: string) {}

  read(): JsonValue {
    const value = this.value(0)
    this.space()
    if (this.index !== this.text.length) this.fail('text after the JSON value')
    return value
  }

  private fail(what: string): never {
    throw new Error(`JSON: ${what} at offset ${String(this.index)}`)
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
 * @param limit - the most bytes the file may hold; checked before parsing.
 * @returns the value.
 * @throws Error when the file exceeds its limit, is not UTF-8 or JSON, holds a duplicate key or nests too deeply.
 */
export function parseStrictJson(bytes: Uint8Array, limit: number): JsonValue {
  if (bytes.byteLength > limit) throw new Error(`JSON: the file has ${String(bytes.byteLength)} bytes, above its limit of ${String(limit)}`)
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  return new StrictReader(text).read()
}

/**
 * A typed value as the JSON value its serialization reads back as.
 * @param value - a value of a JSON-serializable type, such as a contract type.
 * @returns the value with undefined members dropped, as `JSON.stringify` writes it.
 */
export function toJsonValue(value: object): JsonValue {
  const parsed: JsonValue = JSON.parse(JSON.stringify(value))
  return parsed
}
