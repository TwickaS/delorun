import dgram from 'node:dgram'
import dns from 'node:dns'
import { lookup as importedLookup } from 'node:dns/promises'
import net from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installNetworkGuard, isLoopbackAddress, NETWORK_GUARD_CODE, type NetworkGuard } from '../../src/stack/index.ts'

// TEST-NET-1 (RFC 5737): reserved for documentation and never routed.
const OUTSIDE = '192.0.2.1'

let guard: NetworkGuard

beforeEach(() => {
  guard = installNetworkGuard()
})

afterEach(() => {
  guard.uninstall()
})

async function connectOutcome(options: net.NetConnectOpts): Promise<{ readonly connected: boolean, readonly code?: string }> {
  return new Promise(resolve => {
    const socket = net.connect(options)
    socket.once('connect', () => {
      socket.destroy()
      resolve({ connected: true })
    })
    socket.once('error', (error: NodeJS.ErrnoException) => { resolve({ connected: false, ...(error.code === undefined ? {} : { code: error.code }) }) })
  })
}

async function loopbackServer(): Promise<{ readonly port: number, readonly close: () => Promise<void> }> {
  const server = net.createServer(socket => { socket.end() })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  return { port: (server.address() as net.AddressInfo).port, close: async () => new Promise(resolve => { server.close(() => { resolve() }) }) }
}

describe('the network guard', () => {
  it.each([
    ['127.0.0.1', true], ['127.255.0.9', true], ['::1', true], ['[::1]', true], ['::ffff:127.0.0.1', true],
    ['0.0.0.0', false], ['::', false], [OUTSIDE, false], ['::ffff:192.0.2.1', false], ['198.51.100.7', false], ['localhost', false],
  ] as const)('classifies %s as loopback: %s', (address, loopback) => {
    expect(isLoopbackAddress(address)).toBe(loopback)
  })

  it('refuses a connection to a non-loopback address before it is attempted', async () => {
    expect(await connectOutcome({ host: OUTSIDE, port: 443 })).toEqual({ connected: false, code: NETWORK_GUARD_CODE })
    expect(guard.refusals).toEqual([{ operation: 'connect', target: OUTSIDE, port: 443 }])
    expect(guard.connections).toEqual([])
  })

  it('refuses a connection to a name without looking it up, including through fetch', async () => {
    expect(await connectOutcome({ host: 'example.com', port: 443 })).toEqual({ connected: false, code: NETWORK_GUARD_CODE })
    const failure = await fetch('https://example.com/').then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(TypeError)
    expect((failure as { cause?: { code?: string } }).cause?.code).toBe(NETWORK_GUARD_CODE)
    expect(guard.refusals.map(refusal => [refusal.operation, refusal.target])).toEqual([['connect', 'example.com'], ['connect', 'example.com']])
  })

  it('refuses name lookups and DNS queries other than localhost', async () => {
    const callbackError = await new Promise<NodeJS.ErrnoException | null>(resolve => { dns.lookup('example.com', error => { resolve(error) }) })
    expect(callbackError?.code).toBe(NETWORK_GUARD_CODE)
    await expect(importedLookup('example.com')).rejects.toMatchObject({ code: NETWORK_GUARD_CODE })
    await expect(dns.promises.resolveTxt('_acme-challenge.example.com')).rejects.toMatchObject({ code: NETWORK_GUARD_CODE })
    await expect(new dns.promises.Resolver().resolveCaa('example.com')).rejects.toMatchObject({ code: NETWORK_GUARD_CODE })
    const resolveError = await new Promise<Error | null>(resolve => { dns.resolve4('example.com', error => { resolve(error) }) })
    expect(resolveError).toMatchObject({ code: NETWORK_GUARD_CODE })
    expect((await importedLookup('localhost', { all: true })).every(entry => isLoopbackAddress(entry.address))).toBe(true)
  })

  it('refuses a listener on every interface or a public address, and allows loopback', async () => {
    for (const listen of [(server: net.Server) => server.listen(0), (server: net.Server) => server.listen(0, '0.0.0.0'), (server: net.Server) => server.listen({ port: 0, host: '::' })]) {
      const server = net.createServer()
      const error = await new Promise<NodeJS.ErrnoException>(resolve => {
        server.once('error', resolve)
        listen(server)
      })
      expect(error.code).toBe(NETWORK_GUARD_CODE)
      expect(server.listening).toBe(false)
    }
    const allowed = await loopbackServer()
    await allowed.close()
    expect(guard.refusals.map(refusal => refusal.operation)).toEqual(['listen', 'listen', 'listen'])
  })

  it('refuses UDP to a non-loopback address and a bind on every interface', async () => {
    const socket = dgram.createSocket('udp4')
    const sendError = await new Promise<Error | null>(resolve => { socket.send('x', 53, OUTSIDE, error => { resolve(error) }) })
    expect(sendError).toMatchObject({ code: NETWORK_GUARD_CODE })
    const bindError = await new Promise<Error>(resolve => {
      socket.once('error', resolve)
      socket.bind(0)
    })
    expect(bindError).toMatchObject({ code: NETWORK_GUARD_CODE })
    socket.close()
    expect(guard.refusals.map(refusal => [refusal.operation, refusal.target])).toEqual([['udp-send', OUTSIDE], ['udp-bind', '<unspecified>']])
  })

  it('records loopback connections by address and by localhost', async () => {
    const server = await loopbackServer()
    expect(await connectOutcome({ host: '127.0.0.1', port: server.port })).toEqual({ connected: true })
    expect(await connectOutcome({ host: 'localhost', port: server.port, family: 4 })).toEqual({ connected: true })
    await server.close()
    expect(guard.connections).toEqual([
      { host: '127.0.0.1', remoteAddress: '127.0.0.1', remotePort: server.port, loopback: true },
      { host: 'localhost', remoteAddress: '127.0.0.1', remotePort: server.port, loopback: true },
    ])
    expect(guard.refusals).toEqual([])
  })

  it('refuses a second guard and restores the patched functions on uninstall', () => {
    expect(() => installNetworkGuard()).toThrow(/already installed/)
    const patched = net.Socket.prototype.connect
    guard.uninstall()
    expect(net.Socket.prototype.connect).not.toBe(patched)
    guard = installNetworkGuard()
    expect(net.Socket.prototype.connect).not.toBe(patched)
  })
})
