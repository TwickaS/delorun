/**
 * The refusals of the claim and device routes that the happy-path specs do not reach: a claim whose fields are not
 * strings, an unexpected failure that is answered with a bare 500, the device list and removal answered to the wrong
 * method, a removal with a body or an owner it cannot act on, and the body reader and response writers called on their
 * own with a string chunk, an oversized body, a failing stream and a thrown value that is no refusal.
 *
 * Each test's comment names the check whose removal makes that test fail, so the suite is also the mutation record.
 */
import { once } from 'node:events'
import { IncomingMessage, ServerResponse, createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Socket } from 'node:net'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { HomeAuthError } from '../src/errors.ts'
import {
  claimHandler, DEVICE_REMOVE_PATH, DEVICES_PATH, devicesHandler, MAX_BODY_BYTES, OWNER_CLAIM_PATH, readMessage,
  removeDeviceHandler, sendError, sendJson, sendThrown,
} from '../src/routes.ts'
import { claimOf, homeFixture, keyOf, STUDIO_COOKIE, testCredential, type Home } from './fixtures/home.ts'

/** A running test server. */
interface Server {
  /** Its port on `127.0.0.1`. */
  readonly port: number
  /** Stop it. */
  readonly close: () => Promise<void>
}

/** One reply from the client helper. */
interface Reply {
  readonly status: number
  readonly body: string
}

/**
 * Serve the three routes on a loopback port, which the fixture names as its loopback listener's.
 * @param home - the fixture whose home-auth instance the routes answer from.
 * @returns the running server.
 */
