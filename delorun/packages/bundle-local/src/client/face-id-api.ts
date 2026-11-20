/**
 * The HTTP implementation of {@link PasskeyApi}: the home's `/auth/passkey/*` routes through the same-origin requests of
 * [`./host-api.ts`](./host-api.ts). It sends what the person did and nothing it could grant itself: the home hashes the
 * request it receives and decides.
 * @module @delorun/bundle-local/client/face-id-api
 */
import { call, fields, isBoolean, isRecord, isRefused, isString, isTime, listOf, optional, orNull, type Check, type HostFetch } from './host-api.ts'
import { DEVICE_ROUTES, readDevices } from './devices-api.ts'
import { PASS_CHANGED } from './face-id-pass.ts'
import type {
  AssertionResponseJSON, CreationOptionsJSON, GrantTicket, PasskeyApi, PasskeyDevice, PasskeyEntry, PendingAdd, RegistrationResponseJSON, RequestOptionsJSON,
} from './face-id-types.ts'

/** The home's passkey routes. */
export const PASSKEY_ROUTES = {
  state: '/auth/passkey/state',
  options: '/auth/passkey/options',
  verify: '/auth/passkey/verify',
  pin: '/auth/passkey/pin',
  registerOptions: '/auth/passkey/register/options',
  register: '/auth/passkey/register',
  addRequest: '/auth/passkey/add/request',
  addPending: '/auth/passkey/add/pending',
  addApprove: '/auth/passkey/add/approve',
  remove: '/auth/passkey/remove',
  devices: '/auth/passkey/devices',
} as const

/** The header that carries a grant's id on the call it covers. */
export const GRANT_HEADER = 'Delorun-Grant'

const isEntry = fields({ credentialId: isString, createdAt: isTime, lastUsedAt: orNull(isTime), synced: isBoolean })
const isGrant = fields({ grantId: isString, expiresAt: isTime })
const isRecordCheck: Check = isRecord
const isState = fields({ deviceId: isString, passkeys: listOf(isEntry), ticket: isBoolean })
const isAddRequest = fields({ requestId: isString, code: isString, expiresAt: isTime })
const isPending = fields({ pending: listOf(fields({ requestId: isString, deviceId: isString, expiresAt: isTime })) })
const isDevices = fields({ devices: listOf(fields({ deviceId: isString, passkeys: listOf(isEntry) })) })
const grantHeader = (grantId: string | undefined): { readonly headers?: Record<string, string> } =>
  grantId === undefined ? {} : { headers: { [GRANT_HEADER]: grantId } }

/**
 * The passkey routes over HTTP.
 * @param fetch - the same-origin request function.
 * @returns the API.
 */
export function httpPasskeyApi(fetch: HostFetch): PasskeyApi {
  return {
    state: () => call<{ deviceId: string; passkeys: PasskeyEntry[]; ticket: boolean }>(fetch, PASSKEY_ROUTES.state, isState),
    options: request => call<RequestOptionsJSON>(fetch, PASSKEY_ROUTES.options, fields({ challenge: isString, rpId: isString }), request),
    async verify(response: AssertionResponseJSON) {
      const ticket = await call<GrantTicket>(fetch, PASSKEY_ROUTES.verify, isGrant, response)
      // A verified Face ID may have opened this device's pass; the page's pass mirror reads it again.
      globalThis.window?.dispatchEvent(new Event(PASS_CHANGED))
      return ticket
    },
    pin: request => call<GrantTicket>(fetch, PASSKEY_ROUTES.pin, isGrant, request),
    registerOptions: () => call<CreationOptionsJSON>(fetch, PASSKEY_ROUTES.registerOptions, fields({ challenge: isString, rp: isRecordCheck }), {}),
    register: (response: RegistrationResponseJSON) => call<PasskeyEntry>(fetch, PASSKEY_ROUTES.register, isEntry, response),
    addRequest: () => call<{ requestId: string; code: string; expiresAt: number }>(fetch, PASSKEY_ROUTES.addRequest, isAddRequest, {}),
    async pendingAdds() {
      const { pending } = await call<{ pending: { requestId: string; deviceId: string; expiresAt: number }[] }>(fetch, PASSKEY_ROUTES.addPending, isPending)
      const labels = await deviceLabels(fetch)
      return pending.map((entry): PendingAdd => ({ ...entry, deviceLabel: labels.get(entry.deviceId) ?? entry.deviceId }))
    },
    async approveAdd(request) {
      try {
        await call<object>(fetch, PASSKEY_ROUTES.addApprove, optional(isRecordCheck), request)
        return { matched: true }
      } catch (error) {
        if (isRefused(error, 'BAD_REQUEST')) return { matched: false }
        throw error
      }
    },
    async devices(request) {
      const { devices } = await call<{ devices: { deviceId: string; passkeys: PasskeyEntry[] }[] }>(fetch, PASSKEY_ROUTES.devices, isDevices, undefined, grantHeader(request?.grantId))
      const labels = await deviceLabels(fetch)
      const own = new Set((await call<{ passkeys: PasskeyEntry[] }>(fetch, PASSKEY_ROUTES.state, isState)).passkeys.map(entry => entry.credentialId))
      return devices.map((device): PasskeyDevice => ({
        deviceId: device.deviceId,
        label: labels.get(device.deviceId) ?? device.deviceId,
        thisDevice: device.passkeys.some(entry => own.has(entry.credentialId)),
        passkeys: device.passkeys,
      }))
    },
    async removePasskey({ credentialId, deviceId, grantId }) {
      await call<object>(fetch, PASSKEY_ROUTES.remove, isRecordCheck, { credentialId, deviceId }, grantHeader(grantId))
    },
    async removeDevice({ deviceId, grantId }) {
      await call<object>(fetch, DEVICE_ROUTES.remove, isRecordCheck, { v: 1, deviceId }, grantHeader(grantId))
    },
  }
}

/** The device names the home's own list gives; empty when the list is not readable, so a name falls back to the id. */
async function deviceLabels(fetch: HostFetch): Promise<ReadonlyMap<string, string>> {
  try {
    const list = await readDevices(fetch)
    return new Map((list?.devices ?? []).map(device => [device.id as string, device.label]))
  } catch {
    // The names are a convenience; the passkey routes' own answer already stands.
    return new Map()
  }
}
