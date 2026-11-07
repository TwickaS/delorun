/**
 * Additional listeners: every request and upgrade request reaches the gate
 * before any route, upgrade handler or the fallback; refusals dispatch nothing;
 * `only` limits a pass to one named route; a pass's Peer reaches resources and
 * its headers stay pinned through the route's own; `streams` listeners end TLS
 * on handed-in streams and expose SNI; close and service disposal end every
 * connection. The configured listener keeps its ungated behavior.
 */

import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { PassThrough, type Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import WebServer, { type WebGateDecision, type WebListener, type WebListenerGate } from '../src/index.ts'
import { materializeTlsFixture } from './tls-fixture.ts'

/** The Peer a gate passes; the routes read no field of it. */
const PEER = { principal: { kind: 'owner' } } as PeerScope

let contexts: Context[] = []
let roots: string[] = []

afterEach(async () => {
  const open = contexts
  contexts = []
  await Promise.all(open.map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
  roots = []
})

/** A webserver on 127.0.0.1 with a handler, resource and upgrade route and a resource fallback, each recording that it ran. */
async function startServer(): Promise<{ server: WebServer; ran: string[]; peers: (PeerScope | undefined)[] }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const server = ctx.webServer
  const ran: string[] = []
  const peers: (PeerScope | undefined)[] = []
  server.register({ kind: 'exact', path: '/handler', handler: (_req, res) => {
    ran.push('handler')
    res.setHeader('x-frame-options', 'route')
    res.removeHeader('x-gate')
    res.writeHead(200, { 'content-security-policy': "default-src 'none'", 'set-cookie': 'route=1', 'x-gate': 'route' })
    res.end('handler')
  } })
  server.register({ kind: 'prefix', path: '/assets', resource: (_request, peer) => {
    ran.push('assets')
    peers.push(peer)
    return Promise.resolve(new Response('asset'))
  } })
  server.registerUpgrade({ path: '/socket', handler: (_req, socket) => {
    ran.push('upgrade')
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
  } })
  server.registerFallback({ resource: (_request, peer) => {
    ran.push('fallback')
    peers.push(peer)
    return Promise.resolve(new Response('fallback'))
  } })
  return { server, ran, peers }
}

function address(listener: WebListener): AddressInfo {
  if (listener.address === undefined) throw new Error('listener has no address')
  return { address: listener.address.host, port: listener.address.port, family: 'IPv4' }
}

async function get(port: number, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(port)}${path}`, { headers })
}

/** Send one raw upgrade request and collect everything the server writes until it closes. */
async function rawUpgrade(socket: Duplex, path: string): Promise<string> {
  let received = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => { received += chunk })
  const closed = once(socket, 'close')
  socket.write(`GET ${path} HTTP/1.1\r\nHost: reach.test\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n`)
  await closed
  return received
}

const refuseAll: WebListenerGate = () => ({ kind: 'refuse', status: 401, headers: { 'content-type': 'application/json' }, body: '{"error":"NOT_SIGNED_IN"}' })

describe('additional listeners', () => {
  it('binds 127.0.0.1 on an assigned port and refuses every route, upgrade and the fallback before they run', async () => {
    const { server, ran } = await startServer()
    const gated: string[] = []
    const listener = await server.openListener({ id: 'reach-a', bind: { kind: 'loopback' }, gate: (req, kind) => {
      gated.push(`${kind} ${req.url ?? ''}`)
      return refuseAll(req, kind)
    } })
    const { address: host, port } = address(listener)
    expect(host).toBe('127.0.0.1')
    expect(port).not.toBe(server.port)
    for (const path of ['/handler', '/assets/a.js', '/anything']) {
      const response = await get(port, path)
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'NOT_SIGNED_IN' })
    }
    const socket = connect(port, '127.0.0.1')
    await once(socket, 'connect')
    expect(await rawUpgrade(socket, '/socket')).toMatch(/^HTTP\/1\.1 401 Unauthorized\r\n[\s\S]*\r\n\r\n\{"error":"NOT_SIGNED_IN"\}$/)
    expect(ran).toEqual([])
    expect(gated).toEqual(['request /handler', 'request /assets/a.js', 'request /anything', 'upgrade /socket'])
    // The configured listener is not gated.
    expect((await get(server.port ?? 0, '/handler')).status).toBe(200)
    expect(ran).toEqual(['handler'])
  })

  it('dispatches a pass to the same routes, handing its Peer to resources and pinning its headers', async () => {
    const { server, ran, peers } = await startServer()
    const listener = await server.openListener({ id: 'reach-a', bind: { kind: 'loopback' }, gate: () => ({
      kind: 'pass',
      peer: PEER,
      headers: { 'set-cookie': 'gate=1', 'content-security-policy': "img-src 'self'", 'x-gate': 'gate', 'x-frame-options': 'DENY' },
    }) })
    const { port } = address(listener)
    const handler = await get(port, '/handler')
    expect(await handler.text()).toBe('handler')
    expect(handler.headers.getSetCookie()).toEqual(['route=1', 'gate=1'])
    expect(handler.headers.get('content-security-policy')).toBe("default-src 'none', img-src 'self'")
    expect(handler.headers.get('x-gate')).toBe('gate')
    expect(handler.headers.get('x-frame-options')).toBe('DENY')
    expect(await (await get(port, '/assets/a.js')).text()).toBe('asset')
    expect(await (await get(port, '/elsewhere')).text()).toBe('fallback')
    expect(peers).toEqual([PEER, PEER])
    // The configured listener still hands resources no Peer.
    await get(server.port ?? 0, '/assets/b.js')
    expect(peers).toEqual([PEER, PEER, undefined])
    expect(ran).toEqual(['handler', 'assets', 'fallback', 'assets'])
  })

  it('lets a pass with only reach exactly its named route, never the fallback or an upgrade', async () => {
    const { server, ran } = await startServer()
    const refusal = { status: 401, body: '{"error":"NOT_SIGNED_IN"}' }
    const listener = await server.openListener({ id: 'reach-a', bind: { kind: 'loopback' }, gate: (req): WebGateDecision => ({
      kind: 'pass',
      only: { route: req.url?.startsWith('/assets') === true ? { kind: 'prefix', path: '/assets' } : { kind: 'exact', path: '/handler' }, refusal },
    }) })
    const { port } = address(listener)
    expect((await get(port, '/handler')).status).toBe(200)
    expect((await get(port, '/assets/x')).status).toBe(200)
    expect((await get(port, '/handler/extra')).status).toBe(401)
    expect((await get(port, '/missing')).status).toBe(401)
    const socket = connect(port, '127.0.0.1')
    await once(socket, 'connect')
    expect(await rawUpgrade(socket, '/socket')).toMatch(/^HTTP\/1\.1 401 /)
    expect(ran).toEqual(['handler', 'assets'])
  })

  it('answers 500 and dispatches nothing when the gate throws', async () => {
    const { server, ran } = await startServer()
    const listener = await server.openListener({ id: 'reach-a', bind: { kind: 'loopback' }, gate: () => { throw new Error('gate failed') } })
    const { port } = address(listener)
    expect((await get(port, '/handler')).status).toBe(500)
    const socket = connect(port, '127.0.0.1')
    await once(socket, 'connect')
    expect(await rawUpgrade(socket, '/socket')).toBe('')
    expect(ran).toEqual([])
  })

  it('refuses a second open listener with the same id, also while the first is still binding', async () => {
    const { server } = await startServer()
    const both = await Promise.allSettled([
      server.openListener({ id: 'reach-a', bind: { kind: 'loopback' }, gate: refuseAll }),
      server.openListener({ id: 'reach-a', bind: { kind: 'loopback' }, gate: refuseAll }),
    ])
    expect(both.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(String((both[1] as PromiseRejectedResult).reason)).toMatch(/already open/)
    await expect(server.openListener({ id: 'reach-a', bind: { kind: 'loopback' }, gate: refuseAll })).rejects.toThrow(/already open/)
  })

  it('survives refused upgrades whose clients reset the connection at once', async () => {
    const { server } = await startServer()
    const listener = await server.openListener({ id: 'reach-a', bind: { kind: 'loopback' }, gate: refuseAll })
    const { port } = address(listener)
    const uncaught: unknown[] = []
    const record = (error: unknown): void => { uncaught.push(error) }
    process.on('uncaughtException', record)
    try {
      await Promise.all(Array.from({ length: 50 }, async () => {
        const socket = connect(port, '127.0.0.1')
        socket.on('error', () => {})
        await once(socket, 'connect')
        socket.write('GET /socket HTTP/1.1\r\nHost: reach.test\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
        socket.resetAndDestroy()
      }))
      await new Promise(resolve => setTimeout(resolve, 200))
    } finally {
      process.off('uncaughtException', record)
    }
    expect(uncaught).toEqual([])
    expect((await get(port, '/handler')).status).toBe(401)
  })

  it('closes a refused upgrade whose client keeps its half of the connection open, and close settles', async () => {
    const { server } = await startServer()
    const refused: Duplex[] = []
    const listener = await server.openListener({ id: 'reach-a', bind: { kind: 'loopback' }, gate: (req, kind) => {
      refused.push(req.socket)
      return refuseAll(req, kind)
    } })
    const socket = connect({ port: address(listener).port, host: '127.0.0.1', allowHalfOpen: true })
    socket.on('error', () => {})
    await once(socket, 'connect')
    socket.write('GET /socket HTTP/1.1\r\nHost: reach.test\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
    await once(socket, 'data')
    await expect.poll(() => refused[0]?.destroyed).toBe(true)
    const closed = listener.close().then(() => 'closed')
    const timeout = new Promise(resolve => setTimeout(() => { resolve('timed out') }, 2000))
    expect(await Promise.race([closed, timeout])).toBe('closed')
    socket.destroy()
  })

  it('ends TLS on streams handed to a streams listener and shows the gate the SNI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-webserver-listeners-'))
    roots.push(root)
    const fixture = await materializeTlsFixture(root)
    const { server, ran } = await startServer()
    const servernames: unknown[] = []
    const listener = await server.openListener({
      id: 'reach-relay',
      bind: { kind: 'streams', tls: { cert: readFileSync(fixture.certFile, 'utf8'), key: readFileSync(fixture.keyFile, 'utf8') } },
      gate: (req) => {
        servernames.push((req.socket as TLSSocket).servername)
        return { kind: 'pass' }
      },
    })
    expect(listener.address).toBeUndefined()
    const relay = createTcpServer((socket) => { listener.accept(socket) })
    relay.listen(0, '127.0.0.1')
    await once(relay, 'listening')
    try {
      const { port } = relay.address() as AddressInfo
      const tls = tlsConnect({ host: '127.0.0.1', port, servername: 'localhost', ca: fixture.ca })
      await once(tls, 'secureConnect')
      let received = ''
      tls.setEncoding('utf8')
      tls.on('data', (chunk: string) => { received += chunk })
      tls.write('GET /handler HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
      await once(tls, 'end')
      expect(received).toMatch(/^HTTP\/1\.1 200 OK/)
      expect(servernames).toEqual(['localhost'])
      expect(ran).toEqual(['handler'])
      await listener.close()
      expect(() => { listener.accept(new PassThrough()) }).toThrow(/closed/)
    } finally {
      relay.close()
    }
  })

  it('refuses streams on a loopback listener', async () => {
    const { server } = await startServer()
    const listener = await server.openListener({ id: 'reach-a', bind: { kind: 'loopback' }, gate: refuseAll })
    const socket = connect(address(listener).port, '127.0.0.1')
    await once(socket, 'connect')
    expect(() => { listener.accept(socket) }).toThrow(/accepts no streams/)
    socket.destroy()
  })

  it('closes its idle and upgraded connections on close, and every additional listener closes with the service', async () => {
    const { server } = await startServer()
    let upgraded: Duplex | undefined
    server.registerUpgrade({ path: '/hold', handler: (_req, socket) => {
      upgraded = socket
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
    } })
    const pass: WebListenerGate = () => ({ kind: 'pass' })
    const first = await server.openListener({ id: 'reach-a', bind: { kind: 'loopback' }, gate: pass })
    const second = await server.openListener({ id: 'reach-b', bind: { kind: 'loopback' }, gate: pass })
    const client = connect(address(first).port, '127.0.0.1')
    // Closing destroys the upgraded socket, which the client may see as a reset.
    client.on('error', () => {})
    await once(client, 'connect')
    client.write('GET /hold HTTP/1.1\r\nHost: reach.test\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
    await once(client, 'data')
    expect(upgraded).toBeDefined()
    const clientClosed = new Promise((resolve) => { client.once('close', resolve) })
    await first.close()
    await clientClosed
    await expect(get(address(first).port, '/handler')).rejects.toThrow()
    // The id is free again once closed.
    const reopened = await server.openListener({ id: 'reach-a', bind: { kind: 'loopback' }, gate: pass })
    const idle: Socket = connect(address(second).port, '127.0.0.1')
    idle.on('error', () => {})
    await once(idle, 'connect')
    const idleClosed = new Promise((resolve) => { idle.once('close', resolve) })
    await contexts[0]?.fiber.dispose()
    await idleClosed
    await expect(get(address(reopened).port, '/handler')).rejects.toThrow()
  })
})
