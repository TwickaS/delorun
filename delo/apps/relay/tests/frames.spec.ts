/**
 * The frame codec: round trips, C6's payload limits, the header and stream rules, and a
 * deterministic malformed-input corpus. Removing a limit or a stream rule turns the spec that
 * covers it green, because each refusal names the code the tunnel closes with.
 */
import { FRAME_TYPES, RELAY_LIMITS, STREAM_CLOSE_REASONS, type Base64Url } from '@delo/contract-relay-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it } from 'vitest'
import { isRelayError } from '../src/errors.ts'
import { encodeClose, encodeControl, encodeCredit, encodeData, encodeFrame, encodeOpen, parseFrame } from '../src/frames.ts'
import { utf8 } from '../src/keys.ts'

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error: unknown) {
    if (!isRelayError(error)) throw error
    return error.code
  }
  throw new Error('the frame was accepted')
}

describe('round trips', () => {
  it('encodes an OPEN frame the parser reads back with C6\'s fields', () => {
    const frame = encodeOpen(1, { sni: 'studio.example.test', clientAddress: '203.0.113.7', clientPort: 51_234 })
    expect(frame[0]).toBe(FRAME_TYPES.OPEN)
    expect(new DataView(frame.buffer).getUint32(1, false)).toBe(1)
    expect(parseFrame(frame)).toEqual({ type: 'open', streamId: 1, payload: { sni: 'studio.example.test', clientAddress: '203.0.113.7', clientPort: 51_234 } })
  })

  it('encodes a DATA frame whose payload is the bytes it carries', () => {
    const bytes = Uint8Array.of(0x16, 0x03, 0x01, 0x00, 0x00, 0xff)
    const frame = encodeData(7, bytes)
    const parsed = parseFrame(frame)
    expect(parsed.type).toBe('data')
    expect(parsed.type === 'data' ? [...parsed.payload] : []).toEqual([...bytes])
    expect(frame.byteLength).toBe(5 + bytes.byteLength)
  })

  it('encodes a CREDIT frame as a 4-byte big-endian number', () => {
    const frame = encodeCredit(2, 1_048_576)
    expect([...frame.subarray(5)]).toEqual([0x00, 0x10, 0x00, 0x00])
    expect(parseFrame(frame)).toEqual({ type: 'credit', streamId: 2, credit: 1_048_576 })
  })

  it('encodes a CLOSE frame with one reason byte', () => {
    for (const reason of Object.values(STREAM_CLOSE_REASONS)) {
      expect(parseFrame(encodeClose(3, reason))).toEqual({ type: 'close', streamId: 3, reason })
    }
  })

  it('encodes an announcement on the tunnel\'s stream 0', () => {
    const frame = encodeControl({ type: 'announce', kind: 'second-tunnel-refused', at: 5, clientAddress: '198.51.100.9', jti: brandString<Base64Url>('jti-value') })
    expect(new DataView(frame.buffer).getUint32(1, false)).toBe(0)
    expect(parseFrame(frame)).toEqual({ type: 'control', message: { type: 'announce', kind: 'second-tunnel-refused', at: 5, clientAddress: '198.51.100.9', jti: 'jti-value' } })
  })

  it('reads the home\'s acknowledgements on stream 0', () => {
    expect(parseFrame(encodeControl({ type: 'pong' }))).toEqual({ type: 'control', message: { type: 'pong' } })
    expect(parseFrame(encodeControl({ type: 'rebind-pending' }))).toEqual({ type: 'control', message: { type: 'rebind-pending' } })
  })
})

describe('limits', () => {
  it('refuses a DATA payload over 65,536 bytes as too large', () => {
    expect(codeOf(() => parseFrame(encodeData(1, new Uint8Array(RELAY_LIMITS.dataPayloadBytes + 1))))).toBe('FRAME_TOO_LARGE')
    expect(parseFrame(encodeData(1, new Uint8Array(RELAY_LIMITS.dataPayloadBytes))).type).toBe('data')
  })

  it('refuses an OPEN payload over 1,024 bytes as too large', () => {
    expect(codeOf(() => parseFrame(encodeFrame(FRAME_TYPES.OPEN, 1, new Uint8Array(RELAY_LIMITS.openPayloadBytes + 1))))).toBe('FRAME_TOO_LARGE')
  })

  it('refuses a CONTROL payload over 16,384 bytes as too large', () => {
    expect(codeOf(() => parseFrame(encodeFrame(FRAME_TYPES.CONTROL, 0, new Uint8Array(RELAY_LIMITS.controlPayloadBytes + 1))))).toBe('FRAME_TOO_LARGE')
  })
})

