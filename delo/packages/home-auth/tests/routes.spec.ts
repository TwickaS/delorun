/**
 * The routes the owner's claim and the device list answer on, over a real HTTP server on a loopback port: the claim
 * that arrives on a reach listener is refused before its body is read, an unclaimed home refuses the device list with
 * `NO_OWNER`, and a removal is the end of a device's sessions.
 *
 * The test server plays the part of both listeners: a request under `?reach` is stamped with a reach listener, as a
 * reach dispatcher stamps the requests it forwards, and every other request arrives unstamped, as the loopback
 * listener's do.
 *
 * Each test's comment names the check whose removal makes that test fail, so the suite is also the mutation record.
 */
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect } from 'node:net'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ListenerId, StudioAddress } from '@delo/contract-admission'
import { REQUEST_LISTENER } from '../src/arrival.ts'
import type { HomeAuth } from '../src/home-auth.ts'
import { deviceIdOf } from '../src/records.ts'
import {
  claimHandler, DEVICE_REMOVE_PATH, DEVICES_PATH, devicesHandler, OWNER_CLAIM_PATH, reachClaimRefusal, removeDeviceHandler,
} from '../src/routes.ts'
import { homeFixture, keyOf } from './fixtures/home.ts'

const ADDRESS = brandString<StudioAddress>('http://127.0.0.1:3080')
const HOUR = 60 * 60 * 1000

/** A running test server. */
interface Server {
  /** Its port on `127.0.0.1`. */
  readonly port: number
  /** Stop it. */
  readonly close: () => Promise<void>
}

/**
 * Serve the three routes, stamping a request under `?reach` with a reach listener as a dispatcher would.
 * @param auth - the home-auth instance the routes answer from.
 * @returns the running server.
 */
async function serve(auth: HomeAuth): Promise<Server> {
  const handlers: Record<string, (request: IncomingMessage, response: ServerResponse) => Promise<void>> = {
    [OWNER_CLAIM_PATH]: claimHandler(auth),
    [DEVICES_PATH]: devicesHandler(auth),
    [DEVICE_REMOVE_PATH]: removeDeviceHandler(auth),
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://server.invalid')
    const handler = handlers[url.pathname]
    if (handler === undefined) {
      response.statusCode = 404
      response.end()
      return
    }
    if (url.searchParams.has('reach')) {
      Object.defineProperty(request, REQUEST_LISTENER, { value: 'reach-tailscale-private' as ListenerId })
    }
    void handler(request, response)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return { port, close: () => new Promise((resolve) => { server.close(() => { resolve() }) }) }
}

/** One reply from the raw-socket helper. */
interface Reply {
  readonly status: number
  readonly body: string
}

/**
 * Send one request on a socket and read the reply, which lets a spec set `Host` and leave the body unfinished.
 * @param port - the server's port.
 * @param head - the request line and headers, each without its carriage return.
 * @param body - what to write after the headers, which may be shorter than `Content-Length` claims.
 * @returns the status and the body read.
 */
async function raw(port: number, head: readonly string[], body = ''): Promise<Reply> {
  const socket = connect(port, '127.0.0.1')
  socket.on('error', () => {})
  await once(socket, 'connect')
  let received = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => { received += chunk })
  socket.write(`${head.join('\r\n')}\r\n\r\n${body}`)
  await Promise.race([
    new Promise((resolve) => { socket.once('close', resolve) }),
    new Promise((resolve) => { socket.once('data', resolve) }),
  ])
  socket.destroy()
  for (let attempt = 0; attempt < 200 && !received.includes('\r\n\r\n'); attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  }
  const split = received.indexOf('\r\n\r\n')
  const head_ = split === -1 ? received : received.slice(0, split)
  const rest = split === -1 ? '' : received.slice(split + 4)
  return { status: Number(head_.split('\r\n')[0]?.split(' ')[1] ?? 0), body: rest }
}

/**
 * Post a JSON message over the socket helper.
 * @param port - the server's port.
 * @param path - the request target, query included.
 * @param message - the body.
 * @param host - the `Host` header.
 * @returns the reply.
 */
function postJson(port: number, path: string, message: unknown, host = `127.0.0.1:${String(port)}`): Promise<Reply> {
  const body = JSON.stringify(message)
  return raw(port, [
    `POST ${path} HTTP/1.1`,
    `Host: ${host}`,
    'Content-Type: application/json',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    'Connection: close',
  ], body)
}

