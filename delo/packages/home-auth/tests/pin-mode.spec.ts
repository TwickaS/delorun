/**
 * PIN mode in the home (C14, "PIN mode"): the computer-only routes that set the PIN, the page unlock a PIN mints on the
 * Tailscale private listener, its token binding, its idle and absolute ends, the wrong tries that remove a device or
 * pause unlocks, and the guarantee that the PIN reaches no log, error or file in the clear.
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { REACH_SESSION_COOKIE, type DeviceId, type ReachListenerId, type StudioAddress } from '@delo/contract-admission'
import { HOME_AUTH_FILES } from '@delo/contract-device-approval'
import { PIN_MODE_LIMITS } from '@delo/contract-oidc-passkeys'
import { stampListener } from '@delo/home'
import { DeviceStore } from '../src/devices.ts'
import type { ElevationChange } from '../src/elevation.ts'
import { PinModeStore } from '../src/pin-mode.ts'
import type { PinEvent } from '../src/pin-unlocks.ts'
import { PIN_PATHS, pinLockHandler, pinModeHandler, pinOffHandler, pinResumeHandler, pinSetHandler, pinStateHandler, pinTouchHandler, pinUnlockHandler } from '../src/pin-routes.ts'
import type { RouteHandler } from '../src/routes.ts'
import { claimOf, homeFixture, recordOf, STUDIO_COOKIE, testCredential, type Home } from './fixtures/home.ts'

const ADDRESS = brandString<StudioAddress>('https://home.example.ts.net')
const PRIVATE: ReachListenerId = 'reach-tailscale-private'
const FUNNEL: ReachListenerId = 'reach-tailscale-funnel'
const PIN = '482916'
const MINUTE = 60_000

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
    [PIN_PATHS.mode]: pinModeHandler(home.auth, testCredential),
    [PIN_PATHS.set]: pinSetHandler(home.auth, testCredential),
    [PIN_PATHS.off]: pinOffHandler(home.auth, testCredential),
    [PIN_PATHS.resume]: pinResumeHandler(home.auth, testCredential),
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
function running(listener: ReachListenerId = PRIVATE): { readonly id: string; readonly sessionId: string } | undefined {
  return home.auth.elevationsAtComputer().running.find(record => record.deviceId === first && record.listener === listener)
}

/** Turn the mode on at the computer. */
async function turnOn(secret: string = PIN): Promise<void> {
  expect((await send('POST', PIN_PATHS.set, { secret })).status).toBe(200)
}

/**
 * Unlock the first device's page.
 * @param secret - the PIN to send.
 * @param cookie - the session token to send, the first device's by default.
 * @returns the reply.
 */
function unlock(secret: string = PIN, cookie: string = token): Promise<Reply> {
  return send('POST', `${PIN_PATHS.unlock}?reach`, { secret }, { cookie: `${REACH_SESSION_COOKIE}=${cookie}` })
}

describe('with PIN mode off', () => {
  it('answers an unlock as off and mints no elevation', async () => {
    // Pins the mode check: an unlock on a home that never turned the mode on succeeds nowhere.
    expect(await unlock()).toMatchObject({ status: 409, body: { error: 'PIN_MODE_OFF' } })
    expect((await send('GET', `${PIN_PATHS.state}?reach`)).body).toEqual({ kind: 'off' })
    expect(running()).toBeUndefined()
    expect(home.auth.elevationsAtComputer().running).toEqual([])
    // A header the old home never reads changes nothing.
    expect((await send('GET', `${PIN_PATHS.state}?reach`, undefined, { 'delo-unlock': 'anything' })).body).toEqual({ kind: 'off' })
  })

  it('is off again after the computer turns it off', async () => {
    await turnOn()
    const unlocked = await unlock()
    expect(unlocked.status).toBe(200)
    expect((await send('POST', PIN_PATHS.off, {})).body).toEqual({ enabled: false })
    // Pins the end at mode off: the unlock goes with the mode.
    expect(running()).toBeUndefined()
    expect(changes.at(-1)).toMatchObject({ kind: 'ended', reason: 'pin-mode-off' })
    expect(await unlock()).toMatchObject({ status: 409, body: { error: 'PIN_MODE_OFF' } })
  })
})

