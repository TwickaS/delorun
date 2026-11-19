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

/** What a sensitive action is, in the words its own description gives the person. */
export interface FaceIdAction {
  /** The elevated action's name, which the home checks the grant against. */
  readonly name: string
  /** The action as a question, such as `Install “Reports”?`. */
  readonly title: string
  /** One or two lines saying what changes and what widens. */
  readonly body: string
  /** The items a batch covers; the sheet shows at most three, then the count of the rest. */
  readonly items?: readonly string[]
  /** The SHA-256 hash of the action's canonical arguments, as the options request sends it. */
  readonly bodyHash: string
}

/** A passkey as the Devices list shows it. */
export interface PasskeyEntry {
  readonly id: string
  readonly kind: FaceIdKind
  /** Milliseconds since the epoch. */
  readonly addedAt: number
  readonly lastUsedAt?: number
  /** How many times it was used today. */
  readonly usesToday: number
  /** Whether the passkey is backup-eligible, so the platform syncs it. */
  readonly synced: boolean
}

/** A device with the passkeys it holds. */
export interface PasskeyDevice {
  readonly id: string
  readonly label: string
  /** Whether this page is that device. */
  readonly thisDevice: boolean
  /** Milliseconds since the epoch; undefined for a device that never signed in. */
  readonly lastSeenAt?: number
  readonly passkeys: readonly PasskeyEntry[]
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
}

/** An assertion, in the base64url JSON the home verifies. */
export interface AssertionResponseJSON {
  readonly id: string
  readonly rawId: string
  readonly type: 'public-key'
  readonly response: { readonly clientDataJSON: string; readonly authenticatorData: string; readonly signature: string; readonly userHandle?: string }
}

/** The result of one request to the passkey routes. */
export interface PasskeyApi {
  /**
   * Ask for the options of one assertion, for one action.
   * @param request - the action's name and the hash of its arguments.
   * @returns the options, and the id the verify request names.
   */
  assertionOptions(request: { readonly action: string; readonly bodyHash: string }): Promise<{ readonly challengeId: string; readonly options: RequestOptionsJSON }>
  /**
   * Send the assertion.
   * @param request - the challenge id and the assertion.
   * @returns the id of the grant the home now holds for the action.
   */
  verifyAssertion(request: { readonly challengeId: string; readonly response: AssertionResponseJSON }): Promise<{ readonly grantId: string }>
  /**
   * Ask for the options of a new passkey.
   * @param request - the enrol ticket the computer's Pair tap minted, or absent for a device that is already paired.
   * @returns the options, and the id the register request names.
   */
  registrationOptions(request: { readonly ticket?: string }): Promise<{ readonly challengeId: string; readonly options: CreationOptionsJSON }>
  /**
   * Send the new credential.
   * @param request - the challenge id and the credential.
   * @returns `done` once the pairing's own approval covers it, or `code` with the `delorun-passkey-v1` code to type at the computer.
   */
  register(request: { readonly challengeId: string; readonly response: RegistrationResponseJSON }): Promise<{ readonly kind: 'done' } | { readonly kind: 'code'; readonly code: string }>
  /**
   * Whether the computer accepted the code of a later "Add Face ID".
   * @returns `pending` until the computer's person types the code.
   */
  registrationState(): Promise<'pending' | 'done' | 'refused'>
  /**
   * The computer's side of a later "Add Face ID": the code typed at the computer.
   * @param code - the digits the phone shows.
   * @returns whether the code matched.
   */
  confirmCode(code: string): Promise<{ readonly matched: boolean }>
  /**
   * The devices with their passkeys.
   * @returns the list.
   */
  list(): Promise<readonly PasskeyDevice[]>
  /**
   * Remove one passkey.
   * @param request - the passkey, and the grant of a Face ID confirmation when the page is a phone.
   */
  removePasskey(request: { readonly passkeyId: string; readonly grantId?: string }): Promise<void>
  /**
   * Remove one device with its passkeys.
   * @param request - the device, and the grant of a Face ID confirmation when the page is a phone.
   */
  removeDevice(request: { readonly deviceId: string; readonly grantId?: string }): Promise<void>
}
