import { describe, expect, it, vi } from 'vitest'
import type { EmailSender, Env, OutgoingEmail } from '../src/worker/env.ts'
import { route, sweep, type Deps } from '../src/worker/routes.ts'
import { CONSENT_OUT_OF_DATE, CONSENT_TEXT_VERSION } from '../src/site/signup.ts'
import { createDb, type TestDb } from './d1-sqlite.ts'

const ORIGIN = 'https://delorun.test'
const NOW = new Date('2026-11-13T10:00:00.000Z')

interface Harness {
  readonly env: Env
  readonly db: TestDb
  readonly sent: OutgoingEmail[]
  readonly siteverify: ReturnType<typeof vi.fn>
  readonly deps: Deps
  clock: Date
}

/** A Worker environment whose email binding, Turnstile and rate limiter are recorded fakes: nothing is sent anywhere. */
function harness(options: { sending: boolean; turnstile?: 'passed' | 'failed' | 'down'; allowed?: boolean }): Harness {
  const db = createDb()
  const sent: OutgoingEmail[] = []
  const email: EmailSender = { send: async message => (sent.push(message), { messageId: 'test' }) }
  const siteverify = vi.fn(async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    if (options.turnstile === 'down') throw new TypeError('network')
    return Response.json({ success: (options.turnstile ?? 'passed') === 'passed' })
  })
  const rateLimit = vi.fn(async () => ({ success: options.allowed ?? true }))
  const state = { clock: NOW }
  const env: Env = {
    DB: db,
    ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
    RATE_LIMIT: { limit: rateLimit },
    TURNSTILE_SITEKEY: 'site-key',
    TURNSTILE_SECRET: 'secret',
    SEND_CONFIRMATION: options.sending ? 'on' : 'off',
    SENDER_ADDRESS: 'updates@delorun.com',
    SUPPORT_ADDRESS: 'support@delorun.com',
    PUBLIC_ORIGIN: ORIGIN,
    ...(options.sending ? { EMAIL: email } : {}),
  }
  return {
    env, db, sent, siteverify, rateLimit,
    deps: { fetch: siteverify as typeof fetch, now: () => state.clock },
    get clock() { return state.clock },
    set clock(value) { state.clock = value },
  }
}

function post(path: string, fields: Record<string, string>, accept = 'application/json'): Request {
  const body = new FormData()
  for (const [key, value] of Object.entries(fields)) body.set(key, value)
  return new Request(`${ORIGIN}${path}`, { method: 'POST', body, headers: { Accept: accept, 'CF-Connecting-IP': '203.0.113.9' } })
}

const SIGNUP = { email: 'ada@example.com', first_name: 'Ada', consent: 'yes', page: '/', consent_version: CONSENT_TEXT_VERSION, 'cf-turnstile-response': 'token' }

function tokenIn(message: OutgoingEmail, route: 'confirm' | 'unsubscribe'): string {
  const match = new RegExp(`/${route}\\?token=([A-Za-z0-9_-]{43})`).exec(message.text)
  if (match?.[1] === undefined) throw new Error('no link')
  return match[1]
}

