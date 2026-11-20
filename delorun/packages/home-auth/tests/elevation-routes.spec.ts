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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { REACH_SESSION_COOKIE, type DeviceId, type StudioAddress } from '@delorun/contract-admission'
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
import { PASSKEY_DEVICES_ACTION, PASSKEY_PATHS, PASSKEY_REMOVE_ACTION, passkeyDevicesHandler, passkeyLockHandler, passkeyPassHandler, passkeyRemoveHandler, passkeyStateHandler } from '../src/passkey-routes.ts'
import { DEVICE_REMOVE_ACTION, DEVICE_REMOVE_PATH, DEVICES_PATH, devicesHandler, removeDeviceHandler, type RouteHandler } from '../src/routes.ts'
import { claimOf, homeFixture, recordOf, STUDIO_COOKIE, testCredential, type Home } from './fixtures/home.ts'
import { DeviceStore } from '../src/devices.ts'
import { hashArgs, PASS_SETTING_ACTION } from '../src/grants.ts'
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
    [PASSKEY_PATHS.remove]: passkeyRemoveHandler(home.auth),
    [PASSKEY_PATHS.state]: passkeyStateHandler(home.auth),
    [PASSKEY_PATHS.devices]: passkeyDevicesHandler(home.auth),
    [PASSKEY_PATHS.lock]: passkeyLockHandler(home.auth),
    [PASSKEY_PATHS.pass]: passkeyPassHandler(home.auth, testCredential),
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

  // Putting a preview-flag check back on the passkey routes makes a home with no flags set answer 404 here.
  it('answers the passkey routes on a home with no preview flags set', async () => {
    expect(await send('GET', `${PASSKEY_PATHS.state}?reach`)).toMatchObject({ status: 200, body: { passkeys: [] } })
  })

  describe('removing a passkey (F20)', () => {
    const record = (credentialId: string, deviceId: string) => ({ credentialId, publicKey: 'k', counter: 0, backupEligible: false, backupState: false, transports: [], createdAt: 1, lastUsedAt: null, address: ADDRESS, rpId: 'home.example.ts.net', deviceId: brandString<DeviceId>(deviceId) })
    const setup = async (): Promise<{ other: ReturnType<typeof recordOf>; current: string; grant: (message: object, factor: 'passkey' | 'pin') => void }> => {
      const other = recordOf(9, ADDRESS)
      await new DeviceStore({ file: join(home.directory, HOME_AUTH_FILES.devices) }).add(other)
      const current = String((await send('GET', `${DEVICES_PATH}?reach`)).body['current'])
      await home.auth.passkeyStore.add(record('cred-other', other.id))
      await home.auth.passkeyStore.add(record('cred-own', current))
      return { other, current, grant: (message, factor) => { home.auth.grants.mint({ deviceId: current, listener: LISTENER }, [{ action: PASSKEY_REMOVE_ACTION, hash: hashArgs(message) ?? '' }], factor) } }
    }

    // Removing the factor check lets a PIN seen on a stolen phone strip Face ID from the owner's other phones: the grant stays unused and the passkey stays.
    it('refuses another device\'s passkey with a grant the PIN minted', async () => {
      const { other, grant } = await setup()
      const message = { credentialId: 'cred-other', deviceId: other.id }
      grant(message, 'pin')
      expect(await send('POST', `${PASSKEY_PATHS.remove}?reach`, message)).toMatchObject({ status: 403, body: { error: 'ELEVATION_REQUIRED' } })
      expect(home.auth.passkeyStore.find('cred-other')).toBeDefined()
    })

    it('removes another device\'s passkey with a grant a passkey minted, once', async () => {
      const { other, grant } = await setup()
      const message = { credentialId: 'cred-other', deviceId: other.id }
      grant(message, 'passkey')
      expect(await send('POST', `${PASSKEY_PATHS.remove}?reach`, message)).toMatchObject({ status: 200, body: { removed: true } })
      expect(home.auth.passkeyStore.find('cred-other')).toBeUndefined()
    })

    it('still takes a PIN grant for the device\'s own passkey', async () => {
      const { grant } = await setup()
      const message = { credentialId: 'cred-own' }
      grant(message, 'pin')
      expect(await send('POST', `${PASSKEY_PATHS.remove}?reach`, message)).toMatchObject({ status: 200, body: { removed: true } })
    })
  })

  describe('removing another device while Face ID is on', () => {
    const body = (deviceId: string): { v: 1; deviceId: string } => ({ v: 1, deviceId })
    const setup = async (): Promise<{ other: ReturnType<typeof recordOf>; current: string; grant: (message: object) => void }> => {
      const other = recordOf(9, ADDRESS)
      await new DeviceStore({ file: join(home.directory, HOME_AUTH_FILES.devices) }).add(other)
      const current = String((await send('GET', `${DEVICES_PATH}?reach`)).body['current'])
      return { other, current, grant: (message) => { home.auth.grants.mint({ deviceId: current, listener: LISTENER }, [{ action: DEVICE_REMOVE_ACTION, hash: hashArgs(message) ?? '' }], 'passkey') } }
    }

    // Removing the hashArgs grant check lets a phone remove another device without Face ID.
    it('removes the other device with a grant for exactly the body sent, once', async () => {
      const { other, grant } = await setup()
      grant(body(other.id))
      expect(await send('POST', `${DEVICE_REMOVE_PATH}?reach`, body(other.id))).toMatchObject({ status: 200, body: { removed: true } })
      expect((await home.auth.devices()).devices.map(device => device.id)).not.toContain(other.id)
    })

    it('is refused with no grant', async () => {
      const { other } = await setup()
      expect(await send('POST', `${DEVICE_REMOVE_PATH}?reach`, body(other.id))).toMatchObject({ status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
      expect((await home.auth.devices()).devices.map(device => device.id)).toContain(other.id)
    })

    // Removing the body hash lets a grant for one device remove another.
    it('is refused with a grant for another deviceId, and the grant stays', async () => {
      const { other, grant, current } = await setup()
      grant(body('someone-else'))
      expect(await send('POST', `${DEVICE_REMOVE_PATH}?reach`, body(other.id))).toMatchObject({ status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
      expect(home.auth.grants.has({ deviceId: current, listener: LISTENER }, DEVICE_REMOVE_ACTION, hashArgs(body('someone-else')) ?? '')).toBe(true)
      expect((await home.auth.devices()).devices.map(device => device.id)).toContain(other.id)
    })

    // Removing the factor check at consume lets a PIN grant remove another device (F20): the grant stays unused and the device stays.
    it('is refused with a grant the PIN minted, and the device stays', async () => {
      const { other, current } = await setup()
      home.auth.grants.mint({ deviceId: current, listener: LISTENER }, [{ action: DEVICE_REMOVE_ACTION, hash: hashArgs(body(other.id)) ?? '' }], 'pin')
      expect(await send('POST', `${DEVICE_REMOVE_PATH}?reach`, body(other.id))).toMatchObject({ status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
      expect((await home.auth.devices()).devices.map(device => device.id)).toContain(other.id)
    })

    // Removing the holder from the grant key lets a grant minted for another device's holder remove a device.
    it('is refused with a grant minted for another device\'s holder, and the device stays', async () => {
      const { other } = await setup()
      home.auth.grants.mint({ deviceId: other.id, listener: LISTENER }, [{ action: DEVICE_REMOVE_ACTION, hash: hashArgs(body(other.id)) ?? '' }], 'passkey')
      expect(await send('POST', `${DEVICE_REMOVE_PATH}?reach`, body(other.id))).toMatchObject({ status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
      expect((await home.auth.devices()).devices.map(device => device.id)).toContain(other.id)
    })

    // Removing the single use lets one confirmation remove a device twice or a replayed body again.
    it('is refused when the grant was used already', async () => {
      const { other, grant } = await setup()
      grant(body(other.id))
      await send('POST', `${DEVICE_REMOVE_PATH}?reach`, body(other.id))
      expect(await send('POST', `${DEVICE_REMOVE_PATH}?reach`, body(other.id))).toMatchObject({ status: 403 })
    })
  })

  it('refuses an unsigned request', async () => {
    expect(await send('GET', `${DEVICES_PATH}?reach`, undefined, { cookie: undefined })).toMatchObject({ status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
  })
})

describe('a Face ID pass (A499) at the device routes', () => {
  const setup = async (): Promise<{ other: ReturnType<typeof recordOf>; current: string; holder: { deviceId: string; listener: typeof LISTENER } }> => {
    const other = recordOf(9, ADDRESS)
    await new DeviceStore({ file: join(home.directory, HOME_AUTH_FILES.devices) }).add(other)
    const current = String((await send('GET', `${DEVICES_PATH}?reach`)).body['current'])
    const holder = { deviceId: current, listener: LISTENER } as const
    home.auth.grants.openPass(holder, 15)
    return { other, current, holder }
  }

  describe('leaves the always-ask rows asking', () => {
    // Pins the always-ask device removal: a pass check in removeDeviceHandler would let a stolen phone in a pass remove the owner's other devices.
    it('refuses removing another device during a pass without its grant', async () => {
      const { other } = await setup()
      expect(await send('POST', `${DEVICE_REMOVE_PATH}?reach`, { v: 1, deviceId: other.id })).toMatchObject({ status: 403, body: { error: 'LOOPBACK_REQUIRED' } })
      expect((await home.auth.devices()).devices.map(device => device.id)).toContain(other.id)
    })

    // Pins the always-ask passkey removal.
    it('refuses removing a passkey during a pass without its grant', async () => {
      const { current } = await setup()
      await home.auth.passkeyStore.add({ credentialId: 'cred-own', publicKey: 'k', counter: 0, backupEligible: false, backupState: false, transports: [], createdAt: 1, lastUsedAt: null, address: ADDRESS, rpId: 'home.example.ts.net', deviceId: brandString<DeviceId>(current) })
      expect(await send('POST', `${PASSKEY_PATHS.remove}?reach`, { credentialId: 'cred-own' })).toMatchObject({ status: 403, body: { error: 'ELEVATION_REQUIRED' } })
      expect(home.auth.passkeyStore.find('cred-own')).toBeDefined()
    })

    // Pins the always-ask Face ID settings list of every device's passkeys.
    it('refuses the devices\' passkey list during a pass without its grant', async () => {
      const { holder } = await setup()
      expect(await send('GET', `${PASSKEY_PATHS.devices}?reach`)).toMatchObject({ status: 403, body: { error: 'ELEVATION_REQUIRED' } })
      home.auth.grants.mint(holder, [{ action: PASSKEY_DEVICES_ACTION, hash: hashArgs({}) ?? '' }], 'passkey')
      expect(await send('GET', `${PASSKEY_PATHS.devices}?reach`)).toMatchObject({ status: 200 })
    })

    // Pins the always-ask pass setting: without the grant check a phone in a pass could lengthen its own pass.
    it('refuses changing the pass setting during a pass without its grant, and the setting stays', async () => {
      await setup()
      expect(await send('POST', `${PASSKEY_PATHS.pass}?reach`, { minutes: 60 })).toMatchObject({ status: 403, body: { error: 'ELEVATION_REQUIRED' } })
      expect(home.auth.passMinutes()).toBe(15)
    })
  })

  describe('the pass setting', () => {
    // Removing the factor check lets a PIN seen on a stolen phone lengthen every phone's pass.
    it('refuses a device\'s change with a grant the PIN minted, and admits one a passkey minted, once', async () => {
      const { holder } = await setup()
      const body = { minutes: 60 }
      home.auth.grants.mint(holder, [{ action: PASS_SETTING_ACTION, hash: hashArgs(body) ?? '' }], 'pin')
      expect(await send('POST', `${PASSKEY_PATHS.pass}?reach`, body)).toMatchObject({ status: 403, body: { error: 'ELEVATION_REQUIRED' } })
      home.auth.grants.mint(holder, [{ action: PASS_SETTING_ACTION, hash: hashArgs(body) ?? '' }], 'passkey')
      expect(await send('POST', `${PASSKEY_PATHS.pass}?reach`, body)).toMatchObject({ status: 200, body: { minutes: 60, choices: [0, 5, 15, 30, 60] } })
      expect(home.auth.passMinutes()).toBe(60)
      expect(await send('POST', `${PASSKEY_PATHS.pass}?reach`, body)).toMatchObject({ status: 403 })
    })

    // Removing the validation stores a length outside the set, at the computer or from a device.
    it('refuses a length outside Every time, 5, 15, 30 and 60 minutes', async () => {
      const { holder } = await setup()
      for (const minutes of [7, 120, -5, '15', null]) {
        const body = { minutes }
        home.auth.grants.mint(holder, [{ action: PASS_SETTING_ACTION, hash: hashArgs(body) ?? '' }], 'passkey')
        expect(await send('POST', `${PASSKEY_PATHS.pass}?reach`, body), JSON.stringify(minutes)).toMatchObject({ status: 400, body: { error: 'BAD_REQUEST' } })
        expect(await send('POST', PASSKEY_PATHS.pass, body), JSON.stringify(minutes)).toMatchObject({ status: 400, body: { error: 'BAD_REQUEST' } })
      }
      expect(home.auth.passMinutes()).toBe(15)
    })

    it('is changed at the computer without a grant, and kept across a restart of the store', async () => {
      expect(await send('GET', PASSKEY_PATHS.pass)).toMatchObject({ status: 200, body: { minutes: 15, pass: null } })
      expect(await send('POST', PASSKEY_PATHS.pass, { minutes: 0 })).toMatchObject({ status: 200, body: { minutes: 0 } })
      await home.auth.passSetting.load()
      expect(home.auth.passMinutes()).toBe(0)
    })

    // Removing endPasses from the route leaves a 60-minute pass running after the person chose Every time (review P2-2).
    it('ends every live pass when it changes, from a device or at the computer', async () => {
      const { other, holder } = await setup()
      const theirs = { deviceId: other.id, listener: LISTENER } as const
      home.auth.grants.openPass(theirs, 15)
      const body = { minutes: 0 }
      home.auth.grants.mint(holder, [{ action: PASS_SETTING_ACTION, hash: hashArgs(body) ?? '' }], 'passkey')
      expect(await send('POST', `${PASSKEY_PATHS.pass}?reach`, body)).toMatchObject({ status: 200, body: { minutes: 0, pass: null } })
      expect(home.auth.grants.passOf(holder)).toBeUndefined()
      expect(home.auth.grants.passOf(theirs)).toBeUndefined()
      home.auth.grants.openPass(theirs, 15)
      expect(await send('POST', PASSKEY_PATHS.pass, { minutes: 30 })).toMatchObject({ status: 200, body: { minutes: 30 } })
      expect(home.auth.grants.passOf(theirs)).toBeUndefined()
    })

    // Pins the computer's arrival check: a foreign origin never changes the setting.
    it('refuses a change at the computer from another origin', async () => {
      expect(await send('POST', PASSKEY_PATHS.pass, { minutes: 60 }, { origin: 'https://evil.example' })).toMatchObject({ status: 403 })
      expect(home.auth.passMinutes()).toBe(15)
    })
  })

  // Only a verified Face ID opens a pass: a code typed at the computer starts an unlock, never a pass.
  it('never opens from a computer code', async () => {
    const current = String((await send('GET', `${DEVICES_PATH}?reach`)).body['current'])
    const asked = await send('POST', `${ELEVATION_PATHS.request}?reach`)
    home.auth.approveElevation(String(asked.body['requestId']), String(asked.body['code']))
    expect(home.auth.elevationOf(brandString<DeviceId>(current), LISTENER)).toBeDefined()
    expect(home.auth.grants.passOf({ deviceId: current, listener: LISTENER })).toBeUndefined()
    expect(await send('GET', `${PASSKEY_PATHS.pass}?reach`)).toMatchObject({ status: 200, body: { pass: null } })
  })

  // Removing touchPass from admitToken lets a pass end idle while its device is still making requests (review P2-1).
  it('counts each admitted request of the device as its use of the pass', async () => {
    const { holder } = await setup()
    const touched = vi.spyOn(home.auth.grants, 'touchPass')
    await send('GET', `${DEVICES_PATH}?reach`)
    expect(touched).toHaveBeenCalledWith({ deviceId: holder.deviceId, listener: LISTENER })
  })

  // Removing the route's endPass leaves the pass running after Lock now.
  it('reads the live pass and ends it with Lock now', async () => {
    const { holder } = await setup()
    expect(await send('GET', `${PASSKEY_PATHS.pass}?reach`)).toMatchObject({ status: 200, body: { pass: { endsAt: expect.any(Number) } } })
    expect(await send('POST', `${PASSKEY_PATHS.lock}?reach`, {})).toMatchObject({ status: 200, body: { ended: true } })
    expect(home.auth.grants.passOf(holder)).toBeUndefined()
    expect(await send('GET', `${PASSKEY_PATHS.pass}?reach`)).toMatchObject({ status: 200, body: { pass: null } })
  })

  // Pins forgetDevice's endDevice and the rotation: a removed device's pass ends with it, and so does every other.
  it('ends the pass of a device that is removed', async () => {
    const { other, holder } = await setup()
    const theirs = { deviceId: other.id, listener: LISTENER } as const
    home.auth.grants.openPass(theirs, 15)
    home.auth.grants.mint(holder, [{ action: DEVICE_REMOVE_ACTION, hash: hashArgs({ v: 1, deviceId: other.id }) ?? '' }], 'passkey')
    expect(await send('POST', `${DEVICE_REMOVE_PATH}?reach`, { v: 1, deviceId: other.id })).toMatchObject({ status: 200 })
    expect(home.auth.grants.passOf(theirs)).toBeUndefined()
    // A removal rotates every session, so the remover's pass ends too and its next strong action asks.
    expect(home.auth.grants.passOf(holder)).toBeUndefined()
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
