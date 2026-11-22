/**
 * Passkey enrolment and assertion for the unlock of one action (C14, "Passkeys"), with `@simplewebauthn/server`.
 *
 * - **Enrolment** needs a single-use ticket: the computer's approval of a pairing mints one for the new device
 *   ({@link PasskeyAuth.mintTicket}), and a paired device gets one by showing a `delorun-passkey-v1` code the person
 *   types at the computer ({@link PasskeyAuth.requestAdd}, {@link PasskeyAuth.approveAdd}). The credential options ask
 *   for a resident, user-verified credential with no attestation, on the address host as relying-party id. A passkey is
 *   recorded for the device whose session enrolled it and for no other.
 * - **Assertion** is asked for each action: the device names the actions (each with the hash it wants covered) or one
 *   prompt answer; the home stores a 32-byte challenge for the device, session, listener and that list for 60 seconds,
 *   single use; `allowCredentials` holds only this device's credential ids. A verified assertion mints grants
 *   ({@link GrantStore}), never a window. A failed one counts as a wrong try in the PIN's counters.
 * - **A correct PIN** on a device mints the same grants ({@link PasskeyAuth.pinGrant}), and never opens a pass.
 * - **A verified assertion** also opens the device's Face ID pass when the pass setting is above 0 and nothing it
 *   confirmed is always-ask (A499, {@link GrantStore.openPass}).
 *
 * @module @delorun/home-auth/passkey-auth
 */
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON, type RegistrationResponseJSON, type WebAuthnCredential,
} from '@simplewebauthn/server'
import type { DeviceId, StudioAddress } from '@delorun/contract-admission'
import { IDENTITY_LIMITS, PASSKEY_COSE_ALGORITHMS, PASSKEY_REGISTRATION, RELYING_PARTY_NAME } from '@delorun/contract-oidc-passkeys'
import { HomeAuthError } from './errors.ts'
import { isRecord } from './files.ts'
import { ALWAYS_ASK_ACTIONS } from './auth-classes.ts'
import { answerKey, DEVICE_REMOVE_ACTION, HOLD_FEATURES, type GrantEntry, type GrantStore, type HoldFeature, type PassView } from './grants.ts'
import { passkeyCode } from './match-code.ts'
import type { PasskeyRecord, PasskeyStore } from './passkeys.ts'
import type { PinUnlocks, UnlockAsker } from './pin-unlocks.ts'
import { newSecret, type RandomBytes } from './secret.ts'

/** How long an assertion challenge lives: 60 seconds. */
export const ASSERTION_CHALLENGE_MS = 60_000

/** How long an enrolment ticket and a registration challenge live. */
export const ENROL_TICKET_MS = IDENTITY_LIMITS.enrolmentSessionMs

/** How long a request to add a passkey waits for the person at the computer: 5 minutes. */
export const ADD_REQUEST_MS = 5 * 60_000

/** The wrong codes after which a request to add a passkey ends. */
export const ADD_REQUEST_WRONG_CODES = 3

/** The most actions one assertion covers. */
export const MAX_ACTIONS_PER_ASSERTION = 16

/** The most unused challenges one device holds; the oldest is dropped past it. */
const CHALLENGES_PER_DEVICE = 8

/** The most characters of an action name or a hold id. */
const MAX_NAME_CHARS = 128

const ACTION_NAME = /^[A-Za-z0-9:/_.-]+$/
const HASH = /^[0-9a-f]{64}$/

/** What an assertion is asked for: actions to be used once each, or one answer to one prompt. */
export type AssertionRequest =
  | { readonly kind: 'actions'; readonly entries: readonly GrantEntry[] }
  | { readonly kind: 'answer'; readonly requestKey: string; readonly answer: string }

/** What a passed assertion or PIN minted. */
export interface PasskeyGrantResult {
  /** The grant's id; it is no credential. */
  readonly grantId: string
  /** When the grant stops being usable, in milliseconds since the epoch. */
  readonly expiresAt: number
  /** The Face ID pass this assertion's device holds on this listener, when one is live (A499); a PIN never opens one. */
  readonly pass?: PassView
}

