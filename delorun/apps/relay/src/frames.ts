/**
 * The binary frame codec of C6's tunnel: one frame type byte, a 4-byte unsigned big-endian
 * stream id, then the payload. Encoding covers the relay's direction; parsing accepts either
 * direction and refuses an unknown type, a frame shorter than the 5-byte header, a payload
 * over its limit, and a payload that is not the JSON object its type defines. The relay reads
 * a stream's bytes only as `DATA` payloads: it never interprets them.
 *
 * @module @delorun/relay/frames
 */
import { FRAME_HEADER_BYTES, FRAME_TYPES, RELAY_LIMITS, STREAM_CLOSE_REASONS, type Announcement, type Base64Url, type OpenPayload } from '@delorun/contract-relay-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import { parseStrictJson, type JsonValue } from '@delorun/release-formats/sign/json'
import { z } from 'zod'
import { RelayError } from './errors.ts'

/** A reason a `CLOSE` frame carries: normal, refused, limit, protocol error or timeout. */
export type StreamCloseReason = (typeof STREAM_CLOSE_REASONS)[keyof typeof STREAM_CLOSE_REASONS]

/** The control messages a home sends on stream 0. */
export type HomeControlMessage = { readonly type: 'pong' } | { readonly type: 'rebind-pending' }

/** A parsed frame. */
export type Frame =
  | { readonly type: 'open'; readonly streamId: number; readonly payload: OpenPayload }
  | { readonly type: 'data'; readonly streamId: number; readonly payload: Uint8Array }
  | { readonly type: 'credit'; readonly streamId: number; readonly credit: number }
  | { readonly type: 'close'; readonly streamId: number; readonly reason: StreamCloseReason }
  | { readonly type: 'control'; readonly message: Announcement | HomeControlMessage }

/** The most bytes a frame header is followed by, per type. */
const PAYLOAD_LIMITS: Readonly<Record<number, number>> = {
  [FRAME_TYPES.OPEN]: RELAY_LIMITS.openPayloadBytes,
  [FRAME_TYPES.DATA]: RELAY_LIMITS.dataPayloadBytes,
  [FRAME_TYPES.CREDIT]: 4,
  [FRAME_TYPES.CLOSE]: 1,
  [FRAME_TYPES.CONTROL]: RELAY_LIMITS.controlPayloadBytes,
}

const openPayloadSchema = z.strictObject({
  sni: z.string().min(1).max(253),
  clientAddress: z.string().min(1).max(255),
  clientPort: z.number().int().min(0).max(65_535),
})

const homeControlSchema = z.strictObject({ type: z.enum(['pong', 'rebind-pending']) })

const announcementSchema = z.strictObject({
  type: z.literal('announce'),
  kind: z.enum(['second-tunnel-refused', 'tunnel-rebound']),
  at: z.number().int(),
  clientAddress: z.string().min(1).max(255),
  jti: z.string().optional(),
})

/** A `CONTROL` payload is an announcement or one of the home's acknowledgements. */
const controlSchema = z.discriminatedUnion('type', [homeControlSchema, announcementSchema])

