/**
 * The SNI reader of C6's browser side: it accepts a TLS connection's bytes until the first
 * ClientHello is complete, then reports the name in its `server_name` extension and nothing
 * else. It never decrypts, never buffers more than C6's 16,384-byte ClientHello limit, and
 * refuses a connection that sends another record type, a ClientHello split across records or
 * a hello whose lengths run past the record, so the caller can close it without a response.
 *
 * @module @delo/relay/client-hello
 */
import { RELAY_LIMITS } from '@delo/contract-relay-protocol'
import { RelayError } from './errors.ts'

/** What one push of bytes found. */
export type ClientHelloRead = { readonly done: false } | { readonly done: true; readonly sni: string | undefined }

/** The TLS record type of a handshake. */
const TLS_HANDSHAKE = 0x16
/** The handshake type of a ClientHello. */
const CLIENT_HELLO = 0x01
/** The extension type of `server_name`. */
const SERVER_NAME = 0x0000

/** A DNS host name: labels of letters, digits and hyphens that neither start nor end with a hyphen. */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * Whether a text is a DNS host name, compared without case.
 * @param name - the presented name.
 * @returns true for 1 to 253 bytes of labels of letters, digits and hyphens.
 */
export function isHostName(name: string): boolean {
  if (name.length === 0 || name.length > 253) return false
  return name.split('.').every(label => HOST_LABEL.test(label))
}

/** A bounds-checked reader over the bytes received so far. */
class Bytes {
  private readonly bytes: Uint8Array
  private offset = 0

  /**
   * @param bytes - the bytes to read.
   */
  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  /** Bytes read so far. */
  get position(): number {
    return this.offset
  }

  /** Bytes left. */
  get left(): number {
    return this.bytes.byteLength - this.offset
  }

  u8(): number {
    if (this.left < 1) throw new RelayError('PROTOCOL_ERROR', 'a ClientHello ends inside a field')
    const value = this.bytes[this.offset] ?? 0
    this.offset += 1
    return value
  }

  u16(): number {
    if (this.left < 2) throw new RelayError('PROTOCOL_ERROR', 'a ClientHello ends inside a field')
    const value = ((this.bytes[this.offset] ?? 0) << 8) | (this.bytes[this.offset + 1] ?? 0)
    this.offset += 2
    return value
  }

  u24(): number {
    if (this.left < 3) throw new RelayError('PROTOCOL_ERROR', 'a ClientHello ends inside a field')
    const value = ((this.bytes[this.offset] ?? 0) << 16) | ((this.bytes[this.offset + 1] ?? 0) << 8) | (this.bytes[this.offset + 2] ?? 0)
    this.offset += 3
    return value
  }

  skip(count: number): void {
    if (count < 0 || this.left < count) throw new RelayError('PROTOCOL_ERROR', 'a ClientHello field runs past the record')
    this.offset += count
  }

  slice(count: number): Uint8Array {
    if (count < 0 || this.left < count) throw new RelayError('PROTOCOL_ERROR', 'a ClientHello field runs past the record')
    const value = this.bytes.subarray(this.offset, this.offset + count)
    this.offset += count
    return value
  }
}

/** The `server_name` entry of a ClientHello's extensions, or `undefined` when it has none. */
function readExtensions(extensions: Uint8Array): string | undefined {
  const reader = new Bytes(extensions)
  let sni: string | undefined
  while (reader.left > 0) {
    const type = reader.u16()
    const length = reader.u16()
    const data = reader.slice(length)
    if (type !== SERVER_NAME) continue
    if (sni !== undefined) throw new RelayError('PROTOCOL_ERROR', 'a ClientHello carries two server_name extensions')
    const names = new Bytes(data)
    const listLength = names.u16()
    const list = new Bytes(names.slice(listLength))
    while (list.left > 0) {
      const nameType = list.u8()
      const name = Buffer.from(list.slice(list.u16())).toString('utf8')
      if (nameType !== 0) continue
      if (sni !== undefined) throw new RelayError('PROTOCOL_ERROR', 'a ClientHello carries two host names')
      sni = name
    }
  }
  return sni
}

