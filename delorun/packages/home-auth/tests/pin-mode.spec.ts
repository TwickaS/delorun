/**
 * PIN mode in the home (C14, "PIN mode"): the computer-only routes that set the PIN, the refusal of a device's page
 * unlock (A483: a paired device holds no PIN window and confirms each action with a one-action grant), the wrong tries
 * on the PIN grant route that remove a device or pause PIN checks, and the guarantee that the PIN reaches no log, error
 * or file in the clear.
 *
 * A request under `?reach` is stamped with the Tailscale private listener, one under `?funnel` with the Funnel
 * listener, and every other request arrives on the socket the fixture names as the loopback listener's.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { once } from 'node:events'
import { randomBytes, scryptSync } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { REACH_SESSION_COOKIE, type DeviceId, type ReachListenerId, type StudioAddress } from '@delorun/contract-admission'
import { HOME_AUTH_FILES } from '@delorun/contract-device-approval'
import { PIN_MODE_LIMITS } from '@delorun/contract-oidc-passkeys'
import { stampListener } from '@delorun/home'
import { DeviceStore } from '../src/devices.ts'
import type { ElevationChange, ElevationRecord } from '../src/elevation.ts'
import { PinModeStore } from '../src/pin-mode.ts'
import type { PinEvent } from '../src/pin-unlocks.ts'
import { passkeyPinHandler, PASSKEY_PATHS } from '../src/passkey-routes.ts'
import { PIN_PATHS, pinLockHandler, pinModeHandler, pinOffHandler, pinOptionsHandler, pinResumeHandler, pinSetHandler, pinStateHandler, pinTouchHandler, pinUnlockHandler } from '../src/pin-routes.ts'
import type { RouteHandler } from '../src/routes.ts'
import { claimOf, homeFixture, recordOf, STUDIO_COOKIE, testCredential, type Home } from './fixtures/home.ts'

const ADDRESS = brandString<StudioAddress>('https://home.example.ts.net')
const PRIVATE: ReachListenerId = 'reach-tailscale-private'
const FUNNEL: ReachListenerId = 'reach-tailscale-funnel'
const PIN = '482916'
/** Each secret comparison is one scrypt derivation at the production cost; these specs make a dozen or more, so they outlast the default 10 s under load. */
const SCRYPT_TIMEOUT_MS = 60_000
// Every spec and hook here may derive at the production cost, so the whole file gets the longer limit, not only the specs that make the most comparisons.
vi.setConfig({ testTimeout: SCRYPT_TIMEOUT_MS, hookTimeout: SCRYPT_TIMEOUT_MS })
const MINUTE = 60_000
/** The one action the grant tests confirm, with the lowercase hex SHA-256 of its arguments the grant route requires. */
const ACTION = 'pluginManager/installBundle'
const HASH = 'a'.repeat(64)

interface Reply {
  readonly status: number
  readonly body: Record<string, unknown>
  readonly text: string
}

let home: Home
let port = 0
let first: DeviceId
let token = ''
let close: () => Promise<void> = () => Promise.resolve()
let stopServing: () => void = () => undefined
let waiting: readonly { ns: string; field: string }[] = []
let events: PinEvent[]
let changes: ElevationChange[]
const texts: string[] = []

/**
 * Sign a device in on a listener.
 * @param deviceId - the device.
 * @param listener - the listener.
 * @returns the session cookie token.
 */
async function signIn(deviceId: DeviceId, listener: ReachListenerId = PRIVATE): Promise<string> {
  return (await home.auth.openSession({ deviceId, listener, address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: 60 * MINUTE })).token
}

/**
 * Add a second, third… device to the store and sign it in.
 * @param fill - the fixture key fill.
 * @returns the device and its session token.
 */
async function addDevice(fill: number): Promise<{ readonly deviceId: DeviceId; readonly token: string }> {
  const record = recordOf(fill, ADDRESS)
  await new DeviceStore({ file: join(home.directory, 'devices.json') }).add(record)
  return { deviceId: record.id, token: await signIn(record.id) }
}