describe('setting the PIN', () => {
  it('is the computer\'s alone', async () => {
    // Pins the computer-only rule: a device, unlocked or not, never sets, clears or resumes in version 1.
    for (const path of [PIN_PATHS.set, PIN_PATHS.off, PIN_PATHS.resume]) {
      expect(await send('POST', `${path}?reach`, { secret: PIN })).toMatchObject({ status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
    }
    expect(await send('GET', `${PIN_PATHS.mode}?reach`)).toMatchObject({ status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
    expect(home.auth.pin.summary().enabled).toBe(false)
    await turnOn()
    // The same refusal while the mode is on and the device is unlocked.
    expect((await unlock()).status).toBe(200)
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
    expect((await unlock('wrong horse battery')).status).toBe(403)
    expect((await unlock(passcode)).status).toBe(200)
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

describe('a page unlock', () => {
  beforeEach(async () => { await turnOn() })

  it('admits the device\'s elevated actions and reports its state to the page that holds the token', async () => {
    const reply = await unlock()
    expect(reply).toMatchObject({ status: 200, body: { token: expect.any(String), unlockId: expect.any(String) } })
    expect(running()?.id).toBe(reply.body.unlockId)
    // Pins the once-only token: the home keeps a digest, so no read gives it back.
    const state = await send('GET', `${PIN_PATHS.state}?reach`, undefined, { 'delo-unlock': reply.body.token as string })
    expect(state.body).toMatchObject({ kind: 'on', secret: 'pin', paused: false, unlock: { unlockId: reply.body.unlockId } })
    expect(JSON.stringify(state.body)).not.toContain(reply.body.token as string)
    // A page without the token sees the mode and no unlock.
    expect((await send('GET', `${PIN_PATHS.state}?reach`)).body).toMatchObject({ kind: 'on', unlock: null })
  })

  it('is refused on the Funnel listener and the loopback listener', async () => {
    const funnelToken = await signIn(first, FUNNEL)
    // Pins the address rule: version 1 unlocks with a PIN on the private address only.
    expect(await send('POST', `${PIN_PATHS.unlock}?funnel`, { secret: PIN }, { cookie: `${REACH_SESSION_COOKIE}=${funnelToken}` })).toMatchObject({ status: 403, body: { error: 'PIN_NOT_ALLOWED_ON_ADDRESS' } })
    expect(await send('POST', PIN_PATHS.unlock, { secret: PIN })).toMatchObject({ status: 421, body: { error: 'HOST_MISMATCH' } })
    expect(running(FUNNEL)).toBeUndefined()
    expect(running()).toBeUndefined()
  })

  it('answers a wrong secret with the tries left and a foreign page\'s POST with a refusal', async () => {
    const wrong = await unlock('135790')
    expect(wrong).toMatchObject({ status: 403, body: { error: 'PIN_INVALID' } })
    expect(wrong.text).toContain('4 tries left')
    expect(wrong.text).not.toContain('135790')
    // Pins the origin fence on the unlock.
    expect(await send('POST', `${PIN_PATHS.unlock}?reach`, { secret: PIN }, { 'sec-fetch-site': 'cross-site' })).toMatchObject({ status: 403, body: { error: 'ORIGIN_MISMATCH' } })
    expect(running()).toBeUndefined()
  })

  it('refuses a token from another device, another session or another listener, and ends the unlock', async () => {
    const other = await addDevice(2)
    const sameDeviceElsewhere = await signIn(first)
    const funnelSession = await signIn(first, FUNNEL)
    for (const [label, cookie, suffix] of [['device', other.token, 'reach'], ['session', sameDeviceElsewhere, 'reach'], ['listener', funnelSession, 'funnel']] as const) {
      const unlocked = await unlock()
      const header = unlocked.body.token as string
      expect(running(), label).toBeDefined()
      // Pins the binding: the digest names its device, listener and session, and a mismatch burns the unlock.
      const replay = await send('POST', `${PIN_PATHS.touch}?${suffix}`, undefined, { cookie: `${REACH_SESSION_COOKIE}=${cookie}`, 'delo-unlock': header })
      expect(replay, label).toMatchObject({ status: 401, body: { error: 'UNLOCK_INVALID' } })
      expect(running(), label).toBeUndefined()
      const burnt = await send('POST', `${PIN_PATHS.touch}?reach`, undefined, { 'delo-unlock': header })
      expect(burnt, label).toMatchObject({ status: 401, body: { error: 'UNLOCK_INVALID' } })
    }
    expect(changes.filter(change => change.kind === 'ended' && change.reason === 'token-refused')).toHaveLength(3)
  })

  it('reads the token from the header only', async () => {
    const unlocked = await unlock()
    const header = unlocked.body.token as string
    // Pins the header-only rule: a query or body token is no token.
    expect(await send('POST', `${PIN_PATHS.touch}?reach&token=${header}`, { token: header })).toMatchObject({ status: 401, body: { error: 'UNLOCK_INVALID' } })
    expect(await send('POST', `${PIN_PATHS.touch}?reach`, undefined, { 'delo-unlock': 'unknown-token' })).toMatchObject({ status: 401, body: { error: 'UNLOCK_INVALID' } })
    expect(running()).toBeDefined()
  })

  it('locks on the lock route', async () => {
    const header = (await unlock()).body.token as string
    expect(await send('POST', `${PIN_PATHS.lock}?reach`, undefined, { 'delo-unlock': header })).toMatchObject({ status: 200, body: { locked: true } })
    // Pins the server-side end: the lock button ends the unlock, not only the page's copy of the token.
    expect(running()).toBeUndefined()
    expect(await send('POST', `${PIN_PATHS.touch}?reach`, undefined, { 'delo-unlock': header })).toMatchObject({ status: 401 })
  })

  it('ends after the idle minutes, and activity moves the end forward', async () => {
    const header = (await unlock()).body.token as string
    home.clock.advance(10 * MINUTE)
    expect(await send('POST', `${PIN_PATHS.touch}?reach`, undefined, { 'delo-unlock': header })).toMatchObject({ status: 200 })
    home.clock.advance(10 * MINUTE)
    // Pins the touch: 20 minutes after the unlock, 10 after the touch, it stands.
    expect(running()).toBeDefined()
    // A poll that carries the token is not activity: only a touch moves the idle end.
    for (let poll = 0; poll < PIN_MODE_LIMITS.defaultIdleMinutes; poll += 1) {
      home.clock.advance(MINUTE)
      await send('GET', `${PIN_PATHS.state}?reach`, undefined, { 'delo-unlock': header })
    }
    home.clock.advance(MINUTE)
    // Pins the idle end.
    expect(running()).toBeUndefined()
    expect(changes.at(-1)).toMatchObject({ kind: 'ended', reason: 'expired' })
  })

  it('ends at the absolute cap however active the page is', async () => {
    const unlocked = await unlock()
    const header = unlocked.body.token as string
    const asker = { deviceId: first, listener: PRIVATE, sessionId: running()?.sessionId ?? '' }
    let elapsed = 0
    while (elapsed + 10 * MINUTE < PIN_MODE_LIMITS.absoluteCapMs) {
      home.clock.advance(10 * MINUTE)
      elapsed += 10 * MINUTE
      home.auth.pin.touch(header, asker)
    }
    expect(running()).toBeDefined()
    home.clock.advance(PIN_MODE_LIMITS.absoluteCapMs - elapsed + 1)
    // Pins the cap: touching never pushes the end past twelve hours from the unlock.
    expect(running()).toBeUndefined()
  })

  it('ends when the PIN changes, and when the device\'s session ends', async () => {
    await unlock()
    expect((await send('POST', PIN_PATHS.set, { secret: '739150' })).status).toBe(200)
    expect(running()).toBeUndefined()
    expect(changes.at(-1)).toMatchObject({ kind: 'ended', reason: 'pin-changed' })
    expect((await unlock('739150')).status).toBe(200)
    await home.auth.revokeDevice(first)
    expect(running()).toBeUndefined()
  })
})

describe('wrong tries', () => {
  beforeEach(async () => { await turnOn() })

  it('remove the device on the fifth and close its sessions', async () => {
    for (let tries = 4; tries >= 1; tries -= 1) {
      const reply = await unlock('135790')
      expect(reply.text).toContain(`${String(tries)} ${tries === 1 ? 'try' : 'tries'} left`)
    }
    const last = await unlock('135790')
    // Pins the lockout: the fifth wrong try removes the device as the computer's removal does.
    expect(last).toMatchObject({ status: 403, body: { error: 'PIN_INVALID' } })
    expect(last.text).toContain('signed out')
    expect(home.closed).toContainEqual({ deviceId: first })
    expect((await home.auth.devices()).devices.map(device => device.id)).not.toContain(first)
    expect(home.auth.admitToken(token, PRIVATE)).toMatchObject({ kind: 'refused' })
    expect(await unlock(PIN)).toMatchObject({ status: 401 })
    expect(events.some(event => event.kind === 'lockout')).toBe(true)
  })

  it('count twenty parallel guesses as at most five', async () => {
    const replies = await Promise.all(Array.from({ length: 20 }, () => unlock('135790')))
    // Pins the count-before-compare under a per-device queue: only four guesses are told how many tries are left.
    expect(replies.filter(reply => /tries? left/.test(reply.text)).length).toBeLessThanOrEqual(4)
    expect(replies.filter(reply => reply.text.includes('signed out')).length).toBeGreaterThanOrEqual(1)
    expect(replies.every(reply => reply.status === 403 || reply.status === 401)).toBe(true)
    expect((await home.auth.devices()).devices.map(device => device.id)).not.toContain(first)
  })

  it('pause every device\'s unlock after ten across the home, until the computer resumes', async () => {
    const devices = [{ deviceId: first, token }, await addDevice(2), await addDevice(3)]
    for (const [index, device] of devices.entries()) {
      for (let miss = 0; miss < (index === 2 ? 2 : 4); miss += 1) await unlock('135790', device.token)
    }
    // Pins the home-wide count: the tenth miss pauses even a correct PIN from a device that missed twice.
    const third = devices[2]
    expect(await unlock(PIN, third?.token)).toMatchObject({ status: 429, body: { error: 'PIN_UNLOCKS_PAUSED' } })
    expect(events.some(event => event.kind === 'paused')).toBe(true)
    expect((await send('GET', PIN_PATHS.mode)).body).toMatchObject({ enabled: true, paused: true })
    await send('POST', PIN_PATHS.resume, {})
    expect((await unlock(PIN, third?.token)).status).toBe(200)
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
  })

  it('compares a passcode in NFC and refuses a store another user could read', async () => {
    const store = new PinModeStore({ directory: home.directory, now: home.clock.read })
    await store.set('café au lait 1')
    expect(await store.check('a', 'café au lait 1')).toEqual({ kind: 'ok' })
  })
})

describe('a change while a secret is being compared', () => {
  beforeEach(async () => { await turnOn() })

  /**
   * Start an unlock whose comparison waits until the gate opens.
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
    const reply = unlock()
    await started
    return { reply, open }
  }

  it('refuses the old PIN when the computer turns the mode off', async () => {
    const { reply, open } = await gated()
    await home.auth.pin.off()
    open()
    // Pins the generation check: an emergency turn-off is not followed by an unlock from a try already in flight.
    expect((await reply).status).not.toBe(200)
    expect(running()).toBeUndefined()
  })

  it('refuses the old PIN when the computer changes it', async () => {
    const { reply, open } = await gated()
    await home.auth.pin.set('739150', {})
    open()
    expect((await reply).status).not.toBe(200)
    expect(running()).toBeUndefined()
  })

  it('mints nothing when the device is removed', async () => {
    const { reply, open } = await gated()
    await home.auth.revokeDevice(first)
    open()
    expect((await reply).status).not.toBe(200)
    expect(running()).toBeUndefined()
  })

  it('mints nothing when the session ends', async () => {
    const { reply, open } = await gated()
    home.clock.advance(61 * MINUTE)
    home.auth.admitToken(token, PRIVATE)
    open()
    expect((await reply).status).not.toBe(200)
    expect(running()).toBeUndefined()
  })

  it('mints nothing when the listener stops being served', async () => {
    const { reply, open } = await gated()
    stopServing()
    open()
    expect((await reply).status).not.toBe(200)
    expect(running()).toBeUndefined()
  })
})

describe('home-wide pause on every miss path', () => {
  /**
   * Miss five times with one session, which removes its device.
   * @param cookie - the session token.
   */
  async function ceiling(cookie: string): Promise<void> {
    for (let miss = 0; miss < 5; miss += 1) await unlock('135790', cookie)
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
    expect(await unlock(PIN, await signIn(fourth.deviceId))).toMatchObject({ status: 429, body: { error: 'PIN_UNLOCKS_PAUSED' } })
    expect(events.some(event => event.kind === 'paused')).toBe(true)
  })
})

describe('the unlock state and the hash cost', () => {
  it('reports the idle end and the cap as the unlock and the touch do', async () => {
    await turnOn()
    const reply = await unlock()
    const state = await send('GET', `${PIN_PATHS.state}?reach`, undefined, { 'delo-unlock': reply.body.token as string })
    expect(state.body).toMatchObject({ unlock: { unlockId: reply.body.unlockId, endsAt: reply.body.endsAt, idleEndsAt: reply.body.idleEndsAt } })
    expect(reply.body.endsAt).not.toBe(reply.body.idleEndsAt)
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
