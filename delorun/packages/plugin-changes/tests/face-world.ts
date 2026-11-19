/**
 * A real grant store for the consumer packages' route specs: the home's `passkeysEnabled`, `faceGrants` and
 * `deviceHasPasskey` answers for one device, and a way to make the grant a Face ID would have made for one call.
 *
 * @module @delorun/plugin-changes/tests/face-world
 */
import { GrantStore, hashRequest } from '@delorun/home-auth'

/** The fields a `homeAuth` stand-in spreads in to turn the Face ID flag on for one device. */
export interface FaceWorld {
  readonly fields: { readonly passkeysEnabled: () => boolean, readonly faceGrants: () => GrantStore, readonly deviceHasPasskey: (deviceId: string) => boolean }
  /**
   * @param action - the gate's `action` option.
   * @param call - the method, path and body text the device will send.
   * @returns the `Delorun-Grant` header value for that call.
   */
  readonly grantFor: (action: string, call: { readonly method?: string, readonly path: string, readonly body: string }) => string
  readonly store: GrantStore
}

/**
 * @param deviceId - the device the grants belong to.
 * @param listener - the listener its session arrived on.
 * @param hasPasskey - whether the device holds a passkey.
 * @returns the stand-in.
 */
export function faceWorld(deviceId: string, listener: string, hasPasskey = true): FaceWorld {
  let counter = 0
  const store = new GrantStore({ now: () => 1_000_000, random: size => Uint8Array.from({ length: size }, () => (counter++ % 251) + 1) })
  return {
    store,
    fields: { passkeysEnabled: () => true, faceGrants: () => store, deviceHasPasskey: id => hasPasskey && id === deviceId },
    grantFor: (action, call) => {
      const hash = hashRequest({ method: call.method ?? 'POST', path: call.path, body: Buffer.from(call.body) })
      if (hash === undefined) throw new Error('body over the cap')
      return store.mint({ deviceId, listener: listener as never }, [{ action, hash }], 'passkey').grantId
    },
  }
}
