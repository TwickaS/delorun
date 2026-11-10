/**
 * Reach end to end over loopback, with `tailscale` faked: Delo's shipped web composition boots in this process,
 * `@delo/home-auth` and `@delo/reach` load with the Tailscale private option on, and a client plays the phone on the
 * reach listener's port, sending the `Host` that `tailscaled` forwards. The person at the home's computer is the
 * loopback listener.
 *
 * The phone asks for approval outside a window and is refused unread; the person opens a window; the phone's request
 * shows a match code that the browser module computes and the person types; the phone signs a challenge and receives a
 * `tailnet-membership` session; that session is refused every action of the home's own computer; removal ends it.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RemoteError, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { HomeAuthService } from '@delo/home-auth'
import { bootStudio, type Studio } from '../../home-auth/tests/denial/admission/studio.ts'
import { ReachService, type Config } from '../src/service.ts'
import type { TailscaleResult, TailscaleRunner } from '../src/tailscale.ts'
// @ts-expect-error -- the sign-in page's browser module is JavaScript without declarations.
import { deviceIdOf, matchCodeOf, signInMessage } from '../../home-auth/assets/sign-in.js'

const ADDRESS = 'https://home.example.ts.net'
const HOST = 'home.example.ts.net'

/** A fake `tailscale` that records each invocation and answers as a signed-in machine with HTTPS on. */
function fakeTailscale(calls: string[][]): TailscaleRunner {
  return async (args): Promise<TailscaleResult> => {
    calls.push([...args])
    if (args[0] === 'status') {
      return { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${HOST}.` }, CertDomains: [HOST] }), stderr: '' }
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' })
  }
}

/** One reply. */
interface Reply {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

/**
 * Send one request to a port with exactly these headers.
 * @param port - the port on `127.0.0.1`.
 * @param method - the method.
 * @param path - the target.
 * @param headers - the headers, `host` included.
 * @param body - a JSON body.
 * @returns the reply.
 */
function send(port: number, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body)
    const request = httpRequest({
      host: '127.0.0.1', port, method, path, setHost: false, agent: false,
      headers: { ...headers, ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }) },
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

function json(reply: Reply): Record<string, unknown> {
  return JSON.parse(reply.body) as Record<string, unknown>
}

/** The phone: a device key and the requests it sends on the reach listener. */
class Phone {
  readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  readonly jwk = this.keys.publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string; y: string }
  cookie: string | undefined

  constructor(private readonly port: () => number) {}

  async deviceId(): Promise<string> {
    return deviceIdOf(this.jwk) as Promise<string>
  }

  send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    return send(this.port(), method, path, { host: HOST, ...(this.cookie === undefined ? {} : { cookie: this.cookie }), ...(method === 'POST' ? { origin: ADDRESS } : {}), ...headers }, body)
  }

  async signIn(key: KeyObject = this.keys.privateKey): Promise<Reply> {
    const deviceId = await this.deviceId()
    const challenge = await this.send('POST', '/auth/device/challenge', { deviceId })
    if (challenge.status !== 200) return challenge
    const value = json(challenge).challenge as string
    const signature = sign('sha256', signInMessage(ADDRESS, value) as Uint8Array, { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    const session = await this.send('POST', '/auth/session', { deviceId, challenge: value, signature })
    const cookie = session.headers['set-cookie']?.[0]
    if (cookie !== undefined) this.cookie = cookie.split(';')[0]
    return session
  }
}

let studio: Studio
let secrets: string
const calls: string[][] = []
let reachPort = 0

/** The reach service with the faked `tailscale`. */
class FakeReach extends ReachService {
  protected override tailscale(): TailscaleRunner {
    return fakeTailscale(calls)
  }
}

function loopback(method: string, path: string, body?: unknown): Promise<Reply> {
  const port = studio.ctx.webServer.port ?? 0
  return send(port, method, path, { host: `127.0.0.1:${String(port)}`, ...(method === 'POST' ? { origin: `http://127.0.0.1:${String(port)}` } : {}) }, body)
}

beforeAll(async () => {
  studio = await bootStudio()
  secrets = await mkdtemp(join(tmpdir(), 'delo-reach-e2e-'))
  await studio.ctx.plugin(HomeAuthService, { secretsDirectory: join(secrets, 'home-auth') })
  const config: Config = { tailscalePrivate: { enabled: true, address: ADDRESS, servePort: 443 } }
  await studio.ctx.plugin(FakeReach, config)
  await new Promise<void>((resolve) => { studio.ctx.inject(['reach'], () => { resolve() }) })
  const served = calls.find(call => call[0] === 'serve')?.at(-1) ?? ''
  reachPort = Number(new URL(served).port)
}, 120_000)

afterAll(async () => {
  await studio.close()
  await rm(secrets, { recursive: true, force: true })
})

describe('reach on the Tailscale private address', () => {
  it('configures tailscale serve to the reach listener, never through sudo', () => {
    expect(calls.map(call => call[0])).toEqual(['version', 'status', 'serve'])
    expect(calls.find(call => call[0] === 'serve')).toEqual(['serve', '--bg', '--https=443', `http://127.0.0.1:${String(reachPort)}`])
    expect(calls.flat()).not.toContain('sudo')
    expect(studio.ctx.reach.status()).toEqual([{ option: 'tailscale-private', state: 'ready', address: ADDRESS }])
  })

  it('serves the sign-in page under the reach policy with a nonce, and nothing else before sign-in', async () => {
    const phone = new Phone(() => reachPort)
    const page = await phone.send('GET', '/auth/sign-in')
    expect(page.status).toBe(200)
    expect(page.headers['content-security-policy']).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9_-]{22}'/)
    const script = /src="(\/auth\/assets\/sign-in-[0-9a-f]{12}\.js)"/.exec(page.body)?.[1] ?? ''
    expect((await phone.send('GET', script)).status).toBe(200)
    expect((await phone.send('GET', '/auth/assets/..%2f..%2fpackage.json')).status).toBe(404)
    expect(json(await phone.send('GET', '/')).error).toBe('NOT_SIGNED_IN')
  })

  it('a foreign Host on the serve target is refused', async () => {
    const reply = await send(reachPort, 'GET', '/auth/sign-in', { host: 'attacker.example' })
    expect(reply.status).toBe(421)
    expect(json(reply).error).toBe('HOST_MISMATCH')
  })

  it('owner claim on the tailnet route is refused', async () => {
    const phone = new Phone(() => reachPort)
    const reply = await phone.send('POST', '/auth/owner/claim', { v: 1, ownerCode: 'A'.repeat(26), devicePublicKey: phone.jwk, label: 'Phone' })
    expect(reply.status).toBe(403)
    expect(json(reply).error).toBe('OWNER_CLAIM_LOOPBACK_ONLY')
  })

  it('a request outside a window is refused unread', async () => {
    // A body announced but never sent: a route that read it first would hold the reply until the socket closed.
    const reply = await send(reachPort, 'POST', '/auth/device/request', { host: HOST, origin: ADDRESS, 'content-type': 'application/json', 'content-length': '4096' })
    expect(reply.status).toBe(403)
    expect(json(reply).error).toBe('APPROVALS_CLOSED')
  })

  it('an unapproved device on the tailnet route gets no session, forged Tailscale headers or not', async () => {
    const phone = new Phone(() => reachPort)
    const reply = await phone.send('POST', '/auth/device/challenge', { deviceId: await phone.deviceId() }, { 'tailscale-user-login': 'owner@example.com', 'Tailscale-User-Name': 'Owner' })
    expect(reply.status).toBe(401)
    expect(json(reply).error).toBe('DEVICE_NOT_TRUSTED')
    expect(phone.cookie).toBeUndefined()
  })

  describe('an approved phone', () => {
    const phone = new Phone(() => reachPort)

    it('is approved at the home\'s computer with the match code it shows, and signs in with tailnet-membership', async () => {
      expect((await loopback('POST', '/auth/devices/window')).status).toBe(200)
      const deviceNonce = Buffer.alloc(16, 9).toString('base64url')
      const asked = await phone.send('POST', '/auth/device/request', { v: 1, devicePublicKey: phone.jwk, deviceNonce, label: 'Phone', platform: 'Test browser' })
      expect(asked.status).toBe(201)
      const accepted = json(asked) as { requestId: string; requestSecret: string; homePublicKey: string; homeNonce: string }
      const code = await matchCodeOf({ homePublicKey: accepted.homePublicKey, deviceId: await phone.deviceId(), homeNonce: accepted.homeNonce, deviceNonce, address: ADDRESS }) as string
      const pending = json(await loopback('GET', '/auth/devices/pending')) as { pending: { requestId: string; label: string }[] }
      expect(pending.pending).toEqual([expect.objectContaining({ requestId: accepted.requestId, label: 'Phone' })])
      const wrong = await loopback('POST', '/auth/devices/approve', { requestId: accepted.requestId, typedCode: code === '00000000' ? '11111111' : '00000000' })
      expect(json(wrong).error).toBe('APPROVAL_CODE_MISMATCH')
      const approved = await loopback('POST', '/auth/devices/approve', { requestId: accepted.requestId, typedCode: `${code.slice(0, 4)} ${code.slice(4)}` })
      expect(approved.status).toBe(200)
      const state = await phone.send('GET', `/auth/device/request/${accepted.requestId}`, undefined, { authorization: `Delo-Request ${accepted.requestSecret}` })
      expect(json(state).state).toBe('approved')
      const session = await phone.signIn()
      expect(session.status).toBe(201)
      expect(session.headers['set-cookie']?.[0]).toMatch(/^__Host-delo-session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=\d+$/)
      expect((await phone.send('GET', '/')).status).not.toBe(401)
      const devices = json(await loopback('GET', '/auth/devices')) as { devices: { approvedBy: string; address: string }[] }
      expect(devices.devices).toEqual([expect.objectContaining({ approvedBy: 'local', address: ADDRESS })])
      // The window closed at the first approval.
      expect(json(await phone.send('POST', '/auth/device/request', { v: 1, devicePublicKey: phone.jwk, deviceNonce, label: 'Again', platform: '' })).error).toBe('APPROVALS_CLOSED')
    })

    it('a replayed signature does not sign in again', async () => {
      const other = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      const before = phone.cookie
      const forged = await phone.signIn(other.privateKey)
      expect(json(forged).error).toBe('CHALLENGE_INVALID')
      expect(phone.cookie).toBe(before)
    })

    it('a tailnet-route session cannot approve a device', async () => {
      for (const path of ['/auth/devices/window', '/auth/devices/approve']) {
        const reply = await phone.send('POST', path, { requestId: 'AAAAAAAAAAAAAAAAAAAAAA', typedCode: '12345678' })
        expect({ path, status: reply.status, error: json(reply).error }).toEqual({ path, status: 403, error: 'LOOPBACK_REQUIRED' })
        expect(json(reply).message).toMatch(/needs you at your computer/)
      }
      expect(studio.ctx.homeAuth.approvalWindowOpenUntil()).toBeUndefined()
    })

    it('a tailnet-route session cannot remove a device, reset, enrol a factor or change reach', async () => {
      const deviceId = await phone.deviceId()
      const removal = await phone.send('POST', '/auth/devices/remove', { v: 1, deviceId })
      expect(json(removal).error).toBe('LOOPBACK_REQUIRED')
      expect((json(await loopback('GET', '/auth/devices')) as { devices: unknown[] }).devices).toHaveLength(1)
      // No route of this home resets, enrols a factor or changes reach from a session; each path answers as unregistered.
      for (const path of ['/auth/devices/reset', '/auth/passkey/register', '/auth/oidc/start', '/auth/recovery', '/delo/reach/settings']) {
        const reply = await phone.send('POST', path, {})
        expect({ path, ok: reply.status < 300 }).toEqual({ path, ok: false })
      }
      expect(studio.ctx.reach.status()[0]?.state).toBe('ready')
    })

    it('a tailnet-route session cannot grant full access by the escalation prompt or the workspace consent', () => {
      const peer = admittedPeer(phone)
      const guard = studio.ctx.get('remoteAnswerGuard')
      expect(guard).toBeDefined()
      const answer = (request: object, value: unknown, by: PeerScope): void => { guard?.check({ peer: by, event: 'approval/request', request, value }) }
      expect(() => { answer({ toolName: 'bash', grants: 'full-access' }, 'allowed-once', peer) }).toThrow(RemoteError)
      expect(() => { answer({ toolName: 'permission', grants: 'full-access' }, 'allowed-once', peer) }).toThrow(/needs you at your computer/)
      // Refusing the same prompt from the phone, and answering any other prompt, apply.
      expect(() => { answer({ toolName: 'bash', grants: 'full-access' }, 'rejected', peer) }).not.toThrow()
      expect(() => { answer({ toolName: 'bash' }, 'allowed-once', peer) }).not.toThrow()
      expect(() => { answer({ toolName: 'bash', grants: 'full-access' }, 'allowed-once', studio.ctx.connection.browserPeer) }).not.toThrow()
    })

    it('removing the device ends its session at once', async () => {
      const deviceId = await phone.deviceId()
      const removed = await loopback('POST', '/auth/devices/remove', { v: 1, deviceId })
      expect(json(removed)).toMatchObject({ removed: true, sessions: 1 })
      const after = await phone.send('GET', '/')
      expect(after.status).toBe(401)
      expect(json(await phone.send('POST', '/auth/device/challenge', { deviceId })).error).toBe('DEVICE_NOT_TRUSTED')
    })
  })
})

/**
 * The Peer the provider admits for the phone's session, read through `admit` as the dispatcher calls it.
 * @param phone - the signed-in phone.
 * @returns the Peer.
 */
function admittedPeer(phone: Phone): PeerScope {
  const admission = studio.ctx.authenticator.admit({ headers: { host: HOST, cookie: phone.cookie ?? '' }, method: 'GET', url: '/' }, 'reach-tailscale-private')
  if (admission.kind !== 'admitted') throw new Error(`the phone's session was not admitted: ${JSON.stringify(admission)}`)
  return admission.peer
}