/** The public half of one passkey record, which a device's studio lists. */
export interface PasskeySummary {
  readonly credentialId: string
  readonly createdAt: number
  readonly lastUsedAt: number | null
  /** Whether the passkey is synced across the person's devices (`backupEligible`) rather than bound to this device. */
  readonly synced: boolean
}

/** What a device sees of its passkeys and of enrolment. */
export interface PasskeyState {
  /** The asking device's own id, which it signs in with; the studio keys what it remembers per device by it. */
  readonly deviceId: DeviceId
  /** The device's passkeys. */
  readonly passkeys: readonly PasskeySummary[]
  /** Whether a ticket for this device is waiting, so the studio may offer "Set up Face ID". */
  readonly ticket: boolean
}

/** One request to add a passkey, as the person at the computer sees it. */
export interface PendingAdd {
  readonly requestId: string
  readonly deviceId: DeviceId
  readonly expiresAt: number
}

/** A pending request to add a passkey. */
interface AddRequest {
  readonly requestId: string
  readonly asker: UnlockAsker
  readonly address: string
  readonly code: string
  readonly expiresAt: number
  wrong: number
}

/** A single-use enrolment ticket. */
interface Ticket {
  readonly deviceId: DeviceId
  readonly listener: UnlockAsker['listener']
  readonly expiresAt: number
  /** The session that used the ticket first; no other session continues it. */
  sessionId: string | undefined
}

/** A stored registration challenge. */
interface RegistrationChallenge {
  readonly deviceId: DeviceId
  readonly sessionId: string
  readonly listener: UnlockAsker['listener']
  readonly expiresAt: number
}

/** A stored assertion challenge. */
interface AssertionChallenge {
  readonly deviceId: DeviceId
  readonly sessionId: string
  readonly listener: UnlockAsker['listener']
  readonly request: AssertionRequest
  readonly expiresAt: number
}

/** What {@link PasskeyAuth} is built from. */
export interface PasskeyAuthOptions {
  readonly store: PasskeyStore
  readonly grants: GrantStore
  /**
   * The pass length in minutes a verified Face ID opens (A499), read at each verification; 0 or absent opens none.
   * @returns the minutes.
   */
  readonly passMinutes?: () => number
  readonly pin: Pick<PinUnlocks, 'missed' | 'cleared' | 'verify'>
  readonly now: () => number
  readonly random: RandomBytes
  /**
   * Whether the asker's session is still admitted on its listener: the session exists, its device is paired and the
   * listener serves. Checked just before a grant is minted, so a sign-out that ran while the request body was still arriving mints nothing.
   * @param asker - the device, listener and session.
   * @returns whether the session is still admitted.
   */
  readonly stillAdmitted: (asker: UnlockAsker) => boolean
  /** Whether two session ids are one session, a roll's successor included. */
  readonly sameSession: (presented: string, bound: string) => boolean
  /**
   * Record one operational event; the text holds no challenge, public key or signature.
   * @param event - the event line.
   */
  readonly log: (event: string) => void
}

/**
 * Check a body's list of actions or its prompt answer.
 * @param body - the parsed JSON body of an options or PIN-grant request.
 * @returns the request.
 * @throws {HomeAuthError} `BAD_REQUEST` for a body that names neither, both, too many actions or a malformed one.
 */
