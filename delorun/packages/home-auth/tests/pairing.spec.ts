/**
 * Pop-up pairing (contract C5, "Pop-up pairing"): who may ask for a device approval outside an approval window, what a
 * forged identity gains, what the pairing configuration bounds and who sees the waiting requests.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { once } from 'node:events'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StudioAddress } from '@delorun/contract-admission'
import { DEVICE_APPROVAL_LIMITS, type ApprovalRequestAccepted, type Base64Url } from '@delorun/contract-device-approval'
import { stampListener } from '@delorun/home'
import { mayAskWithoutWindow, PAIRING_BOUNDS, PAIRING_DEFAULTS, resolvePairing, tailnetIdentityOf, type PairingSpec, type TailnetIdentity } from '../src/pairing.ts'
import { approvalRequestHandler, approveHandler, cancelHandler, pendingHandler, REACH_PATHS } from '../src/reach-routes.ts'
import type { RouteHandler } from '../src/routes.ts'
import { deviceIdOf } from '../src/records.ts'
import { Config } from '../src/service.ts'
import { matchCode } from '../src/match-code.ts'
import { homeFixture, keyOf, STUDIO_COOKIE, testCredential, type Home } from './fixtures/home.ts'

const ADDRESS = brandString<StudioAddress>('https://home.example.ts.net')
const LISTENER = 'reach-tailscale-private'
const COMPUTER = 'me@example.com'
const ME: TailnetIdentity = { login: COMPUTER, name: 'Me' }
const SOMEONE: TailnetIdentity = { login: 'friend@example.com', name: 'Friend' }

let home: Home

/**
 * Build a claimed home that serves the reach listener, with the window closed.
 * @param pairing - the pairing values, Delorun's defaults when absent.
 * @param computerUser - the computer's Tailscale login the listener declares.
 * @param readsTailscaleIdentity - whether the listener sits behind `tailscale serve` and reads the identity headers.
 */
