/**
 * Device and owner-claim records for the CLI's denial suites, built through `@delorun/home-auth`'s public exports: a
 * deterministic device public key, a trusted device's record, and the owner claim the home's computer makes over the
 * loopback listener.
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StudioAddress } from '@delorun/contract-admission'
import { DEVICE_APPROVAL_VERSION, type Base64Url, type DevicePublicKeyJwk } from '@delorun/contract-device-approval'
import { deviceIdOf, type ClaimRequest, type DeviceRecord } from '@delorun/home-auth'

/**
 * A P-256 public key whose coordinates are filled with one byte value, so each fill names a distinct device.
 * @param fill - the coordinates' byte value.
 * @returns the key.
 */
export function keyOf(fill: number): DevicePublicKeyJwk {
  const coordinate = (value: number): Base64Url => brandString<Base64Url>(Buffer.alloc(32, value).toString('base64url'))
  return { kty: 'EC', crv: 'P-256', x: coordinate(fill), y: coordinate(fill + 100) }
}

/**
 * A trusted device's record, as an approval writes it.
 * @param fill - the device key's fill.
 * @param address - the studio address the device was approved for.
 * @returns the record.
 */
export function recordOf(fill: number, address: StudioAddress): DeviceRecord {
  const publicKey = keyOf(fill)
  return {
    v: DEVICE_APPROVAL_VERSION,
    id: deviceIdOf(publicKey),
    publicKey,
    address,
    label: `Device ${String(fill)}`,
    platform: '',
    approvedAt: 0,
    approvedBy: null,
    lastSignInAt: null,
  }
}

/**
 * The owner claim the home's computer makes with an owner code, over the loopback listener on port 3080.
 * @param ownerCode - the owner code.
 * @param overrides - fields that differ from that claim.
 * @returns the claim.
 */
export function claimOf(ownerCode: string, overrides: Partial<ClaimRequest> = {}): ClaimRequest {
  return {
    listener: 'loopback',
    host: '127.0.0.1:3080',
    source: '127.0.0.1',
    ownerCode,
    devicePublicKey: keyOf(1),
    label: 'This computer',
    address: brandString<StudioAddress>('http://127.0.0.1:3080'),
    ...overrides,
  }
}