export function parseAssertionRequest(body: Readonly<Record<string, unknown>>): AssertionRequest {
  const { actions, answer } = body
  if ((actions === undefined) === (answer === undefined)) throw new HomeAuthError('BAD_REQUEST', 'name either the actions to confirm or one answer, not both')
  if (answer !== undefined) {
    const named = isRecord(answer) ? [answer.agent, answer.callId, answer.grants, answer.value] : []
    if (named.length !== 4 || !named.every((field): field is string => typeof field === 'string' && field !== '' && field.length <= MAX_NAME_CHARS)) {
      throw new HomeAuthError('BAD_REQUEST', 'an answer names its agent, call id, grants marker and value')
    }
    const [agent, callId, grants, value] = named
    return { kind: 'answer', requestKey: answerKey({ agent: agent ?? '', callId: callId ?? '', grants: grants ?? '' }), answer: value ?? '' }
  }
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > MAX_ACTIONS_PER_ASSERTION) throw new HomeAuthError('BAD_REQUEST', `confirm from 1 to ${String(MAX_ACTIONS_PER_ASSERTION)} actions`)
  const entries = actions.map((item: unknown): GrantEntry => {
    if (!isRecord(item) || typeof item.action !== 'string' || !ACTION_NAME.test(item.action) || item.action.length > MAX_NAME_CHARS || typeof item.hash !== 'string' || !HASH.test(item.hash)) {
      throw new HomeAuthError('BAD_REQUEST', 'an action names itself and the SHA-256 of its arguments in lowercase hex')
    }
    const { hold } = item
    if (hold === undefined) return { action: item.action, hash: item.hash }
    if (!isRecord(hold) || typeof hold.id !== 'string' || hold.id === '' || hold.id.length > MAX_NAME_CHARS || !HOLD_FEATURES.some(feature => feature === hold.feature)) {
      throw new HomeAuthError('BAD_REQUEST', 'a hold names a terminal or a picker and its id')
    }
    return { action: item.action, hash: item.hash, hold: { feature: hold.feature as HoldFeature, id: hold.id } }
  })
  return { kind: 'actions', entries }
}

/**
 * The relying-party id and origin of a studio address.
 * @param address - the address, `https://<host>[:port]`.
 * @returns the host as relying-party id, and the origin an assertion's client data names.
 */
function relyingParty(address: string): { readonly rpId: string; readonly origin: string } {
  const url = new URL(address)
  return { rpId: url.hostname, origin: url.origin }
}

/** Passkey enrolment, assertion and the grants and PIN counters they use, for one home. */
export class PasskeyAuth {
  private readonly options: PasskeyAuthOptions
  private readonly tickets = new Map<string, Ticket>()
  private readonly adds = new Map<string, AddRequest>()
  private readonly registrations = new Map<string, RegistrationChallenge>()
  private readonly assertions = new Map<string, AssertionChallenge>()

  /**
   * @param options - the stores, the clock, the random source.
   */
  constructor(options: PasskeyAuthOptions) {
    this.options = options
  }

  /**
   * Mint the single-use enrolment ticket of a device whose pairing the person approved at the computer. A device holds
   * one ticket; a new one replaces it.
   * @param deviceId - the approved device.
   * @param listener - the listener its sessions will live on.
   */
  mintTicket(deviceId: DeviceId, listener: UnlockAsker['listener']): void {
    this.tickets.set(deviceId, { deviceId, listener, expiresAt: this.options.now() + ENROL_TICKET_MS, sessionId: undefined })
  }

  /**
   * What a device sees: its passkeys and whether a ticket waits.
   * @param deviceId - the device.
   * @returns its state.
   */
  stateOf(deviceId: DeviceId): PasskeyState {
    const passkeys = this.options.store.forDevice(deviceId).map(record => ({ credentialId: record.credentialId, createdAt: record.createdAt, lastUsedAt: record.lastUsedAt, synced: record.backupEligible }))
    const ticket = this.tickets.get(deviceId)
    return { deviceId, passkeys, ticket: ticket !== undefined && ticket.expiresAt > this.options.now() }
  }

  /**
   * Every device's passkeys, for the studio's device list.
   * @returns one entry per device that holds a passkey.
   */
  allDevices(): readonly { readonly deviceId: DeviceId; readonly passkeys: readonly PasskeySummary[] }[] {
    const ids = [...new Set(this.options.store.list().map(record => record.deviceId))]
    return ids.map(deviceId => ({ deviceId, passkeys: this.stateOf(deviceId).passkeys }))
  }

  /**
   * A paired device asks to add a passkey: the home derives a code the device shows and the person types at the computer.
   * @param asker - the device, listener and session.
   * @param address - the studio address the session is bound to.
   * @returns the request id and the code to show.
   */
  requestAdd(asker: UnlockAsker, address: string): { readonly requestId: string; readonly code: string; readonly expiresAt: number } {
    const at = this.options.now()
    for (const [id, request] of this.adds) if (request.expiresAt <= at || request.asker.deviceId === asker.deviceId) this.adds.delete(id)
    const requestId = newSecret(8, this.options.random)
    const nonce = newSecret(16, this.options.random)
    const code = passkeyCode({ deviceId: asker.deviceId, sessionId: asker.sessionId, nonce, address })
    const expiresAt = at + ADD_REQUEST_MS
    this.adds.set(requestId, { requestId, asker, address, code, expiresAt, wrong: 0 })
    return { requestId, code, expiresAt }
  }

