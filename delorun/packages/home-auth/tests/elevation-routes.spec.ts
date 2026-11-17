/**
 * The elevation routes over a real HTTP server: a request under `?reach` is stamped with the Tailscale private listener,
 * as the provider stamps a request a reach listener admits, and every other request arrives on the socket the fixture
 * names as the loopback listener's.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { once } from 'node:events'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { REACH_SESSION_COOKIE, type StudioAddress } from '@delorun/contract-admission'
import { ELEVATION_LIMITS } from '@delorun/contract-oidc-passkeys'
import { stampListener } from '@delorun/home'
import {
  ELEVATION_PATHS,
  elevationApproveHandler,
  elevationLockHandler,
  elevationPendingHandler,
  elevationRequestHandler,
  elevationRevokeHandler,
  elevationStateHandler,
} from '../src/elevation-routes.ts'
import { DEVICE_REMOVE_PATH, DEVICES_PATH, devicesHandler, removeDeviceHandler, type RouteHandler } from '../src/routes.ts'
import { claimOf, homeFixture, recordOf, STUDIO_COOKIE, testCredential, type Home } from './fixtures/home.ts'
import { DeviceStore } from '../src/devices.ts'
import { HOME_AUTH_FILES } from '@delorun/contract-device-approval'

const ADDRESS = brandString<StudioAddress>('https://home.example.ts.net')
const LISTENER = 'reach-tailscale-private'

interface Reply {
  readonly status: number
  readonly body: Record<string, unknown>
}

let home: Home
let port = 0
let token = ''
let close: () => Promise<void> = () => Promise.resolve()

beforeEach(async () => {
  home = await homeFixture()
  home.auth.serve({ listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership' })
  const issued = await home.auth.issueOwnerCode()
  const claimed = await home.auth.claim(claimOf(issued.code, { address: ADDRESS }))
  token = (await home.auth.openSession({ deviceId: claimed.device.id, listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: 60 * 60 * 1000 })).token
  const routes: Readonly<Record<string, RouteHandler>> = {
    [DEVICES_PATH]: devicesHandler(home.auth, testCredential),
    [DEVICE_REMOVE_PATH]: removeDeviceHandler(home.auth, testCredential),
    [ELEVATION_PATHS.state]: elevationStateHandler(home.auth),
    [ELEVATION_PATHS.request]: elevationRequestHandler(home.auth),
    [ELEVATION_PATHS.lock]: elevationLockHandler(home.auth),
    [ELEVATION_PATHS.pending]: elevationPendingHandler(home.auth, testCredential),
    [ELEVATION_PATHS.approve]: elevationApproveHandler(home.auth, testCredential),
    [ELEVATION_PATHS.revoke]: elevationRevokeHandler(home.auth, testCredential),
  }
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://server.invalid')
    if (url.searchParams.has('reach')) stampListener(request, LISTENER)
    const route = routes[url.pathname]
    if (route === undefined) {
      response.statusCode = 404
      response.end()
      return
    }
    void route(request, response)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  port = (server.address() as AddressInfo).port
  home.loopback.port = port
  close = () => new Promise((resolve) => { server.close(() => { resolve() }) })
})

afterEach(async () => {
  await close()
  await home.dispose()
})

/**
 * Send one request: as the device under `?reach` with its session cookie, else as the loopback studio.
 * @param method - the method.
 * @param path - the path, with `?reach` for the device.
 * @param body - the JSON body.
 * @param headers - extra headers, which replace the defaults; an undefined one leaves the header out.
 * @returns the status and the parsed body.
 */
function send(method: string, path: string, body?: unknown, headers: Record<string, string | undefined> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body)
    const host = `127.0.0.1:${String(port)}`
    const defaults = path.includes('reach')
      ? { cookie: `${REACH_SESSION_COOKIE}=${token}` }
      : { cookie: STUDIO_COOKIE, origin: `http://${host}` }
    const request = httpRequest({
      host: '127.0.0.1', port, method, path, setHost: false, agent: false,
      headers: Object.fromEntries(Object.entries({ host, ...defaults, ...headers, ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }) })
        .filter((entry): entry is [string, string] => entry[1] !== undefined)),
    }, (response) => {
      let received = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { received += chunk })
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, body: received === '' ? {} : JSON.parse(received) as Record<string, unknown> }) })
    })
    request.on('error', reject)
    request.end(text)
  })
}

