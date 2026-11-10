/** Browser launch-token and persistent-cookie behavior. */

import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { PeerId } from '@deepseek-ai/dsh-typert-protocol'
import { BrowserAuth } from '../src/browser-auth.ts'
import { OneTimeLaunchTokens } from '../src/launch-tokens.ts'
import type { ConnectionIndexRequest, ConnectionIndexResponse } from '../src/rpc.ts'
import { RecordCredentials } from './browser-credentials.ts'

function signedCookie(store: RecordCredentials, name: string, payload: unknown): string {
  const body = typeof payload === 'string'
    ? Buffer.from(payload, 'utf8').toString('base64url')
    : Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return signedBodyCookie(store, name, body)
}

function signedBodyCookie(store: RecordCredentials, name: string, body: string): string {
  const record = store.record
  if (record?.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) {
    throw new Error('test credential store has no signing secret')
  }
  const secret: unknown = Reflect.get(record.payload, 'secret')
  if (typeof secret !== 'string') throw new Error('test credential record has no string secret')
  const signature = createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest('base64url')
  return `${name}=v1.${body}.${signature}`
}

interface ResponseState {
  status?: number
  headers?: Readonly<Record<string, string>>
  body?: string
}

function response(): { value: ConnectionIndexResponse; state: ResponseState } {
  const state: ResponseState = {}
  return {
    value: {
      writeHead(status, headers) {
        state.status = status
        if (headers !== undefined) state.headers = headers
      },
      end(body) {
        if (body !== undefined) state.body = body
      },
    },
    state,
  }
}

function credentials(store: RecordCredentials): CredentialProvider {
  return store as unknown as CredentialProvider
}

function createAuth(
  store: RecordCredentials,
  maxAgeDays = 30,
  processOwner: object = {},
): Promise<BrowserAuth> {
  return BrowserAuth.create(processOwner, credentials(store), maxAgeDays)
}

function request(url: string, authority = '127.0.0.1:3080', init?: {
  cookie?: string
  method?: string
}): ConnectionIndexRequest {
  return {
    method: init?.method ?? 'GET',
    url,
    headers: {
      host: authority,
      ...init?.cookie === undefined ? {} : { cookie: init.cookie },
    },
  }
}