function strictJson(payload: Uint8Array, limit: number, what: string): JsonValue {
  try {
    return parseStrictJson(payload, limit)
  } catch (error: unknown) {
    throw new RelayError('PROTOCOL_ERROR', `a ${what} payload is not JSON: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
}

function schemaFailure(error: unknown, what: string): never {
  const detail = error instanceof z.ZodError ? error.issues.map(issue => issue.message).join('; ') : 'unknown error'
  throw new RelayError('PROTOCOL_ERROR', `a ${what} payload is not the object its type defines: ${detail}`)
}

/**
 * Encode one frame.
 * @param type - the frame type byte.
 * @param streamId - the stream id; 0 is the tunnel's own stream.
 * @param payload - the payload bytes.
 * @returns the frame.
 */
export function encodeFrame(type: number, streamId: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength)
  frame[0] = type
  new DataView(frame.buffer).setUint32(1, streamId, false)
  frame.set(payload, FRAME_HEADER_BYTES)
  return frame
}

/**
 * Encode an `OPEN` frame from its payload.
 * @param streamId - the stream id, 1 or above.
 * @param payload - the payload.
 * @returns the frame.
 */
export function encodeOpen(streamId: number, payload: OpenPayload): Uint8Array {
  return encodeFrame(FRAME_TYPES.OPEN, streamId, new TextEncoder().encode(JSON.stringify({ sni: payload.sni, clientAddress: payload.clientAddress, clientPort: payload.clientPort })))
}

/**
 * Encode a `DATA` frame.
 * @param streamId - the stream id, 1 or above.
 * @param bytes - 1 to 65,536 bytes of the connection's encrypted bytes.
 * @returns the frame.
 */
export function encodeData(streamId: number, bytes: Uint8Array): Uint8Array {
  return encodeFrame(FRAME_TYPES.DATA, streamId, bytes)
}

/**
 * Encode a `CREDIT` frame: bytes the receiver may add.
 * @param streamId - the stream id, 1 or above.
 * @param credit - the bytes granted, at most a 4-byte unsigned number.
 * @returns the frame.
 * @throws RelayError `PROTOCOL_ERROR` for a credit the 4-byte field cannot hold.
 */
export function encodeCredit(streamId: number, credit: number): Uint8Array {
  if (!Number.isInteger(credit) || credit < 0 || credit > 0xffff_ffff) throw new RelayError('PROTOCOL_ERROR', `a credit of ${String(credit)} bytes does not fit the 4-byte field`)
  const payload = new Uint8Array(4)
  new DataView(payload.buffer).setUint32(0, credit, false)
  return encodeFrame(FRAME_TYPES.CREDIT, streamId, payload)
}

/**
 * Encode a `CLOSE` frame.
 * @param streamId - the stream id, 1 or above.
 * @param reason - the close reason.
 * @returns the frame.
 */
export function encodeClose(streamId: number, reason: StreamCloseReason): Uint8Array {
  return encodeFrame(FRAME_TYPES.CLOSE, streamId, Uint8Array.of(reason))
}

/**
 * Encode a `CONTROL` frame on the tunnel's stream 0.
 * @param message - the announcement the relay sends, or a home's acknowledgement.
 * @returns the frame.
 */
export function encodeControl(message: Announcement | HomeControlMessage): Uint8Array {
  return encodeFrame(FRAME_TYPES.CONTROL, 0, new TextEncoder().encode(JSON.stringify(message)))
}

/**
 * Parse one frame, checking its header, its type, its stream id class and its payload limit.
 * @param bytes - one WebSocket binary message.
 * @returns the frame.
 * @throws RelayError `PROTOCOL_ERROR` for an unknown type, a short frame, a stream id the type
 *   does not allow, a `DATA` payload of 0 bytes, a malformed payload or a stream id of 0 on a
 *   stream frame; `FRAME_TOO_LARGE` for a payload over its limit.
 */
export function parseFrame(bytes: Uint8Array): Frame {
  if (bytes.byteLength < FRAME_HEADER_BYTES) throw new RelayError('PROTOCOL_ERROR', `a frame of ${String(bytes.byteLength)} bytes is shorter than its 5-byte header`)
  const type = bytes[0] ?? 0
  const streamId = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, false)
  const limit = PAYLOAD_LIMITS[type]
  if (limit === undefined) throw new RelayError('PROTOCOL_ERROR', `frame type 0x${type.toString(16)} is not one of the protocol's`)
  const payload = bytes.subarray(FRAME_HEADER_BYTES)
  if (payload.byteLength > limit) throw new RelayError('FRAME_TOO_LARGE', `a frame of type 0x${type.toString(16)} carries ${String(payload.byteLength)} bytes, above its limit of ${String(limit)}`)
  switch (type) {
    case FRAME_TYPES.OPEN: {
      if (streamId === 0) throw new RelayError('PROTOCOL_ERROR', 'an OPEN frame names the tunnel stream')
      let value: JsonValue
      let payloadValue: OpenPayload
      try {
        value = strictJson(payload, limit, 'OPEN')
        payloadValue = openPayloadSchema.parse(value)
      } catch (error: unknown) {
        if (error instanceof RelayError) throw error
        schemaFailure(error, 'OPEN')
      }
      return { type: 'open', streamId, payload: payloadValue }
    }
    case FRAME_TYPES.DATA: {
      if (streamId === 0) throw new RelayError('PROTOCOL_ERROR', 'a DATA frame names the tunnel stream')
      if (payload.byteLength === 0) throw new RelayError('PROTOCOL_ERROR', 'a DATA frame carries no bytes')
      return { type: 'data', streamId, payload: Uint8Array.from(payload) }
    }
    case FRAME_TYPES.CREDIT: {
      if (streamId === 0) throw new RelayError('PROTOCOL_ERROR', 'a CREDIT frame names the tunnel stream')
      if (payload.byteLength !== 4) throw new RelayError('PROTOCOL_ERROR', `a CREDIT frame carries ${String(payload.byteLength)} bytes where the protocol fixes 4`)
      return { type: 'credit', streamId, credit: new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, false) }
    }
    case FRAME_TYPES.CLOSE: {
      if (streamId === 0) throw new RelayError('PROTOCOL_ERROR', 'a CLOSE frame names the tunnel stream')
      if (payload.byteLength !== 1) throw new RelayError('PROTOCOL_ERROR', `a CLOSE frame carries ${String(payload.byteLength)} bytes where the protocol fixes 1`)
      const reason = payload[0] ?? -1
      if (!Object.values(STREAM_CLOSE_REASONS).includes(reason as StreamCloseReason)) throw new RelayError('PROTOCOL_ERROR', `a CLOSE frame carries the unknown reason ${String(reason)}`)
      return { type: 'close', streamId, reason: reason as StreamCloseReason }
    }
    case FRAME_TYPES.CONTROL: {
      if (streamId !== 0) throw new RelayError('PROTOCOL_ERROR', `a CONTROL frame names stream ${String(streamId)} where the protocol fixes 0`)
      let value: JsonValue
      try {
        value = strictJson(payload, limit, 'CONTROL')
      } catch (error: unknown) {
        if (error instanceof RelayError) throw error
        throw new RelayError('PROTOCOL_ERROR', 'a CONTROL payload is not JSON')
      }
      const parsed = controlSchema.safeParse(value)
      if (!parsed.success) throw new RelayError('PROTOCOL_ERROR', 'a CONTROL payload is neither an acknowledgement nor an announcement')
      const message = parsed.data
      if (message.type === 'announce') {
        const announce: Announcement = { type: 'announce', kind: message.kind, at: message.at, clientAddress: message.clientAddress }
        return { type: 'control', message: message.jti === undefined ? announce : { ...announce, jti: brandString<Base64Url>(message.jti) } }
      }
      return { type: 'control', message }
    }
    default:
      throw new RelayError('PROTOCOL_ERROR', `frame type 0x${type.toString(16)} is not one of the protocol's`)
  }
}