/**
 * Read a JSON reply body.
 * @param reply - the reply.
 * @returns the parsed body.
 */
function json(reply: Reply): Record<string, unknown> {
  return JSON.parse(reply.body) as Record<string, unknown>
}

describe('the claim route', () => {
  it('claims the home from an unstamped loopback request', async () => {
    const home = await homeFixture()
    const server = await serve(home.auth)
    try {
      const issued = await home.auth.issueOwnerCode()
      const reply = await postJson(server.port, OWNER_CLAIM_PATH, {
        v: 1, ownerCode: issued.code.toLowerCase(), devicePublicKey: keyOf(1), label: 'This computer',
      })
      expect(reply.status).toBe(201)
      expect(json(reply)).toMatchObject({ owner: { firstDeviceId: deviceIdOf(keyOf(1)) }, device: { label: 'This computer' } })
      await expect(home.auth.owner()).resolves.toMatchObject({ firstDeviceId: deviceIdOf(keyOf(1)) })
    } finally {
      await server.close()
      await home.dispose()
    }
  })

  it('refuses a claim a reach listener forwards, with the contract code, and claims nothing', async () => {
    const home = await homeFixture()
    const server = await serve(home.auth)
    try {
      const issued = await home.auth.issueOwnerCode()
      const reply = await postJson(server.port, `${OWNER_CLAIM_PATH}?reach`, {
        v: 1, ownerCode: issued.code, devicePublicKey: keyOf(1), label: 'This computer',
      })
      // Pins the route's arrival check: without it the core's check is reached only after the body is read, and a
      // dispatcher that failed to refuse the claim itself would read a reach request's body here.
      expect(reply.status).toBe(403)
      expect(json(reply)).toMatchObject({ error: 'OWNER_CLAIM_LOOPBACK_ONLY' })
      await expect(home.auth.owner()).resolves.toBeUndefined()
      // Pins "a reach claim spends nothing": the code the person printed is still outstanding.
      await expect(home.auth.ownerCodeOutstanding()).resolves.toBe(true)
    } finally {
      await server.close()
      await home.dispose()
    }
  })

  it('refuses a claim whose Host names a reach address', async () => {
    const home = await homeFixture()
    const server = await serve(home.auth)
    try {
      const issued = await home.auth.issueOwnerCode()
      const reply = await postJson(server.port, OWNER_CLAIM_PATH, {
        v: 1, ownerCode: issued.code, devicePublicKey: keyOf(1), label: 'This computer',
      }, 'home.example.ts.net')
      // Pins the Host half of the arrival check: an unstamped request is loopback only if its Host says so.
      expect(reply.status).toBe(403)
      expect(json(reply)).toMatchObject({ error: 'OWNER_CLAIM_LOOPBACK_ONLY' })
      await expect(home.auth.owner()).resolves.toBeUndefined()
    } finally {
      await server.close()
      await home.dispose()
    }
  })

  it('answers the refusal before the body has arrived', async () => {
    const home = await homeFixture()
    const server = await serve(home.auth)
    try {
      // A body of 4096 bytes that is never finished: a route that read it first would hold the response until the
      // socket closed, and this test would time out with no reply.
      const reply = await raw(server.port, [
        `POST ${OWNER_CLAIM_PATH}?reach HTTP/1.1`,
        `Host: 127.0.0.1:${String(server.port)}`,
        'Content-Type: application/json',
        'Content-Length: 4096',
      ], '{"v":1,"ownerCode":"')
      // Pins "without reading the body", which C5 requires of the reach refusal.
      expect(reply.status).toBe(403)
      expect(json(reply)).toMatchObject({ error: 'OWNER_CLAIM_LOOPBACK_ONLY' })
    } finally {
      await server.close()
      await home.dispose()
    }
  })

  it('refuses a message of another version, a malformed body and a wrong method', async () => {
    const home = await homeFixture()
    const server = await serve(home.auth)
    try {
      const issued = await home.auth.issueOwnerCode()
      const version = await postJson(server.port, OWNER_CLAIM_PATH, {
        v: 2, ownerCode: issued.code, devicePublicKey: keyOf(1), label: 'This computer',
      })
      expect(version.status).toBe(400)
      expect(json(version)).toMatchObject({ error: 'BAD_REQUEST' })
      const malformed = await raw(server.port, [
        `POST ${OWNER_CLAIM_PATH} HTTP/1.1`,
        `Host: 127.0.0.1:${String(server.port)}`,
        'Content-Length: 9',
        'Connection: close',
      ], 'not json!')
      expect(malformed.status).toBe(400)
      const wrongMethod = await raw(server.port, [`GET ${OWNER_CLAIM_PATH} HTTP/1.1`, `Host: 127.0.0.1:${String(server.port)}`, 'Connection: close'])
      // Pins the method check: without it a GET on the claim route reads an empty body and answers BAD_REQUEST.
      expect(wrongMethod.status).toBe(405)
      expect(json(wrongMethod)).toMatchObject({ error: 'METHOD_NOT_ALLOWED' })
    } finally {
      await server.close()
      await home.dispose()
    }
  })
})