async function start(pairing: PairingSpec = PAIRING_DEFAULTS, computerUser: string | null = COMPUTER, readsTailscaleIdentity = true): Promise<void> {
  home = await homeFixture({ pairing })
  home.auth.serve({ listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership', ...(readsTailscaleIdentity ? { readsTailscaleIdentity } : {}), ...(computerUser === null ? {} : { computerUser }) })
  // A local claim owns the home; the window it opens is closed again, so the requests below arrive without one.
  await home.auth.openApprovalWindow()
  home.auth.approvals.closeWindow()
}

afterEach(async () => {
  // The configuration tests build no home.
  await (home as Home | undefined)?.dispose()
  home = undefined as never
})

/**
 * Send one approval request from the device of a fill.
 * @param fill - the device key's fill.
 * @param identity - the Tailscale user its headers name.
 * @returns the home's answer.
 */
function ask(fill: number, identity?: TailnetIdentity): Promise<ApprovalRequestAccepted> {
  const devicePublicKey = keyOf(fill)
  return home.auth.requestApproval({
    devicePublicKey,
    deviceId: deviceIdOf(devicePublicKey),
    deviceNonce: brandString<Base64Url>(Buffer.alloc(16, fill).toString('base64url')),
    label: `Device ${String(fill)}`,
    platform: '',
  }, { listener: LISTENER, source: '127.0.0.1', identity })
}

describe('the pairing configuration', () => {
  it('resolves to Delorun\'s defaults when the profile sets none', () => {
    // Pins the default values the guide and C5 state.
    expect(resolvePairing(undefined)).toEqual({ mayAskWithoutWindow: 'own-user', showRequest: 'dialog', windowMs: 5 * 60_000, requestExpiryMs: 5 * 60_000, pendingPerIdentity: 1 })
    expect(resolvePairing({})).toEqual(PAIRING_DEFAULTS)
  })

  it('fills the pop-up dialog as the schema\'s default display, and keeps the notice and none choices', () => {
    // Pins the schema default: a profile that sets no pairing section shows a request as the pop-up dialog.
    expect(Config({ secretsDirectory: '/nowhere' }).pairing.get()).toMatchObject({ showRequest: 'dialog', mayAskWithoutWindow: 'own-user' })
    expect(Config({ secretsDirectory: '/nowhere', pairing: {} }).pairing.get()).toMatchObject({ showRequest: 'dialog' })
    for (const showRequest of ['notice', 'dialog', 'none'] as const) {
      expect(Config({ secretsDirectory: '/nowhere', pairing: { showRequest } }).pairing.get()).toMatchObject({ showRequest })
    }
    expect(() => Config({ secretsDirectory: '/nowhere', pairing: { showRequest: 'popup' as never } })).toThrow()
  })

  it('reads every field a profile sets', () => {
    expect(resolvePairing({ mayAskWithoutWindow: 'tailnet', showRequest: 'dialog', windowMinutes: 15, requestExpiryMinutes: 10, pendingPerIdentity: 5 }))
      .toEqual({ mayAskWithoutWindow: 'tailnet', showRequest: 'dialog', windowMs: 15 * 60_000, requestExpiryMs: 10 * 60_000, pendingPerIdentity: 5 })
  })

  it('refuses each numeric field outside its bounds, naming the field and the bounds', () => {
    for (const [field, { min, max }] of Object.entries(PAIRING_BOUNDS)) {
      for (const value of [min - 1, max + 1, 1.5, Number.NaN]) {
        // Pins the bound check: each field's range is enforced at load.
        expect(() => resolvePairing({ [field]: value })).toThrow(`pairing.${field} must be a whole number from ${String(min)} to ${String(max)}`)
      }
      expect(resolvePairing({ [field]: min })).toBeDefined()
      expect(resolvePairing({ [field]: max })).toBeDefined()
    }
  })

  it('refuses a choice that is not one of the allowed values', () => {
    expect(() => resolvePairing({ mayAskWithoutWindow: 'anyone' as never })).toThrow('pairing.mayAskWithoutWindow must be one of own-user, tailnet, window-only')
    expect(() => resolvePairing({ showRequest: 'popup' as never })).toThrow('pairing.showRequest must be one of notice, dialog, none')
  })

  it('applies the window length and the request expiry it resolves', async () => {
    await start(resolvePairing({ windowMinutes: 2, requestExpiryMinutes: 1 }))
    expect(await home.auth.openApprovalWindow()).toBe(home.clock.now + 2 * 60_000)
    const accepted = await ask(1, ME)
    expect(accepted.expiresAt).toBe(home.clock.now + 60_000)
    home.clock.advance(60_000)
    // Pins the configured expiry: the request is no longer pending a minute on.
    expect(home.auth.pendingApprovals()).toEqual([])
  })
})

describe('who may ask without an approval window', () => {
  it('refuses a request that names no identity, in every mode that allows some', async () => {
    for (const mayAsk of ['own-user', 'tailnet'] as const) {
      await start(resolvePairing({ mayAskWithoutWindow: mayAsk }))
      // Pins the identity requirement: no header, no request outside a window, even when any tailnet user may ask.
      await expect(ask(1)).rejects.toMatchObject({ code: 'APPROVALS_CLOSED' })
      expect(home.auth.pendingApprovals()).toEqual([])
      await home.dispose()
    }
    await start()
  })

  it('refuses another user with the default mode and accepts them when any tailnet device may ask', async () => {
    await start()
    // Pins the own-user comparison.
    await expect(ask(1, SOMEONE)).rejects.toMatchObject({ code: 'APPROVALS_CLOSED' })
    await expect(ask(2, ME)).resolves.toMatchObject({ requestId: expect.any(String) })
    await home.dispose()
    await start(resolvePairing({ mayAskWithoutWindow: 'tailnet' }))
    await expect(ask(1, SOMEONE)).resolves.toMatchObject({ requestId: expect.any(String) })
  })

  it('refuses everyone with window-only, and when the computer\'s own user is unknown', async () => {
    await start(resolvePairing({ mayAskWithoutWindow: 'window-only' }))
    await expect(ask(1, ME)).rejects.toMatchObject({ code: 'APPROVALS_CLOSED' })
    await home.dispose()
    // Pins the fail-closed default: without a readable own user, own-user mode accepts no one.
    await start(PAIRING_DEFAULTS, null)
    await expect(ask(1, ME)).rejects.toMatchObject({ code: 'APPROVALS_CLOSED' })
  })

  it('still takes a request that names no identity while a window is open', async () => {
    await start()
    await home.auth.openApprovalWindow()
    await expect(ask(1)).resolves.toMatchObject({ requestId: expect.any(String) })
    expect(home.auth.pendingApprovals()[0]).toMatchObject({ identity: null, windowless: false })
  })

  it('decides per mode in one place', () => {
    expect(mayAskWithoutWindow('own-user', ME, COMPUTER)).toBe(true)
    expect(mayAskWithoutWindow('own-user', SOMEONE, COMPUTER)).toBe(false)
    expect(mayAskWithoutWindow('tailnet', SOMEONE, undefined)).toBe(true)
    expect(mayAskWithoutWindow('tailnet', undefined, COMPUTER)).toBe(false)
    expect(mayAskWithoutWindow('window-only', ME, COMPUTER)).toBe(false)
  })
})

describe('the waiting requests of one identity', () => {
  it('refuses a second waiting request from the same identity until the first ends', async () => {
    await start(resolvePairing({ mayAskWithoutWindow: 'tailnet' }))
    const first = await ask(1, SOMEONE)
    // Pins the per-identity quota.
    await expect(ask(2, SOMEONE)).rejects.toMatchObject({ code: 'APPROVAL_PENDING_LIMIT', detail: expect.stringContaining('already has a device request waiting') })
    await expect(ask(3, ME)).resolves.toMatchObject({ requestId: expect.any(String) })
    home.auth.approvals.cancel(first.requestId)
    await expect(ask(2, SOMEONE)).resolves.toMatchObject({ requestId: expect.any(String) })
  })

  it('keeps a request waiting and listed whichever display the studio uses', async () => {
    for (const showRequest of ['dialog', 'notice', 'none'] as const) {
      await (home as Home | undefined)?.dispose()
      await start(resolvePairing({ showRequest, pendingPerIdentity: 5 }))
      await ask(1, ME)
      // Pins the display as a studio choice only: no value of showRequest hides or refuses a waiting request.
      expect(home.auth.pendingApprovals().map(request => request.label)).toEqual(['Device 1'])
    }
  })

  it('allows the configured number, and keeps the global cap of 5', async () => {
    await start(resolvePairing({ mayAskWithoutWindow: 'tailnet', pendingPerIdentity: 5 }))
    const windowless = DEVICE_APPROVAL_LIMITS.pendingRequestsPerHome - 1
    for (let fill = 1; fill <= windowless; fill += 1) await ask(fill, SOMEONE)
    await home.auth.openApprovalWindow()
    await ask(windowless + 1)
    await expect(ask(6)).rejects.toMatchObject({ code: 'APPROVAL_PENDING_LIMIT', detail: expect.stringContaining('5 device requests') })
  })

  it('leaves the last of the 5 slots to a window request when five tailnet users ask without a window', async () => {
    await start(resolvePairing({ mayAskWithoutWindow: 'tailnet' }))
    const users = [1, 2, 3, 4, 5].map((fill): TailnetIdentity => ({ login: `user${String(fill)}@example.com`, name: `User ${String(fill)}` }))
    for (const [index, user] of users.entries()) {
      // Pins the window-less cap: the fifth user is refused although 5 slots are the global cap and the user has no request waiting.
      if (index < 4) await ask(index + 1, user)
      else await expect(ask(index + 1, user)).rejects.toMatchObject({ code: 'APPROVAL_PENDING_LIMIT', detail: expect.stringContaining('without an approval window') })
    }
    await home.auth.openApprovalWindow()
    await expect(ask(6)).resolves.toMatchObject({ requestId: expect.any(String) })
    expect(home.auth.pendingApprovals()).toHaveLength(5)
  })

  it('lets one identity\'s repeated window-less asks neither spend the source budget nor stop a window request', async () => {
    await start()
    await ask(1, ME)
    const perMinute = DEVICE_APPROVAL_LIMITS.approvalRequestsPerMinutePerSource
    // Pins the order of the checks: each refusal here is the identity's quota, never the shared source limit.
    for (let fill = 2; fill <= perMinute * 2; fill += 1) {
      await expect(ask(fill, ME)).rejects.toMatchObject({ code: 'APPROVAL_PENDING_LIMIT' })
    }
    await home.auth.openApprovalWindow()
    await expect(ask(perMinute * 2 + 1)).resolves.toMatchObject({ requestId: expect.any(String) })
  })

  it('keeps the window-less source budget apart from the window\'s', async () => {
    await start(resolvePairing({ mayAskWithoutWindow: 'tailnet', pendingPerIdentity: 5 }))
    await home.auth.openApprovalWindow()
    for (let fill = 1; fill <= DEVICE_APPROVAL_LIMITS.approvalRequestsPerMinutePerSource; fill += 1) {
      const accepted = await ask(fill)
      home.auth.approvals.cancel(accepted.requestId)
    }
    await expect(ask(50)).rejects.toMatchObject({ code: 'APPROVAL_RATE_LIMITED' })
    home.auth.approvals.closeWindow()
    await expect(ask(51, SOMEONE)).resolves.toMatchObject({ requestId: expect.any(String) })
  })

  it('keeps one Tailscale identity from filling the slots of an open window, and lets another identity through', async () => {
    await start(resolvePairing({ mayAskWithoutWindow: 'window-only', pendingPerIdentity: 2 }))
    await home.auth.openApprovalWindow()
    await ask(1, SOMEONE)
    await ask(2, SOMEONE)
    // Pins the per-identity pending cap inside a window: without it these requests fill all of the home's slots.
    for (let fill = 3; fill <= 8; fill += 1) {
      await expect(ask(fill, SOMEONE)).rejects.toMatchObject({ code: 'APPROVAL_PENDING_LIMIT' })
    }
    await expect(ask(9, ME)).resolves.toMatchObject({ requestId: expect.any(String) })
  })

  it('counts a window\'s request budget per identity, so one identity\'s asks do not stop another\'s', async () => {
    await start(resolvePairing({ mayAskWithoutWindow: 'window-only', pendingPerIdentity: 5 }))
    await home.auth.openApprovalWindow()
    for (let fill = 1; fill <= DEVICE_APPROVAL_LIMITS.approvalRequestsPerMinutePerSource; fill += 1) {
      home.auth.approvals.cancel((await ask(fill, SOMEONE)).requestId)
    }
    // Pins the per-identity key: the shared source budget would be spent and this identity's ask refused too.
    await expect(ask(50, SOMEONE)).rejects.toMatchObject({ code: 'APPROVAL_RATE_LIMITED' })
    await expect(ask(51, ME)).resolves.toMatchObject({ requestId: expect.any(String) })
  })

  it('keeps a ceiling over every identity in a window, so many logins cannot raise the total without bound', async () => {
    await start(resolvePairing({ mayAskWithoutWindow: 'window-only', pendingPerIdentity: 5 }))
    await home.auth.openApprovalWindow()
    const ceiling = DEVICE_APPROVAL_LIMITS.approvalRequestsPerMinutePerSource * DEVICE_APPROVAL_LIMITS.pendingRequestsPerHome
    for (let fill = 1; fill <= ceiling; fill += 1) {
      home.auth.approvals.cancel((await ask(fill, { login: `person${String(fill)}@example.com`, name: 'Person' })).requestId)
    }
    // Pins the ceiling: each login is within its own budget, but the total is spent.
    await expect(ask(500, { login: 'one-more@example.com', name: 'One more' })).rejects.toMatchObject({ code: 'APPROVAL_RATE_LIMITED' })
  })

  it('shows the identity, the window-less mark and the wrong codes of a waiting request', async () => {
    await start()
    await ask(1, ME)
    await expect(home.auth.approveLocally(home.auth.pendingApprovals()[0]?.requestId ?? '', '00000000')).rejects.toMatchObject({ code: 'APPROVAL_CODE_MISMATCH' })
    expect(home.auth.pendingApprovals()).toMatchObject([{ identity: ME, windowless: true, wrongCodes: 1, label: 'Device 1' }])
  })
})

describe('the identity headers by listener', () => {
  it('reads Tailscale-User-* only on a listener behind tailscale serve', async () => {
    const headers = { 'tailscale-user-login': COMPUTER, 'tailscale-user-name': 'Me' }
    await start(PAIRING_DEFAULTS, COMPUTER, true)
    expect(home.auth.identityOf(LISTENER, headers)).toEqual(ME)
    await home.dispose()
    // Pins the per-listener flag: a client of any other listener could send these headers itself.
    await start(PAIRING_DEFAULTS, COMPUTER, false)
    expect(home.auth.identityOf(LISTENER, headers)).toBeUndefined()
  })
})

describe('the identity headers', () => {
  it('reads the login and the name, and no identity from absent, repeated or unprintable values', () => {
    expect(tailnetIdentityOf({ 'tailscale-user-login': ' me@example.com ', 'tailscale-user-name': 'Me' })).toEqual({ login: COMPUTER, name: 'Me' })
    expect(tailnetIdentityOf({ 'tailscale-user-login': COMPUTER })).toEqual({ login: COMPUTER, name: COMPUTER })
    for (const headers of [{}, { 'tailscale-user-login': '' }, { 'tailscale-user-login': ['a@b', 'c@d'] }, { 'tailscale-user-login': 'a\r\nb' }, { 'tailscale-user-login': 'x'.repeat(201) }] as IncomingHttpHeaders[]) {
      // Pins the header reader: only one printable value of bounded length is an identity.
      expect(tailnetIdentityOf(headers)).toBeUndefined()
    }
  })
})

describe('the routes', () => {
  let port = 0
  let close: () => Promise<void> = () => Promise.resolve()

  beforeEach(async () => {
    await start()
    const routes: [string, RouteHandler][] = [
      [REACH_PATHS.request, approvalRequestHandler(home.auth)],
      [REACH_PATHS.pending, pendingHandler(home.auth, testCredential)],
      [REACH_PATHS.approve, approveHandler(home.auth, testCredential)],
      [REACH_PATHS.cancel, cancelHandler(home.auth, testCredential)],
    ]
    const server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
      const url = new URL(incoming.url ?? '/', 'http://server.invalid')
      const route = routes.find(([path]) => url.pathname === path || url.pathname.startsWith(`${path}/`))
      if (url.searchParams.has('reach')) stampListener(incoming, LISTENER)
      if (route === undefined) {
        response.statusCode = 404
        response.end()
        return
      }
      void route[1](incoming, response)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    port = (server.address() as AddressInfo).port
    home.loopback.port = port
    close = () => new Promise((resolve) => { server.close(() => { resolve() }) })
  })

  afterEach(async () => {
    await close()
  })

  /**
   * Send one request to the test server.
   * @param method - the method.
   * @param path - the path; `reach` in its query stamps the reach listener.
   * @param body - the JSON body, or a raw text.
   * @param headers - extra headers.
   * @returns the status and the JSON body.
   */
  function send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const text = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
      const outgoing = httpRequest({
        host: '127.0.0.1', port, method, path, setHost: false, agent: false,
        headers: { host: `127.0.0.1:${String(port)}`, ...(path.includes('reach') ? {} : { cookie: STUDIO_COOKIE, origin: `http://127.0.0.1:${String(port)}` }), ...headers, ...(text === undefined ? {} : { 'content-length': String(Buffer.byteLength(text)) }) },
      }, (response) => {
        let received = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => { received += chunk })
        response.on('end', () => { resolve({ status: response.statusCode ?? 0, text: received, json: received === '' ? {} : JSON.parse(received) as Record<string, unknown> }) })
      })
      outgoing.on('error', reject)
      outgoing.end(text)
    })
  }

  const message = (fill: number): Record<string, unknown> => ({ v: 1, devicePublicKey: keyOf(fill), deviceNonce: Buffer.alloc(16, fill).toString('base64url'), label: `Phone ${String(fill)}`, platform: 'Test' })
  const identityHeaders = (identity: TailnetIdentity): Record<string, string> => ({ 'tailscale-user-login': identity.login, 'tailscale-user-name': identity.name })

  it('refuses a request without an identity outside a window before it reads the body', async () => {
    // Pins the early refusal: an unreadable body is not parsed, so the answer is the closed window and not BAD_REQUEST.
    const reply = await send('POST', `${REACH_PATHS.request}?reach`, 'not json')
    expect({ status: reply.status, error: reply.json.error }).toEqual({ status: 403, error: 'APPROVALS_CLOSED' })
    const other = await send('POST', `${REACH_PATHS.request}?reach`, 'not json', identityHeaders(SOMEONE))
    expect(other.json.error).toBe('APPROVALS_CLOSED')
  })

  it('gives a forged identity from a local process a pending request and no more: the code is still needed', async () => {
    // A local process reaches the listener behind `tailscale serve` and sends the computer's own login itself.
    const reply = await send('POST', `${REACH_PATHS.request}?reach`, message(1), identityHeaders(ME))
    expect(reply.status).toBe(201)
    const pending = (await send('GET', REACH_PATHS.pending)).json.pending as { requestId: string }[]
    expect(pending).toHaveLength(1)
    const requestId = pending[0]?.requestId ?? ''
    // Pins the match code: without the digits the forging process's screen shows, three guesses cancel the request.
    for (let attempt = 1; attempt <= DEVICE_APPROVAL_LIMITS.wrongTypedCodesPerRequest; attempt += 1) {
      const wrong = await send('POST', REACH_PATHS.approve, { requestId, typedCode: '00000000' })
      expect(wrong.json.error).toBe('APPROVAL_CODE_MISMATCH')
    }
    expect((await send('POST', REACH_PATHS.approve, { requestId, typedCode: '00000000' })).json.error).toBe('APPROVAL_EXPIRED')
    expect((await home.auth.devices()).devices).toEqual([])
  })

  it('approves a window-less request only with all 8 digits of its own code: a partial, longer or wrong code approves nothing', async () => {
    const accepted = (await send('POST', `${REACH_PATHS.request}?reach`, message(1), identityHeaders(ME))).json as { requestId: string; homePublicKey: string; homeNonce: Base64Url }
    const code = matchCode({
      homePublicKey: Buffer.from(accepted.homePublicKey, 'base64url'), deviceId: deviceIdOf(keyOf(1)), homeNonce: accepted.homeNonce,
      deviceNonce: brandString<Base64Url>(Buffer.alloc(16, 1).toString('base64url')), address: ADDRESS,
    })
    // Pins the full-code comparison the pop-up's Submit relies on: the first 7 digits, or the code with a digit added, are wrong codes.
    for (const typedCode of [code.slice(0, 7), `${code}0`]) {
      const refused = await send('POST', REACH_PATHS.approve, { requestId: accepted.requestId, typedCode })
      expect({ typedCode, status: refused.status, error: refused.json.error }).toEqual({ typedCode, status: 403, error: 'APPROVAL_CODE_MISMATCH' })
    }
    expect((await home.auth.devices()).devices).toEqual([])
    expect((await send('GET', REACH_PATHS.pending)).json.pending).toMatchObject([{ requestId: accepted.requestId, wrongCodes: 2 }])
    const approved = await send('POST', REACH_PATHS.approve, { requestId: accepted.requestId, typedCode: `${code.slice(0, 4)} ${code.slice(4)}` })
    expect(approved.status).toBe(200)
    expect((await home.auth.devices()).devices).toHaveLength(1)
  })

  it('shows the pending requests, the identity and the display choice at the computer, and never to a reach session', async () => {
    await send('POST', `${REACH_PATHS.request}?reach`, message(1), identityHeaders(ME))
    const computer = await send('GET', REACH_PATHS.pending)
    expect(computer.status).toBe(200)
    expect(computer.json).toMatchObject({
      pending: [{ label: 'Phone 1', identity: ME, windowless: true, wrongCodes: 0 }],
      pairing: { mayAskWithoutWindow: 'own-user', showRequest: 'dialog' },
    })
    const requestId = (computer.json.pending as { requestId: string }[])[0]?.requestId ?? ''
    // Pins the computer-only arrival: a reach session gets the refusal, with none of the pending data in it.
    for (const [method, path, body] of [
      ['GET', `${REACH_PATHS.pending}?reach`, undefined],
      ['POST', `${REACH_PATHS.approve}?reach`, { requestId, typedCode: '00000000' }],
      ['POST', `${REACH_PATHS.cancel}?reach`, { requestId }],
    ] as const) {
      const refused = await send(method, path, body)
      expect({ path, status: refused.status, error: refused.json.error }).toEqual({ path, status: 403, error: 'LOOPBACK_REQUIRED' })
      expect(refused.text).not.toContain(ME.login)
      expect(refused.text).not.toContain('Phone 1')
    }
    expect(home.auth.pendingApprovals()).toHaveLength(1)
  })

  it('refuses a local program without the studio credential the list of pending requests', async () => {
    await send('POST', `${REACH_PATHS.request}?reach`, message(1), identityHeaders(ME))
    const refused = await send('GET', REACH_PATHS.pending, undefined, { cookie: 'none' })
    expect(refused.status).toBe(401)
    expect(refused.text).not.toContain(ME.login)
  })
})
