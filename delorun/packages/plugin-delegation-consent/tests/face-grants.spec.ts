/** The delegation consent routes under Face ID: allowing an agent needs a grant for that exact call; the reads and revoke stay free. */
import { describe, expect, it, vi } from 'vitest'
import { REACH_DEVICE } from '@delorun/home-auth'
import { faceWorld, type FaceWorld } from '../../plugin-changes/tests/face-world.ts'
import { registerDelegationRoutes } from '../src/routes.ts'
import { DELEGATION_CONSENT_ROUTES } from '../src/wire.ts'

interface Route {
  readonly path: string
  readonly admitPeer?: (request: Request, peer: { principal: { kind: string } }) => boolean
  readonly fetch: (request: Request) => Promise<Response>
}

const ALLOW_BODY = JSON.stringify({ sessionId: 'chat-1', provider: 'codex', confirmed: true })
const OTHER_BODY = JSON.stringify({ sessionId: 'chat-2', provider: 'codex', confirmed: true })

function setup(home: { face: FaceWorld, elevation?: { id: string, grace?: true }, page?: boolean }) {
  const routes = new Map<string, Route>()
  const service = {
    grants: vi.fn(() => Promise.resolve({ grants: [] })), levels: vi.fn(() => ({ levels: [] })),
    allowWorkspace: vi.fn(() => Promise.resolve({ allowed: true })), revoke: vi.fn(() => Promise.resolve({ revoked: true })),
  }
  const ctx = {
    on: () => {},
    get: (name: string) => (name === 'homeAuth' ? {
      passkeysEnabled: () => false, faceGrants: () => undefined, deviceHasPasskey: () => false,
      ...home.face.fields,
      elevationOf: () => home.elevation, pageUnlockOf: () => (home.page === true ? { id: 'p1' } : undefined),
      arrivalOf: () => ({ listener: 'reach' }), dangerousMode: () => false, unlockModeEnabled: () => false, touchUnlock: () => {},
    } : undefined),
    connection: { fetch: { register: (route: Route) => { routes.set(route.path, route) } } },
  }
  registerDelegationRoutes(ctx as never, service as never)
  return { routes, service }
}

const device = (extra: object = {}) => ({ principal: { kind: REACH_DEVICE, deviceId: 'd1', listener: 'reach', ...extra } })
const call = (path: string, body: string, grant?: string) => new Request(`http://x${path}`, { method: 'POST', headers: grant === undefined ? {} : { 'delorun-grant': grant }, body })

/** Run one request as the Connection does: admit the Peer, then answer it. */
async function through(route: Route, request: Request, peer: object = device()): Promise<number | 'refused'> {
  if (route.admitPeer?.(request, peer as never) !== true) return 'refused'
  return (await route.fetch(request)).status
}

describe('under Face ID', () => {
  it('refuses allow to a device with a passkey that holds an unlock, a PIN page unlock, the grace or no grant, and never reaches the service', async () => {
    // Pins `gateByClass`: without the grant check the legacy unlock would admit the first two.
    for (const home of [{ elevation: { id: 'e1' } }, { page: true }, { elevation: { id: 'g1', grace: true as const } }, {}]) {
      const { routes, service } = setup({ face: faceWorld('d1', 'reach'), ...home })
      const route = routes.get(DELEGATION_CONSENT_ROUTES.allow)!
      const request = call(DELEGATION_CONSENT_ROUTES.allow, ALLOW_BODY)
      expect(route.admitPeer!(request, device(home.page === true ? { unlockId: 'live' } : {}) as never), JSON.stringify(home)).toBe(true)
      const refusal = await route.fetch(request)
      expect([refusal.status, await refusal.json()], JSON.stringify(home)).toEqual([403, expect.objectContaining({ error: 'ELEVATION_REQUIRED' })])
      expect(service.allowWorkspace).not.toHaveBeenCalled()
    }
  })

  it('admits exactly the body a grant was made for, once, and no other body', async () => {
    // Pins the request hash: without it a grant for one chat would allow an agent into another.
    const world = faceWorld('d1', 'reach')
    const { routes, service } = setup({ face: world })
    const route = routes.get(DELEGATION_CONSENT_ROUTES.allow)!
    const grant = world.grantFor('plugin-delegation-consent/allow', { path: DELEGATION_CONSENT_ROUTES.allow, body: ALLOW_BODY })
    expect(await through(route, call(DELEGATION_CONSENT_ROUTES.allow, OTHER_BODY, grant))).toBe(403)
    expect(service.allowWorkspace).not.toHaveBeenCalled()
    expect(await through(route, call(DELEGATION_CONSENT_ROUTES.allow, ALLOW_BODY, grant))).toBe(200)
    expect(service.allowWorkspace).toHaveBeenCalledWith({ sessionId: 'chat-1', provider: 'codex', confirmed: true })
    // Pins the single use: without `consume` the same grant would allow again.
    expect(await through(route, call(DELEGATION_CONSENT_ROUTES.allow, ALLOW_BODY, grant))).toBe(403)
    expect(service.allowWorkspace).toHaveBeenCalledTimes(1)
  })

  it('answers grants, levels and revoke to a device with no unlock and no grant', async () => {
    // Pins the `free` class: gating them like allow would refuse a locked phone its reads and its tightening call.
    const { routes } = setup({ face: faceWorld('d1', 'reach') })
    for (const path of [DELEGATION_CONSENT_ROUTES.grants, DELEGATION_CONSENT_ROUTES.levels]) expect(await through(routes.get(path)!, new Request(`http://x${path}`)), path).toBe(200)
    expect(await through(routes.get(DELEGATION_CONSENT_ROUTES.revoke)!, call(DELEGATION_CONSENT_ROUTES.revoke, JSON.stringify({ workspace: '/w', provider: 'codex' })))).toBe(200)
  })

  it('never asks the owner: a request that skips admitPeer reaches the service', async () => {
    // Pins `principal === undefined`: without it the owner's Peer would be asked for a grant.
    const { routes, service } = setup({ face: faceWorld('d1', 'reach') })
    expect((await routes.get(DELEGATION_CONSENT_ROUTES.allow)!.fetch(call(DELEGATION_CONSENT_ROUTES.allow, ALLOW_BODY))).status).toBe(200)
    expect(service.allowWorkspace).toHaveBeenCalledTimes(1)
  })
})
