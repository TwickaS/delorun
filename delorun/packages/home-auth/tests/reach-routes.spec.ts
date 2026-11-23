/**
 * The routes of reach sign-in and of local approval over a real HTTP server: a request under `?reach` is stamped with
 * the Tailscale private listener, as the provider stamps a request a reach listener admits, and every other request
 * arrives on the socket the fixture names as the loopback listener's.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { generateKeyPairSync, sign } from 'node:crypto'
import { once } from 'node:events'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { REACH_SESSION_COOKIE, type StudioAddress } from '@delorun/contract-admission'
import type { Base64Url, DevicePublicKeyJwk } from '@delorun/contract-device-approval'
import { stampListener } from '@delorun/home'
import { faviconIcon } from '@delorun/brand/icons'
import { matchCode } from '../src/match-code.ts'
import { deviceIdOf } from '../src/records.ts'
import { signInMessage } from '../src/sign-in.ts'
import {
  REACH_PRE_LOGIN_ROUTES, approvalRequestHandler, approveHandler, assetHandler, challengeHandler, landingOf, pathnameOf, pendingHandler, REACH_PATHS, SIGN_IN_ASSETS,
  SIGN_IN_PAGE, sessionHandler, signInLocation, signInPageHandler, windowHandler,
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
    expect(page.body).toBe(SIGN_IN_PAGE)
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
    // The reach listener's gate sets the Content Security Policy; the route adds none that could replace or widen it.
    expect(page.headers['content-security-policy']).toBeUndefined()
    for (const [name, asset] of SIGN_IN_ASSETS) {
      const served = await send('GET', `${REACH_PATHS.assets}/${name}?reach`)
      expect({ status: served.status, type: served.headers['content-type'] }).toEqual({ status: 200, type: asset.type })
      expect(served.headers['content-security-policy']).toBeUndefined()
    }
    expect((await send('GET', `${REACH_PATHS.assets}/sign-in.js?reach`)).status).toBe(404)
    // The page's markup is read by the route, never served as an asset under any name.
    expect((await send('GET', `${REACH_PATHS.assets}/sign-in.html?reach`)).status).toBe(404)
    expect((await send('POST', `${REACH_PATHS.request}/some-id?reach`)).status).toBe(405)
    expect(pathnameOf({})).toBe('/')
  })

  it('serve the sign-in page with a landing on this address only, and send any other `next` to the page without it', async () => {
    const page = (next: string): Promise<Reply> => send('GET', `${REACH_PATHS.signIn}?reach&next=${encodeURIComponent(next)}`)
    expect((await page('/settings/devices?tab=1')).status).toBe(200)
    // Pins the landing rule: an open redirect to another site, or a path the page cannot name exactly, is never served.
    for (const next of ['//evil.example/x', '/\\evil.example', 'https://evil.example/', 'javascript:alert(1)', '/a/../b', '/a%2fb', '/a b', '/auth/devices', '', `/${'a'.repeat(2048)}`]) {
      const reply = await page(next)
      expect({ next, status: reply.status, location: reply.headers.location }).toEqual({ next, status: 303, location: REACH_PATHS.signIn })
    }
    const twice = await send('GET', `${REACH_PATHS.signIn}?reach&next=%2Fa&next=%2Fb`)
    expect({ status: twice.status, location: twice.headers.location }).toEqual({ status: 303, location: REACH_PATHS.signIn })
    expect([signInLocation('/'), signInLocation('/chat?x=1'), signInLocation('//evil.example')])
      .toEqual(['/auth/sign-in', '/auth/sign-in?next=%2Fchat%3Fx%3D1', '/auth/sign-in'])
    expect([landingOf('/chat'), landingOf('/auth'), landingOf('/x\u0000')]).toEqual(['/chat', undefined, undefined])
  })

  it('serve a page that runs no inline code or style and loads only its own two assets', () => {
    // Pins the page to what the reach policy allows without a nonce: no inline script, style element or handler.
    expect(SIGN_IN_PAGE).not.toMatch(/<script(?![^>]*\bsrc=)|<style|\son[a-z]+=|javascript:/i)
    const loaded = [...SIGN_IN_PAGE.matchAll(/\s(?:src|href)="([^"#][^"]*)"/g)].map(match => match[1])
    const names = [...SIGN_IN_ASSETS.keys()]
    const [script, style, light, dark, png, touch] = names.map(name => `${REACH_PATHS.assets}/${name}`)
    expect(loaded).toEqual([light, dark, light, png, touch, style, script, 'https://docs.delorun.com/guide/everyday-use/reach'])
    expect(SIGN_IN_PAGE).not.toContain('{{')
    expect(names).toEqual([expect.stringMatching(/^sign-in-[0-9a-f]{12}\.js$/), expect.stringMatching(/^sign-in-[0-9a-f]{12}\.css$/), expect.stringMatching(/^favicon-light-[0-9a-f]{12}\.svg$/), expect.stringMatching(/^favicon-dark-[0-9a-f]{12}\.svg$/), expect.stringMatching(/^favicon-32-[0-9a-f]{12}\.png$/), expect.stringMatching(/^apple-touch-icon-[0-9a-f]{12}\.png$/)])
  })

  it('carry the studio\'s tab icon on the sign-in page, as assets a device that has not signed in can fetch', () => {
    // Pins the icon links: without them the tab shows no icon on a reach address, where the studio's own files need a session.
    const [, , light, dark, png, touch] = [...SIGN_IN_ASSETS.keys()]
    // iOS Safari draws no SVG tab icon: it takes the PNG favicon and the home-screen icon.
    expect(SIGN_IN_PAGE).toContain(`<link rel="icon" type="image/png" sizes="32x32" href="${REACH_PATHS.assets}/${png}">`)
    expect(SIGN_IN_PAGE).toContain(`<link rel="apple-touch-icon" href="${REACH_PATHS.assets}/${touch}">`)
    expect(SIGN_IN_ASSETS.get(png ?? '')).toMatchObject({ type: 'image/png' })
    expect(SIGN_IN_ASSETS.get(touch ?? '')).toMatchObject({ type: 'image/png' })
    expect(SIGN_IN_PAGE).toContain(`<link rel="icon" type="image/svg+xml" href="${REACH_PATHS.assets}/${light}">`)
    expect(SIGN_IN_PAGE).toContain(`href="${REACH_PATHS.assets}/${dark}" media="(prefers-color-scheme: dark)"`)
    expect(SIGN_IN_ASSETS.get(light ?? '')?.body.toString()).toBe(faviconIcon('light'))
    expect(SIGN_IN_ASSETS.get(dark ?? '')?.body.toString()).toBe(faviconIcon('dark'))
    // Every asset the page links is on the pre-login asset route.
    expect(REACH_PRE_LOGIN_ROUTES).toContainEqual({ method: 'GET', path: '/auth/assets/<asset>' })
  })

  it('name only symbols of its own sprite and link the guide safely', () => {
    // Every internal reference names an icon of the page's own sprite.
    for (const [, id] of SIGN_IN_PAGE.matchAll(/href="#([^"]+)"/g)) expect(SIGN_IN_PAGE).toContain(`<symbol id="${id ?? ''}"`)
    expect(SIGN_IN_PAGE).toContain('<a href="https://docs.delorun.com/guide/everyday-use/reach" target="_blank" rel="noopener noreferrer">')
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
    expect(JSON.parse((await send('GET', `${REACH_PATHS.request}/${requestId}?reach`, undefined, { authorization: `Delorun-Request ${requestSecret}` })).body)).toEqual({ state: 'pending' })
    expect(error(await send('GET', `${REACH_PATHS.request}/${requestId}?reach`))).toBe('APPROVAL_EXPIRED')
    expect(second.status).toBe(201)
    expect(error(await post(REACH_PATHS.challenge, { deviceId: 'short' }))).toBe('BAD_REQUEST')
    expect(error(await post(REACH_PATHS.challenge, { deviceId: 'A'.repeat(43) }))).toBe('DEVICE_NOT_TRUSTED')
    expect(error(await post(REACH_PATHS.challenge, '[]'))).toBe('BAD_REQUEST')
    expect(error(await post(REACH_PATHS.session, { deviceId: 'A'.repeat(43) }))).toBe('BAD_REQUEST')
    expect(error(await post(REACH_PATHS.session, '[]'))).toBe('BAD_REQUEST')
    expect(error(await send('POST', `${REACH_PATHS.session}?reach`, { deviceId: 'A'.repeat(43), challenge: 'c', signature: 's' }, { cookie: 'other=1; __Host-delorun-session=old' }))).toBe('DEVICE_NOT_TRUSTED')
  })

  it('refuse a label or platform carrying a control or bidirectional formatting character', async () => {
    await home.auth.openApprovalWindow()
    const ask = (fields: { label: string; platform?: string }): Promise<Reply> =>
      send('POST', `${REACH_PATHS.request}?reach`, { v: 1, devicePublicKey: keyOf(1), deviceNonce: Buffer.alloc(16).toString('base64url'), ...fields })
    // Pins the label check: without it each label reaches the terminal of `delorun devices approve` and the studio.
    for (const label of ['Ph\u001b[2Jone', 'Phone\u0007', 'Ph\u007fone', 'Ph\u009bone', 'Ph‮enoh', 'Ph⁦one', 'Ph‏one', 'Ph؜one', 'Ph one']) {
      const reply = await ask({ label })
      expect({ label, status: reply.status, error: error(reply) }).toEqual({ label, status: 400, error: 'BAD_REQUEST' })
    }
    // Pins the platform check, which runs on the whole value before it is cut to 64 characters.
    for (const platform of ['iOS\r\nSafari', 'iOS ‮', `${'x'.repeat(64)}\u001b[2J`]) {
      const reply = await ask({ label: 'Phone', platform })
      expect({ platform, status: reply.status, error: error(reply) }).toEqual({ platform, status: 400, error: 'BAD_REQUEST' })
    }
    expect(home.auth.pendingApprovals()).toEqual([])
    // Text in other scripts, emoji with their joiners and surrounding whitespace are not formatting controls.
    expect((await ask({ label: ' Телефон 👩‍💻\t', platform: 'iPhone; עברית' })).status).toBe(201)
    expect(home.auth.pendingApprovals()).toEqual([expect.objectContaining({ label: 'Телефон 👩‍💻', platform: 'iPhone; עברית' })])
  })
})

describe('the routes of the home\'s own computer', () => {
  it('open the window, list pending requests and approve on loopback, from the studio\'s own origin', async () => {
    const origin = { origin: `http://127.0.0.1:${String(port)}` }
    expect(JSON.parse((await send('GET', REACH_PATHS.pending)).body)).toMatchObject({ windowClosesAt: null, pending: [], pairing: { mayAskWithoutWindow: 'own-user', showRequest: 'dialog' } })
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

  it('approve a device on loopback and sign it in on the reach route, rotating the session its cookie names', async () => {
    const origin = { origin: `http://127.0.0.1:${String(port)}` }
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const exported = pair.publicKey.export({ format: 'jwk' })
    const jwk: DevicePublicKeyJwk = { kty: 'EC', crv: 'P-256', x: brandString<Base64Url>(exported.x ?? ''), y: brandString<Base64Url>(exported.y ?? '') }
    const deviceId = deviceIdOf(jwk)
    const deviceNonce = brandString<Base64Url>(Buffer.alloc(16, 5).toString('base64url'))
    expect((await send('POST', REACH_PATHS.window, undefined, origin)).status).toBe(200)
    const requested = await send('POST', `${REACH_PATHS.request}?reach`, { v: 1, devicePublicKey: jwk, deviceNonce, label: 'Phone', platform: 'iOS' })
    const accepted = JSON.parse(requested.body) as { requestId: string; homePublicKey: string; homeNonce: Base64Url }
    const typedCode = matchCode({ homePublicKey: Buffer.from(accepted.homePublicKey, 'base64url'), deviceId, homeNonce: accepted.homeNonce, deviceNonce, address: ADDRESS })
    const approved = await send('POST', REACH_PATHS.approve, { requestId: accepted.requestId, typedCode }, origin)
    expect({ status: approved.status, device: (JSON.parse(approved.body) as { device: unknown }).device }).toEqual({ status: 200, device: { id: deviceId, label: 'Phone', address: ADDRESS } })
    const signIn = async (cookie?: string): Promise<Reply> => {
      const { challenge } = JSON.parse((await send('POST', `${REACH_PATHS.challenge}?reach`, { deviceId })).body) as { challenge: string }
      const signature = sign('sha256', signInMessage(ADDRESS, challenge), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
      return send('POST', `${REACH_PATHS.session}?reach`, { deviceId, challenge, signature }, cookie === undefined ? {} : { cookie })
    }
    expect((await signIn()).status).toBe(201)
    const first = await signIn('theme=dark')
    expect(first.status).toBe(201)
    const tokenOf = (reply: Reply): string => new RegExp(`^${REACH_SESSION_COOKIE}=([^;]+);`).exec(String(reply.headers['set-cookie']))?.[1] ?? ''
    const token = tokenOf(first)
    expect(token).not.toBe('')
    // A sign-in that carries the session cookie rotates that session to a new token.
    const rotated = await signIn(`theme=dark; ${REACH_SESSION_COOKIE}=${token}`)
    expect(rotated.status).toBe(201)
    expect(tokenOf(rotated)).not.toBe(token)
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
