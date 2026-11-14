/**
 * Routing: a browser connection reaches only the home that registered its name, a frame is
 * resolved in the home's own stream map, and the peer facts the relay asserts are the ones its
 * socket observed and no others. Removing the name lookup's exact match, or routing a stream by
 * a shared stream id, turns the cross-home specs red: the other home's socket then receives the
 * connection's `OPEN` or its frames.
 */
import { FRAME_TYPES, RELAY_LIMITS, STREAM_CLOSE_REASONS } from '@delorun/contract-relay-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeClose, encodeData, encodeFrame } from '../src/frames.ts'
import { peerAssertion, UNKNOWN_CLIENT_ADDRESS } from '../src/peer.ts'
import { clientHello, connectHome, FakeBrowser, makeRelay, type RelayFixture } from './support.ts'

const STUDIO = 'studio.example.test'
const OTHER = 'other.example.test'

const fixtures: RelayFixture[] = []
afterEach(() => {
  for (const fixture of fixtures) fixture.core.dispose()
  fixtures.length = 0
})

function relay(): RelayFixture {
  const fixture = makeRelay({ names: [STUDIO, OTHER] })
  fixtures.push(fixture)
  return fixture
}

function browserAt(port: number): FakeBrowser {
  return new FakeBrowser(peerAssertion({ address: '203.0.113.7', port }))
}

describe('one home per name', () => {
  it('routes a browser connection to the home that registered the name and to no other', () => {
    const fixture = relay()
    // The other home registers first, so a lookup that fell back to any live tunnel would route
    // the browser to it and this spec would see its frames.
    const other = connectHome(fixture, { name: OTHER })
    const studio = connectHome(fixture, { name: STUDIO })
    expect(studio.ready && other.ready).toBe(true)
    const browser = browserAt(40_001)
    const hello = clientHello({ sni: STUDIO })
    expect(fixture.core.openBrowser(STUDIO, hello, browser)).toEqual({ routed: 'opened', streamId: 1 })
    browser.deliver(new TextEncoder().encode('GET / HTTP/1.1\r\n\r\n'))
    expect(studio.socket.frames().map(frame => frame.type)).toEqual(['open', 'data', 'data'])
    expect(other.socket.frames()).toEqual([])
  })

  it('drops a browser connection whose name has no live tunnel and sends nothing to another live home', () => {
    const fixture = relay()
    const studio = connectHome(fixture, { name: STUDIO })
    expect(studio.ready).toBe(true)
    const browser = browserAt(40_002)
    expect(fixture.core.openBrowser(OTHER, clientHello({ sni: OTHER }), browser)).toEqual({ routed: 'dropped', reason: 'no-live-tunnel' })
    expect(browser.destroyed).toBe(true)
    expect(studio.socket.frames()).toEqual([])
  })

  it('matches the name exactly, so a prefix or a suffix of a bound name reaches no home', () => {
    const fixture = relay()
    const studio = connectHome(fixture, { name: STUDIO })
    expect(studio.ready).toBe(true)
    for (const name of ['example.test', 'studio.example.test.', 'studio.example.test.evil', 'studio']) {
      const browser = browserAt(40_003)
      expect(fixture.core.openBrowser(name, clientHello({ sni: name }), browser)).toEqual({ routed: 'dropped', reason: 'no-live-tunnel' })
    }
    expect(studio.socket.frames()).toEqual([])
  })

  it('drops a browser connection after the name\'s tunnel closed', () => {
    const fixture = relay()
    const studio = connectHome(fixture, { name: STUDIO })
    expect(studio.ready).toBe(true)
    studio.socket.remoteClose()
    const browser = browserAt(40_004)
    expect(fixture.core.openBrowser(STUDIO, clientHello({ sni: STUDIO }), browser)).toEqual({ routed: 'dropped', reason: 'no-live-tunnel' })
    expect(browser.destroyed).toBe(true)
  })
})

describe('one stream map per tunnel', () => {
  it('a frame for a stream the home never opened closes that home\'s tunnel and reaches no other home', () => {
    const fixture = relay()
    const studio = connectHome(fixture, { name: STUDIO })
    const other = connectHome(fixture, { name: OTHER })
    expect(studio.ready && other.ready).toBe(true)
    const routed = browserAt(40_005)
    expect(fixture.core.openBrowser(STUDIO, clientHello({ sni: STUDIO }), routed).routed).toBe('opened')
    const before = routed.received().byteLength
    other.socket.deliverBinary(encodeData(2, new TextEncoder().encode('another home\'s bytes')))
    expect(other.socket.closeCode).toBe(4400)
    expect(studio.socket.closeCode).toBeUndefined()
    expect(fixture.core.isLive(STUDIO)).toBe(true)
    expect(routed.received().byteLength).toBe(before)
    expect(routed.destroyed).toBe(false)
  })

  it('a home cannot close another home\'s stream by reusing its id', () => {
    const fixture = relay()
    connectHome(fixture, { name: STUDIO })
    const other = connectHome(fixture, { name: OTHER })
    const routed = browserAt(40_006)
    fixture.core.openBrowser(STUDIO, clientHello({ sni: STUDIO }), routed)
    other.socket.deliverBinary(encodeClose(1, STREAM_CLOSE_REASONS.normal))
    expect(other.socket.closeCode).toBe(4400)
    expect(routed.destroyed).toBe(false)
    expect(fixture.core.streamCount(STUDIO)).toBe(1)
  })

  it('a home cannot send an OPEN frame, which only the relay sends', () => {
    const fixture = relay()
    const home = connectHome(fixture, { name: STUDIO })
    home.socket.deliverBinary(encodeFrame(FRAME_TYPES.OPEN, 1, new TextEncoder().encode(JSON.stringify({ sni: STUDIO, clientAddress: '203.0.113.7', clientPort: 1 }))))
    expect(home.socket.closeCode).toBe(4400)
  })

  it('a home cannot announce, which only the relay does', () => {
    const fixture = relay()
    const home = connectHome(fixture, { name: STUDIO })
    home.socket.deliverBinary(encodeFrame(FRAME_TYPES.CONTROL, 0, new TextEncoder().encode(JSON.stringify({ type: 'announce', kind: 'tunnel-rebound', at: 1, clientAddress: '203.0.113.7' }))))
    expect(home.socket.closeCode).toBe(4400)
  })
})

