/**
 * A software platform authenticator for specs: it makes the registration and assertion JSON a browser's
 * `navigator.credentials.create` and `get` return, with ES256 keys, `none` attestation and the flags a spec chooses
 * (user presence, user verification, backup eligibility, the relying-party id it hashes, the origin it reports).
 */
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto'
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import { isoCBOR } from '@simplewebauthn/server/helpers'

/** What one ceremony reports. */
export interface Ceremony {
  /** The origin the client data names. */
  readonly origin: string
  /** The relying-party id whose hash the authenticator data carries; defaults to the options' own. */
  readonly rpId?: string
  /** User verification; true by default. */
  readonly uv?: boolean
  /** User presence; true by default. */
  readonly up?: boolean
  /** The backup-eligible flag; false by default. */
  readonly be?: boolean
  /** The signature counter an assertion reports. */
  readonly counter?: number
  /** The challenge the client data carries; defaults to the options'. */
  readonly challenge?: string
}

const sha256 = (data: Uint8Array | string): Buffer => createHash('sha256').update(data).digest()

/** One credential held by the software authenticator. */
export class VirtualAuthenticator {
  readonly credentialId = randomBytes(16)
  private readonly privateKey: KeyObject
  private readonly x: Buffer
  private readonly y: Buffer
  private count = 0

  constructor() {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    this.privateKey = pair.privateKey
    const jwk = pair.publicKey.export({ format: 'jwk' })
    this.x = Buffer.from(jwk.x ?? '', 'base64url')
    this.y = Buffer.from(jwk.y ?? '', 'base64url')
  }

  /** @returns the credential id, base64url. */
  get id(): string {
    return this.credentialId.toString('base64url')
  }

  private flags(ceremony: Ceremony, attested: boolean): number {
    return ((ceremony.up ?? true) ? 0x01 : 0) | ((ceremony.uv ?? true) ? 0x04 : 0) | ((ceremony.be ?? false) ? 0x08 : 0) | (attested ? 0x40 : 0)
  }

  /**
   * Answer `navigator.credentials.create`.
   * @param options - the creation options the home sent.
   * @param ceremony - what to report.
   * @returns the registration response, as JSON.
   */
  create(options: PublicKeyCredentialCreationOptionsJSON, ceremony: Ceremony): RegistrationResponseJSON {
    const rpIdHash = sha256(ceremony.rpId ?? options.rp.id ?? '')
    const cose = Buffer.from(isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, this.x], [-3, this.y]])))
    const idLength = Buffer.alloc(2)
    idLength.writeUInt16BE(this.credentialId.length)
    const authData = Buffer.concat([rpIdHash, Buffer.of(this.flags(ceremony, true)), Buffer.alloc(4), Buffer.alloc(16), idLength, this.credentialId, cose])
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: ceremony.challenge ?? options.challenge, origin: ceremony.origin, crossOrigin: false }))
    const attestationObject = Buffer.from(isoCBOR.encode(new Map<string, string | Map<string, string> | Uint8Array>([['fmt', 'none'], ['attStmt', new Map<string, string>()], ['authData', authData]])))
    return {
      id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
      response: { clientDataJSON: clientData.toString('base64url'), attestationObject: attestationObject.toString('base64url'), transports: ['internal'] },
    }
  }

  /**
   * Answer `navigator.credentials.get`.
   * @param options - the request options the home sent.
   * @param ceremony - what to report; `counter` defaults to one more than the last assertion.
   * @returns the assertion, as JSON.
   */
  get(options: PublicKeyCredentialRequestOptionsJSON, ceremony: Ceremony): AuthenticationResponseJSON {
    this.count += 1
    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(ceremony.counter ?? this.count)
    const authData = Buffer.concat([sha256(ceremony.rpId ?? options.rpId ?? ''), Buffer.of(this.flags(ceremony, false)), counter])
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: ceremony.challenge ?? options.challenge, origin: ceremony.origin, crossOrigin: false }))
    const signature = createSign('sha256').update(Buffer.concat([authData, sha256(clientData)])).sign(this.privateKey)
    return {
      id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
      response: { clientDataJSON: clientData.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url') },
    }
  }
}