beforeEach(async () => {
  home = await homeFixture()
  events = []
  waiting = []
  changes = []
  texts.length = 0
  home.auth.onPinEvent((event) => { events.push(event) })
  home.auth.onElevationChange((change) => { changes.push(change) })
  stopServing = home.auth.serve({ listener: PRIVATE, address: ADDRESS, factor: 'tailnet-membership' })
  const issued = await home.auth.issueOwnerCode()
  const claimed = await home.auth.claim(claimOf(issued.code, { address: ADDRESS }))
  first = claimed.device.id
  token = await signIn(first)
  const routes: Readonly<Record<string, RouteHandler>> = {
    [PIN_PATHS.state]: pinStateHandler(home.auth),
    [PIN_PATHS.unlock]: pinUnlockHandler(home.auth),
    [PIN_PATHS.touch]: pinTouchHandler(home.auth),
    [PIN_PATHS.lock]: pinLockHandler(home.auth),
    [PIN_PATHS.mode]: pinModeHandler(home.auth, testCredential, () => waiting),
    [PIN_PATHS.set]: pinSetHandler(home.auth, testCredential),
    [PIN_PATHS.off]: pinOffHandler(home.auth, testCredential),
    [PIN_PATHS.options]: pinOptionsHandler(home.auth, testCredential),
    [PIN_PATHS.resume]: pinResumeHandler(home.auth, testCredential),
    [PASSKEY_PATHS.pin]: passkeyPinHandler(home.auth),
  }
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://server.invalid')
    if (url.searchParams.has('reach')) stampListener(request, PRIVATE)
    if (url.searchParams.has('funnel')) stampListener(request, FUNNEL)
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
 * Send one request: as a device under `?reach` or `?funnel`, else as the loopback studio.
 * @param method - the method.
 * @param path - the path, with `?reach` or `?funnel` for a device.
 * @param body - the JSON body.
 * @param headers - extra headers, which replace the defaults; an undefined one leaves the header out.
 * @returns the status and the parsed body.
 */
function send(method: string, path: string, body?: unknown, headers: Record<string, string | undefined> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body)
    const host = `127.0.0.1:${String(port)}`
    const asDevice = path.includes('reach') || path.includes('funnel')
    const defaults = asDevice ? { cookie: `${REACH_SESSION_COOKIE}=${token}` } : { cookie: STUDIO_COOKIE, origin: `http://${host}` }
    const request = httpRequest({
      host: '127.0.0.1', port, method, path, setHost: false, agent: false,
      headers: Object.fromEntries(Object.entries({ host, ...defaults, ...headers, ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }) })
        .filter((entry): entry is [string, string] => entry[1] !== undefined)),
    }, (response) => {
      let received = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { received += chunk })
      response.on('end', () => {
        texts.push(received)
        resolve({ status: response.statusCode ?? 0, text: received, body: received === '' ? {} : JSON.parse(received) as Record<string, unknown> })
      })
    })
    request.on('error', reject)
    request.end(text)
  })
}

/**
 * The first device's running page unlock on a listener. The device-wide `elevationOf` never returns a page unlock, so the
 * computer's list of running unlocks is the one place to read it.
 * @param listener - the listener.
 * @returns the unlock, or undefined.
 */
function running(listener: ReachListenerId = PRIVATE): ElevationRecord | undefined {
  return home.auth.elevationsAtComputer().running.find(record => record.deviceId === first && record.listener === listener)
}

/** Turn the mode on at the computer. */
async function turnOn(secret: string = PIN): Promise<void> {
  expect((await send('POST', PIN_PATHS.set, { secret })).status).toBe(200)
}

/**
 * Ask the unlock route for the first device's page, which a device never gets.
 * @param secret - the PIN to send.
 * @param cookie - the session token to send, the first device's by default.
 * @returns the reply.
 */
function unlock(secret: string = PIN, cookie: string = token): Promise<Reply> {
  return send('POST', `${PIN_PATHS.unlock}?reach`, { secret }, { cookie: `${REACH_SESSION_COOKIE}=${cookie}` })
}

/**
 * Confirm one action of the first device with the PIN: the device's one-action grant.
 * @param secret - the PIN to send.
 * @param cookie - the session token to send, the first device's by default.
 * @param suffix - `reach` for the private listener, `funnel` for the Funnel listener.
 * @returns the reply; a 200 carries the grant id.
 */
function grant(secret: string = PIN, cookie: string = token, suffix: 'reach' | 'funnel' = 'reach'): Promise<Reply> {
  return send('POST', `${PASSKEY_PATHS.pin}?${suffix}`, { secret, actions: [{ action: ACTION, hash: HASH }] }, { cookie: `${REACH_SESSION_COOKIE}=${cookie}` })
}

/**
 * Whether a device holds a live grant for {@link ACTION}.
 * @param deviceId - the device, the first by default.
 * @param listener - the listener, the private one by default.
 * @returns whether a grant covers the action.
 */
function granted(deviceId: DeviceId = first, listener: ReachListenerId = PRIVATE): boolean {
  return home.auth.grants.has({ deviceId, listener }, ACTION, HASH)
}

describe('with PIN mode off', () => {
  it('refuses an unlock as an elevation and mints no elevation, and answers a grant as off', async () => {
    // Pins the unlock refusal: removing it lets a home that never turned the mode on answer the unlock route with anything but ELEVATION_REQUIRED.
    expect(await unlock()).toMatchObject({ status: 403, body: { error: 'ELEVATION_REQUIRED' } })
    expect((await send('GET', `${PIN_PATHS.state}?reach`)).body).toEqual({ kind: 'off' })
    expect(running()).toBeUndefined()
    expect(home.auth.elevationsAtComputer().running).toEqual([])
    // Pins the mode check on the grant route: a PIN grants nothing while the mode is off.
    expect(await grant()).toMatchObject({ status: 409, body: { error: 'PIN_MODE_OFF' } })
    expect(granted()).toBe(false)
    // A header the home never reads changes nothing.
    expect((await send('GET', `${PIN_PATHS.state}?reach`, undefined, { 'delorun-unlock': 'anything' })).body).toEqual({ kind: 'off' })
  })

  it('is off again after the computer turns it off', async () => {
    await turnOn()
    const confirmed = await grant()
    expect(confirmed).toMatchObject({ status: 200, body: { grantId: expect.any(String) } })
    expect(granted()).toBe(true)
    expect((await send('POST', PIN_PATHS.off, {})).body).toEqual({ enabled: false })
    // Pins the mode check on the grant route: the PIN goes with the mode and mints no new grant.
    expect(await grant()).toMatchObject({ status: 409, body: { error: 'PIN_MODE_OFF' } })
    expect(home.auth.pin.summary().enabled).toBe(false)
    expect((await send('GET', `${PIN_PATHS.state}?reach`)).body).toEqual({ kind: 'off' })
    expect(running()).toBeUndefined()
    expect(await unlock()).toMatchObject({ status: 403, body: { error: 'ELEVATION_REQUIRED' } })
  })
})