describe('the peer facts', () => {
  it('names the ClientHello\'s SNI and the peer facts the relay observed, in exactly C6\'s three fields', () => {
    const fixture = relay()
    const studio = connectHome(fixture, { name: STUDIO })
    const browser = browserAt(40_007)
    fixture.core.openBrowser(STUDIO, clientHello({ sni: STUDIO }), browser)
    const open = studio.socket.frames()[0]
    if (open?.type !== 'open') throw new Error('the home received no OPEN frame')
    expect(open.payload).toEqual({ sni: STUDIO, clientAddress: '203.0.113.7', clientPort: 40_007 })
    const text = Buffer.from(studio.socket.binaries[0] ?? new Uint8Array()).subarray(5).toString('utf8')
    expect(JSON.parse(text)).toStrictEqual({ sni: STUDIO, clientAddress: '203.0.113.7', clientPort: 40_007 })
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(['clientAddress', 'clientPort', 'sni'])
  })

  it('gives each connection the facts of its own socket', () => {
    const fixture = relay()
    const studio = connectHome(fixture, { name: STUDIO })
    for (const port of [40_010, 40_011]) {
      fixture.core.openBrowser(STUDIO, clientHello({ sni: STUDIO }), browserAt(port))
    }
    const opens = studio.socket.frames().flatMap(frame => (frame.type === 'open' ? [frame.payload.clientPort] : []))
    expect(opens).toEqual([40_010, 40_011])
  })

  it('marks every assertion unverified and marks a transport without a peer as unknown rather than inventing one', () => {
    expect(peerAssertion({ address: '203.0.113.7', port: 1234 }).verified).toBe(false)
    expect(peerAssertion({ address: undefined, port: undefined })).toEqual({ clientAddress: UNKNOWN_CLIENT_ADDRESS, clientPort: 0, verified: false })
    expect(peerAssertion({ address: '', port: 65_536 })).toEqual({ clientAddress: UNKNOWN_CLIENT_ADDRESS, clientPort: 0, verified: false })
  })

  it('carries the unknown address through the OPEN frame without a claim beside it', () => {
    const fixture = relay()
    const studio = connectHome(fixture, { name: STUDIO })
    fixture.core.openBrowser(STUDIO, clientHello({ sni: STUDIO }), new FakeBrowser(peerAssertion({ address: undefined, port: undefined })))
    const open = studio.socket.frames()[0]
    if (open?.type !== 'open') throw new Error('the home received no OPEN frame')
    expect(open.payload).toEqual({ sni: STUDIO, clientAddress: UNKNOWN_CLIENT_ADDRESS, clientPort: 0 })
  })
})

describe('the stream limit', () => {
  it('closes the 65th concurrent browser connection of one home without an OPEN frame', () => {
    const fixture = relay()
    const studio = connectHome(fixture, { name: STUDIO })
    for (let index = 0; index < RELAY_LIMITS.concurrentStreamsPerHome; index += 1) {
      expect(fixture.core.openBrowser(STUDIO, clientHello({ sni: STUDIO }), browserAt(41_000 + index)).routed).toBe('opened')
    }
    expect(fixture.core.streamCount(STUDIO)).toBe(RELAY_LIMITS.concurrentStreamsPerHome)
    const opensBefore = studio.socket.frames().filter(frame => frame.type === 'open').length
    const extra = browserAt(42_000)
    expect(fixture.core.openBrowser(STUDIO, clientHello({ sni: STUDIO }), extra)).toEqual({ routed: 'dropped', reason: 'stream-limit' })
    expect(extra.destroyed).toBe(true)
    expect(studio.socket.frames().filter(frame => frame.type === 'open').length).toBe(opensBefore)
  })

  it('frees a stream for the next connection when a browser closes', () => {
    const fixture = relay()
    connectHome(fixture, { name: STUDIO })
    const browsers = Array.from({ length: RELAY_LIMITS.concurrentStreamsPerHome }, (_unused, index) => browserAt(43_000 + index))
    for (const browser of browsers) fixture.core.openBrowser(STUDIO, clientHello({ sni: STUDIO }), browser)
    expect(fixture.core.streamCount(STUDIO)).toBe(RELAY_LIMITS.concurrentStreamsPerHome)
    browsers[0]?.close()
    expect(fixture.core.streamCount(STUDIO)).toBe(RELAY_LIMITS.concurrentStreamsPerHome - 1)
    expect(fixture.core.openBrowser(STUDIO, clientHello({ sni: STUDIO }), browserAt(44_000)).routed).toBe('opened')
  })
})