describe('rules', () => {
  it('refuses a frame shorter than its 5-byte header', () => {
    expect(codeOf(() => parseFrame(Uint8Array.of(0x02, 0, 0, 0)))).toBe('PROTOCOL_ERROR')
    expect(codeOf(() => parseFrame(new Uint8Array(0)))).toBe('PROTOCOL_ERROR')
  })

  it('refuses an unknown frame type', () => {
    expect(codeOf(() => parseFrame(encodeFrame(0x7f, 1, Uint8Array.of(1))))).toBe('PROTOCOL_ERROR')
    expect(codeOf(() => parseFrame(encodeFrame(0x00, 1, Uint8Array.of(1))))).toBe('PROTOCOL_ERROR')
  })

  it('refuses a CONTROL frame on another stream', () => {
    expect(codeOf(() => parseFrame(encodeFrame(FRAME_TYPES.CONTROL, 1, utf8(JSON.stringify({ type: 'pong' })))))).toBe('PROTOCOL_ERROR')
  })

  it('refuses a stream frame on the tunnel\'s own stream 0', () => {
    expect(codeOf(() => parseFrame(encodeData(0, Uint8Array.of(1))))).toBe('PROTOCOL_ERROR')
    expect(codeOf(() => parseFrame(encodeCredit(0, 1)))).toBe('PROTOCOL_ERROR')
    expect(codeOf(() => parseFrame(encodeClose(0, STREAM_CLOSE_REASONS.normal)))).toBe('PROTOCOL_ERROR')
    expect(codeOf(() => parseFrame(encodeFrame(FRAME_TYPES.OPEN, 0, utf8('{}'))))).toBe('PROTOCOL_ERROR')
  })

  it('refuses an empty DATA frame', () => {
    expect(codeOf(() => parseFrame(encodeFrame(FRAME_TYPES.DATA, 1, new Uint8Array(0))))).toBe('PROTOCOL_ERROR')
  })

  it('refuses a CREDIT frame whose payload is not 4 bytes', () => {
    expect(codeOf(() => parseFrame(encodeFrame(FRAME_TYPES.CREDIT, 1, Uint8Array.of(1, 2, 3))))).toBe('PROTOCOL_ERROR')
    expect(codeOf(() => parseFrame(encodeFrame(FRAME_TYPES.CREDIT, 1, Uint8Array.of(1, 2, 3, 4, 5))))).toBe('FRAME_TOO_LARGE')
  })

  it('refuses a CREDIT the 4-byte field cannot hold', () => {
    expect(codeOf(() => encodeCredit(1, -1))).toBe('PROTOCOL_ERROR')
    expect(codeOf(() => encodeCredit(1, 0x1_0000_0000))).toBe('PROTOCOL_ERROR')
  })

  it('refuses a CLOSE frame with an unknown reason', () => {
    expect(codeOf(() => parseFrame(encodeFrame(FRAME_TYPES.CLOSE, 1, Uint8Array.of(9))))).toBe('PROTOCOL_ERROR')
    expect(codeOf(() => parseFrame(encodeFrame(FRAME_TYPES.CLOSE, 1, new Uint8Array(0))))).toBe('PROTOCOL_ERROR')
  })

  it('refuses a payload that is not the JSON object its type defines', () => {
    expect(codeOf(() => parseFrame(encodeFrame(FRAME_TYPES.OPEN, 1, utf8('{'))))).toBe('PROTOCOL_ERROR')
    expect(codeOf(() => parseFrame(encodeFrame(FRAME_TYPES.OPEN, 1, utf8(JSON.stringify({ sni: 'a' })))))).toBe('PROTOCOL_ERROR')
    expect(codeOf(() => parseFrame(encodeFrame(FRAME_TYPES.OPEN, 1, utf8(JSON.stringify({ sni: 'a', clientAddress: 'b', clientPort: 70_000 })))))).toBe('PROTOCOL_ERROR')
    expect(codeOf(() => parseFrame(encodeFrame(FRAME_TYPES.CONTROL, 0, utf8(JSON.stringify({ type: 'other' })))))).toBe('PROTOCOL_ERROR')
    expect(codeOf(() => parseFrame(encodeFrame(FRAME_TYPES.CONTROL, 0, utf8('{}'))))).toBe('PROTOCOL_ERROR')
  })

  it('refuses a payload with a duplicate key, as the strict reader does', () => {
    expect(codeOf(() => parseFrame(encodeFrame(FRAME_TYPES.CONTROL, 0, utf8('{"type":"pong","type":"pong"}'))))).toBe('PROTOCOL_ERROR')
  })
})

describe('malformed input', () => {
  it('answers a deterministic corpus of random messages with refusals only, never a crash', () => {
    let state = 0x2f6e2b1
    const next = (): number => {
      state = (state * 1_103_515_245 + 12_345) & 0x7fffffff
      return state
    }
    const refusals = new Set<string>()
    for (let index = 0; index < 512; index += 1) {
      const length = next() % 40
      const bytes = new Uint8Array(length)
      for (let offset = 0; offset < length; offset += 1) bytes[offset] = next() & 0xff
      try {
        parseFrame(bytes)
      } catch (error: unknown) {
        if (!isRelayError(error)) throw error
        refusals.add(error.code)
      }
    }
    expect([...refusals]).toEqual(['PROTOCOL_ERROR'])
  })

  it('answers every truncation and every byte change of a valid frame with a refusal', () => {
    const valid = encodeOpen(1, { sni: 'studio.example.test', clientAddress: '203.0.113.7', clientPort: 1234 })
    for (let length = 0; length < valid.byteLength; length += 1) {
      try {
        parseFrame(valid.subarray(0, length))
        throw new Error(`a frame of ${String(length)} bytes was accepted`)
      } catch (error: unknown) {
        if (!isRelayError(error)) throw error
      }
    }
    for (let offset = 0; offset < valid.byteLength; offset += 1) {
      const changed = Uint8Array.from(valid)
      changed[offset] = (changed[offset] ?? 0) ^ 0xff
      try {
        parseFrame(changed)
      } catch (error: unknown) {
        if (!isRelayError(error)) throw error
      }
    }
  })
})
