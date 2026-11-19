/**
 * The Face ID screens' view of the home's passkey routes: the requests the screens make, as a typed interface. The
 * HTTP implementation sits behind it, so the screens and their specs never see a route path, and a spec supplies the
 * fake of [`./face-id-fake.ts`](./face-id-fake.ts).
 * @module @delorun/bundle-local/client/face-id-types
 */

/** How the platform names its unlock: the screens' copy takes the noun from this. */
export type FaceIdKind = 'faceId' | 'touchId' | 'windowsHello' | 'fingerprint' | 'deviceLock'

/** The kinds, in the order a spec walks them. */
export const FACE_ID_KINDS: readonly FaceIdKind[] = ['faceId', 'touchId', 'windowsHello', 'fingerprint', 'deviceLock']

/** What the grant covers: the calls one tap makes, or one prompt answer. */
export type GrantRequest =
  | { readonly actions: readonly { readonly action: string; readonly hash: string }[] }
  | { readonly answer: { readonly requestId: string; readonly value: string } }

/** What a sensitive action is, in the words its own description gives the person. */
export interface FaceIdAction {
  /** What the grant covers, hashed by the caller from the calls it is about to make. */
  readonly grant: GrantRequest
  /** The action as a question, such as `Install “Reports”?`. */
  readonly title: string
  /** One or two lines saying what changes and what widens. */
  readonly body: string
  /** The items a batch covers; the sheet shows at most three, then the count of the rest. */
  readonly items?: readonly string[]
}

/** A passkey as the home lists it. */
export interface PasskeyEntry {
  readonly credentialId: string
  /** Milliseconds since the epoch. */
  readonly createdAt: number
  /** Milliseconds since the epoch; null before its first use. */
  readonly lastUsedAt: number | null
  /** Whether the passkey is backup-eligible, so the platform syncs it. */
  readonly synced: boolean
}

/** A device with the passkeys it holds. */
export interface PasskeyDevice {
  readonly deviceId: string
  readonly label: string
  /** Whether this page is that device. */
  readonly thisDevice: boolean
  readonly passkeys: readonly PasskeyEntry[]
}

/** A pending "Add Face ID" request, as the computer lists it. */
export interface PendingAdd {
  readonly requestId: string
  readonly deviceId: string
  readonly deviceLabel: string
  readonly expiresAt: number
}

/** A grant the home now holds, used once by the call that carries its id in `Delorun-Grant`. */
export interface GrantTicket {
  readonly grantId: string
  /** Milliseconds since the epoch. */
  readonly expiresAt: number
}

/** The JSON a passkey creation needs, as the home sends it: binary fields are base64url strings. */
export interface CreationOptionsJSON {
  readonly challenge: string
  readonly rp: { readonly id: string; readonly name: string }
  readonly user: { readonly id: string; readonly name: string; readonly displayName: string }
  readonly pubKeyCredParams: readonly { readonly type: 'public-key'; readonly alg: number }[]
  readonly excludeCredentials?: readonly { readonly type: 'public-key'; readonly id: string }[]
  readonly authenticatorSelection: {
    readonly residentKey: 'required'
    readonly userVerification: 'required'
    readonly authenticatorAttachment: 'platform'
  }
  readonly attestation: 'none'
  readonly timeout?: number
}

/** The JSON an assertion needs, as the home sends it. */
export interface RequestOptionsJSON {
  readonly challenge: string
  readonly rpId: string
  readonly allowCredentials: readonly { readonly type: 'public-key'; readonly id: string }[]
  readonly userVerification: 'required'
  readonly timeout?: number
}

/** A created credential, in the base64url JSON the home verifies. */
export interface RegistrationResponseJSON {
  readonly id: string
  readonly rawId: string
  readonly type: 'public-key'
  readonly response: { readonly clientDataJSON: string; readonly attestationObject: string; readonly transports?: readonly string[] }
  readonly clientExtensionResults: Record<string, never>
  readonly authenticatorAttachment?: string
}

/** An assertion, in the base64url JSON the home verifies. */
export interface AssertionResponseJSON {
  readonly id: string
  readonly rawId: string
  readonly type: 'public-key'
  readonly response: { readonly clientDataJSON: string; readonly authenticatorData: string; readonly signature: string; readonly userHandle?: string }
  readonly clientExtensionResults: Record<string, never>
  readonly authenticatorAttachment?: string
}

/** The home's passkey routes, one method per route. Each rejects with the home's refusal or an unreachable-host error. */
export interface PasskeyApi {
  /**
   * What this device holds, and whether an enrolment ticket waits.
   * @returns the passkeys and the ticket flag.
   */
  state(): Promise<{ readonly passkeys: readonly PasskeyEntry[]; readonly ticket: boolean }>
  /**
   * Ask for the options of one assertion.
   * @param request - the calls the tap covers, or one prompt answer.
   * @returns the options, with a 60 s single-use challenge.
   */
  options(request: GrantRequest): Promise<RequestOptionsJSON>
  /**
   * Send the assertion.
   * @param response - the browser's assertion.
   * @returns the grant.
   */
  verify(response: AssertionResponseJSON): Promise<GrantTicket>
  /**
   * Mint a grant with the PIN or passcode, for a device with no passkey or after a cancelled prompt.
   * @param request - the secret and what the grant covers.
   * @returns the grant.
   */
  pin(request: GrantRequest & { readonly secret: string }): Promise<GrantTicket>
  /**
   * The options of a new passkey; needs a live enrolment ticket.
   * @returns the options.
   */
  registerOptions(): Promise<CreationOptionsJSON>
  /**
   * Send the new credential; uses the ticket up.
   * @param response - the browser's credential.
   * @returns the stored passkey.
   */
  register(response: RegistrationResponseJSON): Promise<PasskeyEntry>
  /**
   * A paired device asks to add a passkey.
   * @returns the request id and the code to type at the computer.
   */
  addRequest(): Promise<{ readonly requestId: string; readonly code: string; readonly expiresAt: number }>
  /**
   * The computer's pending requests.
   * @returns the requests, without their codes.
   */
  pendingAdds(): Promise<readonly PendingAdd[]>
  /**
   * The computer's person types the code the device shows.
   * @param request - the request and the digits.
   * @returns whether the code matched.
   */
  approveAdd(request: { readonly requestId: string; readonly code: string }): Promise<{ readonly matched: boolean }>
  /**
   * Every device with its passkeys. A phone needs the grant of a Face ID confirmation for action `auth/passkey/devices`.
   * @param request - the grant, when the page is a phone.
   * @returns the devices.
   */
  devices(request?: { readonly grantId?: string }): Promise<readonly PasskeyDevice[]>
  /**
   * Remove one passkey.
   * @param request - the passkey, its device, and the grant of a Face ID confirmation when the page is a phone.
   */
  removePasskey(request: { readonly credentialId: string; readonly deviceId: string; readonly grantId?: string }): Promise<void>
  /**
   * Remove one device with its passkeys.
   * @param request - the device, and the grant of a Face ID confirmation when the page is a phone.
   */
  removeDevice(request: { readonly deviceId: string; readonly grantId?: string }): Promise<void>
}
