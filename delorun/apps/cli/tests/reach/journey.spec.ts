/**
 * Remote access end to end, with `tailscale` faked: `delorun reach on tailscale` writes the profile's row; Delorun's web
 * composition boots in this process with `@delorun/home-auth` and `@delorun/reach` loaded from that row; the person's
 * `devices.approve` opens the window; a second device asks for approval and shows its match code; the person approves
 * it with that code; the device signs in, reads the chat list over the reach listener, is refused a full-access grant
 * and device management, and `delorun devices remove` ends its session.
 */
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { HomeAuthService } from '@delorun/home-auth'
import { newStartToken } from '@delorun/home'
import { approveDevices, removeDevice } from '@delorun/home-process'
import { ReachService, type TailscaleRunner } from '@delorun/reach'
import { bootStudio, type Studio } from '../denial/admission/studio.ts'
import { fakeTailscale } from '../fixtures/fake-tailscale.ts'
// @ts-expect-error -- the sign-in page's browser module is JavaScript without declarations.
import { deviceIdOf, matchCodeOf, signInMessage } from '@delorun/home-auth/assets/sign-in.js'
import { EXIT } from '../../src/exit.ts'
import type { CommandContext } from '../../src/command.ts'
import { createReachCommand } from '../../src/reach/command.ts'
import { createDevicesCommand } from '../../src/devices/command.ts'
import { localDeviceApproval } from '../../src/devices/host.ts'
import { readReachRow } from '../../src/reach/row.ts'

const HOST = 'phone-home.example.ts.net'
const ADDRESS = `https://${HOST}`
/** A fake `tailscale`: a signed-in machine with HTTPS on, keeping its serve configuration. */
const fake = fakeTailscale(HOST)
const tailscale: TailscaleRunner = fake.run
const calls = fake.calls

/** The reach service over the fake. */
class FakeReach extends ReachService {
  protected override tailscale(): TailscaleRunner {
    return tailscale
  }
}

interface Reply {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

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

const json = (reply: Reply): Record<string, unknown> => JSON.parse(reply.body) as Record<string, unknown>

let osHome: string
let delorunHome: string
let studio: Studio
let reachPort = 0
const output = { stdout: '', stderr: '' }
let context: CommandContext

/** The second device: a P-256 key, its cookie, and the requests it sends on the reach listener. */
const phone = {
  keys: generateKeyPairSync('ec', { namedCurve: 'P-256' }),
  cookie: undefined as string | undefined,
  send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    return send(reachPort, method, path, { host: HOST, ...(this.cookie === undefined ? {} : { cookie: this.cookie }), ...(method === 'POST' ? { origin: ADDRESS } : {}), ...headers }, body)
  },
  jwk(): { kty: string; crv: string; x: string; y: string } {
    return this.keys.publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string; y: string }
  },
}

beforeAll(async () => {
  osHome = mkdtempSync(join(tmpdir(), 'delorun-journey-'))
  delorunHome = join(osHome, '.delorun')
  mkdirSync(join(delorunHome, 'profiles', 'default'), { recursive: true, mode: 0o700 })
  writeFileSync(join(delorunHome, 'profiles', 'default', 'package.json'), '{"name":"dsh-profile-default","private":true}\n')
  context = { env: { ...process.env, HOME: osHome, DELORUN_HOME: delorunHome, DELORUN_PROFILE: undefined }, stdout: (text) => { output.stdout += text }, stderr: (text) => { output.stderr += text } }
  studio = await bootStudio()
}, 120_000)

afterAll(async () => {
  await studio.close()
  rmSync(osHome, { recursive: true, force: true })
})

