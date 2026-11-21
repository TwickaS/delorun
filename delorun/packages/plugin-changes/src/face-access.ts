/**
 * A paired device's Face ID grants as the Changes routes read them ({@link FaceAccess}): the home keeps the grants, and a
 * route uses one up only for the exact method, path and body it was made for, unless the device's Peer holds a live
 * Face ID pass, which admits every `face` control.
 *
 * @module @delorun/plugin-changes/face-access
 */
import { hashRequest, passAdmitsRow, type GrantHolder, type GrantStore } from '@delorun/home-auth'
import type { FaceAccess } from './routes.ts'

/** The prefix of a Changes control's grant action; the rest is its `changes:` row in `AUTH_CLASSES`. */
const CHANGES_PREFIX = 'changes/'

/**
 * @param grants - the home's grant store, or undefined while the home keeps none.
 * @param hasPasskey - whether the device holds a passkey.
 * @param holder - the device, the listener its session arrived on and its page unlock, which a grant and a pass are bound to.
 * @returns the device's grants; `enabled` is false while the home keeps no grant store.
 */
export function faceAccessOf(grants: GrantStore | undefined, hasPasskey: boolean, holder: GrantHolder): FaceAccess {
  return {
    enabled: grants !== undefined,
    hasPasskey,
    claim: (action, call, grantId) => {
      // The device's live Face ID pass on this listener admits a Changes control whose row is `face` (A499); the grant header is then not read.
      if (grants !== undefined && action.startsWith(CHANGES_PREFIX) && passAdmitsRow(grants, holder, `changes:${action.slice(CHANGES_PREFIX.length)}`)) return () => true
      const hash = hashRequest(call)
      if (grants === undefined || hash === undefined || grantId === undefined) return undefined
      // The header only names the grant; the home checks the hash of the bytes it read itself.
      if (grants.peek(holder, action, hash)?.grantId !== grantId) return undefined
      return () => grants.consume(holder, action, hash) !== undefined
    },
  }
}