  /**
   * The requests waiting for the person at the computer, without their codes.
   * @returns the pending requests.
   */
  pendingAdds(): readonly PendingAdd[] {
    const at = this.options.now()
    return [...this.adds.values()].filter(request => request.expiresAt > at).map(request => ({ requestId: request.requestId, deviceId: request.asker.deviceId, expiresAt: request.expiresAt }))
  }

  /**
   * The person at the computer types the code a device shows; a match mints the device's ticket.
   * @param requestId - the request.
   * @param typedCode - what the person typed.
   * @throws {HomeAuthError} `BAD_REQUEST` for an unknown or expired request or a wrong code, which ends the request after {@link ADD_REQUEST_WRONG_CODES} of them.
   */
  approveAdd(requestId: string, typedCode: string): void {
    const request = this.adds.get(requestId)
    if (request === undefined || request.expiresAt <= this.options.now()) {
      this.adds.delete(requestId)
      throw new HomeAuthError('BAD_REQUEST', 'This request is gone. Ask again on the device')
    }
    const digits = typedCode.replace(/[\s-]/g, '')
    if (digits !== request.code) {
      request.wrong += 1
      if (request.wrong >= ADD_REQUEST_WRONG_CODES) this.adds.delete(requestId)
      throw new HomeAuthError('BAD_REQUEST', 'That code does not match the one on the device')
    }
    this.adds.delete(requestId)
    this.tickets.set(request.asker.deviceId, { deviceId: request.asker.deviceId, listener: request.asker.listener, expiresAt: this.options.now() + ENROL_TICKET_MS, sessionId: request.asker.sessionId })
  }

  /**
   * The creation options for a device's passkey.
   * @param asker - the device, listener and session.
   * @param address - the studio address the session is bound to.
   * @param label - the device's name, shown by the authenticator.
   * @returns the options for `navigator.credentials.create`.
   * @throws {HomeAuthError} `ELEVATION_REQUIRED` without a live ticket for this device, listener and session.
   */
  async registrationOptions(asker: UnlockAsker, address: string, label: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const ticket = this.liveTicket(asker)
    ticket.sessionId ??= asker.sessionId
    const { rpId } = relyingParty(address)
    const challenge = Uint8Array.from(this.options.random(IDENTITY_LIMITS.passkeyChallengeBytes))
    const options = await generateRegistrationOptions({
      rpName: RELYING_PARTY_NAME, rpID: rpId, userName: PASSKEY_REGISTRATION.userName, userID: Buffer.from(asker.deviceId, 'base64url'), userDisplayName: label,
      challenge, attestationType: PASSKEY_REGISTRATION.attestation, timeout: PASSKEY_REGISTRATION.timeoutMs,
      excludeCredentials: this.options.store.forDevice(asker.deviceId).map(record => ({ id: record.credentialId, transports: [...record.transports] })),
      authenticatorSelection: { residentKey: PASSKEY_REGISTRATION.residentKey, userVerification: PASSKEY_REGISTRATION.userVerification, authenticatorAttachment: 'platform' },
      supportedAlgorithmIDs: [...PASSKEY_COSE_ALGORITHMS],
    })
    this.registrations.set(options.challenge, { deviceId: asker.deviceId, sessionId: asker.sessionId, listener: asker.listener, expiresAt: this.options.now() + ENROL_TICKET_MS })
    this.trim(this.registrations, asker.deviceId)
    return options
  }