function exchange(
  auth: BrowserAuth,
  authority = '127.0.0.1:3080',
  secure = false,
): { cookie: string; launchUrl: string; state: ResponseState } {
  const launchUrl = auth.authenticatedUrl(`http://${authority}`)
  const target = new URL(launchUrl)
  const res = response()
  expect(auth.authorizeIndex(request(`${target.pathname}${target.search}`, authority), res.value, secure)).toBe(false)
  const setCookie = res.state.headers?.['set-cookie']
  if (setCookie === undefined) throw new Error('token exchange did not set a cookie')
  return { cookie: setCookie.split(';', 1)[0]!, launchUrl, state: res.state }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('API credentials', () => {
  it('refuses a request without a URL before publishing an API operator', async () => {
    const auth = await createAuth(new RecordCredentials())
    const publish = vi.fn(() => 'api-operator' as PeerId)
    const res = response()

    auth.authorizeConnect({ method: 'GET', headers: { host: 'localhost' } }, res.value, false, publish)

    expect(res.state).toEqual({
      status: 401,
      headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
      body: 'dsh web authentication required; reopen the URL printed by dsh web.\n',
    })
    expect(publish).not.toHaveBeenCalled()
  })

  it('signs the published id and rejects browser confusion, tampering, audience mismatch, and expiry', async () => {
    vi.useFakeTimers()
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const authority = '127.0.0.1:3080'
    const id = 'api-operator' as PeerId
    const issuedAt = Date.now()
    const publish = vi.fn(() => id)
    const res = response()
    auth.authorizeConnect(request(auth.authenticatedUrl(`http://${authority}/connect`)), {
      ...res.value,
      writeHead(status, headers) {
        expect(publish).toHaveBeenCalledExactlyOnceWith('none')
        return res.value.writeHead(status, headers)
      },
    }, false, publish)
    const cookie = res.state.headers?.['set-cookie']?.split(';', 1)[0]
    if (cookie === undefined) throw new Error('API connect did not set a cookie')
    const [name, value] = cookie.split('=') as [string, string]
    const payload = { version: 2, authority, id, issuedAt, expiresAt: issuedAt + 30 * 86_400_000 }
    expect(JSON.parse(Buffer.from(value.split('.')[1]!, 'base64url').toString('utf8'))).toEqual(payload)
    expect(auth.authenticateApi(request('/', authority, { cookie }))).toBe(id)
    expect(auth.isAuthenticated(request('/', authority, { cookie }))).toBe(false)
    expect(auth.authenticateApi(request('/', authority, { cookie: exchange(auth).cookie }))).toBeUndefined()
    expect(auth.isAuthenticated(request('/', authority, { cookie: cookie.replace('=v2.', '=v1.') }))).toBe(false)
    expect(auth.authenticateApi(request('/', authority, { cookie: `${cookie.slice(0, -1)}!` }))).toBeUndefined()
    expect(auth.authenticateApi(request('/', 'localhost:3080', { cookie }))).toBeUndefined()
    expect(auth.authenticateApi(request('/', '127.0.0.1:3081', { cookie }))).toBeUndefined()
    expect(auth.authenticateApi(request('/', authority, { cookie }), true)).toBeUndefined()
    for (const invalid of [
      { ...payload, version: 3 },
      { ...payload, authority: 'localhost:3080' },
      { ...payload, id: '' },
      { ...payload, id: 42 },
      { ...payload, id: undefined },
      { ...payload, issuedAt: issuedAt + 1 },
      { ...payload, issuedAt: 0.5 },
      { ...payload, expiresAt: 'later' },
      { ...payload, expiresAt: issuedAt - 1 },
    ]) {
      const invalidCookie = signedCookie(store, name, invalid).replace('=v1.', '=v2.')
      expect(auth.authenticateApi(request('/', authority, { cookie: invalidCookie }))).toBeUndefined()
      expect(auth.isAuthenticated(request('/', authority, { cookie: invalidCookie }))).toBe(false)
    }
    const shorter = await createAuth(store, 1)
    expect(shorter.authenticateApi(request('/', authority, { cookie }))).toBeUndefined()
    vi.setSystemTime(payload.expiresAt)
    expect(auth.authenticateApi(request('/', authority, { cookie }))).toBeUndefined()
  })
})

describe('BrowserAuth', () => {
  it('mints one process token and a persistent authority-bound cookie', async () => {
    const store = new RecordCredentials()
    const processOwner = {}
    const first = await createAuth(store, 30, processOwner)
    const login = exchange(first)

    expect(login.state).toMatchObject({
      status: 303,
      headers: {
        'cache-control': 'no-store',
        'location': './',
        'referrer-policy': 'no-referrer',
      },
    })
    expect(login.state.headers?.['set-cookie']).toMatch(/; Max-Age=2592000; Path=\/; Expires=.*; HttpOnly; SameSite=Strict$/u)
    expect(login.state.headers?.['set-cookie']).not.toContain('Secure')
    expect(first.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: login.cookie }))).toBe(true)
    expect(first.isAuthenticated({
      headers: new Headers({ host: '127.0.0.1:3080', cookie: login.cookie }),
    })).toBe(true)
    expect(first.isAuthenticated({ headers: new Headers() })).toBe(false)
    expect(first.isAuthenticated(request('/', 'localhost:3080', { cookie: login.cookie }))).toBe(false)
    expect(first.isAuthenticated(request('/', '127.0.0.1:3081', { cookie: login.cookie }))).toBe(false)

    const reloaded = await createAuth(store, 30, processOwner)
    expect(reloaded.authenticatedUrl('http://127.0.0.1:3080')).toBe(login.launchUrl)
    expect(reloaded.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: login.cookie }))).toBe(true)

    const restarted = await createAuth(store)
    expect(new URL(restarted.authenticatedUrl('http://127.0.0.1:3080')).searchParams.get('token'))
      .not.toBe(new URL(login.launchUrl).searchParams.get('token'))
    expect(restarted.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: login.cookie }))).toBe(true)
    const staleUrl = new URL(login.launchUrl)
    const redirected = response()
    expect(restarted.authorizeIndex(request(
      `${staleUrl.pathname}${staleUrl.search}`,
      '127.0.0.1:3080',
      { cookie: login.cookie },
    ), redirected.value)).toBe(false)
    expect(redirected.state).toEqual({
      status: 303,
      headers: {
        'cache-control': 'no-store',
        'location': './',
        'referrer-policy': 'no-referrer',
      },
    })
  })

  it('keeps HTTPS port 443 distinct from HTTP port 80 with one signing secret', async () => {
    const auth = await createAuth(new RecordCredentials())
    const plain = exchange(auth, 'harness.example')
    const tls = exchange(auth, 'harness.example', true)
    expect(auth.isAuthenticated(request('/', 'harness.example', { cookie: plain.cookie }), true)).toBe(false)
    expect(auth.isAuthenticated(request('/', 'harness.example', { cookie: tls.cookie }), true)).toBe(true)
    expect(auth.isAuthenticated(request('/', 'harness.example:443', { cookie: tls.cookie }), true)).toBe(true)
    expect(auth.isAuthenticated(request('/', 'harness.example', { cookie: tls.cookie }))).toBe(false)
  })

  it('rejects HTTP cookie replay after enabling TLS on the same authority', async () => {
    const store = new RecordCredentials()
    const authority = 'harness.example:3080'
    const plain = exchange(await createAuth(store), authority)
    const restarted = await createAuth(store)
    const denied = response()
    expect(restarted.authorizeIndex(request('/', authority, { cookie: plain.cookie }), denied.value, true)).toBe(false)
    expect(denied.state.status).toBe(401)

    const tls = exchange(restarted, authority, true)
    expect(tls.state.headers?.['set-cookie']).toContain('; Secure')
    expect(restarted.isAuthenticated(request('/', authority, { cookie: tls.cookie }), true)).toBe(true)
    expect(restarted.isAuthenticated(request('/', authority, { cookie: tls.cookie }))).toBe(false)
    const tlsName = tls.cookie.slice(0, tls.cookie.indexOf('='))
    const plainValue = plain.cookie.slice(plain.cookie.indexOf('=') + 1)
    expect(restarted.isAuthenticated(request('/', authority, { cookie: `${tlsName}=${plainValue}` }), true)).toBe(false)
  })

  it('preserves the caller authority and mount while adding only this process token', async () => {
    const auth = await createAuth(new RecordCredentials())
    const mounted = new URL(auth.authenticatedUrl('https://gateway.example/tools/dsh/'))
    expect(mounted.origin).toBe('https://gateway.example')
    expect(mounted.pathname).toBe('/tools/dsh/')
    expect([...mounted.searchParams.keys()]).toEqual(['token'])

    const loopback = new URL(auth.authenticatedUrl('http://127.0.0.1:3080/'))
    expect(loopback.origin).toBe('http://127.0.0.1:3080')
    expect(loopback.pathname).toBe('/')
    expect(loopback.searchParams.get('token')).toBe(mounted.searchParams.get('token'))

    // The proxy preserves the browser-facing Host and strips the mount.
    const token = mounted.searchParams.get('token')
    const exchanged = response()
    expect(auth.authorizeIndex(request(`/?token=${String(token)}`, 'gateway.example'), exchanged.value)).toBe(false)
    const setCookie = exchanged.state.headers?.['set-cookie']
    if (setCookie === undefined) throw new Error('mount exchange did not set a cookie')
    expect(auth.isAuthenticated(request(
      '/', 'gateway.example', { cookie: setCookie.split(';', 1)[0]! },
    ))).toBe(true)
  })

  it('accepts the cookie for index serving and gives every unauthenticated request one response', async () => {
    const auth = await createAuth(new RecordCredentials())
    const { cookie } = exchange(auth)
    const allowed = response()
    expect(auth.authorizeIndex(request('/index.html', '127.0.0.1:3080', { cookie }), allowed.value)).toBe(true)
    expect(allowed.state).toEqual({})

    for (const candidate of [
      request('/'),
      request('/?token=wrong'),
      request('/?token=wrong&token=again'),
      request('/index.html?token=wrong'),
      request(auth.authenticatedUrl('http://127.0.0.1:3080'), '127.0.0.1:3080', { method: 'HEAD' }),
    ]) {
      const denied = response()
      expect(auth.authorizeIndex(candidate, denied.value)).toBe(false)
      expect(denied.state.status).toBe(401)
      expect(denied.state.headers).toEqual({
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
      })
      expect(denied.state.body).toBe(candidate.method === 'HEAD'
        ? undefined
        : 'dsh web authentication required; reopen the URL printed by dsh web.\n')
    }
  })

  it('rejects tampering, expiry, future issuance, and a longer lifetime than configured', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const { cookie } = exchange(auth)
    const [name, value] = cookie.split('=') as [string, string]

    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=broken` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=${value.slice(0, -1)}x` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=%` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
      cookie: signedBodyCookie(store, name, 'a'),
    }))).toBe(false)
    expect(auth.isAuthenticated({ headers: {} })).toBe(false)
    expect(auth.isAuthenticated({ headers: { host: 'bad host', cookie } })).toBe(false)
    expect(auth.isAuthenticated({ headers: { host: '127.0.0.1:3080' } })).toBe(false)

    const invalidPayloads: unknown[] = [
      'not json',
      null,
      { version: 2, authority: '127.0.0.1:3080', issuedAt: Date.now(), expiresAt: Date.now() + 1000 },
      { version: 1, authority: 42, issuedAt: Date.now(), expiresAt: Date.now() + 1000 },
      { version: 1, authority: '127.0.0.1:3080', issuedAt: 'now', expiresAt: Date.now() + 1000 },
      { version: 1, authority: '127.0.0.1:3080', issuedAt: Date.now(), expiresAt: 'later' },
    ]
    for (const payload of invalidPayloads) {
      expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
        cookie: signedCookie(store, name, payload),
      }))).toBe(false)
    }

    const shorter = await createAuth(store, 1)
    expect(shorter.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
    vi.setSystemTime(new Date('2026-09-24T00:00:00.000Z'))
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
    vi.setSystemTime(new Date('2026-08-23T00:00:00.000Z'))
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
  })

  it('loads one secret per activation and replaces it after deletion on the next activation', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const first = exchange(auth)
    expect(store).toMatchObject({ reads: 0, modifies: 1 })

    await store.deleteRecord()
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: first.cookie }))).toBe(true)
    const sameActivation = exchange(auth)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: sameActivation.cookie }))).toBe(true)
    expect(store).toMatchObject({ reads: 0, modifies: 1 })

    const reactivated = await createAuth(store)
    const second = exchange(reactivated)
    expect(second.cookie).not.toBe(first.cookie)
    expect(reactivated.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: first.cookie }))).toBe(false)
    expect(reactivated.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: second.cookie }))).toBe(true)
    expect(store).toMatchObject({ reads: 0, modifies: 2 })
  })

  it('fails loud on an invalid owner record instead of replacing it', async () => {
    const unsupported = new RecordCredentials()
    unsupported.record = { kind: 'api-key', key: 'not-a-cookie-secret' }
    await expect(createAuth(unsupported)).rejects.toThrow(/unsupported format/u)

    const malformed = new RecordCredentials()
    malformed.record = { kind: 'grant', payload: { version: 1, secret: 'short' } }
    await expect(createAuth(malformed)).rejects.toThrow(/invalid secret/u)

    const nonString = new RecordCredentials()
    nonString.record = { kind: 'grant', payload: { version: 1, secret: 42 } }
    await expect(createAuth(nonString)).rejects.toThrow(/invalid secret/u)

    const discarded = new RecordCredentials()
    discarded.discardWrites = true
    await expect(createAuth(discarded)).rejects.toThrow(/was not created/u)

    await expect(createAuth(new RecordCredentials(), Number.MAX_SAFE_INTEGER))
      .rejects.toThrow(/safe timestamp range/u)
  })
})

describe('one-time launch tokens', () => {
  const AUTHORITY = '127.0.0.1:3080'
  const HINT = 'run the open command again'

  function oneTimeAuth(store = new RecordCredentials(), processOwner: object = {}): Promise<BrowserAuth> {
    return BrowserAuth.create(processOwner, credentials(store), 30, () => {}, { oneTime: true, reopenHint: HINT })
  }

  /** Present a launch URL's query at the root, with extra headers, and return the response. */
  function present(auth: BrowserAuth, launchUrl: string, headers: Record<string, string> = {}, method = 'GET'): ResponseState {
    const target = new URL(launchUrl)
    const res = response()
    expect(auth.authorizeIndex({ method, url: `/${target.search}`, headers: { host: AUTHORITY, ...headers } }, res.value)).toBe(false)
    return res.state
  }

  function signsIn(state: ResponseState): boolean {
    return state.status === 303 && state.headers?.['set-cookie']?.startsWith('dsh-auth-') === true
  }

  it('signs in once with each token and refuses its second use with the configured instruction', async () => {
    const auth = await oneTimeAuth()
    expect(auth.oneTimeLaunchTokens).toBe(true)
    const launchUrl = auth.authenticatedUrl(`http://${AUTHORITY}/`)
    const other = auth.authenticatedUrl(`http://${AUTHORITY}/`)
    expect(new URL(other).searchParams.get('token')).not.toBe(new URL(launchUrl).searchParams.get('token'))
    expect(new URL(launchUrl).searchParams.get('token')).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(signsIn(present(auth, launchUrl))).toBe(true)
    expect(present(auth, launchUrl)).toEqual({
      status: 401,
      headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
      body: `dsh web authentication required; ${HINT}.\n`,
    })
    expect(signsIn(present(auth, other))).toBe(true)
  })

  it('refuses a token at another loopback port or name, naming the address it was made for', async () => {
    const auth = await oneTimeAuth()
    for (const host of ['127.0.0.1:3081', 'localhost:3080']) {
      const launchUrl = auth.authenticatedUrl(`http://${AUTHORITY}/`)
      expect(present(auth, launchUrl, { host })).toEqual({
        status: 401,
        headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
        body: `dsh web authentication required; this sign-in link was made for ${AUTHORITY} and signs in only there; ${HINT}.\n`,
      })
      expect(present(auth, launchUrl).status).toBe(401)
    }
    const forwarded = auth.authenticatedUrl('http://127.0.0.1:4000/')
    expect(signsIn(present(auth, forwarded, { host: '127.0.0.1:4000' }))).toBe(true)
  })

  it('refuses Origin: null and accepts Sec-Fetch-Site: same-origin', async () => {
    const auth = await oneTimeAuth()
    const opaque = auth.authenticatedUrl(`http://${AUTHORITY}/`)
    expect(present(auth, opaque, { origin: 'null' }).status).toBe(401)
    expect(present(auth, opaque).status).toBe(401)
    expect(signsIn(present(auth, auth.authenticatedUrl(`http://${AUTHORITY}/`), { 'sec-fetch-site': 'same-origin' }))).toBe(true)
  })

  it('drops expired tokens before it counts the five, and refuses more than four token values unread', () => {
    vi.useFakeTimers()
    const store = new OneTimeLaunchTokens()
    const url = new URL(`http://${AUTHORITY}/`)
    for (let minted = 0; minted < 5; minted += 1) store.mint(url)
    vi.advanceTimersByTime(60_000)
    const fresh = store.mint(url)
    expect(store.waiting).toBe(1)
    expect(store.redeem([fresh, 'a', 'b', 'c', 'd'], AUTHORITY)).toEqual({ kind: 'refused' })
    expect(store.waiting).toBe(1)
    expect(store.redeem([fresh], AUTHORITY)).toEqual({ kind: 'accepted' })
  })

  it('refuses a token after 60 seconds', async () => {
    vi.useFakeTimers()
    const auth = await oneTimeAuth()
    const fresh = auth.authenticatedUrl(`http://${AUTHORITY}/`)
    const stale = auth.authenticatedUrl(`http://${AUTHORITY}/`)
    vi.advanceTimersByTime(59_999)
    expect(signsIn(present(auth, fresh))).toBe(true)
    vi.advanceTimersByTime(1)
    expect(present(auth, stale).status).toBe(401)
  })

  it('keeps at most five waiting tokens and drops the oldest when a sixth is minted', async () => {
    const auth = await oneTimeAuth()
    const urls = Array.from({ length: 6 }, () => auth.authenticatedUrl(`http://${AUTHORITY}/`))
    expect(present(auth, urls[0]!).status).toBe(401)
    for (const url of urls.slice(1)) expect(signsIn(present(auth, url))).toBe(true)
  })

  it('refuses and consumes a token presented with another Host, from another site, by another method or beside another token', async () => {
    const auth = await oneTimeAuth()
    const cases: readonly [Record<string, string>, string?][] = [
      [{ host: 'localhost:3080' }],
      [{ host: 'not a host' }],
      [{ 'sec-fetch-site': 'cross-site' }],
      [{ 'sec-fetch-site': 'same-site' }],
      [{ origin: 'http://evil.example' }],
      [{}, 'HEAD'],
    ]
    for (const [headers, method] of cases) {
      const launchUrl = auth.authenticatedUrl(`http://${AUTHORITY}/`)
      expect(present(auth, launchUrl, headers, method).status).toBe(401)
      expect(present(auth, launchUrl).status).toBe(401)
    }
    const first = new URL(auth.authenticatedUrl(`http://${AUTHORITY}/`))
    const second = new URL(auth.authenticatedUrl(`http://${AUTHORITY}/`))
    const both = new URL(`http://${AUTHORITY}/`)
    both.searchParams.append('token', first.searchParams.get('token') ?? '')
    both.searchParams.append('token', second.searchParams.get('token') ?? '')
    expect(present(auth, both.href).status).toBe(401)
    expect(present(auth, first.href).status).toBe(401)
    expect(present(auth, second.href).status).toBe(401)
    const navigated = auth.authenticatedUrl(`http://${AUTHORITY}/`)
    expect(signsIn(present(auth, navigated, { 'sec-fetch-site': 'none', origin: `http://${AUTHORITY}` }))).toBe(true)
    const tls = await oneTimeAuth()
    const secureUrl = new URL(tls.authenticatedUrl('https://studio.example/'))
    const res = response()
    tls.authorizeIndex({ method: 'GET', url: `/${secureUrl.search}`, headers: { host: 'studio.example', origin: 'https://studio.example' } }, res.value, true)
    expect(signsIn(res.state)).toBe(true)
  })

  it('accepts no process token and keeps waiting tokens across a reload of the same process owner', async () => {
    const store = new RecordCredentials()
    const owner = {}
    const auth = await oneTimeAuth(store, owner)
    const launchUrl = auth.authenticatedUrl(`http://${AUTHORITY}/`)
    // The same process owner's reusable token, which upstream's mode would accept, signs nothing in.
    const stock = await createAuth(store, 30, owner)
    const processUrl = stock.authenticatedUrl(`http://${AUTHORITY}/`)
    expect(signsIn(present(stock, processUrl))).toBe(true)
    expect(present(auth, processUrl).status).toBe(401)
    const reloaded = await oneTimeAuth(store, owner)
    expect(signsIn(present(reloaded, launchUrl))).toBe(true)
    expect(present(auth, launchUrl).status).toBe(401)
  })

  it('exchanges a token once at /connect and consumes one presented with a refused declaration', async () => {
    const auth = await oneTimeAuth()
    const publish = vi.fn(() => 'api-operator' as PeerId)
    const connect = (url: string): ResponseState => {
      const target = new URL(url)
      const res = response()
      auth.authorizeConnect(request(`${target.pathname}${target.search}`), res.value, false, publish)
      return res.state
    }
    const launchUrl = auth.authenticatedUrl(`http://${AUTHORITY}/connect`)
    expect(connect(launchUrl).status).toBe(302)
    expect(connect(launchUrl).status).toBe(401)
    const elsewhere = new URL(auth.authenticatedUrl('http://127.0.0.1:4000/connect'))
    const bound = response()
    auth.authorizeConnect(request(`${elsewhere.pathname}${elsewhere.search}`), bound.value, false, publish)
    expect(bound.state.body).toBe(`dsh web authentication required; this sign-in link was made for 127.0.0.1:4000 and signs in only there; ${HINT}.\n`)
    const declared = auth.authenticatedUrl(`http://${AUTHORITY}/connect?interactions=sometimes`)
    expect(connect(declared).status).toBe(400)
    expect(connect(declared.replace('interactions=sometimes&', '')).status).toBe(401)
    expect(publish).toHaveBeenCalledOnce()
  })

  it('consumes a token on request, as a reach listener does with one it refuses', async () => {
    const auth = await oneTimeAuth()
    const launchUrl = auth.authenticatedUrl(`http://${AUTHORITY}/`)
    auth.consumeLaunchTokens([new URL(launchUrl).searchParams.get('token') ?? ''])
    expect(present(auth, launchUrl).status).toBe(401)
  })

  it('keeps the reusable process token when the mode is off', async () => {
    const auth = await createAuth(new RecordCredentials())
    expect(auth.oneTimeLaunchTokens).toBe(false)
    const launchUrl = auth.authenticatedUrl(`http://${AUTHORITY}/`)
    expect(auth.authenticatedUrl(`http://${AUTHORITY}/`)).toBe(launchUrl)
    auth.consumeLaunchTokens([new URL(launchUrl).searchParams.get('token') ?? ''])
    expect(signsIn(present(auth, launchUrl, { host: AUTHORITY, 'sec-fetch-site': 'cross-site' }))).toBe(true)
    expect(signsIn(present(auth, launchUrl))).toBe(true)
  })
})