describe('the device list and removal for a signed-in device', () => {
  it('lists the paired devices with the device\'s own id, and shows the unlocks running now', async () => {
    const before = await send('GET', `${DEVICES_PATH}?reach`)
    expect(before).toMatchObject({ status: 200, body: { current: expect.any(String), unlocks: [], devices: [expect.objectContaining({ id: expect.any(String) })] } })
    const asked = await send('POST', `${ELEVATION_PATHS.request}?reach`)
    home.auth.approveElevation(String(asked.body['requestId']), String(asked.body['code']))
    const after = await send('GET', `${DEVICES_PATH}?reach`)
    expect(after.body['unlocks']).toEqual([{ deviceId: before.body['current'], endsAt: expect.any(Number) }])
    // Pins the public listing: no public key travels to the device.
    expect(JSON.stringify(after.body)).not.toContain('publicKey')
  })

  it('lets the device remove itself and refuses the removal of any other device with LOOPBACK_REQUIRED, unlocked or not', async () => {
    const { body: listing } = await send('GET', `${DEVICES_PATH}?reach`)
    const other = await send('POST', `${DEVICE_REMOVE_PATH}?reach`, { v: 1, deviceId: 'someone-else' })
    expect(other).toMatchObject({ status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
    const asked = await send('POST', `${ELEVATION_PATHS.request}?reach`)
    home.auth.approveElevation(String(asked.body['requestId']), String(asked.body['code']))
    // Pins the self check: an unlock does not widen the removal to another device.
    expect(await send('POST', `${DEVICE_REMOVE_PATH}?reach`, { v: 1, deviceId: 'someone-else' })).toMatchObject({ status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
    expect(await send('POST', `${DEVICE_REMOVE_PATH}?reach`, { v: 1, deviceId: listing['current'] })).toMatchObject({ status: 200, body: { removed: true } })
    expect((await send('GET', `${DEVICES_PATH}?reach`)).status).toBe(403)
  })

  it('leaves a real second paired device paired when a signed-in device asks to remove it', async () => {
    const other = recordOf(9, ADDRESS)
    await new DeviceStore({ file: join(home.directory, HOME_AUTH_FILES.devices) }).add(other)
    expect((await home.auth.devices()).devices).toHaveLength(2)
    const asked = await send('POST', `${ELEVATION_PATHS.request}?reach`)
    home.auth.approveElevation(String(asked.body['requestId']), String(asked.body['code']))
    // Pins the self check against a real record: neither the session nor an unlock removes another device.
    expect(await send('POST', `${DEVICE_REMOVE_PATH}?reach`, { v: 1, deviceId: other.id })).toMatchObject({ status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
    expect((await home.auth.devices()).devices.map(device => device.id)).toContain(other.id)
    expect((await home.auth.devices()).devices).toHaveLength(2)
  })

  it('refuses an unsigned request', async () => {
    expect(await send('GET', `${DEVICES_PATH}?reach`, undefined, { cookie: undefined })).toMatchObject({ status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
  })
})

describe('the device routes', () => {
  it('ask for an elevation, show the code, and lock it', async () => {
    expect(await send('GET', `${ELEVATION_PATHS.state}?reach`)).toEqual({ status: 200, body: { kind: 'none', unlockMinutes: 15 } })
    const asked = await send('POST', `${ELEVATION_PATHS.request}?reach`)
    expect(asked).toMatchObject({ status: 201, body: { kind: 'pending', unlockMinutes: 15, code: expect.stringMatching(/^\d{8}$/) } })
    const approved = await send('POST', ELEVATION_PATHS.approve, { requestId: asked.body.requestId, typedCode: asked.body.code })
    expect(approved).toMatchObject({ status: 200, body: { listener: LISTENER } })
    expect(await send('GET', `${ELEVATION_PATHS.state}?reach`)).toMatchObject({ body: { kind: 'elevated', elevationId: approved.body.id } })
    expect(await send('POST', `${ELEVATION_PATHS.lock}?reach`)).toEqual({ status: 200, body: { kind: 'none', unlockMinutes: 15 } })
  })

  it('answer a reach request with a live session only, and a POST from the studio\'s own page only', async () => {
    // Pins the reach arrival: the loopback studio has no device session to elevate.
    expect(await send('GET', ELEVATION_PATHS.state)).toMatchObject({ status: 421, body: { error: 'HOST_MISMATCH' } })
    // Pins the session check: without the cookie, or with a token the home does not know, nothing is asked.
    expect(await send('POST', `${ELEVATION_PATHS.request}?reach`, undefined, { cookie: 'other=1' })).toMatchObject({ status: 401, body: { error: 'NOT_SIGNED_IN' } })
    expect(await send('POST', `${ELEVATION_PATHS.request}?reach`, undefined, { cookie: `${REACH_SESSION_COOKIE}=unknown` })).toMatchObject({ status: 401, body: { error: 'NOT_SIGNED_IN' } })
    // Pins the origin checks: another site's page cannot ask for, or lock, the device's elevation.
    expect(await send('POST', `${ELEVATION_PATHS.request}?reach`, undefined, { 'sec-fetch-site': 'cross-site' })).toMatchObject({ status: 403, body: { error: 'ORIGIN_MISMATCH' } })
    expect(await send('POST', `${ELEVATION_PATHS.lock}?reach`, undefined, { origin: 'https://elsewhere.example' })).toMatchObject({ status: 403, body: { error: 'ORIGIN_MISMATCH' } })
    expect(await send('POST', `${ELEVATION_PATHS.request}?reach`, undefined, { 'sec-fetch-site': 'same-origin', origin: `http://127.0.0.1:${String(port)}` })).toMatchObject({ status: 201 })
    // Pins the methods.
    expect(await send('POST', `${ELEVATION_PATHS.state}?reach`)).toMatchObject({ status: 405 })
    expect(await send('GET', `${ELEVATION_PATHS.lock}?reach`)).toMatchObject({ status: 405 })
    expect(home.auth.elevationsAtComputer().pending).toHaveLength(1)
  })

  it('answer the home\'s request limit as a refusal', async () => {
    const store = new DeviceStore({ file: join(home.directory, 'devices.json') })
    const tokens: string[] = [token]
    for (let fill = 2; fill <= ELEVATION_LIMITS.pendingPerHome + 1; fill += 1) {
      const record = recordOf(fill, ADDRESS)
      await store.add(record)
      tokens.push((await home.auth.openSession({ deviceId: record.id, listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: 60 * 60 * 1000 })).token)
    }
    const statuses: number[] = []
    for (const each of tokens) statuses.push((await send('POST', `${ELEVATION_PATHS.request}?reach`, undefined, { cookie: `${REACH_SESSION_COOKIE}=${each}` })).status)
    // Pins the limit's answer: the sixth device is told the home holds its limit instead of the request failing silently.
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429])
  })
})

describe('the computer routes', () => {
  it('refuse a device: it can neither list, approve nor revoke an unlock', async () => {
    const asked = await send('POST', `${ELEVATION_PATHS.request}?reach`)
    // Pins the computer check: a device approving its own request would make the code a formality.
    expect(await send('GET', `${ELEVATION_PATHS.pending}?reach`)).toMatchObject({ status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
    expect(await send('POST', `${ELEVATION_PATHS.approve}?reach`, { requestId: asked.body.requestId, typedCode: asked.body.code })).toMatchObject({ status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
    expect(await send('POST', `${ELEVATION_PATHS.revoke}?reach`, { id: asked.body.requestId })).toMatchObject({ status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
    expect(home.auth.elevationOf(String(home.auth.elevationsAtComputer().pending[0]?.deviceId), LISTENER)).toBeUndefined()
  })

  it('list, approve with the typed code, and revoke', async () => {
    const asked = await send('POST', `${ELEVATION_PATHS.request}?reach`)
    const listed = await send('GET', ELEVATION_PATHS.pending)
    expect(listed).toMatchObject({ status: 200, body: { pending: [{ requestId: asked.body.requestId }], running: [] } })
    expect(JSON.stringify(listed.body)).not.toContain(String(asked.body.code))
    expect(await send('POST', ELEVATION_PATHS.approve, { requestId: asked.body.requestId, typedCode: '1' })).toMatchObject({ status: 403, body: { error: 'APPROVAL_CODE_MISMATCH' } })
    const approved = await send('POST', ELEVATION_PATHS.approve, { requestId: asked.body.requestId, typedCode: asked.body.code })
    expect(await send('POST', ELEVATION_PATHS.revoke, { id: approved.body.id })).toEqual({ status: 200, body: { revoked: true } })
    expect(await send('POST', ELEVATION_PATHS.revoke, { id: approved.body.id })).toEqual({ status: 200, body: { revoked: false } })
  })

  it('refuse a malformed body and another method', async () => {
    expect(await send('POST', ELEVATION_PATHS.approve, { requestId: 1 })).toMatchObject({ status: 400, body: { error: 'BAD_REQUEST' } })
    expect(await send('POST', ELEVATION_PATHS.revoke, {})).toMatchObject({ status: 400, body: { error: 'BAD_REQUEST' } })
    expect(await send('POST', ELEVATION_PATHS.approve, 'not json')).toMatchObject({ status: 400 })
    expect(await send('POST', ELEVATION_PATHS.revoke, 'not json')).toMatchObject({ status: 400 })
    expect(await send('GET', ELEVATION_PATHS.approve)).toMatchObject({ status: 405 })
    expect(await send('GET', ELEVATION_PATHS.revoke)).toMatchObject({ status: 405 })
    expect(await send('POST', ELEVATION_PATHS.pending)).toMatchObject({ status: 405 })
  })
})