  /**
   * Verify a created credential and record it for the device.
   * @param asker - the device, listener and session.
   * @param address - the studio address the session is bound to.
   * @param response - the credential `navigator.credentials.create` returned, as JSON.
   * @returns the passkey's summary.
   * @throws {HomeAuthError} `ELEVATION_REQUIRED` without a live ticket; `PASSKEY_ASSERTION_INVALID` for a challenge that is unknown, used, expired or another device's, a wrong relying party or origin, or a credential that does not verify; `PASSKEY_USER_VERIFICATION_REQUIRED` when the authenticator did not verify the user.
   */
  async register(asker: UnlockAsker, address: string, response: RegistrationResponseJSON): Promise<PasskeySummary> {
    const ticket = this.liveTicket(asker)
    const challenge = this.takeChallenge(this.registrations, extractChallenge(response.response.clientDataJSON), asker)
    if (challenge === undefined) throw new HomeAuthError('PASSKEY_ASSERTION_INVALID', 'This enrolment is not current. Start it again')
    const { rpId, origin } = relyingParty(address)
    let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>
    try {
      verified = await verifyRegistrationResponse({ response, expectedChallenge: value => value === extractChallenge(response.response.clientDataJSON), expectedOrigin: origin, expectedRPID: rpId, requireUserPresence: true, requireUserVerification: true, supportedAlgorithmIDs: [...PASSKEY_COSE_ALGORITHMS] })
    } catch (error) {
      throw verificationFailure(error)
    }
    if (!verified.verified || !verified.registrationInfo.userVerified) throw new HomeAuthError('PASSKEY_USER_VERIFICATION_REQUIRED', 'The device did not verify you. Try again')
    const { credential, credentialDeviceType, credentialBackedUp } = verified.registrationInfo
    const record: PasskeyRecord = {
      credentialId: credential.id, publicKey: Buffer.from(credential.publicKey).toString('base64url'), counter: credential.counter,
      backupEligible: credentialDeviceType === 'multiDevice', backupState: credentialBackedUp, transports: [...(response.response.transports ?? [])],
      createdAt: this.options.now(), lastUsedAt: null, address: address as StudioAddress, rpId, deviceId: asker.deviceId,
    }
    await this.options.store.add(record)
    // The ticket is used only once the passkey is recorded.
    if (this.tickets.get(asker.deviceId) === ticket) this.tickets.delete(asker.deviceId)
    this.options.log(`home-auth: passkey.enrolled device=${asker.deviceId} listener=${asker.listener} synced=${String(record.backupEligible)}`)
    return { credentialId: record.credentialId, createdAt: record.createdAt, lastUsedAt: null, synced: record.backupEligible }
  }

  /**
   * The request options for one assertion. The home stores the challenge with the device, session, listener and what is
   * asked; `allowCredentials` lists this device's credentials only.
   * @param asker - the device, listener and session.
   * @param address - the studio address the session is bound to.
   * @param request - the actions or the answer to confirm.
   * @returns the options for `navigator.credentials.get`.
   * @throws {HomeAuthError} `PASSKEY_UNAVAILABLE` when the device holds no passkey.
   */
  async assertionOptions(asker: UnlockAsker, address: string, request: AssertionRequest): Promise<PublicKeyCredentialRequestOptionsJSON> {
    // A passkey enrolled on another address has another relying-party id: it cannot assert here, and the device sets Face ID up again.
    const mine = this.options.store.forDevice(asker.deviceId).filter(record => record.address === address)
    if (mine.length === 0) throw new HomeAuthError('PASSKEY_UNAVAILABLE', 'This device has no Face ID set up for this address')
    const { rpId } = relyingParty(address)
    const options = await generateAuthenticationOptions({
      rpID: rpId, userVerification: 'required', timeout: ASSERTION_CHALLENGE_MS,
      challenge: Uint8Array.from(this.options.random(IDENTITY_LIMITS.passkeyChallengeBytes)),
      allowCredentials: mine.map(record => ({ id: record.credentialId, transports: [...record.transports] })),
    })
    this.assertions.set(options.challenge, { deviceId: asker.deviceId, sessionId: asker.sessionId, listener: asker.listener, request, expiresAt: this.options.now() + ASSERTION_CHALLENGE_MS })
    this.trim(this.assertions, asker.deviceId)
    return options
  }

