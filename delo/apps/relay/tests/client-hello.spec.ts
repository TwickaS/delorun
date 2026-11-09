/**
 * The SNI reader: a ClientHello in one record, its name in lowercase, a hello without the
 * extension, and the refusals that close a connection without a response.
 */
import { RELAY_LIMITS } from '@delo/contract-relay-protocol'
import { describe, expect, it } from 'vitest'
import { ClientHelloReader, isHostName } from '../src/client-hello.ts'
import { isRelayError } from '../src/errors.ts'
import { clientHello, sniOf } from './support.ts'

function refusalOf(chunks: readonly Uint8Array[]): string {
  const reader = new ClientHelloReader()
  try {
    for (const chunk of chunks) reader.push(chunk)
  } catch (error: unknown) {
    if (!isRelayError(error)) throw error
    return error.code
  }
  throw new Error('the connection was routed')
}

describe('the name', () => {
  it('reads the SNI of a ClientHello that arrives in one chunk', () => {
    expect(sniOf(clientHello({ sni: 'studio.example.test' }))).toBe('studio.example.test')
  })

  it('reads the SNI of a ClientHello that arrives in pieces', () => {
    const bytes = clientHello({ sni: 'studio.example.test' })
    const reader = new ClientHelloReader()
    expect(reader.push(bytes.subarray(0, 3)).done).toBe(false)
    expect(reader.push(bytes.subarray(3, 20)).done).toBe(false)
    const read = reader.push(bytes.subarray(20))
    expect(read).toEqual({ done: true, sni: 'studio.example.test' })
    expect(reader.received.byteLength).toBe(bytes.byteLength)
  })

  it('compares the name without case', () => {
    expect(sniOf(clientHello({ sni: 'Studio.Example.Test' }))).toBe('studio.example.test')
  })

  it('reports a hello without the extension as complete and without a name', () => {
    expect(sniOf(clientHello({}))).toBeUndefined()
  })

  it('reads a hello whose ALPN offers an ACME challenge like any other', () => {
    expect(sniOf(clientHello({ sni: 'studio.example.test', alpn: 'acme-tls/1' }))).toBe('studio.example.test')
  })

  it('keeps the bytes it read, which the stream\'s first DATA frame carries', () => {
    const bytes = clientHello({ sni: 'studio.example.test' })
    const reader = new ClientHelloReader()
    reader.push(bytes)
    expect([...reader.received]).toEqual([...bytes])
  })
})

describe('refusals', () => {
  it('refuses a connection whose first record is not a handshake', () => {
    const bytes = Uint8Array.from(clientHello({ sni: 'studio.example.test' }))
    bytes[0] = 0x17
    expect(refusalOf([bytes])).toBe('PROTOCOL_ERROR')
  })

  it('refuses a hello above C6\'s 16,384-byte limit', () => {
    const bytes = new Uint8Array(RELAY_LIMITS.clientHelloBytes + 1)
    bytes.set(clientHello({ sni: 'studio.example.test' }))
    expect(refusalOf([bytes])).toBe('PROTOCOL_ERROR')
  })

  it('refuses a record that announces more than 16,384 bytes', () => {
    const bytes = Uint8Array.from(clientHello({ sni: 'studio.example.test' }))
    bytes[3] = 0x7f
    bytes[4] = 0xff
    expect(refusalOf([bytes])).toBe('PROTOCOL_ERROR')
  })

  it('refuses a ClientHello split across records', () => {
    const bytes = Uint8Array.from(clientHello({ sni: 'studio.example.test' }))
    bytes[6] = 0x00
    bytes[7] = 0xff
    bytes[8] = 0xff
    expect(refusalOf([bytes])).toBe('PROTOCOL_ERROR')
  })

  it('refuses a field that runs past the record', () => {
    const bytes = Uint8Array.from(clientHello({ sni: 'studio.example.test' }))
    const cut = bytes.subarray(0, bytes.byteLength - 4)
    const record = Uint8Array.from(cut)
    record[4] = (cut.byteLength - 5) & 0xff
    record[3] = ((cut.byteLength - 5) >> 8) & 0xff
    expect(refusalOf([record])).toBe('PROTOCOL_ERROR')
  })

  it('refuses a name that is not a DNS host name', () => {
    const bytes = clientHello({ sni: 'not a name' })
    expect(refusalOf([bytes])).toBe('PROTOCOL_ERROR')
  })
})

describe('names', () => {
  it('accepts a dotted host name and a single label', () => {
    expect(isHostName('studio.example.test')).toBe(true)
    expect(isHostName('localhost')).toBe(true)
  })

  it('refuses an empty label, a space, a wildcard and a name over 253 bytes', () => {
    expect(isHostName('')).toBe(false)
    expect(isHostName('studio..test')).toBe(false)
    expect(isHostName('studio example')).toBe(false)
    expect(isHostName('*.example.test')).toBe(false)
    expect(isHostName(`${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`)).toBe(false)
    expect(isHostName(`-studio.example.test`)).toBe(false)
    expect(isHostName(`studio-.example.test`)).toBe(false)
  })
})