describe('the device routes', () => {
  it('refuses the device list on an unclaimed home with NO_OWNER', async () => {
    const home = await homeFixture()
    const server = await serve(home.auth)
    try {
      const reply = await raw(server.port, [`GET ${DEVICES_PATH} HTTP/1.1`, `Host: 127.0.0.1:${String(server.port)}`, 'Connection: close'])
      // Pins "refuses rather than failing open": a route that answered the store's empty list would send 200 here.
      expect(reply.status).toBe(403)
      expect(json(reply)).toMatchObject({ error: 'NO_OWNER' })
      expect(reply.body).not.toContain('devices')
    } finally {
      await server.close()
      await home.dispose()
    }
  })

  it('lists the device and ends its sessions when it is removed', async () => {
    const home = await homeFixture()
    const server = await serve(home.auth)
    try {
      const issued = await home.auth.issueOwnerCode()
      await postJson(server.port, OWNER_CLAIM_PATH, { v: 1, ownerCode: issued.code, devicePublicKey: keyOf(1), label: 'This computer' })
      const deviceId = deviceIdOf(keyOf(1))
      const session = await home.auth.openSession({ deviceId, address: ADDRESS, lifetimeMs: HOUR })
      const listing = await raw(server.port, [`GET ${DEVICES_PATH} HTTP/1.1`, `Host: 127.0.0.1:${String(server.port)}`, 'Connection: close'])
      expect(listing.status).toBe(200)
      expect(json(listing)).toMatchObject({ owner: { firstDeviceId: deviceId }, devices: [{ id: deviceId, label: 'This computer' }] })
      const removed = await postJson(server.port, DEVICE_REMOVE_PATH, { v: 1, deviceId })
      expect(removed.status).toBe(200)
      expect(json(removed)).toMatchObject({ removed: true, sessions: 1, connections: 1 })
      // Pins the whole chain of a removal: the route, the record, the sessions and the reach connections.
      await expect(home.auth.sessionOf(session.token)).resolves.toBeUndefined()
      expect(home.closed).toEqual([{ deviceId }])
    } finally {
      await server.close()
      await home.dispose()
    }
  })

  it('refuses a removal without a device id', async () => {
    const home = await homeFixture()
    const server = await serve(home.auth)
    try {
      const issued = await home.auth.issueOwnerCode()
      await postJson(server.port, OWNER_CLAIM_PATH, { v: 1, ownerCode: issued.code, devicePublicKey: keyOf(1), label: 'This computer' })
      const reply = await postJson(server.port, DEVICE_REMOVE_PATH, { v: 1 })
      expect(reply.status).toBe(400)
      expect(json(reply)).toMatchObject({ error: 'BAD_REQUEST' })
      await expect(home.auth.devices()).resolves.toMatchObject({ devices: [{ id: deviceIdOf(keyOf(1)) }] })
    } finally {
      await server.close()
      await home.dispose()
    }
  })
})

describe('the reach refusal', () => {
  it('names the loopback listener and SSH port forwarding', () => {
    const refusal = reachClaimRefusal()
    expect(refusal.status).toBe(403)
    expect(JSON.parse(refusal.body)).toMatchObject({ error: 'OWNER_CLAIM_LOOPBACK_ONLY' })
    expect(refusal.body).toContain('loopback')
    expect(refusal.body).toContain('SSH port forwarding')
  })
})