  /**
   * Verify an assertion and mint what it confirmed. The challenge is used up whatever the outcome; every failure counts as a
   * wrong try of the device in the PIN's counters, and the fifth removes the device.
   * @param asker - the device, listener and session.
   * @param address - the studio address the session is bound to.
   * @param response - the assertion `navigator.credentials.get` returned, as JSON.
   * @returns the grant minted.
   * @throws {HomeAuthError} `PASSKEY_ASSERTION_INVALID`, `PASSKEY_USER_VERIFICATION_REQUIRED` or `PASSKEY_COUNTER_REGRESSED` for a failed check, each with the tries left; `PIN_UNLOCKS_PAUSED` after a home-wide pause.
   */
  async verify(asker: UnlockAsker, address: string, response: AuthenticationResponseJSON): Promise<PasskeyGrantResult> {
    // Every session may end while this confirmation awaits its checks (device access turned off, or every session rotated).
    const generation = this.options.grants.generation
    const challengeText = extractChallenge(response.response.clientDataJSON)
    // A challenge that is unknown, used or expired is a sheet left open or a retried request, not a guess: it costs no try.
    const issued = this.assertions.get(challengeText)
    if (issued === undefined || issued.expiresAt <= this.options.now()) {
      this.assertions.delete(challengeText)
      throw new HomeAuthError('PASSKEY_ASSERTION_INVALID', 'That confirmation is not current. Try again')
    }
    const stored = this.takeChallenge(this.assertions, challengeText, asker)
    if (stored === undefined) return this.fail(asker, 'That confirmation is not current')
    // The credential must be this device's own: a copy of another device's passkey on this session is refused.
    const credential = this.options.store.find(response.id)
    if (credential?.deviceId !== asker.deviceId) return this.fail(asker, 'That passkey does not belong to this device')
    const { rpId, origin } = relyingParty(address)
    if (credential.rpId !== rpId || credential.address !== address) return this.fail(asker, 'That passkey belongs to another address')
    let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>
    try {
      verified = await verifyAuthenticationResponse({
        response, expectedChallenge: value => value === challengeText, expectedOrigin: origin, expectedRPID: rpId, requireUserVerification: true,
        credential: { id: credential.credentialId, publicKey: Buffer.from(credential.publicKey, 'base64url'), counter: credential.counter, ...credential.transports.length === 0 ? {} : { transports: credential.transports as NonNullable<WebAuthnCredential['transports']> } },
      })
    } catch (error) {
      const failure = verificationFailure(error)
      return this.fail(asker, failure.detail, failure.code)
    }
    if (!verified.verified || !verified.authenticationInfo.userVerified) return this.fail(asker, 'The device did not verify you', 'PASSKEY_USER_VERIFICATION_REQUIRED')
    const info = verified.authenticationInfo
    await this.options.store.recordUse(credential.credentialId, { counter: info.newCounter, backupState: info.credentialBackedUp, lastUsedAt: this.options.now() })
    if (credential.backupState && !info.credentialBackedUp) this.options.log(`home-auth: passkey.backup-state-changed device=${asker.deviceId} from=1 to=0`)
    await this.options.pin.cleared(asker.deviceId)
    // A confirmation in flight when every session ended mints no grant and opens no pass: the device signs in again first.
    // A sign-out that ran before this call started (the body was still arriving) is not in `generation`: the session itself is checked too.
    if (this.options.grants.generation !== generation || !this.options.stillAdmitted(asker)) throw new HomeAuthError('PASSKEY_ASSERTION_INVALID', 'That confirmation is not current. Try again')
    const minted = this.mint(asker, stored.request, 'passkey')
    const pass = this.openPass(asker, stored.request)
    return pass === undefined ? minted : { ...minted, pass }
  }

  /**
   * Open the Face ID pass a verified assertion earns (A499): for the device on this listener, which has no page
   * unlock (a device holds no PIN page unlock once the grant store exists), for the length the setting names. An
   * assertion that confirms an always-ask action opens none, and a live pass stays as it is.
   * @param asker - the device and listener.
   * @param request - what the assertion confirmed.
   * @returns the live pass, or undefined when none opened and none was live.
   */
  private openPass(asker: UnlockAsker, request: AssertionRequest): PassView | undefined {
    const holder = { deviceId: asker.deviceId, listener: asker.listener }
    if (request.kind === 'actions' && request.entries.some(entry => ALWAYS_ASK_ACTIONS.has(entry.action))) return this.options.grants.passOf(holder)
    return this.options.grants.openPass(holder, this.options.passMinutes?.() ?? 0)
  }

