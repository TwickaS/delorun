/**
 * Fixtures for the owner claim and device list specs: a temporary secrets directory, a deterministic random source and
 * clock, device keys that need no signing (this package records them and derives their ids), and a claim builder.
 *
 * A key here is only 32 bytes of one value, written base64url: the claim route and the store never verify a signature,
 * which is the sign-in package's work, so a spec needs a well-formed key rather than a usable one.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ListenerId, StudioAddress } from '@delo/contract-admission'
import { DEVICE_APPROVAL_VERSION, type Base64Url, type DevicePublicKeyJwk } from '@delo/contract-device-approval'
import { HomeAuth, type ClaimRequest } from '../../src/home-auth.ts'
import { deviceIdOf, type DeviceRecord } from '../../src/records.ts'

/** The secret a fixture key is filled with, so two fixtures differ without any randomness. */
export function keyOf(fill: number): DevicePublicKeyJwk {
  const coordinate = (value: number): string => Buffer.alloc(32, value).toString('base64url')
  return { kty: 'EC', crv: 'P-256', x: brandString<Base64Url>(coordinate(fill)), y: brandString<Base64Url>(coordinate(fill + 100)) }
}

/**
 * A device record a store holds, as a claim or an approval would write one.
 * @param fill - the fill of the fixture key the record names.
 * @param address - the studio address the device is trusted on.
 * @param overrides - fields to replace, such as the address a spec rewrites.
 * @returns the record.
 */
export function recordOf(fill: number, address: StudioAddress, overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    v: DEVICE_APPROVAL_VERSION,
    id: deviceIdOf(keyOf(fill)),
    publicKey: keyOf(fill),
    address,
    label: `Device ${String(fill)}`,
    platform: '',
    approvedAt: 0,
    approvedBy: null,
    lastSignInAt: null,
    ...overrides,
  }
}

/** A temporary secrets directory, removed when the fixture is disposed. */
export interface Home {
  /** The absolute path of `~/.delo/secrets/home-auth` for this spec. */
  readonly directory: string
  /** A clock the spec moves by hand, in milliseconds since the epoch. */
  readonly clock: { now: number; readonly read: () => number; advance(by: number): void }
  /**
   * A deterministic random source: each draw answers one byte value higher than the last, so a code and a token are
   * reproducible and no two draws ever collide.
   */
  readonly random: (size: number) => Uint8Array
  /** A home-auth instance over this directory and clock. */
  readonly auth: HomeAuth
  /** The port the fixture names as the loopback listener's; a spec's server sets it once it is bound. */
  readonly loopback: { port: number | undefined }
  /** What a `closeReachConnections` stub recorded, in call order. */
  readonly closed: { readonly deviceId?: string }[]
  /** Dispose the directory. */
  readonly dispose: () => Promise<void>
}

/** The epoch a fixture clock starts at: 2026-01-01T00:00:00Z. */
const START = Date.UTC(2026, 0, 1)

/**
 * Build a home fixture.
 * @param options - extra options, such as another random fill.
 * @returns the fixture.
 */
export async function homeFixture(options: { readonly fill?: number } = {}): Promise<Home> {
  const directory = await mkdtemp(join(tmpdir(), 'delo-home-auth-'))
  const clock = {
    now: START,
    read: (): number => clock.now,
    advance: (by: number): void => { clock.now += by },
  }
  let draw = options.fill ?? 7
  const random = (size: number): Uint8Array => {
    const value = draw
    draw += 1
    return new Uint8Array(size).fill(value)
  }
  const closed: { readonly deviceId?: string }[] = []
  const loopback: { port: number | undefined } = { port: undefined }
  const auth = new HomeAuth({
    loopbackPort: () => loopback.port,
    directory,
    now: clock.read,
    random,
    closeReachConnections: (match: { readonly deviceId?: string; readonly sessionId?: string }) => {
      closed.push(match)
      return 1
    },
  })
  await auth.start()
  return {
    directory, clock, random, auth, loopback, closed,
    dispose: async () => {
      await auth.stop()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

/**
 * A claim message a loopback request would carry.
 * @param ownerCode - the code the person typed.
 * @param overrides - fields to replace, such as the listener or the label.
 * @returns the claim.
 */
export function claimOf(ownerCode: string, overrides: Partial<ClaimRequest> = {}): ClaimRequest {
  return {
    listener: 'loopback' as ListenerId,
    host: '127.0.0.1:3080',
    source: '127.0.0.1',
    ownerCode,
    devicePublicKey: keyOf(1),
    label: 'This computer',
    address: brandString<StudioAddress>('http://127.0.0.1:3080'),
    ...overrides,
  }
}
