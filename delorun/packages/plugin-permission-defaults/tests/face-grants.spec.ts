/** The full-access routes under Face ID: turning a workspace's full access on or off needs a grant for that exact call; the reads, the review and the everywhere-off stay free. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REACH_DEVICE } from '@delorun/home-auth'
import { faceWorld, type FaceWorld } from '../../plugin-changes/tests/face-world.ts'
import { registerPermissionRoutes } from '../src/routes.ts'
import { PERMISSION_ROUTES } from '../src/wire.ts'

interface Route {
  readonly path: string
  readonly admitPeer?: (request: Request, peer: { principal: { kind: string } }) => boolean
  readonly fetch: (request: Request) => Promise<Response> | Response
}

const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const REVIEW_A = 'a'.repeat(32)
const ON_BODY = JSON.stringify({ workspace: '/work', reviewId: REVIEW_A, on: true, confirmed: true })
const OTHER_BODY = JSON.stringify({ workspace: '/work', reviewId: 'b'.repeat(32), on: true, confirmed: true })

function setup(home: { face: FaceWorld, elevation?: { id: string, grace?: true }, page?: boolean }) {
  const routes = new Map<string, Route>()
  const defaults = {
    setFullAccess: vi.fn(() => Promise.resolve({ ok: true })), everywhere: vi.fn(() => ({ on: false })), workspaces: vi.fn(() => ({ workspaces: [] })),
    reviewChat: vi.fn(() => ({ workspace: '/work' })), reload: vi.fn(() => Promise.resolve()),
  }
  const ctx = {
    on: () => {},
    get: (name: string) => (name === 'homeAuth' ? {
      ...home.face.fields,
      elevationOf: () => home.elevation, pageUnlockOf: () => (home.page === true ? { id: 'p1' } : undefined),
      arrivalOf: () => ({ listener: 'reach' }), dangerousMode: () => false, unlockModeEnabled: () => false, touchUnlock: () => {},
    } : undefined),
    connection: { fetch: { register: (route: Route) => { routes.set(route.path, route) } } },
    permissionDefaults: defaults,
  }
  registerPermissionRoutes(ctx as never)
  return { routes, defaults }
}

const device = (extra: object = {}) => ({ principal: { kind: REACH_DEVICE, deviceId: 'd1', listener: 'reach', ...extra } })
const call = (path: string, body: string, grant?: string) => new Request(`http://x${path}`, { method: 'POST', headers: grant === undefined ? {} : { 'delorun-grant': grant }, body })

/** Run one request as the Connection does: admit the Peer, then answer it. */
async function through(route: Route, request: Request, peer: object = device()): Promise<number | 'refused'> {
  if (route.admitPeer?.(request, peer as never) !== true) return 'refused'
  return (await route.fetch(request)).status
}

describe('under Face ID', () => {
  it('refuses setFullAccess to a device with a passkey that holds an unlock, a PIN page unlock, the grace or no grant, and never reaches the service', async () => {
    // Pins `gateByClass`: without the grant check the legacy unlock would admit the first two.
    for (const home of [{ elevation: { id: 'e1' } }, { page: true }, { elevation: { id: 'g1', grace: true as const } }, {}]) {
      const { routes, defaults } = setup({ face: faceWorld('d1', 'reach'), ...home })
      const route = routes.get(PERMISSION_ROUTES.setFullAccess)!
      const request = call(PERMISSION_ROUTES.setFullAccess, ON_BODY)
      expect(route.admitPeer!(request, device(home.page === true ? { unlockId: 'live' } : {}) as never)).toBe(true)
      const refusal = await route.fetch(request)
      expect([refusal.status, await refusal.json()], JSON.stringify(home)).toEqual([403, expect.objectContaining({ error: 'ELEVATION_REQUIRED' })])
      expect(defaults.setFullAccess).not.toHaveBeenCalled()
    }
  })

  it('admits exactly the body a grant was made for, once, and no other body', async () => {
    // Pins the request hash: without it a grant for one review would turn on another.
    const world = faceWorld('d1', 'reach')
    const { routes, defaults } = setup({ face: world })
    const route = routes.get(PERMISSION_ROUTES.setFullAccess)!
    const grant = world.grantFor('plugin-permission-defaults/set-full-access', { path: PERMISSION_ROUTES.setFullAccess, body: ON_BODY })
    expect(await through(route, call(PERMISSION_ROUTES.setFullAccess, OTHER_BODY, grant))).toBe(403)
    expect(defaults.setFullAccess).not.toHaveBeenCalled()
    expect(await through(route, call(PERMISSION_ROUTES.setFullAccess, ON_BODY, grant))).toBe(200)
    expect(defaults.setFullAccess).toHaveBeenCalledWith(expect.objectContaining({ workspace: '/work', reviewId: REVIEW_A }), 'device')
    // Pins the single use: without `consume` the same grant would turn it on again.
    expect(await through(route, call(PERMISSION_ROUTES.setFullAccess, ON_BODY, grant))).toBe(403)
    expect(defaults.setFullAccess).toHaveBeenCalledTimes(1)
  })

  // Moving setFullAccess into PASS_ADMITS, or a route that passes the wrong row to gateByClass, lets a picked-up phone in a pass turn on full access (F48).
  it('still asks for full access during a Face ID pass, and admits it with its own grant', async () => {
    const world = faceWorld('d1', 'reach')
    world.store.openPass({ deviceId: 'd1', listener: 'reach' as never }, 60)
    const { routes, defaults } = setup({ face: world })
    const route = routes.get(PERMISSION_ROUTES.setFullAccess)!
    expect(await through(route, call(PERMISSION_ROUTES.setFullAccess, ON_BODY))).toBe(403)
    expect(defaults.setFullAccess).not.toHaveBeenCalled()
    const grant = world.grantFor('plugin-permission-defaults/set-full-access', { path: PERMISSION_ROUTES.setFullAccess, body: ON_BODY })
    expect(await through(route, call(PERMISSION_ROUTES.setFullAccess, ON_BODY, grant))).toBe(200)
    expect(defaults.setFullAccess).toHaveBeenCalledTimes(1)
  })

  it('answers everywhere, everywhereOff, workspaces and review to a device with no unlock and no grant', async () => {
    // Pins the `free` class: gating them like setFullAccess would refuse a locked phone its reads and its tightening calls.
    const root = mkdtempSync(join(tmpdir(), 'dpd-'))
    roots.push(root)
    vi.stubEnv('DELORUN_HOME', root)
    const { routes } = setup({ face: faceWorld('d1', 'reach') })
    for (const path of [PERMISSION_ROUTES.everywhere, PERMISSION_ROUTES.workspaces]) expect(await through(routes.get(path)!, new Request(`http://x${path}`)), path).toBe(200)
    expect(await through(routes.get(PERMISSION_ROUTES.everywhereOff)!, call(PERMISSION_ROUTES.everywhereOff, ''))).toBe(200)
    expect(await through(routes.get(PERMISSION_ROUTES.review)!, call(PERMISSION_ROUTES.review, JSON.stringify({ sessionId: 'chat-1' })))).toBe(200)
  })

  it('never asks the owner: a request that skips admitPeer reaches the service, as the computer', async () => {
    // Pins `principal === undefined`: without it the owner's Peer would be asked for a grant.
    const { routes, defaults } = setup({ face: faceWorld('d1', 'reach') })
    expect((await routes.get(PERMISSION_ROUTES.setFullAccess)!.fetch(call(PERMISSION_ROUTES.setFullAccess, ON_BODY))).status).toBe(200)
    expect(defaults.setFullAccess).toHaveBeenCalledWith(expect.anything(), 'computer')
  })
})