describe('POST /api/subscribe', () => {
  it('gives one answer for a new address, a known pending one and a confirmed one', async () => {
    const h = harness({ sending: true })
    const first = await route(post('/api/subscribe', SIGNUP), h.env, h.deps)
    const confirmToken = tokenIn(h.sent[0]!, 'confirm')
    const second = await route(post('/api/subscribe', SIGNUP), h.env, h.deps)
    await route(new Request(`${ORIGIN}/confirm?token=${confirmToken}`, { method: 'POST' }), h.env, h.deps)
    const third = await route(post('/api/subscribe', { ...SIGNUP, first_name: 'Other' }), h.env, h.deps)
    const bodies = await Promise.all([first, second, third].map(async response => [response.status, await response.json()]))
    expect(bodies[0]).toEqual([200, { ok: true, message: expect.stringContaining('Thanks') }])
    expect(bodies[1]).toEqual(bodies[0])
    expect(bodies[2]).toEqual(bodies[0])
    expect(h.db.rows('SELECT first_name, status FROM subscribers')).toEqual([{ first_name: 'Ada', status: 'confirmed' }])
  })

  it('sends one plain confirmation with the links and headers, and none for a confirmed address', async () => {
    const h = harness({ sending: true })
    await route(post('/api/subscribe', SIGNUP), h.env, h.deps)
    expect(h.sent).toHaveLength(1)
    const [message] = h.sent
    expect(message).toMatchObject({ to: 'ada@example.com', replyTo: 'support@delorun.com', from: { email: 'updates@delorun.com', name: 'Delorun' } })
    expect(message?.text).toContain('Hello Ada,')
    expect(message?.headers['List-Unsubscribe']).toContain(`${ORIGIN}/unsubscribe?token=`)
    expect(message?.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    expect(h.db.rows('SELECT confirmation_sent_at FROM subscribers')[0]?.confirmation_sent_at).toBe(NOW.toISOString())
    await route(post('/api/subscribe', SIGNUP), h.env, h.deps)
    expect(h.sent).toHaveLength(1)
  })

  it('keeps sign-ups pending and sends nothing while sending is off', async () => {
    const h = harness({ sending: false })
    const response = await route(post('/api/subscribe', SIGNUP), h.env, h.deps)
    expect(response.status).toBe(200)
    expect(h.sent).toHaveLength(0)
    expect(h.db.rows('SELECT status, confirmation_sent_at FROM subscribers')).toEqual([{ status: 'pending', confirmation_sent_at: null }])
  })

  it('refuses a stale, missing or malformed consent version with a reload answer, storing nothing and sending nothing', async () => {
    const h = harness({ sending: true })
    const { consent_version: _current, ...withoutVersion } = SIGNUP
    for (const fields of [{ ...SIGNUP, consent_version: 'old' }, withoutVersion, { ...SIGNUP, consent_version: `${CONSENT_TEXT_VERSION}\u0000` }, { ...SIGNUP, consent_version: 'x'.repeat(1000) }]) {
      const response = await route(post('/api/subscribe', fields), h.env, h.deps)
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ ok: false, message: CONSENT_OUT_OF_DATE, code: 'out_of_date' })
    }
    const page = await route(post('/api/subscribe', { ...SIGNUP, consent_version: 'old' }, 'text/html'), h.env, h.deps)
    expect(page.status).toBe(409)
    expect(h.rateLimit).not.toHaveBeenCalled()
    expect(h.siteverify).not.toHaveBeenCalled()
    expect(h.db.rows('SELECT email FROM subscribers')).toEqual([])
    expect(h.sent).toHaveLength(0)
  })

  it('does not reach the database for a bad form, a failed check or a limited connection', async () => {
    const bad = harness({ sending: true })
    expect((await route(post('/api/subscribe', { ...SIGNUP, email: 'nope' }), bad.env, bad.deps)).status).toBe(400)
    expect((await route(post('/api/subscribe', { ...SIGNUP, consent: '' }), bad.env, bad.deps)).status).toBe(400)
    expect(bad.siteverify).not.toHaveBeenCalled()

    const failed = harness({ sending: true, turnstile: 'failed' })
    expect((await route(post('/api/subscribe', SIGNUP), failed.env, failed.deps)).status).toBe(400)
    const noToken = harness({ sending: true })
    expect((await route(post('/api/subscribe', { ...SIGNUP, 'cf-turnstile-response': '' }), noToken.env, noToken.deps)).status).toBe(400)
    expect(noToken.siteverify).not.toHaveBeenCalled()
    const down = harness({ sending: true, turnstile: 'down' })
    expect((await route(post('/api/subscribe', SIGNUP), down.env, down.deps)).status).toBe(503)
    const limited = harness({ sending: true, allowed: false })
    expect((await route(post('/api/subscribe', SIGNUP), limited.env, limited.deps)).status).toBe(429)
    expect(limited.siteverify).not.toHaveBeenCalled()
    for (const each of [bad, failed, noToken, down, limited]) expect(each.db.rows('SELECT id FROM subscribers')).toEqual([])
  })

  it('sends Siteverify the secret and the token, and not the visitor address', async () => {
    const h = harness({ sending: false })
    await route(post('/api/subscribe', SIGNUP), h.env, h.deps)
    const init = h.siteverify.mock.calls[0]?.[1] as RequestInit
    expect(String(init.body)).toBe('secret=secret&response=token')
  })

  it('answers a plain form post with a page, and refuses other methods', async () => {
    const h = harness({ sending: false })
    const page = await route(post('/api/subscribe', SIGNUP, 'text/html'), h.env, h.deps)
    expect(page.headers.get('Content-Type')).toContain('text/html')
    expect(await page.text()).toContain('Thank you')
    expect((await route(new Request(`${ORIGIN}/api/subscribe`), h.env, h.deps)).status).toBe(405)
  })

  it('serves the site key and passes other addresses to the assets', async () => {
    const h = harness({ sending: false })
    expect(await (await route(new Request(`${ORIGIN}/api/signup-config`), h.env, h.deps)).json()).toEqual({ siteKey: 'site-key' })
    expect(await (await route(new Request(`${ORIGIN}/privacy`), h.env, h.deps)).text()).toBe('asset')
  })
})