describe('changing the options without the secret', () => {
  /** The bytes of the record's hash fields, which an options change must leave alone. */
  const hashOf = async (): Promise<string> => JSON.stringify((JSON.parse(await readFile(join(home.directory, HOME_AUTH_FILES.pinMode), 'utf8')) as { hash: unknown }).hash)

  it('changes the idle minutes and lock-when-hidden on the computer, keeps the hash and the grants', async () => {
    await turnOn()
    const before = await hashOf()
    expect((await grant()).status).toBe(200)
    expect((await send('POST', PIN_PATHS.options, { idleMinutes: 30, lockWhenHidden: true })).body).toEqual({ idleMinutes: 30, lockWhenHidden: true })
    expect(home.auth.pin.summary()).toMatchObject({ enabled: true, idleMinutes: 30, lockWhenHidden: true })
    expect(await hashOf()).toBe(before)
    // Pins that an options change is no secret change: the device's grant stays.
    expect(granted()).toBe(true)
    // One field alone leaves the other as it was.
    expect((await send('POST', PIN_PATHS.options, { lockWhenHidden: false })).body).toEqual({ idleMinutes: 30, lockWhenHidden: false })
    // The change is on disk and the PIN still confirms.
    const stored = JSON.parse(await readFile(join(home.directory, HOME_AUTH_FILES.pinMode), 'utf8')) as { idleMinutes: number; lockWhenHidden: boolean }
    expect(stored).toMatchObject({ idleMinutes: 30, lockWhenHidden: false })
    expect((await grant()).status).toBe(200)
  })

  it('leaves a device no window for the idle minutes to shorten', async () => {
    await turnOn()
    await send('POST', PIN_PATHS.options, { idleMinutes: 60 })
    // Pins the unlock refusal: removing it mints a window that the idle minutes would govern.
    expect(await unlock()).toMatchObject({ status: 403, body: { error: 'ELEVATION_REQUIRED' } })
    await send('POST', PIN_PATHS.options, { idleMinutes: 1 })
    expect(await unlock()).toMatchObject({ status: 403, body: { error: 'ELEVATION_REQUIRED' } })
    expect(running()).toBeUndefined()
    expect(home.auth.elevationsAtComputer().running).toEqual([])
    expect((await send('GET', `${PIN_PATHS.state}?reach`)).body).toMatchObject({ kind: 'on', idleMinutes: 1, unlock: null })
  })

  it('is the computer\'s alone', async () => {
    await turnOn()
    const before = JSON.stringify(home.auth.pin.summary())
    expect(await send('POST', `${PIN_PATHS.options}?reach`, { idleMinutes: 5 })).toMatchObject({ status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
    expect((await grant()).status).toBe(200)
    // Pins the computer-only rule: a device that confirmed with the PIN still changes no option.
    expect(await send('POST', `${PIN_PATHS.options}?reach`, { idleMinutes: 5 })).toMatchObject({ status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
    expect(JSON.stringify(home.auth.pin.summary())).toBe(before)
  })

  it('is refused while the mode is off', async () => {
    expect(await send('POST', PIN_PATHS.options, { idleMinutes: 5 })).toMatchObject({ status: 409, body: { error: 'PIN_MODE_OFF' } })
    expect(home.auth.pin.summary().enabled).toBe(false)
  })

  it('refuses an out-of-range, fractional or mistyped value and an empty change, and changes nothing', async () => {
    await turnOn()
    const before = await readFile(join(home.directory, HOME_AUTH_FILES.pinMode), 'utf8')
    for (const body of [{ idleMinutes: 0 }, { idleMinutes: 61 }, { idleMinutes: 1.5 }, { idleMinutes: '5' }, { lockWhenHidden: 'yes' }, {}, { idleMinutes: 5, secret: PIN }, { secret: PIN }]) {
      expect((await send('POST', PIN_PATHS.options, body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(await readFile(join(home.directory, HOME_AUTH_FILES.pinMode), 'utf8')).toBe(before)
  })
})

describe('the computer\'s view of the mode', () => {
  it('names the settings whose set-back waits, by namespace and field only', async () => {
    expect((await send('GET', PIN_PATHS.mode)).body).toMatchObject({ enabled: false, setBackWaiting: [] })
    waiting = [{ ns: 'delorun-delegation-consent', field: 'enabled' }]
    // Pins the field: the computer sees a loosened setting that has not been set back.
    expect((await send('GET', PIN_PATHS.mode)).body).toMatchObject({ setBackWaiting: [{ ns: 'delorun-delegation-consent', field: 'enabled' }] })
    waiting = []
  })
})

describe('setting the PIN', () => {
  it('is the computer\'s alone', async () => {
    // Pins the computer-only rule: a device, confirmed or not, never sets, clears or resumes in version 1.
    for (const path of [PIN_PATHS.set, PIN_PATHS.off, PIN_PATHS.resume]) {
      expect(await send('POST', `${path}?reach`, { secret: PIN })).toMatchObject({ status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
    }
    expect(await send('GET', `${PIN_PATHS.mode}?reach`)).toMatchObject({ status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
    expect(home.auth.pin.summary().enabled).toBe(false)
    await turnOn()
    // The same refusal while the mode is on and the device holds a grant.
    expect((await grant()).status).toBe(200)
    expect(await send('POST', `${PIN_PATHS.set}?reach`, { secret: '739150' })).toMatchObject({ status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
    expect(await send('POST', `${PIN_PATHS.off}?reach`, {})).toMatchObject({ status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
    expect(home.auth.pin.summary().enabled).toBe(true)
  })

  it('refuses a weak PIN or passcode and names the rule without the secret', async () => {
    // Pins the rules of PIN_MODE_LIMITS and the shapes: repeats, runs, common PINs, short PINs and short passcodes.
    for (const secret of ['111111', '123456', '987654', '123123', '000000', '12345', 'short one', 'aaaaaaaaaaaa']) {
      const reply = await send('POST', PIN_PATHS.set, { secret })
      expect(reply, secret).toMatchObject({ status: 400, body: { error: 'PIN_WEAK' } })
      expect(reply.text).not.toContain(secret)
    }
    expect(home.auth.pin.summary().enabled).toBe(false)
    expect((await send('POST', PIN_PATHS.set, { secret: 'a long enough passcode' })).body).toEqual({ enabled: true, secret: 'passcode' })
    expect((await send('POST', PIN_PATHS.set, { secret: PIN, idleMinutes: 61 })).status).toBe(400)
  })

  it('keeps the PIN out of the files, the logs and every answer', async () => {
    const passcode = 'correct horse battery'
    await turnOn(passcode)
    expect((await grant('wrong horse battery')).status).toBe(403)
    expect((await unlock(passcode)).status).toBe(403)
    expect((await grant(passcode)).status).toBe(200)
    const files = await Promise.all(['pin-mode.json', 'pin-attempts.json'].map(name => readFile(join(home.directory, name), 'utf8')))
    const record = JSON.parse(files[0] ?? '') as { hash: { alg: string; salt: string; dk: string } }
    // Pins the hashing: the file holds a salted scrypt hash and no PIN.
    expect(record.hash.alg).toBe('scrypt')
    expect(record.hash.salt).not.toBe('')
    expect(files.join('\n')).not.toContain('horse')
    expect(texts.filter(text => text.includes('horse'))).toEqual([])
    expect(JSON.stringify([events, changes])).not.toContain('horse')
  })
})

describe('a device with no page unlock window', () => {
  beforeEach(async () => { await turnOn() })

  it('refuses every unlock, right PIN, wrong PIN or no body, and mints, answers and counts nothing', async () => {
    const asDevice = { cookie: `${REACH_SESSION_COOKIE}=${token}` }
    // Pins the unlock refusal: removing it makes the route read the secret, answer a token or count a try.
    for (const body of [{ secret: PIN }, { secret: '135790' }, undefined] as const) {
      const reply = await send('POST', `${PIN_PATHS.unlock}?reach`, body, asDevice)
      expect(reply, JSON.stringify(body)).toMatchObject({ status: 403, body: { error: 'ELEVATION_REQUIRED' } })
      for (const word of ['token', 'unlockId', 'endsAt', 'idleEndsAt', 'triesLeft', 'removed']) expect(reply.text, word).not.toContain(word)
      expect(reply.text).not.toContain('135790')
    }
    expect(running()).toBeUndefined()
    expect(home.auth.elevationsAtComputer().running).toEqual([])
    expect((await send('GET', `${PIN_PATHS.state}?reach`)).body).toMatchObject({ kind: 'on', unlock: null })
    // Six wrong unlocks would remove the device on its fifth if the route counted them.
    for (let miss = 0; miss < 6; miss += 1) expect((await unlock('135790')).status).toBe(403)
    expect((await home.auth.devices()).devices.map(device => device.id)).toContain(first)
    expect(home.auth.admitToken(token, PRIVATE)).toMatchObject({ kind: 'admitted' })
    expect(events.filter(event => event.kind !== 'set')).toEqual([])
    // The tries are untouched: the first wrong grant has four left, and the right PIN then confirms.
    const wrong = await grant('135790')
    expect(wrong.body).toMatchObject({ error: 'PIN_INVALID', triesLeft: 4, removed: false })
    expect(granted()).toBe(false)
    expect((await grant()).status).toBe(200)
    expect(granted()).toBe(true)
  }, SCRYPT_TIMEOUT_MS)

  it('is refused on the Funnel listener and the loopback listener, for the unlock and for the grant', async () => {
    const funnelToken = await signIn(first, FUNNEL)
    const asFunnel = { cookie: `${REACH_SESSION_COOKIE}=${funnelToken}` }
    // Pins the address rule: version 1 confirms with a PIN on the private address only.
    expect(await send('POST', `${PIN_PATHS.unlock}?funnel`, { secret: PIN }, asFunnel)).toMatchObject({ status: 403, body: { error: 'ELEVATION_REQUIRED' } })
    expect(await grant(PIN, funnelToken, 'funnel')).toMatchObject({ status: 403, body: { error: 'PIN_NOT_ALLOWED_ON_ADDRESS' } })
    expect(await send('POST', PIN_PATHS.unlock, { secret: PIN })).toMatchObject({ status: 421, body: { error: 'HOST_MISMATCH' } })
    expect(await send('POST', PASSKEY_PATHS.pin, { secret: PIN, actions: [{ action: ACTION, hash: HASH }] })).toMatchObject({ status: 421, body: { error: 'HOST_MISMATCH' } })
    expect(granted(first, FUNNEL)).toBe(false)
    expect(granted()).toBe(false)
    expect(running(FUNNEL)).toBeUndefined()
    expect(running()).toBeUndefined()
  })

  it('answers a wrong secret on the grant with the tries left, and a foreign page\'s POST with a refusal', async () => {
    const wrong = await grant('135790')
    expect(wrong).toMatchObject({ status: 403, body: { error: 'PIN_INVALID' } })
    expect(wrong.text).toContain('4 tries left')
    // Pins the structured fields a page reads instead of the sentence.
    expect(wrong.body).toMatchObject({ triesLeft: 4, removed: false })
    expect(wrong.text).not.toContain('135790')
    // Pins the origin fence on the grant route and on the unlock route.
    const foreign = { 'sec-fetch-site': 'cross-site' }
    expect(await send('POST', `${PASSKEY_PATHS.pin}?reach`, { secret: PIN, actions: [{ action: ACTION, hash: HASH }] }, foreign)).toMatchObject({ status: 403, body: { error: 'ORIGIN_MISMATCH' } })
    expect(await send('POST', `${PIN_PATHS.unlock}?reach`, { secret: PIN }, foreign)).toMatchObject({ status: 403, body: { error: 'ORIGIN_MISMATCH' } })
    expect(granted()).toBe(false)
    expect(running()).toBeUndefined()
  })

  it('mints no grant when every device is signed out while the request body is still arriving', async () => {
    // Pins the checks that run after the body is read: the route admitted the session before it, so the sign-out in between
    // is seen only by the session check before the grant is minted.
    await turnOn()
    const reply = await new Promise<Reply>((resolve, reject) => {
      const text = JSON.stringify({ secret: PIN, actions: [{ action: ACTION, hash: HASH }] })
      const host = `127.0.0.1:${String(port)}`
      const request = httpRequest({
        host: '127.0.0.1', port, method: 'POST', path: `${PASSKEY_PATHS.pin}?reach`, setHost: false, agent: false,
        headers: { host, cookie: `${REACH_SESSION_COOKIE}=${token}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) },
      }, (response) => {
        let received = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => { received += chunk })
        response.on('end', () => { resolve({ status: response.statusCode ?? 0, text: received, body: received === '' ? {} : JSON.parse(received) as Record<string, unknown> }) })
      })
      request.on('error', reject)
      request.write(text.slice(0, 10))
      // The first part has arrived and the route has admitted the session; the rest follows the sign-out.
      setTimeout(() => {
        home.auth.signAllDevicesOut().then(() => { request.end(text.slice(10)) }, reject)
      }, 100)
    })
    expect(reply.status).toBeGreaterThanOrEqual(400)
    expect(granted()).toBe(false)
  }, SCRYPT_TIMEOUT_MS)

  it('gives no unlock window to a device with a passkey or without one, and a grant to both', async () => {
    await home.auth.passkeyStore.add({
      credentialId: 'cred-1', publicKey: 'AAAA', counter: 0, backupEligible: false, backupState: false, transports: [], createdAt: 1, lastUsedAt: null,
      address: ADDRESS, rpId: '127.0.0.1', deviceId: first,
    })
    const other = await addDevice(2)
    // Pins the window rule (A483): removing the unlock refusal gives the device without a passkey the page window it had before.
    expect(await unlock()).toMatchObject({ status: 403, body: { error: 'ELEVATION_REQUIRED' } })
    expect(await unlock(PIN, other.token)).toMatchObject({ status: 403, body: { error: 'ELEVATION_REQUIRED' } })
    expect(running()).toBeUndefined()
    expect(home.auth.elevationsAtComputer().running).toEqual([])
    expect((await grant()).status).toBe(200)
    expect((await grant(PIN, other.token)).status).toBe(200)
    expect(granted(first)).toBe(true)
    expect(granted(other.deviceId)).toBe(true)
  })

  it('admits nothing on a forged Delorun-Unlock header from any device, session or listener, and reports no window', async () => {
    const other = await addDevice(2)
    const sameDeviceElsewhere = await signIn(first)
    const funnelSession = await signIn(first, FUNNEL)
    expect((await grant()).status).toBe(200)
    for (const [label, cookie, suffix] of [['device', other.token, 'reach'], ['session', sameDeviceElsewhere, 'reach'], ['listener', funnelSession, 'funnel'], ['first device', token, 'reach']] as const) {
      for (const forged of ['unknown-token', 'A'.repeat(43), 'a'.repeat(64)]) {
        const headers = { cookie: `${REACH_SESSION_COOKIE}=${cookie}`, 'delorun-unlock': forged }
        // Pins the header check: a touch or lock that finds no unlock of the token refuses and ends nothing, whoever sends it.
        expect(await send('POST', `${PIN_PATHS.touch}?${suffix}`, undefined, headers), label).toMatchObject({ status: 401, body: { error: 'UNLOCK_INVALID' } })
        expect(await send('POST', `${PIN_PATHS.lock}?${suffix}`, undefined, headers), label).toMatchObject({ status: 401, body: { error: 'UNLOCK_INVALID' } })
      }
    }
    // A token in the query or the body, or no header at all, is no token.
    expect(await send('POST', `${PIN_PATHS.touch}?reach&token=${'a'.repeat(43)}`, { token: 'a'.repeat(43) })).toMatchObject({ status: 401, body: { error: 'UNLOCK_INVALID' } })
    expect(await send('POST', `${PIN_PATHS.lock}?reach`)).toMatchObject({ status: 401, body: { error: 'UNLOCK_INVALID' } })
    // Pins the state: a page that sends a token and holds a grant still sees no unlock, idle end or cap.
    const state = await send('GET', `${PIN_PATHS.state}?reach`, undefined, { 'delorun-unlock': 'a'.repeat(43) })
    expect(state.body).toMatchObject({ kind: 'on', secret: 'pin', paused: false, lockWhenHidden: false, unlock: null })
    expect(state.text).not.toContain('endsAt')
    expect(running()).toBeUndefined()
    expect(granted()).toBe(true)
  })

  it('opens no window across a session roll in the grace, on the old cookie or the new one', async () => {
    const HOUR = 60 * MINUTE
    const oldToken = (await home.auth.openSession({ deviceId: first, listener: PRIVATE, address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: 72 * HOUR })).token
    for (const hours of [11, 11, 2]) {
      home.clock.advance(hours * HOUR)
      if (hours === 11) home.auth.admitToken(oldToken, PRIVATE)
    }
    const rolled = home.auth.admitToken(oldToken, PRIVATE, { roll: true })
    if (rolled.kind !== 'admitted' || rolled.rolled === undefined) throw new Error('the session did not roll')
    // Pins the unlock refusal on both cookies of a rolled session: no id mapping can bind a window that is never minted.
    for (const cookie of [oldToken, rolled.rolled.token]) {
      expect(await unlock(PIN, cookie)).toMatchObject({ status: 403, body: { error: 'ELEVATION_REQUIRED' } })
      expect(await send('POST', `${PIN_PATHS.touch}?reach`, undefined, { cookie: `${REACH_SESSION_COOKIE}=${cookie}`, 'delorun-unlock': 'a'.repeat(43) })).toMatchObject({ status: 401, body: { error: 'UNLOCK_INVALID' } })
    }
    expect(running()).toBeUndefined()
  })

  it('opens no window at any age: no idle end or absolute cap can come', async () => {
    // Pins the unlock refusal over time: removing it lets a window start that the idle minutes and the twelve-hour cap would then end.
    expect(await unlock()).toMatchObject({ status: 403, body: { error: 'ELEVATION_REQUIRED' } })
    home.clock.advance(PIN_MODE_LIMITS.defaultIdleMinutes * MINUTE - 1)
    expect((await send('GET', `${PIN_PATHS.state}?reach`, undefined, { 'delorun-unlock': 'a'.repeat(43) })).body).toMatchObject({ kind: 'on', unlock: null })
    home.clock.advance(PIN_MODE_LIMITS.absoluteCapMs)
    expect(running()).toBeUndefined()
    expect(changes.filter(change => change.kind === 'started')).toEqual([])
    expect(changes.filter(change => change.kind === 'ended')).toEqual([])
  })

  it('refuses the old PIN once the computer changes it, and ends the grants of a removed device', async () => {
    expect((await grant()).status).toBe(200)
    expect((await send('POST', PIN_PATHS.set, { secret: '739150' })).status).toBe(200)
    // Pins the PIN change: the old PIN confirms nothing and the new one confirms.
    expect(await grant()).toMatchObject({ status: 403, body: { error: 'PIN_INVALID' } })
    expect((await grant('739150')).status).toBe(200)
    expect(running()).toBeUndefined()
    // Pins the grant end at device removal: a grant never outlives its device.
    expect(granted()).toBe(true)
    await home.auth.revokeDevice(first)
    expect(granted()).toBe(false)
    expect(running()).toBeUndefined()
  })
})

describe('wrong tries', () => {
  beforeEach(async () => { await turnOn() })

  it('remove the device on the fifth and close its sessions', async () => {
    for (let tries = 4; tries >= 1; tries -= 1) {
      const reply = await grant('135790')
      expect(reply.text).toContain(`${String(tries)} ${tries === 1 ? 'try' : 'tries'} left`)
    }
    const last = await grant('135790')
    // Pins the lockout: the fifth wrong try removes the device as the computer's removal does.
    expect(last).toMatchObject({ status: 403, body: { error: 'PIN_INVALID' } })
    expect(last.text).toContain('signed out')
    expect(last.body).toMatchObject({ triesLeft: 0, removed: true })
    expect(home.closed).toContainEqual({ deviceId: first })
    expect((await home.auth.devices()).devices.map(device => device.id)).not.toContain(first)
    expect(home.auth.admitToken(token, PRIVATE)).toMatchObject({ kind: 'refused' })
    expect(await grant(PIN)).toMatchObject({ status: 401 })
    expect(granted()).toBe(false)
    expect(events.some(event => event.kind === 'lockout')).toBe(true)
  })

  it('count twenty parallel guesses as at most five', async () => {
    const replies = await Promise.all(Array.from({ length: 20 }, () => grant('135790')))
    // Pins the count-before-compare under a per-device queue: only four guesses are told how many tries are left.
    expect(replies.filter(reply => /tries? left/.test(reply.text)).length).toBeLessThanOrEqual(4)
    expect(replies.filter(reply => reply.text.includes('signed out')).length).toBeGreaterThanOrEqual(1)
    expect(replies.every(reply => reply.status === 403 || reply.status === 401)).toBe(true)
    expect((await home.auth.devices()).devices.map(device => device.id)).not.toContain(first)
    expect(granted()).toBe(false)
  })

  it('pause every device\'s PIN after ten across the home, until the computer resumes', async () => {
    const devices = [{ deviceId: first, token }, await addDevice(2), await addDevice(3)]
    for (const [index, device] of devices.entries()) {
      for (let miss = 0; miss < (index === 2 ? 2 : 4); miss += 1) await grant('135790', device.token)
    }
    // Pins the home-wide count: the tenth miss pauses even a correct PIN from a device that missed twice.
    const third = devices[2]
    expect(await grant(PIN, third?.token)).toMatchObject({ status: 429, body: { error: 'PIN_UNLOCKS_PAUSED', paused: true } })
    expect(granted(third?.deviceId)).toBe(false)
    expect(events.some(event => event.kind === 'paused')).toBe(true)
    expect((await send('GET', PIN_PATHS.mode)).body).toMatchObject({ enabled: true, paused: true })
    await send('POST', PIN_PATHS.resume, {})
    expect((await grant(PIN, third?.token)).status).toBe(200)
    expect(granted(third?.deviceId)).toBe(true)
  })
})

describe('the store', () => {
  it('keeps the wrong tries across a restart', async () => {
    const options = { directory: home.directory, now: home.clock.read }
    const store = new PinModeStore(options)
    await store.set(PIN)
    for (let miss = 0; miss < 3; miss += 1) await store.check('device-a', '135790')
    const restarted = new PinModeStore(options)
    await restarted.load()
    // Pins the persisted count: a restart does not give the device its tries back.
    expect(await restarted.check('device-a', '135790')).toEqual({ kind: 'wrong', triesLeft: 1 })
    expect(await restarted.check('device-a', '135790')).toEqual({ kind: 'lockout' })
  })

  it('forgets home-wide misses older than 24 hours and clears a device\'s count on success', async () => {
    const store = new PinModeStore({ directory: home.directory, now: home.clock.read })
    await store.set(PIN)
    for (let miss = 0; miss < 4; miss += 1) await store.check('a', '135790')
    expect(await store.check('a', PIN)).toEqual({ kind: 'ok' })
    expect(await store.check('a', '135790')).toEqual({ kind: 'wrong', triesLeft: 4 })
    home.clock.advance(PIN_MODE_LIMITS.homeWindowMs + 1)
    for (const device of ['b', 'c', 'd']) {
      for (let miss = 0; miss < 3; miss += 1) await store.check(device, '135790')
    }
    // Pins the window: nine recent misses and five old ones do not pause.
    expect(store.summary().paused).toBe(false)
  }, SCRYPT_TIMEOUT_MS)

  it('compares a passcode in NFC and refuses a store another user could read', async () => {
    const store = new PinModeStore({ directory: home.directory, now: home.clock.read })
    await store.set('café au lait 1')
    expect(await store.check('a', 'café au lait 1')).toEqual({ kind: 'ok' })
  })
})

describe('a change while a secret is being compared', () => {
  beforeEach(async () => { await turnOn() })

  /**
   * Start a PIN grant whose comparison waits until the gate opens.
   * @returns the pending reply, the point the comparison started and the gate's opener.
   */
  async function gated(): Promise<{ readonly reply: Promise<Reply>; readonly open: () => void }> {
    const store = home.auth['pinStore']
    const real = store['derive'].bind(store)
    let open: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { open = resolve })
    let entered: () => void = () => undefined
    const started = new Promise<void>((resolve) => { entered = resolve })
    let first = true
    store['derive'] = async (...args: Parameters<typeof real>) => {
      if (!first) return real(...args)
      first = false
      entered()
      await gate
      return real(...args)
    }
    const reply = grant()
    await started
    return { reply, open }
  }

  it('refuses the old PIN when the computer turns the mode off', async () => {
    const { reply, open } = await gated()
    await home.auth.pin.off()
    open()
    // Pins the generation check: an emergency turn-off is not followed by a grant from a try already in flight.
    expect((await reply).status).not.toBe(200)
    expect(granted()).toBe(false)
    expect(running()).toBeUndefined()
  })

  it('refuses the old PIN when the computer changes it', async () => {
    const { reply, open } = await gated()
    await home.auth.pin.set('739150', {})
    open()
    expect((await reply).status).not.toBe(200)
    expect(granted()).toBe(false)
    expect(running()).toBeUndefined()
  })

  it('mints nothing when the device is removed', async () => {
    const { reply, open } = await gated()
    await home.auth.revokeDevice(first)
    open()
    expect((await reply).status).not.toBe(200)
    expect(granted()).toBe(false)
    expect(running()).toBeUndefined()
  })

  it('mints nothing when the session ends', async () => {
    const { reply, open } = await gated()
    home.clock.advance(61 * MINUTE)
    home.auth.admitToken(token, PRIVATE)
    open()
    expect((await reply).status).not.toBe(200)
    expect(granted()).toBe(false)
    expect(running()).toBeUndefined()
  })

  it('mints nothing when the listener stops being served', async () => {
    const { reply, open } = await gated()
    stopServing()
    open()
    expect((await reply).status).not.toBe(200)
    expect(granted()).toBe(false)
    expect(running()).toBeUndefined()
  })
})

describe('home-wide pause on every miss path', () => {
  /**
   * Miss five times with one session, which removes its device.
   * @param cookie - the session token.
   */
  async function ceiling(cookie: string): Promise<void> {
    for (let miss = 0; miss < 5; miss += 1) await grant('135790', cookie)
  }

  it('pauses after two devices miss five times each', async () => {
    await turnOn()
    const second = await addDevice(2)
    const third = await addDevice(3)
    const fourth = await addDevice(4)
    await ceiling(second.token)
    // A removal rotates the home's sessions, so the next device signs in again.
    await ceiling(await signIn(third.deviceId))
    // Pins the count on the lockout path: ten misses pause even when each device was removed by its own fifth.
    expect(await grant(PIN, await signIn(fourth.deviceId))).toMatchObject({ status: 429, body: { error: 'PIN_UNLOCKS_PAUSED' } })
    expect(granted(fourth.deviceId)).toBe(false)
    expect(events.some(event => event.kind === 'paused')).toBe(true)
  }, SCRYPT_TIMEOUT_MS)
})

describe('structured PIN refusals and the state fields', () => {
  it('answers triesLeft and removed on a wrong PIN, paused on a pause, and lockWhenHidden in the state', async () => {
    expect((await send('POST', PIN_PATHS.set, { secret: PIN, lockWhenHidden: true })).status).toBe(200)
    // Pins the state field: the client locks on hide only when the home says so.
    expect((await send('GET', `${PIN_PATHS.state}?reach`)).body).toMatchObject({ kind: 'on', lockWhenHidden: true })
    const second = await addDevice(2)
    const third = await addDevice(3)
    const fourth = await addDevice(4)
    // Pins the structured miss: the client reads numbers, not the sentence.
    expect(await grant('135790', second.token)).toMatchObject({ body: { error: 'PIN_INVALID', triesLeft: 4, removed: false } })
    for (let miss = 0; miss < 3; miss += 1) await grant('135790', second.token)
    expect(await grant('135790', second.token)).toMatchObject({ body: { error: 'PIN_INVALID', triesLeft: 0, removed: true } })
    for (let miss = 0; miss < 5; miss += 1) await grant('135790', await signIn(third.deviceId))
    // Pins the structured pause.
    expect(await grant(PIN, await signIn(fourth.deviceId))).toMatchObject({ status: 429, body: { error: 'PIN_UNLOCKS_PAUSED', paused: true } })
  }, 40_000)
})

describe('the PIN state and the hash cost', () => {
  it('reports no unlock, idle end or cap after a grant, as no window exists', async () => {
    await turnOn()
    expect((await grant()).status).toBe(200)
    const state = await send('GET', `${PIN_PATHS.state}?reach`)
    // Pins the state: removing the unlock refusal lets a window appear in the state with its idle end and cap.
    expect(state.body).toEqual({ kind: 'on', secret: 'pin', idleMinutes: PIN_MODE_LIMITS.defaultIdleMinutes, lockWhenHidden: false, paused: false, unlock: null })
  })

  it('hashes a new PIN at 2^17 and still verifies a record with the earlier parameters', async () => {
    const options = { directory: home.directory, now: home.clock.read }
    const store = new PinModeStore(options)
    await store.set(PIN)
    const written = JSON.parse(await readFile(join(home.directory, HOME_AUTH_FILES.pinMode), 'utf8')) as { hash: { N: number; r: number; p: number; salt: string; dk: string } }
    expect(written.hash).toMatchObject({ N: 131072, r: 8, p: 1 })
    const salt = randomBytes(16)
    const old = scryptSync(PIN, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
    const file = join(home.directory, HOME_AUTH_FILES.pinMode)
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')) as object, hash: { alg: 'scrypt', N: 32768, r: 8, p: 1, salt: salt.toString('base64url'), dk: old.toString('base64url') } }), { mode: 0o600 })
    const reloaded = new PinModeStore(options)
    await reloaded.load()
    // Pins the stored parameters: a record made at 2^15 still verifies after the cost rose.
    expect(await reloaded.check('a', PIN)).toEqual({ kind: 'ok' })
  })
})
