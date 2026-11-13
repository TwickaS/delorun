/**
 * The device routes on the loopback listener answer only the person at the home's computer: a request needs the
 * studio's own credential, which the service reads from upstream's `connection.requestRejection`, and a state change
 * also needs the studio's own `Origin`. Without the credential a local process — another program of this user, a
 * command a chat runs, another user of the machine — reaches the port and nothing else. A request a reach listener
 * admitted is refused whatever it carries.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { once } from 'node:events'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StudioAddress } from '@delo/contract-admission'
import type { Base64Url } from '@delo/contract-device-approval'
import { stampListener } from '@delo/home'
import { approveHandler, cancelHandler, pendingHandler, REACH_PATHS, windowHandler } from '../src/reach-routes.ts'
import { DEVICE_REMOVE_PATH, DEVICES_PATH, devicesHandler, removeDeviceHandler, type RouteHandler } from '../src/routes.ts'
import { deviceIdOf } from '../src/records.ts'
import { claimOf, homeFixture, keyOf, STUDIO_COOKIE, testCredential, type Home } from './fixtures/home.ts'

const ADDRESS = brandString<StudioAddress>('https://home.example.ts.net')

interface Reply {
  readonly status: number
  readonly body: Record<string, unknown>
}

let home: Home
let port = 0
let close: () => Promise<void> = () => Promise.resolve()

beforeEach(async () => {
  home = await homeFixture()
  home.auth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
  const routes: Record<string, RouteHandler> = {
    [DEVICES_PATH]: devicesHandler(home.auth, testCredential),
    [DEVICE_REMOVE_PATH]: removeDeviceHandler(home.auth, testCredential),
    [REACH_PATHS.window]: windowHandler(home.auth, testCredential),
    [REACH_PATHS.pending]: pendingHandler(home.auth, testCredential),
    [REACH_PATHS.approve]: approveHandler(home.auth, testCredential),
    [REACH_PATHS.cancel]: cancelHandler(home.auth, testCredential),
  }
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://server.invalid')
    if (url.searchParams.has('reach')) stampListener(request, 'reach-tailscale-private')
    void routes[url.pathname]?.(request, response)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  port = (server.address() as AddressInfo).port
  home.loopback.port = port
  close = () => new Promise((resolve) => { server.close(() => { resolve() }) })
  const issued = await home.auth.issueOwnerCode()
  await home.auth.claim(claimOf(issued.code, { address: ADDRESS }))
})

afterEach(async () => {
  await close()
  await home.dispose()
})

function send(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body)
    const request = httpRequest({
      host: '127.0.0.1', port, method, path, setHost: false, agent: false,
      headers: { host: `127.0.0.1:${String(port)}`, ...headers, ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }) },
    }, (response) => {
      let received = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { received += chunk })
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, body: JSON.parse(received) as Record<string, unknown> }) })
    })
    request.on('error', reject)
    request.end(text)
  })
}

const OWN = (): string => `http://127.0.0.1:${String(port)}`

/** Every device route, with the request each sends. */
function routeCalls(deviceId: string): readonly { readonly name: string; readonly method: string; readonly path: string; readonly body?: unknown }[] {
  return [
    { name: 'list', method: 'GET', path: DEVICES_PATH },
    { name: 'remove', method: 'POST', path: DEVICE_REMOVE_PATH, body: { v: 1, deviceId } },
    { name: 'window', method: 'POST', path: REACH_PATHS.window },
    { name: 'pending', method: 'GET', path: REACH_PATHS.pending },
    { name: 'approve', method: 'POST', path: REACH_PATHS.approve, body: { requestId: 'A'.repeat(22), typedCode: '12345678' } },
    { name: 'cancel', method: 'POST', path: REACH_PATHS.cancel, body: { requestId: 'A'.repeat(22) } },
  ]
}

/** Open the window, have a phone ask, and return its request id. */
async function pendingRequest(): Promise<string> {
  await home.auth.openApprovalWindow()
  const accepted = await home.auth.requestApproval({
    devicePublicKey: keyOf(7), deviceId: deviceIdOf(keyOf(7)), deviceNonce: brandString<Base64Url>(Buffer.alloc(16, 7).toString('base64url')), label: 'Phone', platform: 'iOS',
  }, { listener: 'reach-tailscale-private', source: '127.0.0.1' })
  return accepted.requestId
}

