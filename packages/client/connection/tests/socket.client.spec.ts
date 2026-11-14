/** Physical WebSocket selection and Host mount resolution. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  openConnectionWebSocket,
  type ConnectionWebSocket,
  type ConnectionWebSocketFactory,
} from '../src/client/socket.ts'

function socketProbe(): ConnectionWebSocket {
  return {
    readyState: 0,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('Connection WebSocket carrier', () => {
  it('requires an explicit Host base outside a document before opening a socket', () => {
    const factory = vi.fn<ConnectionWebSocketFactory>()

    expect(typeof document).toBe('undefined')
    expect(() => openConnectionWebSocket('/api/remote.mux', factory))
      .toThrow('connection: WebSocket carrier requires streamBaseUrl outside a document')
    expect(factory).not.toHaveBeenCalled()
  })

  it.each([
    ['http://host.example/tools/dsh/', 'ws://host.example/tools/dsh/api/remote.mux'],
    ['https://host.example/tools/dsh/', 'wss://host.example/tools/dsh/api/remote.mux'],
  ])('resolves the channel beneath the explicit Host base %s', (base, expected) => {
    const socket = socketProbe()
    const factory = vi.fn<ConnectionWebSocketFactory>().mockReturnValue(socket)

    expect(openConnectionWebSocket('/api/remote.mux', factory, base)).toBe(socket)
    expect(factory).toHaveBeenCalledExactlyOnceWith(expected)
  })

  it('uses the browser WebSocket and document base when no carrier is supplied', () => {
    const socket = socketProbe()
    const browserSocket = vi.fn(function (_url: string) { return socket })
    vi.stubGlobal('document', { baseURI: 'https://browser.example/mounted/' } satisfies Pick<Document, 'baseURI'>)
    vi.stubGlobal('WebSocket', browserSocket)
    try {
      expect(openConnectionWebSocket('/api/remote.mux')).toBe(socket)
      expect(browserSocket).toHaveBeenCalledExactlyOnceWith('wss://browser.example/mounted/api/remote.mux')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('Connection request extras', () => {
  it('offers the registered subprotocols on the browser WebSocket, and none otherwise', () => {
    const socket = socketProbe()
    const browserSocket = vi.fn(function (_url: string, _protocols?: string[]) { return socket })
    vi.stubGlobal('document', { baseURI: 'https://browser.example/' } satisfies Pick<Document, 'baseURI'>)
    vi.stubGlobal('WebSocket', browserSocket)
    openConnectionWebSocket('/api/remote.mux', undefined, undefined, ['delorun.mux', 'delorun-unlock.t'])
    expect(browserSocket).toHaveBeenLastCalledWith('wss://browser.example/api/remote.mux', ['delorun.mux', 'delorun-unlock.t'])
    openConnectionWebSocket('/api/remote.mux')
    // Pins the locked default: a socket with no registered subprotocol offers none.
    expect(browserSocket).toHaveBeenLastCalledWith('wss://browser.example/api/remote.mux')
  })

  it('does not offer them to a carrier the Host supplied', () => {
    const factory = vi.fn<ConnectionWebSocketFactory>().mockReturnValue(socketProbe())
    openConnectionWebSocket('/api/remote.mux', factory, 'https://host.example/', ['delorun-unlock.t'])
    expect(factory).toHaveBeenCalledExactlyOnceWith('wss://host.example/api/remote.mux')
  })
})
