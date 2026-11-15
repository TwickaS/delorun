/**
 * The page unlock's carriers on the connection: the header and subprotocols a held token adds, and none while locked.
 */
import { describe, expect, it } from 'vitest'
import { MUX_PROTOCOL, unlockExtras } from '../src/client/unlock-connection.ts'

describe('unlockExtras', () => {
  it('adds the header and the subprotocols for a held token, and nothing while the page is locked', () => {
    // Pins the locked default: a page with no token must send nothing the home could read as an unlock.
    expect(unlockExtras(null)).toEqual({})
    expect(unlockExtras('abc')).toEqual({ headers: { 'Delorun-Unlock': 'abc' }, subprotocols: [MUX_PROTOCOL, 'delorun-unlock.abc'] })
  })
})