describe('confirmation and unsubscribe links', () => {
  async function signedUp(): Promise<{ h: Harness; confirmToken: string; unsubscribeToken: string }> {
    const h = harness({ sending: true })
    await route(post('/api/subscribe', SIGNUP), h.env, h.deps)
    return { h, confirmToken: tokenIn(h.sent[0]!, 'confirm'), unsubscribeToken: tokenIn(h.sent[0]!, 'unsubscribe') }
  }

  it('shows a button on GET /confirm and confirms only on POST', async () => {
    const { h, confirmToken } = await signedUp()
    const view = await route(new Request(`${ORIGIN}/confirm?token=${confirmToken}`), h.env, h.deps)
    expect(view.status).toBe(200)
    expect(await view.text()).toContain('<button')
    expect(h.db.rows('SELECT status FROM subscribers')).toEqual([{ status: 'pending' }])
    const done = new Request(`${ORIGIN}/confirm`, { method: 'POST', body: new URLSearchParams({ token: confirmToken }) })
    expect((await route(done, h.env, h.deps)).status).toBe(200)
    expect(h.db.rows('SELECT status FROM subscribers')).toEqual([{ status: 'confirmed' }])
    expect((await route(new Request(`${ORIGIN}/confirm`, { method: 'POST', body: new URLSearchParams({ token: confirmToken }) }), h.env, h.deps)).status).toBe(200)
  })

  it('unsubscribes on GET and on a one-click POST, and repeating either changes nothing', async () => {
    const { h, unsubscribeToken } = await signedUp()
    const url = `${ORIGIN}/unsubscribe?token=${unsubscribeToken}`
    expect((await route(new Request(url), h.env, h.deps)).status).toBe(200)
    h.clock = new Date('2026-12-01T00:00:00.000Z')
    const oneClick = new Request(url, { method: 'POST', body: new URLSearchParams({ 'List-Unsubscribe': 'One-Click' }) })
    const response = await route(oneClick, h.env, h.deps)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('You have unsubscribed')
    expect(h.db.rows('SELECT status, updated_at FROM subscribers')).toEqual([{ status: 'unsubscribed', updated_at: NOW.toISOString() }])
  })

  it('refuses a malformed or unknown token, and sends no referrer from its pages', async () => {
    const { h } = await signedUp()
    expect((await route(new Request(`${ORIGIN}/unsubscribe?token=short`), h.env, h.deps)).status).toBe(400)
    const unknown = await route(new Request(`${ORIGIN}/unsubscribe?token=${'A'.repeat(43)}`), h.env, h.deps)
    expect(unknown.status).toBe(404)
    expect(unknown.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(unknown.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('the daily sweep', () => {
  it('deletes old unconfirmed sign-ups, and sends nothing while sending is off', async () => {
    const h = harness({ sending: false })
    await route(post('/api/subscribe', SIGNUP), h.env, h.deps)
    h.clock = new Date('2026-12-20T00:00:00.000Z')
    expect(await sweep(h.env, h.deps)).toEqual({ deleted: 1, sent: 0 })
  })

  it('sends the confirmation to pending sign-ups made while sending was off, with fresh tokens', async () => {
    const off = harness({ sending: false })
    await route(post('/api/subscribe', SIGNUP), off.env, off.deps)
    const on: Harness = { ...harness({ sending: true }), db: off.db }
    const env: Env = { ...on.env, DB: off.db }
    expect(await sweep(env, off.deps)).toEqual({ deleted: 0, sent: 1 })
    expect(await sweep(env, off.deps)).toEqual({ deleted: 0, sent: 0 })
    expect(on.sent).toHaveLength(1)
    const link = new Request(`${ORIGIN}/confirm`, { method: 'POST', body: new URLSearchParams({ token: tokenIn(on.sent[0]!, 'confirm') }) })
    expect((await route(link, env, off.deps)).status).toBe(200)
    expect(off.db.rows('SELECT status FROM subscribers')).toEqual([{ status: 'confirmed' }])
  })
})