/** A parsed ClientHello. */
interface ParsedHello {
  readonly sni: string | undefined
}

/** Parse one complete ClientHello record. */
function parseClientHello(bytes: Uint8Array): ParsedHello {
  if (bytes.byteLength < 5) throw new RelayError('PROTOCOL_ERROR', 'a TLS connection sent no record header')
  if (bytes[0] !== TLS_HANDSHAKE) throw new RelayError('PROTOCOL_ERROR', `a TLS connection sent record type 0x${String(bytes[0] ?? 0).padStart(2, '0')} where a handshake is required`)
  const recordLength = ((bytes[3] ?? 0) << 8) | (bytes[4] ?? 0)
  if (recordLength > RELAY_LIMITS.clientHelloBytes) throw new RelayError('PROTOCOL_ERROR', `a ClientHello record of ${String(recordLength)} bytes is above the 16,384-byte limit`)
  const reader = new Bytes(bytes.subarray(5, 5 + recordLength))
  if (reader.u8() !== CLIENT_HELLO) throw new RelayError('PROTOCOL_ERROR', 'a TLS connection sent a handshake other than a ClientHello')
  const helloLength = reader.u24()
  if (helloLength + 4 > recordLength) throw new RelayError('PROTOCOL_ERROR', 'a ClientHello is split across TLS records')
  const hello = new Bytes(reader.slice(helloLength))
  hello.skip(2 + 32)
  hello.skip(hello.u8())
  hello.skip(hello.u16())
  hello.skip(hello.u8())
  if (hello.left === 0) return { sni: undefined }
  const extensions = hello.slice(hello.u16())
  return { sni: readExtensions(extensions) }
}

/**
 * Reads the first TLS record of one browser connection until its ClientHello is complete.
 *
 * The caller feeds each chunk the connection delivers and follows a refusal by closing the
 * connection without a response (C6, "SNI routing"). The reader holds no more than the
 * 16,384-byte ClientHello limit, so a connection that sends more is refused rather than
 * buffered.
 */
export class ClientHelloReader {
  private buffer: Uint8Array = new Uint8Array(0)
  private result: ClientHelloRead | undefined

  /** The bytes received so far, which the first `DATA` frame of the stream must carry. */
  get received(): Uint8Array {
    return this.buffer
  }

  /**
   * Add the bytes one read delivered.
   * @param chunk - the bytes.
   * @returns `done: false` while the ClientHello is incomplete, then `done: true` with the SNI
   *   name in lowercase, or `undefined` when the hello carries none.
   * @throws RelayError `PROTOCOL_ERROR` for another record type, a hello split across records,
   *   a field that runs past the record, or more than 16,384 bytes before the hello completes.
   */
  push(chunk: Uint8Array): ClientHelloRead {
    if (this.result !== undefined) return this.result
    const joined = new Uint8Array(this.buffer.byteLength + chunk.byteLength)
    joined.set(this.buffer)
    joined.set(chunk, this.buffer.byteLength)
    if (joined.byteLength > RELAY_LIMITS.clientHelloBytes) throw new RelayError('PROTOCOL_ERROR', `a connection sent ${String(joined.byteLength)} bytes before its ClientHello completed, above the 16,384-byte limit`)
    this.buffer = joined
    if (joined.byteLength < 5) return { done: false }
    const recordLength = ((joined[3] ?? 0) << 8) | (joined[4] ?? 0)
    if (recordLength > RELAY_LIMITS.clientHelloBytes) throw new RelayError('PROTOCOL_ERROR', `a ClientHello record of ${String(recordLength)} bytes is above the 16,384-byte limit`)
    if (joined.byteLength < 5 + recordLength) return { done: false }
    const parsed = parseClientHello(joined)
    if (parsed.sni !== undefined && !isHostName(parsed.sni.toLowerCase())) throw new RelayError('PROTOCOL_ERROR', `a ClientHello names "${parsed.sni}", which is not a DNS host name`)
    const sni = parsed.sni?.toLowerCase()
    this.result = { done: true, sni }
    return this.result
  }
}
