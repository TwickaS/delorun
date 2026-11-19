/**
 * The browser's WebAuthn calls behind a small interface, so the sheet's call to `navigator.credentials.get` sits in one
 * place and a spec supplies a fake or Chromium's virtual authenticator supplies a real one.
 * @module @delorun/bundle-local/client/face-id-browser
 */
import type {
  AssertionResponseJSON, CreationOptionsJSON, FaceIdKind, RegistrationResponseJSON, RequestOptionsJSON,
} from './face-id-types.ts'

/** What a browser call came to. A cancel is the person dismissing the platform sheet; it is never counted as a failure. */
export type PasskeyResult<T> = { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'cancelled' } | { readonly kind: 'failed' }

/** The browser's passkey calls. */
export interface PasskeyBrowser {
  /**
   * Whether this browser can ask for a platform passkey at all.
   * @returns false when `PublicKeyCredential` is missing or no platform authenticator exists.
   */
  available(): Promise<boolean>
  /**
   * Ask for an assertion. Call it inside the tap's handler: Safari honours the tap for a short time only.
   * @param options - the home's options.
   * @returns the assertion, or why there is none.
   */
  get(options: RequestOptionsJSON): Promise<PasskeyResult<AssertionResponseJSON>>
  /**
   * Create a passkey. Call it inside the tap's handler.
   * @param options - the home's options.
   * @returns the credential, or why there is none.
   */
  create(options: CreationOptionsJSON): Promise<PasskeyResult<RegistrationResponseJSON>>
}

/**
 * Encode bytes as base64url.
 * @param bytes - the bytes.
 * @returns the unpadded base64url text.
 */
export function toBase64Url(bytes: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Decode base64url text.
 * @param text - the base64url text.
 * @returns the bytes.
 */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * Sort a thrown error: the person's dismissal is a cancel, anything else a failure.
 * @param error - what the browser threw.
 * @returns `cancelled` for `NotAllowedError` and `AbortError`, otherwise `failed`.
 */
export function passkeyFailure(error: unknown): { readonly kind: 'cancelled' } | { readonly kind: 'failed' } {
  const name = error instanceof Error ? error.name : ''
  return name === 'NotAllowedError' || name === 'AbortError' ? { kind: 'cancelled' } : { kind: 'failed' }
}

/** The pieces of `navigator` the platform name reads. */
export interface PlatformProbe {
  readonly userAgent: string
  readonly platform: string
  readonly maxTouchPoints: number
}

/**
 * Name the platform's unlock. This is a guess for wording only: it chooses the noun on the button, and never decides
 * whether a passkey may be used.
 * @param probe - the browser's own description of itself.
 * @returns the kind.
 */
export function faceIdKindOf(probe: PlatformProbe): FaceIdKind {
  const text = `${probe.userAgent} ${probe.platform}`
  if (/iPhone|iPad|iPod/.test(text) || (/Mac/.test(probe.platform) && probe.maxTouchPoints > 1)) return 'faceId'
  if (/Mac/.test(text)) return 'touchId'
  if (/Win/.test(text)) return 'windowsHello'
  if (/Android/.test(text)) return 'fingerprint'
  return 'deviceLock'
}

/**
 * The browser's own passkey calls.
 * @param scope - the page's globals; a spec passes a fake.
 * @returns the calls.
 */
export function browserPasskeys(scope: { readonly navigator: Navigator; readonly PublicKeyCredential?: typeof PublicKeyCredential } = globalThis): PasskeyBrowser {
  return {
    async available() {
      const credential = scope.PublicKeyCredential
      if (credential === undefined || scope.navigator.credentials === undefined) return false
      return credential.isUserVerifyingPlatformAuthenticatorAvailable()
    },
    async get(options) {
      let credential: Credential | null
      try {
        credential = await scope.navigator.credentials.get({
          publicKey: {
            challenge: fromBase64Url(options.challenge),
            rpId: options.rpId,
            userVerification: options.userVerification,
            ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
            allowCredentials: options.allowCredentials.map(entry => ({ type: entry.type, id: fromBase64Url(entry.id) })),
          },
        })
      } catch (error) {
        return passkeyFailure(error)
      }
      if (credential === null || !('response' in credential)) return { kind: 'failed' }
      const pk = credential as PublicKeyCredential
      const response = pk.response as AuthenticatorAssertionResponse
      return {
        kind: 'ok',
        value: {
          id: pk.id,
          rawId: toBase64Url(pk.rawId),
          type: 'public-key',
          response: {
            clientDataJSON: toBase64Url(response.clientDataJSON),
            authenticatorData: toBase64Url(response.authenticatorData),
            signature: toBase64Url(response.signature),
            userHandle: response.userHandle === null ? undefined : toBase64Url(response.userHandle),
          },
          clientExtensionResults: {},
          authenticatorAttachment: pk.authenticatorAttachment ?? undefined,
        },
      }
    },
    async create(options) {
      let credential: Credential | null
      try {
        credential = await scope.navigator.credentials.create({
          publicKey: {
            challenge: fromBase64Url(options.challenge),
            rp: options.rp,
            user: { id: fromBase64Url(options.user.id), name: options.user.name, displayName: options.user.displayName },
            pubKeyCredParams: [...options.pubKeyCredParams],
            ...(options.excludeCredentials === undefined ? {} : { excludeCredentials: options.excludeCredentials.map(entry => ({ type: entry.type, id: fromBase64Url(entry.id) })) }),
            authenticatorSelection: options.authenticatorSelection,
            attestation: options.attestation,
            ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
          },
        })
      } catch (error) {
        return passkeyFailure(error)
      }
      if (credential === null || !('response' in credential)) return { kind: 'failed' }
      const pk = credential as PublicKeyCredential
      const response = pk.response as AuthenticatorAttestationResponse
      return {
        kind: 'ok',
        value: {
          id: pk.id,
          rawId: toBase64Url(pk.rawId),
          type: 'public-key',
          response: {
            clientDataJSON: toBase64Url(response.clientDataJSON),
            attestationObject: toBase64Url(response.attestationObject),
            transports: response.getTransports?.(),
          },
          clientExtensionResults: {},
          authenticatorAttachment: pk.authenticatorAttachment ?? undefined,
        },
      }
    },
  }
}
