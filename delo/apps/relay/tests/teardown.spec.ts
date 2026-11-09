/**
 * Teardown: a home that disconnects ends every association it owns at once, the name stays
 * without a tunnel until a new handshake, and the relay's shutdown ends them all. A teardown
 * that only marked the tunnel dead would leave the browsers' connections open, which the first
 * spec asserts against. The silence limit counts a WebSocket pong as received, so an idle tunnel
 * whose home answers every ping stays live while one that receives nothing closes at 45 seconds.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { RELAY_LIMITS, STREAM_CLOSE_REASONS } from '@delo/contract-relay-protocol'
import { encodeClose, encodeControl, encodeData } from '../src/frames.ts'
import { peerAssertion } from '../src/peer.ts'
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

function opened(fixture: RelayFixture, name: string, port: number): { readonly browser: FakeBrowser; readonly streamId: number } {
  const browser = new FakeBrowser(peerAssertion({ address: '203.0.113.7', port }))
  const verdict = fixture.core.openBrowser(name, clientHello({ sni: name }), browser)
  if (verdict.routed !== 'opened') throw new Error('the browser connection was dropped')
  return { browser, streamId: verdict.streamId }
}

describe('a home disconnecting', () => {
  it('ends every browser connection of the name at once and leaves the name without a tunnel', () => {
    const fixture = relay()
    const home = connectHome(fixture, { name: STUDIO })
    expect(home.ready).toBe(true)
    const first = opened(fixture, STUDIO, 40_101)
    const second = opened(fixture, STUDIO, 40_102)
    const third = opened(fixture, STUDIO, 40_103)
    expect(fixture.core.streamCount(STUDIO)).toBe(3)
    home.socket.remoteClose()
    expect(first.browser.destroyed).toBe(true)
    expect(second.browser.destroyed).toBe(true)
    expect(third.browser.destroyed).toBe(true)
    expect(fixture.core.streamCount(STUDIO)).toBe(0)
    expect(fixture.core.isLive(STUDIO)).toBe(false)
  })

  it('ignores bytes a browser sends after its stream ended', () => {
    const fixture = relay()
    const home = connectHome(fixture, { name: STUDIO })
    const { browser } = opened(fixture, STUDIO, 40_104)
    home.socket.remoteClose()
    const frames = home.socket.binaries.length
    browser.deliver(new Uint8Array(100))
    expect(home.socket.binaries.length).toBe(frames)
  })

  it('leaves another name\'s tunnel and streams untouched', () => {
    const fixture = relay()
    const studio = connectHome(fixture, { name: STUDIO })
    const other = connectHome(fixture, { name: OTHER })
    const studioStream = opened(fixture, STUDIO, 40_105)
    const otherStream = opened(fixture, OTHER, 40_106)
    studio.socket.remoteClose()
    expect(studioStream.browser.destroyed).toBe(true)
    expect(otherStream.browser.destroyed).toBe(false)
    expect(fixture.core.isLive(OTHER)).toBe(true)
    other.socket.deliverBinary(encodeData(otherStream.streamId, Uint8Array.of(1, 2, 3)))
    expect([...otherStream.browser.received()]).toEqual([1, 2, 3])
  })

  it('ends a tunnel that closes during its handshake without leaving a tunnel behind', () => {
    const fixture = relay()
    const home = connectHome(fixture, { name: STUDIO, answer: 'none' })
    expect(fixture.core.isLive(STUDIO)).toBe(false)
    home.socket.remoteClose()
    expect(fixture.core.isLive(STUDIO)).toBe(false)
    expect(connectHome(fixture, { name: STUDIO }).ready).toBe(true)
  })

  it('keeps the tunnel live while the home answers the ping and closes it after 45 seconds of silence', () => {
    const fixture = relay()
    const home = connectHome(fixture, { name: STUDIO })
    fixture.timers.advance(15_000)
    expect(home.socket.pings).toBe(1)
    expect(fixture.core.isLive(STUDIO)).toBe(true)
    fixture.timers.advance(45_000)
    expect(home.socket.closeCode).toBe(4400)
    expect(fixture.core.isLive(STUDIO)).toBe(false)
  })

  it('keeps a tunnel that answers within the silence limit', () => {
    const fixture = relay()
    const home = connectHome(fixture, { name: STUDIO })
    for (let index = 0; index < 3; index += 1) {
      home.socket.deliverBinary(encodeControl({ type: 'pong' }))
      fixture.timers.advance(15_000)
    }
    expect(fixture.core.isLive(STUDIO)).toBe(true)
    expect(home.socket.pings).toBe(3)
  })

  it('keeps an idle tunnel live whose home answers every ping with a WebSocket pong', () => {
    const fixture = relay()
    const home = connectHome(fixture, { name: STUDIO })
    // A pong is something received (C6, "Frames and flow control"), so the home's WebSocket
    // answering every ping keeps an idle but healthy tunnel past C6's 45-second silence limit:
    // without the pong listener the tunnel closes at 45 seconds, as the spec above asserts.
    for (let index = 0; index < 4; index += 1) {
      fixture.timers.advance(RELAY_LIMITS.pingIntervalMs)
      expect(home.socket.closeCode).toBeUndefined()
      home.socket.deliverPong()
    }
    expect(home.socket.pings).toBe(4)
    expect(fixture.core.isLive(STUDIO)).toBe(true)
  })
})

describe('the relay\'s shutdown', () => {
  it('ends every tunnel and every browser connection', () => {
    const fixture = relay()
    const studio = connectHome(fixture, { name: STUDIO })
    const other = connectHome(fixture, { name: OTHER })
    const studioStream = opened(fixture, STUDIO, 40_107)
    const otherStream = opened(fixture, OTHER, 40_108)
    fixture.core.dispose()
    expect(studioStream.browser.destroyed).toBe(true)
    expect(otherStream.browser.destroyed).toBe(true)
    expect(fixture.core.isLive(STUDIO)).toBe(false)
    expect(fixture.core.isLive(OTHER)).toBe(false)
    expect(studio.socket.closeCode).toBeUndefined()
    expect(other.socket.closeCode).toBeUndefined()
  })

  it('sends no frame to a closed tunnel when a browser closes afterwards', () => {
    const fixture = relay()
    const home = connectHome(fixture, { name: STUDIO })
    const { browser } = opened(fixture, STUDIO, 40_109)
    home.socket.remoteClose()
    const frames = home.socket.binaries.length
    browser.close()
    expect(home.socket.binaries.length).toBe(frames)
    expect(STREAM_CLOSE_REASONS.normal).toBe(0)
  })
})

describe('a stream closing', () => {
  it('removes the stream from the home as soon as the home closes it', () => {
    const fixture = relay()
    const home = connectHome(fixture, { name: STUDIO })
    const { browser, streamId } = opened(fixture, STUDIO, 40_110)
    home.socket.deliverBinary(encodeClose(streamId, STREAM_CLOSE_REASONS.limit))
    expect(browser.destroyed).toBe(true)
    expect(fixture.core.streamCount(STUDIO)).toBe(0)
    expect(fixture.core.isLive(STUDIO)).toBe(true)
  })
})
