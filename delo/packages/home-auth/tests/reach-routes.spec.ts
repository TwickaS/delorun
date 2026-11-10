/**
 * The routes of reach sign-in and of local approval over a real HTTP server: a request under `?reach` is stamped with
 * the Tailscale private listener, as the provider stamps a request a reach listener admits, and every other request
 * arrives on the socket the fixture names as the loopback listener's.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { once } from 'node:events'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StudioAddress } from '@delo/contract-admission'
import { stampListener } from '../src/arrival.ts'
import {
  approvalRequestHandler, approveHandler, assetHandler, challengeHandler, pathnameOf, pendingHandler, REACH_PATHS, SIGN_IN_ASSETS, sessionHandler,
  signInPageHandler, windowHandler,
} from '../src/reach-routes.ts'
import type { RouteHandler } from '../src/routes.ts'
import { homeFixture, keyOf, STUDIO_COOKIE, testCredential, type Home } from './fixtures/home.ts'

const ADDRESS = brandString<StudioAddress>('https://home.example.ts.net')

interface Reply {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

let home: Home
let port = 0
let close: () => Promise<void> = () => Promise.resolve()

beforeEach(async () => {
  home = await homeFixture()
  home.auth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
  const routes: [string, RouteHandler][] = [
    [REACH_PATHS.signIn, signInPageHandler(home.auth)],
    [REACH_PATHS.assets, assetHandler(home.auth)],
    [REACH_PATHS.request, approvalRequestHandler(home.auth)],
    [REACH_PATHS.challenge, challengeHandler(home.auth)],
    [REACH_PATHS.session, sessionHandler(home.auth)],
    [REACH_PATHS.window, windowHandler(home.auth, testCredential)],
    [REACH_PATHS.pending, pendingHandler(home.auth, testCredential)],
    [REACH_PATHS.approve, approveHandler(home.auth, testCredential)],
  ]
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://server.invalid')
    const route = routes.find(([path]) => url.pathname === path || url.pathname.startsWith(`${path}/`))
    if (url.searchParams.has('reach')) stampListener(request, 'reach-tailscale-private')
    if (route === undefined) {
      response.statusCode = 404
      response.end()
      return
    }
    void route[1](request, response)
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

function send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    const request = httpRequest({
      host: '127.0.0.1', port, method, path, setHost: false, agent: false,
      headers: { host: `127.0.0.1:${String(port)}`, ...(path.includes('reach') ? {} : { cookie: STUDIO_COOKIE, origin: `http://127.0.0.1:${String(port)}` }), ...headers, ...(text === undefined ? {} : { 'content-length': String(Buffer.byteLength(text)) }) },
    }, (response) => {
      let received = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { received += chunk })
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, headers: response.headers, body: received }) })
    })
    request.on('error', reject)
    request.end(text)
  })
}

const error = (reply: Reply): unknown => (JSON.parse(reply.body) as { error?: unknown }).error

describe('the pre-login routes', () => {
  it('answer on a reach listener only, and only with their method', async () => {
    for (const [method, path] of [['GET', REACH_PATHS.signIn], ['GET', `${REACH_PATHS.assets}/x.js`], ['POST', REACH_PATHS.request], ['POST', REACH_PATHS.challenge], ['POST', REACH_PATHS.session]] as const) {
      // Pins the reach arrival: a loopback request reaches none of the sign-in routes.
      const loopback = await send(method, path, method === 'POST' ? {} : undefined)
      expect({ path, status: loopback.status, error: error(loopback) }).toEqual({ path, status: 421, error: 'HOST_MISMATCH' })
      const wrong = await send(method === 'GET' ? 'POST' : 'GET', `${path}?reach`)
      expect({ path, status: wrong.status }).toEqual({ path, status: 405 })
    }
    const page = await send('GET', `${REACH_PATHS.signIn}?reach`)
    expect(page.status).toBe(200)
    expect(page.body).toContain('Add a device')
    expect(page.body).not.toMatch(/<script>|onerror|<style>/)
    for (const name of SIGN_IN_ASSETS.keys()) expect((await send('GET', `${REACH_PATHS.assets}/${name}?reach`)).status).toBe(200)
    expect((await send('GET', `${REACH_PATHS.assets}/sign-in.js?reach`)).status).toBe(404)
    expect((await send('POST', `${REACH_PATHS.request}/some-id?reach`)).status).toBe(405)
    expect(pathnameOf({})).toBe('/')
  })

  it('read and refuse request messages', async () => {
    await home.auth.openApprovalWindow()
    const post = (path: string, body: unknown): Promise<Reply> => send('POST', `${path}?reach`, body)
    expect(error(await post(REACH_PATHS.request, { v: 2 }))).toBe('BAD_REQUEST')
    expect(error(await post(REACH_PATHS.request, { v: 1, devicePublicKey: keyOf(1), deviceNonce: 'short', label: 'P' }))).toBe('BAD_REQUEST')
    expect(error(await post(REACH_PATHS.request, { v: 1, devicePublicKey: keyOf(1), deviceNonce: 7, label: 'P' }))).toBe('BAD_REQUEST')
    expect(error(await post(REACH_PATHS.request, 'not json'))).toBe('BAD_REQUEST')
    const accepted = await post(REACH_PATHS.request, { v: 1, devicePublicKey: keyOf(1), deviceNonce: Buffer.alloc(16).toString('base64url'), label: ' Phone ', platform: 'x'.repeat(100) })
    expect(accepted.status).toBe(201)
    expect(home.auth.pendingApprovals()).toEqual([expect.objectContaining({ label: 'Phone', platform: 'x'.repeat(64) })])
    const second = await post(REACH_PATHS.request, { v: 1, devicePublicKey: keyOf(2), deviceNonce: Buffer.alloc(16).toString('base64url'), label: 'Tablet' })
    expect(home.auth.pendingApprovals()[1]?.platform).toBe('')
    const { requestId, requestSecret } = JSON.parse(accepted.body) as { requestId: string; requestSecret: string }
    expect(JSON.parse((await send('GET', `${REACH_PATHS.request}/${requestId}?reach`, undefined, { authorization: `Delo-Request ${requestSecret}` })).body)).toEqual({ state: 'pending' })
    expect(error(await send('GET', `${REACH_PATHS.request}/${requestId}?reach`))).toBe('APPROVAL_EXPIRED')
    expect(second.status).toBe(201)
    expect(error(await post(REACH_PATHS.challenge, { deviceId: 'short' }))).toBe('BAD_REQUEST')
    expect(error(await post(REACH_PATHS.challenge, { deviceId: 'A'.repeat(43) }))).toBe('DEVICE_NOT_TRUSTED')
    expect(error(await post(REACH_PATHS.challenge, '[]'))).toBe('BAD_REQUEST')
    expect(error(await post(REACH_PATHS.session, { deviceId: 'A'.repeat(43) }))).toBe('BAD_REQUEST')
    expect(error(await post(REACH_PATHS.session, '[]'))).toBe('BAD_REQUEST')
    expect(error(await send('POST', `${REACH_PATHS.session}?reach`, { deviceId: 'A'.repeat(43), challenge: 'c', signature: 's' }, { cookie: 'other=1; __Host-delo-session=old' }))).toBe('DEVICE_NOT_TRUSTED')
  })
})

describe('the routes of the home\'s own computer', () => {
  it('open the window, list pending requests and approve on loopback, from the studio\'s own origin', async () => {
    const origin = { origin: `http://127.0.0.1:${String(port)}` }
    expect(JSON.parse((await send('GET', REACH_PATHS.pending)).body)).toEqual({ windowClosesAt: null, pending: [] })
    expect((await send('POST', REACH_PATHS.window, undefined, origin)).status).toBe(200)
    expect(JSON.parse((await send('GET', REACH_PATHS.pending)).body)).toMatchObject({ windowClosesAt: home.clock.now + 5 * 60 * 1000 })
    // Pins the origin check on a state change: a page on another site cannot open the window.
    expect(error(await send('POST', REACH_PATHS.window, undefined, { origin: 'https://evil.example' }))).toBe('ORIGIN_MISMATCH')
    expect(error(await send('POST', REACH_PATHS.approve, { requestId: 'x', typedCode: '1' }, { origin: 'https://evil.example' }))).toBe('ORIGIN_MISMATCH')
    expect(error(await send('POST', REACH_PATHS.approve, { requestId: 'x' }, origin))).toBe('BAD_REQUEST')
    expect(error(await send('POST', REACH_PATHS.approve, '[]', origin))).toBe('BAD_REQUEST')
    expect(error(await send('POST', REACH_PATHS.approve, { requestId: 'x', typedCode: '12345678' }, origin))).toBe('APPROVAL_EXPIRED')
    expect((await send('GET', REACH_PATHS.window)).status).toBe(405)
    expect((await send('POST', REACH_PATHS.pending)).status).toBe(405)
    expect((await send('GET', REACH_PATHS.approve)).status).toBe(405)
    // A foreign Host on the loopback port is a rebinding name, not the studio.
    expect(error(await send('GET', REACH_PATHS.pending, undefined, { host: 'rebind.example' }))).toBe('HOST_MISMATCH')
  })

  it('a tailnet-route session cannot approve a device or open the window', async () => {
    for (const path of [REACH_PATHS.window, REACH_PATHS.approve]) {
      const reply = await send('POST', `${path}?reach`, { requestId: 'x', typedCode: '12345678' })
      expect({ path, status: reply.status, error: error(reply) }).toEqual({ path, status: 403, error: 'LOOPBACK_REQUIRED' })
    }
    expect(error(await send('GET', `${REACH_PATHS.pending}?reach`))).toBe('LOOPBACK_REQUIRED')
    // Pins the arrival check of the window route: the reach request opened nothing and claimed nothing.
    expect(home.auth.approvals.windowOpenUntil()).toBeUndefined()
    await expect(home.auth.owner()).resolves.toBeUndefined()
  })

  it('answers a window that cannot be opened with the store\'s refusal', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(`${home.directory}/owner.json`, '{"v":2}', { mode: 0o600 })
    const reply = await send('POST', REACH_PATHS.window, undefined, { origin: `http://127.0.0.1:${String(port)}` })
    expect(error(reply)).toBe('STORE_INVALID')
  })
})