async function serve(home: Home): Promise<Server> {
  const handlers = {
    [OWNER_CLAIM_PATH]: claimHandler(home.auth),
    [DEVICES_PATH]: devicesHandler(home.auth, testCredential),
    [DEVICE_REMOVE_PATH]: removeDeviceHandler(home.auth, testCredential),
  }
  const server = createServer((request, response) => {
    const handler = handlers[(request.url ?? '') as keyof typeof handlers] as typeof handlers[typeof OWNER_CLAIM_PATH] | undefined
    if (handler === undefined) {
      response.statusCode = 404
      response.end()
      return
    }
    void handler(request, response)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  home.loopback.port = port
  return { port, close: () => new Promise((resolve) => { server.close(() => { resolve() }) }) }
}

/**
 * Send one request to the test server and read the whole reply.
 * @param port - the server's port.
 * @param method - the request method.
 * @param path - the request target.
 * @param body - the body text, when the request carries one.
 * @returns the status and the body.
 */
async function send(port: number, method: string, path: string, body?: string): Promise<Reply> {
  const request = httpRequest({ host: '127.0.0.1', port, method, path, agent: false, headers: { connection: 'close', cookie: STUDIO_COOKIE, origin: `http://127.0.0.1:${String(port)}` } })
  const replied = once(request, 'response')
  request.end(body)
  const [response] = await replied as [IncomingMessage]
  let text = ''
  response.setEncoding('utf8')
  for await (const chunk of response) text += String(chunk)
  return { status: response.statusCode ?? 0, body: text }
}

/**
 * Send one POST with the headers given instead of the studio's own origin.
 * @param port - the server's port.
 * @param path - the request target.
 * @param body - the body text.
 * @param headers - the request headers besides the cookie.
 * @returns the status and the body.
 */
async function rawPost(port: number, path: string, body: string, headers: Readonly<Record<string, string>>): Promise<Reply> {
  const request = httpRequest({ host: '127.0.0.1', port, method: 'POST', path, agent: false, headers: { connection: 'close', cookie: STUDIO_COOKIE, ...headers } })
  const replied = once(request, 'response')
  request.end(body)
  const [response] = await replied as [IncomingMessage]
  let text = ''
  response.setEncoding('utf8')
  for await (const chunk of response) text += String(chunk)
  return { status: response.statusCode ?? 0, body: text }
}

/**
 * A response that records what it was answered with, without a socket.
 * @returns the response and a reader of what it sent.
 */
function responseDouble(): { readonly response: ServerResponse; readonly sent: () => { status: number; type: unknown; body: string } } {
  const response = new ServerResponse(new IncomingMessage(new Socket()))
  let body = ''
  vi.spyOn(response, 'end').mockImplementation((chunk?: unknown) => {
    body = typeof chunk === 'string' ? chunk : ''
    return response
  })
  return { response, sent: () => ({ status: response.statusCode, type: response.getHeader('content-type'), body }) }
}

/**
 * A request whose body is the given chunks.
 * @param chunks - what the stream yields.
 * @returns the request.
 */
function requestOf(chunks: readonly (string | Uint8Array)[]): IncomingMessage {
  return Readable.from(chunks) as IncomingMessage
}

describe('the claim route', () => {
  it.each([
    ['an owner code that is no string', { ownerCode: 7, label: 'This computer' }],
    ['a label that is no string', { ownerCode: 'ABCD', label: 7 }],
  ])('refuses a claim with %s', async (_name, fields) => {
    const home = await homeFixture()
    const server = await serve(home)
    try {
      const reply = await send(server.port, 'POST', OWNER_CLAIM_PATH, JSON.stringify({ v: 1, devicePublicKey: keyOf(1), ...fields }))
      // Pins the field type check: a claim with a non-string code or label must not reach the owner code comparison.
      expect(reply.status).toBe(400)
      expect(JSON.parse(reply.body)).toMatchObject({ error: 'BAD_REQUEST', message: 'a claim carries the owner code and the device label' })
      await expect(home.auth.owner()).resolves.toBeUndefined()
    } finally {
      await server.close()
      await home.dispose()
    }
  })

  it.each([
    ['an Origin that is another site', { origin: 'http://evil.example' }],
    ['a cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
  ])('refuses a claim from %s before the claim limiter runs', async (_name, headers) => {
    const home = await homeFixture()
    const server = await serve(home)
    try {
      const claim = vi.spyOn(home.auth, 'claim')
      const issued = await home.auth.issueOwnerCode()
      const message = claimOf(issued.code)
      const reply = await rawPost(server.port, OWNER_CLAIM_PATH, JSON.stringify({
        v: 1, ownerCode: message.ownerCode, devicePublicKey: message.devicePublicKey, label: message.label,
      }), headers)
      // Pins cameFromOwnOrigin in the claim route: without it the request reaches claim(), which draws on the shared limit.
      expect(reply.status).toBe(403)
      expect(JSON.parse(reply.body)).toMatchObject({ error: 'ORIGIN_MISMATCH' })
      expect(claim).not.toHaveBeenCalled()
      await expect(home.auth.owner()).resolves.toBeUndefined()
      // The honest caller, from the studio's own origin, still claims.
      const own = await send(server.port, 'POST', OWNER_CLAIM_PATH, JSON.stringify({
        v: 1, ownerCode: message.ownerCode, devicePublicKey: message.devicePublicKey, label: message.label,
      }))
      expect(own.status).toBe(201)
    } finally {
      vi.restoreAllMocks()
      await server.close()
      await home.dispose()
    }
  })

  it('answers an unexpected failure with a bare 500 that carries no message', async () => {
    const home = await homeFixture()
    const server = await serve(home)
    try {
      vi.spyOn(home.auth, 'claim').mockRejectedValue(new Error('disk path /secret/leak'))
      const issued = await home.auth.issueOwnerCode()
      const message = claimOf(issued.code)
      const reply = await send(server.port, 'POST', OWNER_CLAIM_PATH, JSON.stringify({
        v: 1, ownerCode: message.ownerCode, devicePublicKey: message.devicePublicKey, label: message.label,
      }))
      // Pins the catch: an error that is no refusal must not carry its message to the client.
      expect(reply.status).toBe(500)
      expect(reply.body).toBe('{"error":"INTERNAL_ERROR"}')
    } finally {
      vi.restoreAllMocks()
      await server.close()
      await home.dispose()
    }
  })
})

describe('the device list route', () => {
  it('answers a POST with 405', async () => {
    const home = await homeFixture()
    const server = await serve(home)
    try {
      const reply = await send(server.port, 'POST', DEVICES_PATH, '{}')
      // Pins the method check: the list answers a GET only.
      expect(reply.status).toBe(405)
      expect(JSON.parse(reply.body)).toMatchObject({ error: 'METHOD_NOT_ALLOWED' })
    } finally {
      await server.close()
      await home.dispose()
    }
  })
})

describe('the removal route', () => {
  it('answers a GET with 405', async () => {
    const home = await homeFixture()
    const server = await serve(home)
    try {
      const reply = await send(server.port, 'GET', DEVICE_REMOVE_PATH)
      // Pins the method check: a removal is a POST, so a link or a prefetch cannot remove a device.
      expect(reply.status).toBe(405)
      expect(JSON.parse(reply.body)).toMatchObject({ error: 'METHOD_NOT_ALLOWED' })
    } finally {
      await server.close()
      await home.dispose()
    }
  })

  it('refuses a body that is not JSON', async () => {
    const home = await homeFixture()
    const server = await serve(home)
    try {
      const reply = await send(server.port, 'POST', DEVICE_REMOVE_PATH, '{not json')
      // Pins the body check: a removal without a readable message must not reach the owner.
      expect(reply.status).toBe(400)
      expect(JSON.parse(reply.body)).toMatchObject({ error: 'BAD_REQUEST', message: 'a message is a JSON object' })
    } finally {
      await server.close()
      await home.dispose()
    }
  })

  it('refuses a removal on a home nobody has claimed', async () => {
    const home = await homeFixture()
    const server = await serve(home)
    try {
      const reply = await send(server.port, 'POST', DEVICE_REMOVE_PATH, JSON.stringify({ v: 1, deviceId: 'device-1' }))
      // Pins the thrown refusal's answer: an unclaimed home refuses with its own code instead of removing nothing quietly.
      expect(reply.status).toBe(403)
      expect(JSON.parse(reply.body)).toMatchObject({ error: 'NO_OWNER' })
    } finally {
      await server.close()
      await home.dispose()
    }
  })
})

describe('reading a message body', () => {
  it('reads a body that arrives as a string chunk', async () => {
    const { response } = responseDouble()
    // Pins the string branch: a chunk that is a string is counted and joined as UTF-8 bytes.
    await expect(readMessage(requestOf(['{"v":1,', '"label":"x"}']), response)).resolves.toEqual({ v: 1, label: 'x' })
  })

  it('refuses a body over the limit and destroys the request', async () => {
    const { response, sent } = responseDouble()
    const request = requestOf([Buffer.alloc(MAX_BODY_BYTES), Buffer.alloc(1)])
    const destroy = vi.spyOn(request, 'destroy')
    // Pins the size bound: without it a client holds a request open to fill memory.
    await expect(readMessage(request, response)).resolves.toBeUndefined()
    expect(sent()).toMatchObject({ status: 400 })
    expect(JSON.parse(sent().body)).toMatchObject({ error: 'BAD_REQUEST', message: `a message is at most ${String(MAX_BODY_BYTES)} bytes` })
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('refuses a body whose stream fails while it is read', async () => {
    const { response, sent } = responseDouble()
    const request = new Readable({ read() { this.destroy(new Error('connection reset')) } }) as IncomingMessage
    // Pins the read failure answer: a dropped connection is a refusal rather than an unhandled rejection.
    await expect(readMessage(request, response)).resolves.toBeUndefined()
    expect(sent().status).toBe(400)
    expect(JSON.parse(sent().body)).toMatchObject({ message: 'the request body could not be read' })
  })

  it('refuses JSON that is no object', async () => {
    const { response, sent } = responseDouble()
    // Pins the object check: an array or a number is not a message.
    await expect(readMessage(requestOf(['[1]']), response)).resolves.toBeUndefined()
    expect(sent().status).toBe(400)
  })
})

describe('the response writers', () => {
  it('answers a thrown value that is no refusal with a bare 500', () => {
    const { response, sent } = responseDouble()
    sendThrown(response, new Error('database path /secret'))
    // Pins the bare answer: an unexpected failure's message never reaches a client.
    expect(sent()).toEqual({ status: 500, type: 'application/json; charset=utf-8', body: '{"error":"INTERNAL_ERROR"}' })
  })

  it('answers a thrown refusal with its own status and code', () => {
    const { response, sent } = responseDouble()
    sendThrown(response, new HomeAuthError('NO_OWNER', 'no owner'))
    expect(sent().status).toBe(403)
    expect(JSON.parse(sent().body)).toEqual({ error: 'NO_OWNER', message: 'no owner' })
  })

  it('answers a refusal and a value as JSON', () => {
    const refusal = responseDouble()
    sendError(refusal.response, new HomeAuthError('BAD_REQUEST', 'bad'))
    expect(refusal.sent()).toMatchObject({ status: 400, type: 'application/json; charset=utf-8' })
    const value = responseDouble()
    sendJson(value.response, 201, { ok: true })
    expect(value.sent()).toEqual({ status: 201, type: 'application/json; charset=utf-8', body: '{"ok":true}' })
  })
})
