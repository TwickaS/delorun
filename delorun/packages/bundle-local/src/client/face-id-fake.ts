/**
 * A scripted {@link PasskeyApi} and {@link PasskeyBrowser} for specs and the preview. Never loaded by the studio: the
 * home's HTTP implementation replaces it, and nothing here grants anything.
 * @module @delorun/bundle-local/client/face-id-fake
 */
import type { PasskeyBrowser, PasskeyResult } from './face-id-browser.ts'
import type {
  AssertionResponseJSON, CreationOptionsJSON, PasskeyApi, PasskeyDevice, RegistrationResponseJSON, RequestOptionsJSON,
} from './face-id-types.ts'

const REQUEST_OPTIONS: RequestOptionsJSON = { challenge: 'AAAA', rpId: 'phone.example.ts.net', allowCredentials: [{ type: 'public-key', id: 'BBBB' }], userVerification: 'required' }
const CREATION_OPTIONS: CreationOptionsJSON = {
  challenge: 'AAAA', rp: { id: 'phone.example.ts.net', name: 'Delorun' }, user: { id: 'CCCC', name: 'iPhone', displayName: 'iPhone' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  authenticatorSelection: { residentKey: 'required', userVerification: 'required', authenticatorAttachment: 'platform' }, attestation: 'none',
}
const ASSERTION: AssertionResponseJSON = { id: 'BBBB', rawId: 'BBBB', type: 'public-key', response: { clientDataJSON: 'x', authenticatorData: 'y', signature: 'z' } }
const REGISTRATION: RegistrationResponseJSON = { id: 'BBBB', rawId: 'BBBB', type: 'public-key', response: { clientDataJSON: 'x', attestationObject: 'y' } }

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
  /** Whether `register` answers with a code to type at the computer. */
  readonly code?: string
  readonly failOptions?: boolean
  readonly failVerify?: boolean
  readonly state?: readonly ('pending' | 'done' | 'refused')[]
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
  return {
    calls,
    assertionOptions: async (request) => {
      note('assertionOptions', request)
      if (script.failOptions === true) throw new Error('options refused')
      return { challengeId: 'c1', options: REQUEST_OPTIONS }
    },
    verifyAssertion: async (request) => {
      note('verifyAssertion', request)
      if (script.failVerify === true) throw new Error('verify refused')
      return { grantId: 'g1' }
    },
    registrationOptions: async (request) => {
      note('registrationOptions', request)
      if (script.failOptions === true) throw new Error('options refused')
      return { challengeId: 'c2', options: CREATION_OPTIONS }
    },
    register: async (request) => {
      note('register', request)
      return script.code === undefined ? { kind: 'done' } : { kind: 'code', code: script.code }
    },
    registrationState: async () => {
      note('registrationState', undefined)
      const states = script.state ?? ['pending']
      return states[Math.min(polls++, states.length - 1)] ?? 'pending'
    },
    confirmCode: async (code) => { note('confirmCode', code); return { matched: script.matched ?? true } },
    list: async () => devices,
    removePasskey: async (request) => {
      note('removePasskey', request)
      devices = devices.map(device => ({ ...device, passkeys: device.passkeys.filter(passkey => passkey.id !== request.passkeyId) }))
    },
    removeDevice: async (request) => {
      note('removeDevice', request)
      devices = devices.filter(device => device.id !== request.deviceId)
    },
  }
}