  /**
   * Count one failed check as a wrong try and record it without the credential, challenge or signature.
   * @param asker - the device, listener and session.
   * @param reason - the sentence the person sees.
   * @param code - the refusal's code.
   * @returns never: the refusal of {@link PinUnlocks.missed}.
   */
  private async fail(asker: UnlockAsker, reason: string, code?: PasskeyFailureCode): Promise<never> {
    try {
      return await this.options.pin.missed(asker, reason, code)
    } catch (error) {
      const left = error instanceof HomeAuthError ? error.details.triesLeft : undefined
      this.options.log(`home-auth: passkey.failed device=${asker.deviceId} reason=${code ?? 'PASSKEY_ASSERTION_INVALID'} tries-left=${typeof left === 'number' ? String(left) : 'none'}`)
      throw error
    }
  }

  /**
   * A correct PIN mints the same grants a passkey would, for any device; the PIN's counters apply as for an unlock.
   * @param asker - the device, listener and session.
   * @param secret - the PIN or passcode.
   * @param request - the actions or the answer to confirm.
   * @returns the grant minted.
   * @throws {HomeAuthError} `LOOPBACK_REQUIRED` for a request that names {@link DEVICE_REMOVE_ACTION} from any device, and the refusals of {@link PinUnlocks.verify}.
   */
  async pinGrant(asker: UnlockAsker, secret: string, request: AssertionRequest): Promise<PasskeyGrantResult> {
    // Removing another device needs the passkey factor: a PIN seen on a stolen phone must not lock the owner out of the rest.
    if (request.kind === 'actions' && request.entries.some(entry => entry.action === DEVICE_REMOVE_ACTION)) {
      throw new HomeAuthError('LOOPBACK_REQUIRED', 'Removing another device needs Face ID on this device, or you at your computer')
    }
    const generation = this.options.grants.generation
    await this.options.pin.verify(asker, secret)
    // As in `verify`: a sign-out during the check, or before it started, mints no grant.
    if (this.options.grants.generation !== generation || !this.options.stillAdmitted(asker)) throw new HomeAuthError('UNLOCK_INVALID', 'This page is locked. Unlock it again')
    return this.mint(asker, request, 'pin')
  }

  /**
   * Remove one passkey of a device, after the route checked the person may.
   * @param deviceId - the device that owns it.
   * @param credentialId - the credential id.
   * @returns whether a passkey was removed.
   */
  async remove(deviceId: DeviceId, credentialId: string): Promise<boolean> {
    if (this.options.store.find(credentialId)?.deviceId !== deviceId) return false
    const removed = await this.options.store.remove(credentialId)
    if (removed) this.options.log(`home-auth: passkey.removed device=${deviceId}`)
    return removed
  }

  /**
   * End what a removed device had: its ticket, its requests, its challenges, its grants and its passkeys.
   * @param deviceId - the device.
   */
  async forgetDevice(deviceId: DeviceId): Promise<void> {
    this.tickets.delete(deviceId)
    for (const [id, request] of this.adds) if (request.asker.deviceId === deviceId) this.adds.delete(id)
    for (const [key, challenge] of this.registrations) if (challenge.deviceId === deviceId) this.registrations.delete(key)
    for (const [key, challenge] of this.assertions) if (challenge.deviceId === deviceId) this.assertions.delete(key)
    this.options.grants.endDevice(deviceId, 'device-removed')
    const count = await this.options.store.removeDevice(deviceId)
    if (count > 0) this.options.log(`home-auth: passkey.removed device=${deviceId} count=${String(count)} reason=device-removed`)
  }

  /**
   * Mint the grant of a confirmed request.
   * @param asker - the device and listener.
   * @param request - what was confirmed.
   * @param factor - the factor that confirmed it.
   * @returns the grant.
   */
  private mint(asker: UnlockAsker, request: AssertionRequest, factor: 'passkey' | 'pin'): PasskeyGrantResult {
    const holder = { deviceId: asker.deviceId, listener: asker.listener }
    return request.kind === 'actions' ? this.options.grants.mint(holder, request.entries, factor) : this.options.grants.mintAnswer(holder, request.requestKey, request.answer)
  }

