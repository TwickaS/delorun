/** The MCP consent routes under Face ID: accepting a server needs a grant for that exact call; the reads, decline and revoke stay free. */
import { describe, expect, it, vi } from 'vitest'
import { REACH_DEVICE } from '@delorun/home-auth'
import { faceWorld, type FaceWorld } from '../../plugin-changes/tests/face-world.ts'
import { registerMcpConsentRoutes } from '../src/routes.ts'
import { MCP_CONSENT_ROUTES } from '../src/wire.ts'

interface Route {
  readonly path: string
  readonly admitPeer?: (request: Request, peer: { principal: { kind: string } }) => boolean
  readonly fetch: (request: Request) => Promise<Response>
}

const ACCEPT_BODY = JSON.stringify({ serverName: 'files', reviewId: 'a'.repeat(32), confirmed: true })
const OTHER_BODY = JSON.stringify({ serverName: 'files', reviewId: 'b'.repeat(32), confirmed: true })

function setup(home: { face: FaceWorld, elevation?: { id: string, grace?: true }, page?: boolean }) {
  const routes = new Map<string, Route>()
  const reviews = {
    pending: vi.fn(() => []), accepted: vi.fn(() => Promise.resolve([])),
    acceptReview: vi.fn(() => Promise.resolve({ started: 1 })), declineReview: vi.fn(() => Promise.resolve()), revokeAcceptance: vi.fn(() => Promise.resolve({ stopped: 0 })),
  }
  const ctx = {
    on: () => {},
    get: (name: string) => (name === 'homeAuth' ? {
      ...home.face.fields,
      elevationOf: () => home.elevation, pageUnlockOf: () => (home.page === true ? { id: 'p1' } : undefined),
      arrivalOf: () => ({ listener: 'reach' }), dangerousMode: () => false, unlockModeEnabled: () => false, touchUnlock: () => {},
    } : undefined),
    connection: { fetch: { register: (route: Route) => { routes.set(route.path, route) } } },
  }
  registerMcpConsentRoutes(ctx as never, reviews as never)
  return { routes, reviews }
}

const device = (extra: object = {}) => ({ principal: { kind: REACH_DEVICE, deviceId: 'd1', listener: 'reach', ...extra } })
const call = (path: string, body: string, grant?: string) => new Request(`http://x${path}`, { method: 'POST', headers: grant === undefined ? {} : { 'delorun-grant': grant }, body })

/** Run one request as the Connection does: admit the Peer, then answer it. */
async function through(route: Route, request: Request, peer: object = device()): Promise<number | 'refused'> {
  if (route.admitPeer?.(request, peer as never) !== true) return 'refused'
  return (await route.fetch(request)).status
}

describe('under Face ID', () => {
  it('refuses accept to a device with a passkey that holds an unlock, a PIN page unlock, the grace or no grant, and never reaches the service', async () => {
    // Pins `gateByClass`: without the grant check the legacy unlock would admit the first two and the grace-free legacy gate the rest.
    for (const home of [{ elevation: { id: 'e1' } }, { page: true }, { elevation: { id: 'g1', grace: true as const } }, {}]) {
      const { routes, reviews } = setup({ face: faceWorld('d1', 'reach'), ...home })
      const route = routes.get(MCP_CONSENT_ROUTES.accept)!
      const request = call(MCP_CONSENT_ROUTES.accept, ACCEPT_BODY)
      expect(route.admitPeer!(request, device(home.page === true ? { unlockId: 'live' } : {}) as never), JSON.stringify(home)).toBe(true)
      const refusal = await route.fetch(request)
      expect([refusal.status, await refusal.json()], JSON.stringify(home)).toEqual([403, expect.objectContaining({ error: 'ELEVATION_REQUIRED' })])
      expect(reviews.acceptReview).not.toHaveBeenCalled()
    }
  })

  it('admits exactly the body a grant was made for, once, and no other body', async () => {
    // Pins the request hash: without it a grant for one review would accept another.
    const world = faceWorld('d1', 'reach')
    const { routes, reviews } = setup({ face: world })
    const route = routes.get(MCP_CONSENT_ROUTES.accept)!
    const grant = world.grantFor('plugin-mcp-consent/accept', { path: MCP_CONSENT_ROUTES.accept, body: ACCEPT_BODY })
    expect(await through(route, call(MCP_CONSENT_ROUTES.accept, OTHER_BODY, grant))).toBe(403)
    expect(reviews.acceptReview).not.toHaveBeenCalled()
    expect(await through(route, call(MCP_CONSENT_ROUTES.accept, ACCEPT_BODY, grant))).toBe(200)
    expect(reviews.acceptReview).toHaveBeenCalledWith('files', 'a'.repeat(32), true)
    // Pins the single use: without `consume` the same grant would accept again.
    expect(await through(route, call(MCP_CONSENT_ROUTES.accept, ACCEPT_BODY, grant))).toBe(403)
    expect(reviews.acceptReview).toHaveBeenCalledTimes(1)
  })

  it('answers pending, waiting, decline and revoke to a device with no unlock and no grant', async () => {
    // Pins the `free` class: gating them like accept would refuse a locked phone its reads and its tightening answers.
    const { routes } = setup({ face: faceWorld('d1', 'reach') })
    const bodies = new Map([
      [MCP_CONSENT_ROUTES.decline, JSON.stringify({ serverName: 'files', reviewId: 'a'.repeat(32) })],
      [MCP_CONSENT_ROUTES.revoke, JSON.stringify({ acceptanceId: 'c'.repeat(32), confirmed: true })],
    ])
    for (const path of [MCP_CONSENT_ROUTES.pending, MCP_CONSENT_ROUTES.waiting]) expect(await through(routes.get(path)!, new Request(`http://x${path}`)), path).toBe(200)
    for (const [path, body] of bodies) expect(await through(routes.get(path)!, call(path, body)), path).toBe(200)
  })

  it('never asks the owner: a request that skips admitPeer reaches the service', async () => {
    // Pins `principal === undefined`: without it the owner's Peer would be asked for a grant.
    const { routes, reviews } = setup({ face: faceWorld('d1', 'reach') })
    expect((await routes.get(MCP_CONSENT_ROUTES.accept)!.fetch(call(MCP_CONSENT_ROUTES.accept, ACCEPT_BODY))).status).toBe(200)
    expect(reviews.acceptReview).toHaveBeenCalledTimes(1)
  })
})
