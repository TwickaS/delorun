/**
 * Where a request arrived, failing closed: a stamped reach listener is that listener, and an unstamped request is a
 * loopback request only when the loopback listener's own socket accepted it.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { describe, expect, it } from 'vitest'
import { REQUEST_LISTENER, isForeignFetchSite, isLoopbackHost, isSameLoopbackOrigin, listenerOf, loopbackAddressOf, stampListener } from '@delorun/home'

const PORT = 3080
const port = (): number => PORT

describe('the arrival of a request', () => {
  it('reads a reach listener\'s stamp', () => {
    const request = { socket: { localAddress: '127.0.0.1', localPort: PORT } }
    stampListener(request, 'reach-tailscale-private')
    // Pins "the stamp wins": a reach request that arrived on a loopback address is still the reach listener's.
    expect(listenerOf(request, port)).toBe('reach-tailscale-private')
    expect(Reflect.get(request, REQUEST_LISTENER)).toBe('reach-tailscale-private')
    expect(() => { stampListener(request, 'loopback') }).toThrow(TypeError)
  })

  it('reads an unstamped request on the loopback listener\'s socket as loopback', () => {
    expect(listenerOf({ socket: { localAddress: '127.0.0.1', localPort: PORT } }, port)).toBe('loopback')
    expect(listenerOf({ socket: { localAddress: '::ffff:127.0.0.1', localPort: PORT } }, port)).toBe('loopback')
    expect(listenerOf({ socket: { localAddress: '::1', localPort: PORT } }, port)).toBe('loopback')
  })

  it('a request without a listener stamp is not loopback', () => {
    // Pins the port half: another listener's socket, such as a reach listener's that forwarded without a stamp.
    expect(listenerOf({ socket: { localAddress: '127.0.0.1', localPort: PORT + 1 } }, port)).toBeUndefined()
    // Pins the bound-port half: before the loopback listener binds, nothing is loopback.
    expect(listenerOf({ socket: { localAddress: '127.0.0.1', localPort: PORT } }, () => undefined)).toBeUndefined()
    // Pins the address half: the loopback port on another interface is not the loopback listener.
    expect(listenerOf({ socket: { localAddress: '192.0.2.4', localPort: PORT } }, port)).toBeUndefined()
    expect(listenerOf({ socket: { localPort: PORT } }, port)).toBeUndefined()
    // A stream with no TCP socket, such as the relay listener's.
    expect(listenerOf({}, port)).toBeUndefined()
  })
})

describe('the Host and Origin a loopback request names', () => {
  it('reads loopback names and addresses, and refuses what is no loopback authority', () => {
    expect([isLoopbackHost('[::1]:3080'), isLoopbackHost('studio.localhost'), isLoopbackHost('127.1.2.3'), isLoopbackHost(undefined), isLoopbackHost('a b'), isLoopbackHost('example.org')])
      .toEqual([true, true, true, false, false, false])
    expect([loopbackAddressOf('[::1]'), loopbackAddressOf(undefined), loopbackAddressOf('localhost:0'), loopbackAddressOf('localhost:70000'), loopbackAddressOf('localhost:3080')])
      .toEqual(['http://127.0.0.1:3080', undefined, undefined, undefined, 'http://127.0.0.1:3080'])
    expect([
      isSameLoopbackOrigin('http://127.0.0.1:3080', '127.0.0.1:3080'),
      isSameLoopbackOrigin(undefined, '127.0.0.1:3080'),
      isSameLoopbackOrigin('http://127.0.0.1:3080', undefined),
      isSameLoopbackOrigin('http://rebind.example', 'rebind.example'),
    ]).toEqual([true, false, false, false])
    expect([isForeignFetchSite(undefined), isForeignFetchSite('same-origin'), isForeignFetchSite('none'), isForeignFetchSite('cross-site')]).toEqual([false, false, false, true])
  })
})
