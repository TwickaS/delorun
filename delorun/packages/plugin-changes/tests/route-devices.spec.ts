/**
 * How the Changes routes read a paired device and the Phone powers level from the mounted `homeAuth` service: only a
 * reach device's session is a device, an approval grace is told apart from an unlock the person entered, and without
 * `homeAuth` no session is a device's and the level is Careful.
 */
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { routeDevices } from '../src/index.ts'

/** A reach device's admitted session. */
const PEER = { principal: { kind: 'reach-device', deviceId: 'device-1', listener: 'reach-tailscale-private' } }

/**
 * A scope whose `homeAuth` holds one device with the given unlock.
 * @param unlock - the device's unlock, if any.
 * @param touched - collects the unlocks renewed.
 * @returns the scope.
 */
function scope(unlock: { readonly id: string, readonly grace?: true } | undefined, touched: string[]): Pick<Context, 'get'> {
  const homeAuth = {
    passkeysEnabled: () => false,
    faceGrants: () => undefined,
    deviceHasPasskey: () => false,
    elevationOf: () => unlock,
    pageUnlockOf: () => undefined,
    devices: () => Promise.resolve({ devices: [{ id: 'device-1', label: 'Pixel' }] }),
    touchUnlock: (id: string) => { touched.push(id) },
    phonePowers: () => ({ level: 'full', chosen: true }),
  }
  return { get: ((name: string) => (name === 'homeAuth' ? homeAuth : undefined)) as Context['get'] }
}

describe('routeDevices', () => {
  it('reads the device, its unlock and the level, and renews only an unlock', async () => {
    const touched: string[] = []
    const fresh = await routeDevices(scope({ id: 'unlock-1' }, touched)).deviceOf(PEER)
    expect(fresh).toMatchObject({ id: 'device-1', label: 'Pixel', unlock: 'fresh' })
    fresh!.renew()
    expect(touched).toEqual(['unlock-1'])
    expect(await routeDevices(scope({ id: 'unlock-2', grace: true }, touched)).deviceOf(PEER)).toMatchObject({ unlock: 'grace' })
    const locked = await routeDevices(scope(undefined, touched)).deviceOf(PEER)
    expect(locked).toMatchObject({ unlock: 'none' })
    locked!.renew()
    expect(touched).toEqual(['unlock-1'])
    expect(routeDevices(scope(undefined, touched)).phonePowers()).toEqual({ level: 'full', chosen: true })
    // A session that is no reach device's is no device.
    expect(await routeDevices(scope({ id: 'unlock-1' }, touched)).deviceOf({ session: 'local' })).toBeUndefined()
  })

  it('without homeAuth, no session is a device and the level is Careful', async () => {
    const none: Pick<Context, 'get'> = { get: (() => undefined) as Context['get'] }
    expect(await routeDevices(none).deviceOf(PEER)).toBeUndefined()
    expect(routeDevices(none).phonePowers()).toEqual({ level: 'careful', chosen: false })
  })
})
