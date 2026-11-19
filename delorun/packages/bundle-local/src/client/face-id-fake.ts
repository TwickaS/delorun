/**
 * A scripted {@link PasskeyApi} and {@link PasskeyBrowser} for specs and the preview. Never loaded by the studio: the
 * home's HTTP implementation ([`./face-id-api.ts`](./face-id-api.ts)) replaces it, and nothing here grants anything.
 * @module @delorun/bundle-local/client/face-id-fake
 */
import type { PasskeyBrowser, PasskeyResult } from './face-id-browser.ts'
import type {
  AssertionResponseJSON, CreationOptionsJSON, PasskeyApi, PasskeyDevice, PendingAdd, RegistrationResponseJSON, RequestOptionsJSON,
} from './face-id-types.ts'

const REQUEST_OPTIONS: RequestOptionsJSON = { challenge: 'AAAA', rpId: 'phone.example.ts.net', allowCredentials: [{ type: 'public-key', id: 'BBBB' }], userVerification: 'required' }
const CREATION_OPTIONS: CreationOptionsJSON = {
  challenge: 'AAAA', rp: { id: 'phone.example.ts.net', name: 'Delorun' }, user: { id: 'CCCC', name: 'iPhone', displayName: 'iPhone' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  authenticatorSelection: { residentKey: 'required', userVerification: 'required', authenticatorAttachment: 'platform' }, attestation: 'none',
}
const ASSERTION: AssertionResponseJSON = { id: 'BBBB', rawId: 'BBBB', type: 'public-key', response: { clientDataJSON: 'x', authenticatorData: 'y', signature: 'z' }, clientExtensionResults: {} }
const REGISTRATION: RegistrationResponseJSON = { id: 'BBBB', rawId: 'BBBB', type: 'public-key', response: { clientDataJSON: 'x', attestationObject: 'y' }, clientExtensionResults: {} }

/** The fake browser's script: what each call comes to, in order; the last entry repeats. */
export interface FakeBrowserScript {
  readonly available?: boolean
  readonly get?: readonly PasskeyResult<AssertionResponseJSON>[]
  readonly create?: readonly PasskeyResult<RegistrationResponseJSON>[]
}

/** A fake browser that also records its calls. */
export interface FakeBrowser extends PasskeyBrowser {
  readonly calls: string[]
}

/**
 * A scripted browser.
 * @param script - what the calls come to.
 * @returns the browser.
 */
export function fakeBrowser(script: FakeBrowserScript = {}): FakeBrowser {
  const calls: string[] = []
  const next = <T>(list: readonly T[], index: number, fallback: T): T => list[Math.min(index, list.length - 1)] ?? fallback
  let gets = 0
  let creates = 0
  return {
    calls,
    available: async () => script.available ?? true,
    get: async () => { calls.push('get'); return next(script.get ?? [], gets++, { kind: 'ok', value: ASSERTION }) },
    create: async () => { calls.push('create'); return next(script.create ?? [], creates++, { kind: 'ok', value: REGISTRATION }) },
  }
}

/** The fake API's script. */
export interface FakeApiScript {
  readonly devices?: readonly PasskeyDevice[]
  /** The code `addRequest` answers with. */
  readonly code?: string
  readonly failOptions?: boolean
  readonly failVerify?: boolean
  readonly failPin?: boolean
  /** What `state` answers with on each poll: whether an enrolment ticket waits; the last entry repeats. */
  readonly ticket?: readonly boolean[]
  readonly pending?: readonly PendingAdd[]
  readonly matched?: boolean
}

/** A fake API that records its requests. */
export interface FakeApi extends PasskeyApi {
  readonly calls: { readonly name: string; readonly request: unknown }[]
}

/**
 * A scripted API.
 * @param script - what the routes answer.
 * @returns the API.
 */
export function fakeApi(script: FakeApiScript = {}): FakeApi {
  const calls: FakeApi['calls'][number][] = []
  let devices = script.devices ?? []
  let polls = 0
  const note = (name: string, request: unknown): void => { calls.push({ name, request }) }
  const entry = { credentialId: 'BBBB', createdAt: Date.UTC(2026, 10, 18), lastUsedAt: null, synced: true }
  return {
    calls,
    state: async () => {
      note('state', undefined)
      const tickets = script.ticket ?? [false]
      return { passkeys: devices.find(device => device.thisDevice)?.passkeys ?? [], ticket: tickets[Math.min(polls++, tickets.length - 1)] ?? false }
    },
    options: async (request) => {
      note('options', request)
      if (script.failOptions === true) throw new Error('options refused')
      return REQUEST_OPTIONS
    },
    verify: async (response) => {
      note('verify', response)
      if (script.failVerify === true) throw new Error('verify refused')
      return { grantId: 'g1', expiresAt: 0 }
    },
    pin: async (request) => {
      note('pin', request)
      if (script.failPin === true) throw new Error('pin refused')
      return { grantId: 'g2', expiresAt: 0 }
    },
    registerOptions: async () => {
      note('registerOptions', undefined)
      if (script.failOptions === true) throw new Error('options refused')
      return CREATION_OPTIONS
    },
    register: async (response) => { note('register', response); return entry },
    addRequest: async () => { note('addRequest', undefined); return { requestId: 'r1', code: script.code ?? '12345678', expiresAt: 0 } },
    pendingAdds: async () => script.pending ?? [],
    approveAdd: async (request) => { note('approveAdd', request); return { matched: script.matched ?? true } },
    devices: async (request) => { note('devices', request); return devices },
    removePasskey: async (request) => {
      note('removePasskey', request)
      devices = devices.map(device => ({ ...device, passkeys: device.passkeys.filter(passkey => passkey.credentialId !== request.credentialId) }))
    },
    removeDevice: async (request) => {
      note('removeDevice', request)
      devices = devices.filter(device => device.deviceId !== request.deviceId)
    },
  }
}