describe('the loopback device routes', () => {
  it('refuse every request without the studio\'s credential, and change nothing', async () => {
    const claimed = (await home.auth.devices()).devices[0]?.id ?? ''
    for (const call of routeCalls(claimed)) {
      const reply = await send(call.method, call.path, { origin: OWN() }, call.body)
      // Pins the credential check: without it a local process lists, removes, opens the window and approves.
      expect({ route: call.name, status: reply.status, error: reply.body.error }).toEqual({ route: call.name, status: 401, error: 'NOT_SIGNED_IN' })
    }
    for (const call of routeCalls(claimed)) {
      const reply = await send(call.method, call.path, { origin: OWN(), cookie: 'studio=foreign' }, call.body)
      expect({ route: call.name, status: reply.status, error: reply.body.error }).toEqual({ route: call.name, status: 403, error: 'ORIGIN_MISMATCH' })
    }
    // A removal route asked with another method is refused for the credential before the method.
    expect((await send('GET', DEVICE_REMOVE_PATH, {})).body.error).toBe('NOT_SIGNED_IN')
    expect((await send('GET', DEVICE_REMOVE_PATH, { cookie: STUDIO_COOKIE })).body.error).toBe('METHOD_NOT_ALLOWED')
    expect(home.auth.approvals.windowOpenUntil()).toBeUndefined()
    await expect(home.auth.devices()).resolves.toMatchObject({ devices: [{ id: claimed }] })
  })

  it('refuse a state change whose Origin is absent or another origin, even with the credential', async () => {
    const claimed = (await home.auth.devices()).devices[0]?.id ?? ''
    for (const call of routeCalls(claimed).filter(entry => entry.method === 'POST')) {
      // Pins the required Origin: a program holding the credential still names no studio page.
      const absent = await send(call.method, call.path, { cookie: STUDIO_COOKIE }, call.body)
      expect({ route: call.name, status: absent.status, error: absent.body.error }).toEqual({ route: call.name, status: 403, error: 'ORIGIN_MISMATCH' })
      const neighbour = await send(call.method, call.path, { cookie: STUDIO_COOKIE, origin: `http://127.0.0.1:${String(port + 1)}` }, call.body)
      expect({ route: call.name, status: neighbour.status, error: neighbour.body.error }).toEqual({ route: call.name, status: 403, error: 'ORIGIN_MISMATCH' })
    }
    expect(home.auth.approvals.windowOpenUntil()).toBeUndefined()
    await expect(home.auth.devices()).resolves.toMatchObject({ devices: [{ id: claimed }] })
    // The studio's own request, with its credential and Origin, is answered: the refusals above are the gate's.
    const opened = await send('POST', REACH_PATHS.window, { cookie: STUDIO_COOKIE, origin: OWN() })
    expect(opened.status).toBe(200)
  })

  it('refuse a request a reach listener admitted, whatever it carries', async () => {
    const claimed = (await home.auth.devices()).devices[0]?.id ?? ''
    for (const call of routeCalls(claimed)) {
      // Pins the arrival check, which comes before the credential: a phone's session is never the studio's credential.
      const reply = await send(call.method, `${call.path}?reach`, { cookie: STUDIO_COOKIE, origin: OWN() }, call.body)
      expect({ route: call.name, status: reply.status, error: reply.body.error }).toEqual({ route: call.name, status: 403, error: 'LOOPBACK_REQUIRED' })
    }
    expect(home.auth.approvals.windowOpenUntil()).toBeUndefined()
  })

  it('never return the match code to the computer, so only the device that asked can show it', async () => {
    const requestId = await pendingRequest()
    const pending = await send('GET', REACH_PATHS.pending, { cookie: STUDIO_COOKIE })
    expect(pending.status).toBe(200)
    const entry = (pending.body.pending as Record<string, unknown>[])[0]
    // Pins what the approval form reads: the request's label, platform, times, window-less mark, wrong-code count and Tailscale identity hint, and nothing a code derives from.
    expect(Object.keys(entry ?? {}).sort()).toEqual(['address', 'createdAt', 'expiresAt', 'identity', 'label', 'platform', 'requestId', 'windowless', 'wrongCodes'])
    expect(JSON.stringify(pending.body)).not.toMatch(/\b\d{8}\b|\b\d{4} \d{4}\b|homeNonce|deviceNonce|homePublicKey/)
    const wrong = await send('POST', REACH_PATHS.approve, { cookie: STUDIO_COOKIE, origin: OWN() }, { requestId, typedCode: '00000000' })
    expect(wrong.body.error).toBe('APPROVAL_CODE_MISMATCH')
    expect(JSON.stringify(wrong.body)).not.toMatch(/\b\d{8}\b/)
    expect((await home.auth.devices()).devices.map(device => device.id)).not.toContain(deviceIdOf(keyOf(7)))
  })

  it('cancel a pending request only for the studio, and refuse a malformed one', async () => {
    const requestId = await pendingRequest()
    // Pins the gate on the cancellation: a local program without the credential cannot empty the pending list.
    expect((await send('POST', REACH_PATHS.cancel, { origin: OWN() }, { requestId })).body.error).toBe('NOT_SIGNED_IN')
    expect(home.auth.pendingApprovals().map(entry => entry.requestId)).toEqual([requestId])
    expect((await send('POST', REACH_PATHS.cancel, { cookie: STUDIO_COOKIE, origin: OWN() }, {})).body.error).toBe('BAD_REQUEST')
    const notJson = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: REACH_PATHS.cancel, setHost: false, agent: false,
        headers: { host: `127.0.0.1:${String(port)}`, cookie: STUDIO_COOKIE, origin: OWN(), 'content-type': 'application/json' } }, (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
      request.on('error', reject)
      request.end('not json')
    })
    expect(notJson).toBe(400)
    expect((await send('GET', REACH_PATHS.cancel, { cookie: STUDIO_COOKIE })).body.error).toBe('METHOD_NOT_ALLOWED')
    const cancelled = await send('POST', REACH_PATHS.cancel, { cookie: STUDIO_COOKIE, origin: OWN() }, { requestId })
    expect(cancelled).toEqual({ status: 200, body: { cancelled: requestId } })
    expect(home.auth.pendingApprovals()).toEqual([])
    expect((await send('POST', REACH_PATHS.cancel, { cookie: STUDIO_COOKIE, origin: OWN() }, { requestId })).body.error).toBe('APPROVAL_EXPIRED')
  })
})