describe('remote access from a second device', () => {
  it('runs from reach on to the removal that ends the device\'s session', async () => {
    // `delorun reach on tailscale` checks Tailscale and writes the row the profile loads.
    await expect(createReachCommand({ tailscale, running: () => false, send: () => Promise.resolve([]), ask: () => Promise.resolve('y'), terminal: true, installAnchor: () => Promise.resolve('/unused/package.json') }).run(['on', 'tailscale'], context)).resolves.toBe(EXIT.ok)
    const row = readReachRow(delorunHome, 'default')
    expect(row).toEqual({ enabled: true, address: ADDRESS, servePort: 443, listenerPort: expect.any(Number), serveCheckIntervalMs: 60_000, elevationMinutes: 15 })
    expect(output.stdout).toContain('Only a device you approve at this computer')

    // The Host loads home-auth and the reach service from that row.
    await studio.ctx.plugin(HomeAuthService, { secretsDirectory: join(delorunHome, 'secrets', 'home-auth') })
    await studio.ctx.plugin(FakeReach, { enabled: true, tailscalePrivate: row })
    await new Promise<void>((resolve) => { studio.ctx.inject(['reach'], () => { resolve() }) })
    reachPort = Number(new URL(calls.find(call => call[0] === 'serve' && call[1] === '--bg')?.at(-1) ?? '').port)
    // The serve target is the port the row recorded, which the home holds and relays to its reach listener.
    expect(reachPort).toBe(row.listenerPort)
    expect(studio.ctx.reach.status()).toEqual([{ option: 'tailscale-private', state: 'ready', address: ADDRESS }])
    // The studio port the CLI reaches is the profile's own.
    writeFileSync(join(delorunHome, 'profiles', 'default', 'cordis.patch.yml'), `- id: webserver\n  config:\n    port: ${String(studio.ctx.webServer.port)}\n`)

    // Outside a window the device is refused unread.
    const deviceNonce = Buffer.alloc(16, 5).toString('base64url')
    const request = { v: 1, devicePublicKey: phone.jwk(), deviceNonce, label: 'Phone', platform: 'Test phone' }
    expect(json(await phone.send('POST', '/auth/device/request', request)).error).toBe('APPROVALS_CLOSED')

    // The Host's own channel token cannot open the window; the person's `devices.approve` can.
    const devices = localDeviceApproval(studio.ctx)
    await expect(approveDevices({ v: 1, token: newStartToken(), op: 'devices.approve', args: {} }, 'host', devices)).rejects.toMatchObject({ code: 'LOOPBACK_REQUIRED' })
    const waiting = approveDevices({ v: 1, token: newStartToken(), op: 'devices.approve', args: {} }, 'person', devices)
    // The window opens asynchronously; under load a fixed delay is not enough, so wait for the home to report it.
    await vi.waitFor(() => { expect(studio.ctx.homeAuth.approvalWindowOpenUntil()).toBeDefined() }, { timeout: 10_000 })
    const asked = await phone.send('POST', '/auth/device/request', request)
    expect(asked.status).toBe(201)
    const accepted = json(asked) as { requestId: string; homePublicKey: string; homeNonce: string }
    const opened = await waiting
    expect(opened).toMatchObject({ pending: [{ requestId: accepted.requestId, label: 'Phone', platform: 'Test phone' }] })
    const deviceId = await deviceIdOf(phone.jwk()) as string
    const code = await matchCodeOf({ homePublicKey: accepted.homePublicKey, deviceId, homeNonce: accepted.homeNonce, deviceNonce, address: ADDRESS }) as string
    await expect(approveDevices({ v: 1, token: newStartToken(), op: 'devices.approve', args: { requestId: accepted.requestId, typedCode: `${code.slice(0, 4)} ${code.slice(4)}` } }, 'person', devices))
      .resolves.toMatchObject({ device: { label: 'Phone', address: ADDRESS } })

    // The device signs a fresh challenge and receives a tailnet-membership session.
    const challenge = json(await phone.send('POST', '/auth/device/challenge', { deviceId })).challenge as string
    const signature = sign('sha256', signInMessage(ADDRESS, challenge) as Uint8Array, { key: phone.keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    const session = await phone.send('POST', '/auth/session', { deviceId, challenge, signature })
    expect(session.status).toBe(201)
    phone.cookie = session.headers['set-cookie']?.[0]?.split(';')[0]

    // It reads the chat list over the reach listener; without its cookie it reads nothing.
    const listChats = { type: 'client-request', rpcId: 'journey-list', method: 'session/list', payload: { args: { _request: {} } } }
    const chats = await phone.send('POST', '/api/session/list', listChats)
    expect(chats.status).toBe(200)
    expect(json(chats)).toMatchObject({ result: { ok: true } })
    const cookie = phone.cookie
    phone.cookie = undefined
    expect(json(await phone.send('POST', '/api/session/list', listChats)).error).toBe('NOT_SIGNED_IN')
    phone.cookie = cookie

    // A full-access grant from the device without its Face ID or PIN answer grant is refused where the answer applies; so is device management.
    const admitted = studio.ctx.authenticator.admit({ headers: { host: HOST, cookie: phone.cookie ?? '' }, method: 'GET', url: '/' }, 'reach-tailscale-private')
    if (admitted.kind !== 'admitted') throw new Error('the device was not admitted')
    const peer: PeerScope = admitted.peer
    expect(() => { studio.ctx.get('remoteAnswerGuard')?.check({ peer, event: 'approval/request', request: { toolName: 'bash', grants: 'full-access' }, value: 'allowed-once' }) })
      .toThrow(/needs your confirmation: granting full access/)
    expect(json(await phone.send('POST', '/auth/devices/window')).error).toBe('LOOPBACK_REQUIRED')
    expect(json(await phone.send('GET', '/delorun/reach/status')).options).toEqual([{ option: 'tailscale-private', state: 'ready', address: ADDRESS }])
    // A session may not remove another device from the tailnet route; naming its own device is a malformed call and ends nothing.
    const another = `${deviceId.slice(0, -1)}${deviceId.endsWith('a') ? 'b' : 'a'}`
    expect(json(await phone.send('POST', '/auth/devices/remove', { v: 1, deviceId: another })).error).toBe('LOOPBACK_REQUIRED')

    // `delorun devices remove` over the home socket ends the session at once; the Host's own channel token cannot.
    await expect(removeDevice({ v: 1, token: newStartToken(), op: 'devices.remove', args: { deviceId } }, 'host', devices)).rejects.toMatchObject({ code: 'LOOPBACK_REQUIRED' })
    const removed = createDevicesCommand({
      running: () => true,
      send: async (_home, _profile, request) => (request.op === 'devices.remove' ? [{ ok: true, ...await removeDevice({ v: 1, token: newStartToken(), ...request }, 'person', devices) }] : []),
      ask: () => Promise.resolve(undefined),
      terminal: false,
      pin: { secret: () => Promise.resolve(undefined), stdinLine: () => Promise.resolve(undefined), interactive: false, stdinIsTerminal: false, now: () => 0 },
    })
    await expect(removed.run(['remove', deviceId], context)).resolves.toBe(EXIT.ok)
    expect(output.stdout).toContain('1 session(s) ended')
    expect((await phone.send('POST', '/api/session/list', listChats)).status).toBe(401)
    // The reach status answers a signed-in device only: the removed phone reads neither the address nor the state.
    const status = await phone.send('GET', '/delorun/reach/status')
    expect(status.status).toBe(401)
    expect(status.body).not.toContain('example.ts.net')
    expect(json(await phone.send('POST', '/auth/device/challenge', { deviceId })).error).toBe('DEVICE_NOT_TRUSTED')
  }, 60_000)
})
