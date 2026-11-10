/**
 * Sign-in's challenge and device-key signature (contract C5, "Sign-in"): `POST /auth/device/challenge` hands a trusted
 * device 32 random bytes that expire after 60 seconds, a device holds at most 5 unused ones, and each is single-use.
 * `POST /auth/session` carries an ECDSA P-256 signature, in WebCrypto's raw `r ‖ s` form, over
 * `"delo-signin-v1" ‖ 0x00 ‖ address ‖ challenge`, where the address is its UTF-8 text and the challenge its 32 bytes.
 *
 * @module @delo/home-auth/sign-in
 */
import { createPublicKey, verify } from 'node:crypto'
import type { DeviceId } from '@delo/contract-admission'
import { DEVICE_APPROVAL_LIMITS, SIGN_IN_LABEL, type DevicePublicKeyJwk } from '@delo/contract-device-approval'
import { newSecret, type RandomBytes } from './secret.ts'

/** One issued challenge. */
interface Issued {
  readonly value: string
  readonly expiresAt: number
}

/** The unused challenges of a home's devices, in memory. */
export class Challenges {
  private readonly issued = new Map<DeviceId, Issued[]>()

  /**
   * @param now - the clock.
   * @param random - the random source.
   */
  constructor(private readonly now: () => number, private readonly random: RandomBytes) {}

  /**
   * Issue a challenge, dropping the device's oldest unused one past the bound of 5.
   * @param deviceId - the device.
   * @returns the challenge, base64url.
   */
  issue(deviceId: DeviceId): string {
    const at = this.now()
    const live = (this.issued.get(deviceId) ?? []).filter(entry => entry.expiresAt > at)
    const value = newSecret(DEVICE_APPROVAL_LIMITS.challengeBytes, this.random)
    live.push({ value, expiresAt: at + DEVICE_APPROVAL_LIMITS.challengeExpiryMs })
    this.issued.set(deviceId, live.slice(-DEVICE_APPROVAL_LIMITS.unusedChallengesPerDevice))
    return value
  }

  /**
   * Use a challenge once.
   * @param deviceId - the device it was issued to.
   * @param value - the challenge as presented.
   * @returns whether it was issued to this device, is unexpired and was not used; it is used up either way.
   */
  consume(deviceId: DeviceId, value: string): boolean {
    const entries = this.issued.get(deviceId) ?? []
    const index = entries.findIndex(entry => entry.value === value)
    if (index === -1) return false
    const [entry] = entries.splice(index, 1)
    return entry !== undefined && entry.expiresAt > this.now()
  }
}

/**
 * The bytes a sign-in signature covers.
 * @param address - the studio address the session is for.
 * @param challenge - the challenge, base64url.
 * @returns the signed message.
 */
export function signInMessage(address: string, challenge: string): Buffer {
  return Buffer.concat([Buffer.from(SIGN_IN_LABEL, 'utf8'), Buffer.of(0), Buffer.from(address, 'utf8'), Buffer.from(challenge, 'base64url')])
}

/**
 * Whether a sign-in signature verifies with a device's key.
 * @param publicKey - the device public key.
 * @param address - the studio address.
 * @param challenge - the challenge, base64url.
 * @param signature - the signature, base64url of the raw `r ‖ s` form.
 * @returns whether it verifies; a malformed key or signature does not.
 */
export function signInVerifies(publicKey: DevicePublicKeyJwk, address: string, challenge: string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: { kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x, y: publicKey.y }, format: 'jwk' })
    return verify('sha256', signInMessage(address, challenge), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
  } catch {
    // A key that is no P-256 point or a signature of the wrong length is a signature that does not verify.
    return false
  }
}
