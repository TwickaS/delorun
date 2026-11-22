import { describe, expect, it } from 'vitest'
import { webSocketCredential, type WebSocketRequest } from '../src/home-websocket.ts'

const base: WebSocketRequest = {
  homeOrigin: 'http://127.0.0.1:18601', cookie: 'dsh-auth-1=COOKIE', url: 'ws://127.0.0.1:18601/api/remote.mux',
  webContentsId: 7, mainWebContentsId: 7, headers: { Origin: 'dsh-app://app', 'Sec-WebSocket-Key': 'k' },
}

describe('WebSocket credential', () => {
  it('adds the cookie for the chosen home from the main window with the application origin', () => {
    expect(webSocketCredential(base)).toEqual({ requestHeaders: {
      origin: 'http://127.0.0.1:18601', cookie: 'dsh-auth-1=COOKIE', 'sec-fetch-site': 'same-origin', 'sec-websocket-key': 'k',
    } })
  })

  it.each([
    ['another port on loopback', { url: 'ws://127.0.0.1:18602/api/remote.mux' }],
    ['another loopback name', { url: 'ws://localhost:18601/api/remote.mux' }],
    ['another host', { url: 'ws://example.com:18601/api/remote.mux' }],
    ['another scheme', { url: 'wss://127.0.0.1:18601/api/remote.mux' }],
    ['another window', { webContentsId: 8 }],
    ['an address that is not a URL', { url: 'not a url' }],
    ['no home connected', { homeOrigin: undefined }],
    ['no cookie yet', { cookie: undefined }],
    ['no main window', { mainWebContentsId: undefined, webContentsId: undefined }],
  ])('leaves a request for %s without the credential', (_name, change) => {
    expect(webSocketCredential({ ...base, ...change })).toEqual({})
  })

  it('cancels a request to the home that does not come from the application origin', () => {
    expect(webSocketCredential({ ...base, headers: { Origin: 'http://127.0.0.1:18601' } })).toEqual({ cancel: true })
    expect(webSocketCredential({ ...base, headers: {} })).toEqual({ cancel: true })
  })
})
