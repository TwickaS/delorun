// @vitest-environment jsdom
/**
 * The HTTP passkey API: each method's route and body, the grant header, the device-name merge and the add-code refusal.
 *
 * Each test's comment names the behaviour whose removal makes it fail.
 */
import { describe, expect, it } from 'vitest'
import { GRANT_HEADER, httpPasskeyApi, PASSKEY_ROUTES } from '../src/client/face-id-api.ts'
import { DEVICE_ROUTES } from '../src/client/devices-api.ts'
import { fakeHost } from './fake-host.ts'

const entry = { credentialId: 'c1', createdAt: 1, lastUsedAt: null, synced: false }
const ok = (body: unknown) => ({ status: 200, body })
const refused = (error: string) => ({ status: 400, body: { error, message: `${error} sentence` } })
const devicesList = ok({ owner: { claimedAt: 1, firstDeviceId: 'd1' }, devices: [{ id: 'd1', label: 'iPhone', platform: 'iOS', address: 'a', approvedAt: 1, approvedBy: 'local', lastSignInAt: null }] })

describe('httpPasskeyApi', () => {
  it('posts each route with its body and returns the validated answer', async () => {
    // A wrong path or body would send the passkey routes nothing they understand.
    const host = fakeHost({
      [`GET ${PASSKEY_ROUTES.state}`]: ok({ passkeys: [entry], ticket: true }),
      [`POST ${PASSKEY_ROUTES.options}`]: ok({ challenge: 'x', rpId: 'h' }),
      [`POST ${PASSKEY_ROUTES.verify}`]: ok({ grantId: 'g', expiresAt: 5 }),
      [`POST ${PASSKEY_ROUTES.pin}`]: ok({ grantId: 'p', expiresAt: 5 }),
      [`POST ${PASSKEY_ROUTES.registerOptions}`]: ok({ challenge: 'x', rp: { id: 'h' } }),
      [`POST ${PASSKEY_ROUTES.register}`]: ok(entry),
      [`POST ${PASSKEY_ROUTES.addRequest}`]: ok({ requestId: 'r', code: '12345678', expiresAt: 9 }),
    })
    const api = httpPasskeyApi(host.fetch)
    expect(await api.state()).toEqual({ passkeys: [entry], ticket: true })
    await api.options({ actions: [{ action: 'a', hash: 'h' }] })
    expect(await api.verify({ id: 'i', rawId: 'i', type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: 'a', authenticatorData: 'b', signature: 'c' } })).toEqual({ grantId: 'g', expiresAt: 5 })
    expect((await api.pin({ answer: { agent: 'a', callId: 'c', grants: 'full-access', value: 'allowed-once' }, secret: 's' })).grantId).toBe('p')
    await api.registerOptions()
    expect(await api.register({ id: 'i', rawId: 'i', type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: 'a', attestationObject: 'b' } })).toEqual(entry)
    expect((await api.addRequest()).code).toBe('12345678')
    expect(host.received.find(request => request.key === `POST ${PASSKEY_ROUTES.pin}`)?.body).toEqual({ answer: { agent: 'a', callId: 'c', grants: 'full-access', value: 'allowed-once' }, secret: 's' })
  })
  it('lists pending adds with device names, falling back to the id', async () => {
    // A request without a name would be unreadable at the computer.
    const pending = ok({ pending: [{ requestId: 'r', deviceId: 'd1', expiresAt: 1 }, { requestId: 's', deviceId: 'd9', expiresAt: 1 }] })
    const named = httpPasskeyApi(fakeHost({ [`GET ${PASSKEY_ROUTES.addPending}`]: pending, [`GET ${DEVICE_ROUTES.devices}`]: devicesList }).fetch)
    expect((await named.pendingAdds()).map(item => item.deviceLabel)).toEqual(['iPhone', 'd9'])
    const unnamed = httpPasskeyApi(fakeHost({ [`GET ${PASSKEY_ROUTES.addPending}`]: pending }).fetch)
    expect((await unnamed.pendingAdds()).map(item => item.deviceLabel)).toEqual(['d1', 'd9'])
  })
  it('reports a wrong add code as no match and rethrows other failures', async () => {
    // A wrong code is an answer; an unreachable home is an error.
    const wrong = httpPasskeyApi(fakeHost({ [`POST ${PASSKEY_ROUTES.addApprove}`]: refused('BAD_REQUEST') }).fetch)
    expect(await wrong.approveAdd({ requestId: 'r', code: '1' })).toEqual({ matched: false })
    const right = httpPasskeyApi(fakeHost({ [`POST ${PASSKEY_ROUTES.addApprove}`]: ok({ approved: true }) }).fetch)
    expect(await right.approveAdd({ requestId: 'r', code: '1' })).toEqual({ matched: true })
    const down = httpPasskeyApi(fakeHost({ [`POST ${PASSKEY_ROUTES.addApprove}`]: 'unreachable' as const }).fetch)
    await expect(down.approveAdd({ requestId: 'r', code: '1' })).rejects.toThrow()
  })
  it('sends the grant header on the device list and the removals, and marks this device', async () => {
    // Without the header the home refuses the face action.
    const host = fakeHost({
      [`GET ${PASSKEY_ROUTES.devices}`]: ok({ devices: [{ deviceId: 'd1', passkeys: [entry] }, { deviceId: 'd2', passkeys: [] }] }),
      [`GET ${PASSKEY_ROUTES.state}`]: ok({ passkeys: [entry], ticket: false }),
      [`GET ${DEVICE_ROUTES.devices}`]: devicesList,
      [`POST ${PASSKEY_ROUTES.remove}`]: ok({ removed: true }),
      [`POST ${DEVICE_ROUTES.remove}`]: ok({ removed: true, sessions: 0, connections: 0 }),
    })
    const api = httpPasskeyApi(host.fetch)
    const devices = await api.devices({ grantId: 'g' })
    expect(devices.map(device => [device.deviceId, device.label, device.thisDevice])).toEqual([['d1', 'iPhone', true], ['d2', 'd2', false]])
    await api.removePasskey({ credentialId: 'c1', deviceId: 'd1', grantId: 'g' })
    await api.removeDevice({ deviceId: 'd2' })
    const headers = (key: string) => (host.received.find(request => request.key === key)?.init?.headers ?? {}) as Record<string, string>
    expect(headers(`GET ${PASSKEY_ROUTES.devices}`)[GRANT_HEADER]).toBe('g')
    expect(headers(`POST ${PASSKEY_ROUTES.remove}`)[GRANT_HEADER]).toBe('g')
    expect(headers(`POST ${DEVICE_ROUTES.remove}`)[GRANT_HEADER]).toBeUndefined()
    expect(host.received.find(request => request.key === `POST ${DEVICE_ROUTES.remove}`)?.body).toEqual({ v: 1, deviceId: 'd2' })
  })
})
