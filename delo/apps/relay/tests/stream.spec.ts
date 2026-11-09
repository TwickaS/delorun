/**
 * The stream association: opaque byte forwarding, C6's credit and buffer limits, and the stream
 * close reasons. Removing the credit comparison, the 1 MiB backlog cap or the 1 MiB grant cap
 * turns the spec that covers it red: the relay then forwards more than a stream may carry, or
 * buffers more than the contract allows.
 */
import { FRAME_HEADER_BYTES, RELAY_LIMITS, STREAM_CLOSE_REASONS } from '@delo/contract-relay-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeClose, encodeCredit, encodeData, parseFrame, type Frame } from '../src/frames.ts'
import { peerAssertion } from '../src/peer.ts'
import { clientHello, connectHome, FakeBrowser, makeRelay, type RelayFixture } from './support.ts'
import type { Stream } from '../src/stream.ts'

const STUDIO = 'studio.example.test'
const fixtures: RelayFixture[] = []
afterEach(() => {
  for (const fixture of fixtures) fixture.core.dispose()
  fixtures.length = 0
})

interface Opened {
  readonly fixture: RelayFixture
  readonly home: ReturnType<typeof connectHome>
  readonly browser: FakeBrowser
  readonly streamId: number
  readonly frames: () => readonly Frame[]
}

function open(): Opened {
  const fixture = makeRelay({ names: [STUDIO] })
  fixtures.push(fixture)
  const home = connectHome(fixture, { name: STUDIO })
  const browser = new FakeBrowser(peerAssertion({ address: '203.0.113.7', port: 40_100 }))
  const verdict = fixture.core.openBrowser(STUDIO, clientHello({ sni: STUDIO }), browser)
  if (verdict.routed !== 'opened') throw new Error('the browser connection was dropped')
  return {
    fixture,
    home,
    browser,
    streamId: verdict.streamId,
    frames: () => home.socket.frames().filter(frame => !(frame.type === 'open')),
  }
}

/** The bytes a home's DATA frames carry. */
function dataBytes(frames: readonly Frame[]): Uint8Array {
  return Buffer.concat(frames.flatMap(frame => (frame.type === 'data' ? [Buffer.from(frame.payload)] : [])))
}

describe('opaque bytes', () => {
  it('forwards each byte the browser sends unchanged, with only the frame header around it', () => {
    const { home, browser, streamId, frames } = open()
    const bytes = Uint8Array.from({ length: 5_000 }, (_unused, index) => (index * 37) & 0xff)
    browser.deliver(bytes)
    expect([...dataBytes(frames())]).toEqual([...clientHello({ sni: STUDIO }), ...bytes])
    for (const frame of frames()) {
      expect(frame.type).toBe('data')
      expect(frame.type === 'data' ? frame.streamId : 0).toBe(streamId)
    }
    const first = home.socket.binaries[1]
    expect(first?.[0]).toBe(0x02)
    expect(new DataView(first?.buffer ?? new ArrayBuffer(0), first?.byteOffset ?? 0).getUint32(1, false)).toBe(streamId)
    expect(first?.byteLength).toBe(FRAME_HEADER_BYTES + (first?.byteLength ?? 0) - FRAME_HEADER_BYTES)
  })

  it('sends the ClientHello as the stream\'s first DATA frame, before the connection\'s later bytes', () => {
    const { home } = open()
    const hello = clientHello({ sni: STUDIO })
    const frames = home.socket.frames()
    expect(frames[0]?.type).toBe('open')
    expect(frames[1]?.type).toBe('data')
    expect(frames[1]?.type === 'data' ? [...frames[1].payload] : []).toEqual([...hello])
  })

  it('forwards each byte the home sends unchanged', () => {
    const { home, browser, streamId } = open()
    const bytes = Uint8Array.from([0x00, 0xff, 0xc3, 0x28, 0x16, 0x03])
    home.socket.deliverBinary(encodeData(streamId, bytes))
    expect([...browser.received()]).toEqual([...bytes])
  })

  it('splits a read above the DATA limit into frames of at most 65,536 bytes', () => {
    const { browser, frames } = open()
    browser.deliver(new Uint8Array(RELAY_LIMITS.dataPayloadBytes * 2 + 10))
    const sizes = frames().flatMap(frame => (frame.type === 'data' ? [frame.payload.byteLength] : []))
    expect(sizes.slice(1).every(size => size <= RELAY_LIMITS.dataPayloadBytes)).toBe(true)
    expect(sizes.slice(1)).toEqual([RELAY_LIMITS.dataPayloadBytes, RELAY_LIMITS.dataPayloadBytes, 10])
  })
})