  /**
   * The live ticket of an asker.
   * @param asker - the device, listener and session.
   * @returns the ticket.
   * @throws {HomeAuthError} `ELEVATION_REQUIRED` when none is live for this device, listener and session.
   */
  private liveTicket(asker: UnlockAsker): Ticket {
    const ticket = this.tickets.get(asker.deviceId)
    const live = ticket !== undefined && ticket.expiresAt > this.options.now() && ticket.listener === asker.listener
      && (ticket.sessionId === undefined || this.options.sameSession(asker.sessionId, ticket.sessionId))
    if (!live) throw new HomeAuthError('ELEVATION_REQUIRED', 'Face ID can only be set up after your computer approves it')
    return ticket
  }

  /**
   * Take a stored challenge for an asker, using it up even when it is not the asker's.
   * @param from - the challenge map.
   * @param challenge - the challenge as the client data names it.
   * @param asker - the device, listener and session.
   * @returns the stored record, or undefined for one that is unknown, used, expired or another device's, listener's or session's.
   */
  private takeChallenge<T extends { readonly deviceId: DeviceId; readonly sessionId: string; readonly listener: UnlockAsker['listener']; readonly expiresAt: number }>(from: Map<string, T>, challenge: string, asker: UnlockAsker): T | undefined {
    const stored = from.get(challenge)
    from.delete(challenge)
    if (stored === undefined || stored.expiresAt <= this.options.now()) return undefined
    if (stored.deviceId !== asker.deviceId || stored.listener !== asker.listener || !this.options.sameSession(asker.sessionId, stored.sessionId)) return undefined
    return stored
  }

  /**
   * Keep at most {@link CHALLENGES_PER_DEVICE} challenges of a device, dropping the oldest and the expired.
   * @param from - the challenge map.
   * @param deviceId - the device.
   */
  private trim(from: Map<string, { readonly deviceId: DeviceId; readonly expiresAt: number }>, deviceId: DeviceId): void {
    const at = this.options.now()
    for (const [key, challenge] of from) if (challenge.expiresAt <= at) from.delete(key)
    const mine = [...from].filter(([, challenge]) => challenge.deviceId === deviceId)
    for (const [key] of mine.slice(0, Math.max(0, mine.length - CHALLENGES_PER_DEVICE))) from.delete(key)
  }
}

/**
 * The challenge a credential's client data carries.
 * @param clientDataJSON - the client data, base64url.
 * @returns the challenge text, or an empty string for client data that is not JSON with one.
 */
function extractChallenge(clientDataJSON: string): string {
  try {
    const data: unknown = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8'))
    return isRecord(data) && typeof data.challenge === 'string' ? data.challenge : ''
  } catch (_malformed) {
    // Client data that is not JSON names no challenge; the caller refuses an empty one.
    return ''
  }
}

/** The refusal codes a failed passkey check carries. */
export type PasskeyFailureCode = 'PASSKEY_ASSERTION_INVALID' | 'PASSKEY_USER_VERIFICATION_REQUIRED' | 'PASSKEY_COUNTER_REGRESSED'

/**
 * A refusal with a narrowed code.
 * @param code - the code.
 * @param message - the sentence.
 * @returns the error.
 */
function failed(code: PasskeyFailureCode, message: string): HomeAuthError & { readonly code: PasskeyFailureCode } {
  return Object.assign(new HomeAuthError(code, message), { code })
}

/**
 * The refusal a failed verification becomes.
 * @param error - what the library threw.
 * @returns the typed refusal, with the user-verification and counter failures told apart.
 */
function verificationFailure(error: unknown): HomeAuthError & { readonly code: PasskeyFailureCode } {
  const message = error instanceof Error ? error.message : ''
  if (/user verif/i.test(message)) return failed('PASSKEY_USER_VERIFICATION_REQUIRED', 'The device did not verify you')
  if (/counter/i.test(message)) return failed('PASSKEY_COUNTER_REGRESSED', 'That passkey looks copied')
  return failed('PASSKEY_ASSERTION_INVALID', 'That confirmation did not check out')
}
