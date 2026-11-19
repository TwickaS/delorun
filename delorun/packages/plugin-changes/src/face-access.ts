/**
 * A paired device's Face ID grants as the Changes routes read them ({@link FaceAccess}): the home keeps the grants, and a
 * route uses one up only for the exact method, path and body it was made for.
 *
 * @module @delorun/plugin-changes/face-access
 */
import { hashRequest, type GrantHolder, type GrantStore } from '@delorun/home-auth'
import type { FaceAccess } from './routes.ts'

/**
 * @param grants - the home's grant store, or undefined while the Face ID flag is off.
 * @param hasPasskey - whether the device holds a passkey.
 * @param holder - the device and the listener its session arrived on, which a grant is bound to.
 * @returns the device's grants; `enabled` is false while the flag is off.
 */
export function faceAccessOf(grants: GrantStore | undefined, hasPasskey: boolean, holder: GrantHolder): FaceAccess {
  return {
    enabled: grants !== undefined,
    hasPasskey,
    take: (action, call, grantId) => {
      const hash = hashRequest(call)
      if (grants === undefined || hash === undefined || grantId === undefined) return false
      // The header only names the grant; the home checks the hash of the bytes it read itself.
      if (grants.peek(holder, action, hash)?.grantId !== grantId) return false
      return grants.consume(holder, action, hash) !== undefined
    },
  }
}