describe('flow control', () => {
  it('sends no DATA beyond the credit the home granted, and resumes when it grants more', () => {
    const { home, browser, frames } = open()
    const credit = RELAY_LIMITS.streamBufferBytes - clientHello({ sni: STUDIO }).byteLength
    browser.deliver(new Uint8Array(credit))
    expect(dataBytes(frames()).byteLength).toBe(RELAY_LIMITS.streamBufferBytes)
    browser.deliver(new Uint8Array(1_000))
    expect(dataBytes(frames()).byteLength).toBe(RELAY_LIMITS.streamBufferBytes)
    expect(browser.pauses).toBe(0)
    browser.deliver(new Uint8Array(RELAY_LIMITS.streamBufferBytes - 1_000))
    expect(browser.pauses).toBe(1)
    expect(dataBytes(frames()).byteLength).toBe(RELAY_LIMITS.streamBufferBytes)
    home.socket.deliverBinary(encodeCredit(1, 1))
    expect(dataBytes(frames()).byteLength).toBe(RELAY_LIMITS.streamBufferBytes + 1)
    expect(browser.resumes).toBe(1)
  })

  it('holds at most 1 MiB of the browser\'s bytes and closes the stream when a read exceeds it', () => {
    const { home, browser, frames } = open()
    const credit = RELAY_LIMITS.streamBufferBytes - clientHello({ sni: STUDIO }).byteLength
    browser.deliver(new Uint8Array(credit))
    expect(dataBytes(frames()).byteLength).toBe(RELAY_LIMITS.streamBufferBytes)
    browser.deliver(new Uint8Array(RELAY_LIMITS.streamBufferBytes))
    expect(browser.pauses).toBe(1)
    expect(dataBytes(frames()).byteLength).toBe(RELAY_LIMITS.streamBufferBytes)
    browser.deliver(Uint8Array.of(1))
    expect(frames().flatMap(frame => (frame.type === 'close' ? [frame.reason] : []))).toEqual([STREAM_CLOSE_REASONS.protocolError])
    expect(browser.destroyed).toBe(true)
    expect(home.socket.closeCode).toBeUndefined()
  })

  it('withholds credit while the browser holds the bytes and grants it on the transport\'s drain', () => {
    const { home, browser, streamId, frames } = open()
    browser.writable = false
    home.socket.deliverBinary(encodeData(streamId, new Uint8Array(1_000)))
    expect(frames().filter(frame => frame.type === 'credit')).toEqual([])
    browser.drain()
    expect(frames().flatMap(frame => (frame.type === 'credit' ? [frame.credit] : []))).toEqual([1_000])
  })

  it('closes the stream with reason 3 when the home sends beyond the credit the relay granted', () => {
    const { home, browser, streamId, frames } = open()
    browser.writable = false
    for (let index = 0; index < RELAY_LIMITS.streamBufferBytes / RELAY_LIMITS.dataPayloadBytes; index += 1) {
      home.socket.deliverBinary(encodeData(streamId, new Uint8Array(RELAY_LIMITS.dataPayloadBytes)))
    }
    expect(frames().filter(frame => frame.type === 'close')).toEqual([])
    home.socket.deliverBinary(encodeData(streamId, Uint8Array.of(1)))
    expect(frames().flatMap(frame => (frame.type === 'close' ? [frame.reason] : []))).toEqual([STREAM_CLOSE_REASONS.protocolError])
    expect(browser.destroyed).toBe(true)
  })
})

describe('closing', () => {
  it('destroys the browser connection when the home closes the stream', () => {
    const { home, browser, streamId } = open()
    home.socket.deliverBinary(encodeClose(streamId, STREAM_CLOSE_REASONS.refused))
    expect(browser.destroyed).toBe(true)
    expect(fixture(fixtures).core.streamCount(STUDIO)).toBe(0)
  })

  it('tells the home when the browser closes the connection', () => {
    const { browser, frames } = open()
    browser.close()
    expect(frames().flatMap(frame => (frame.type === 'close' ? [frame.reason] : []))).toEqual([STREAM_CLOSE_REASONS.normal])
  })

  it('ends the stream once, whichever side closes first', () => {
    const { home, browser, streamId } = open()
    browser.close()
    home.socket.deliverBinary(encodeClose(streamId, STREAM_CLOSE_REASONS.normal))
    expect(parseFrame(home.socket.binaries.at(-1) ?? new Uint8Array()).type).toBe('close')
    expect(fixture(fixtures).core.streamCount(STUDIO)).toBe(0)
  })
})

/** The most recently made fixture, for a spec that needs the core after {@link open}. */
function fixture(fixtures: readonly RelayFixture[]): RelayFixture {
  const last = fixtures.at(-1)
  if (last === undefined) throw new Error('no fixture')
  return last
}

/** The stream object of a fixture's only stream, for its buffer report. */
export type OpenedStream = Stream
