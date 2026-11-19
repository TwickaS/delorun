/** The Setup versions and report routes under Face ID: saving, switching and reading the report's details need a grant for that exact call; listing versions and their changes stay free. */
import { describe, expect, it, vi } from 'vitest'
import { REACH_DEVICE } from '@delorun/home-auth'
import { faceWorld, type FaceWorld } from '../../plugin-changes/tests/face-world.ts'
import { PROFILE_VERSION_ROUTES } from '../src/client/versions-api.ts'
import { REPORT_ROUTE } from '../src/client/report-api.ts'
import { registerVersionRoutes } from '../src/profile-versions.ts'
import { apply as applyReport, Config as ReportConfig } from '../src/report.ts'

interface Route {
  readonly path: string
  readonly admitPeer?: (request: Request, peer: { principal: { kind: string } }) => boolean
  readonly fetch: (request: Request) => Promise<Response>
}

type Unlock = { elevation?: { id: string, grace?: true }, page?: boolean }

const NO_CHANGES = {
  plugins: [], bundles: [], exemptions: [], builds: [], patchChanged: false, homePatchChanged: false, lockfileChanged: false, disabled: [], same: true,
}

/** The `homeAuth` stand-in: Face ID on for device `d1`, which holds a passkey and whatever unlock `home` gives. */
function homeAuthOf(face: FaceWorld, home: Unlock) {
  return {
    ...face.fields,
    elevationOf: () => home.elevation, pageUnlockOf: () => (home.page === true ? { id: 'p1' } : undefined),
    arrivalOf: () => ({ listener: 'reach' }), touchUnlock: () => {},
  }
}

function versions(face: FaceWorld, home: Unlock = {}) {
  const routes = new Map<string, Route>()
  const service = {
    list: vi.fn(() => Promise.resolve({ versions: [], unsaved: false })),
    changes: vi.fn(() => Promise.resolve(NO_CHANGES)),
    save: vi.fn(() => Promise.resolve({ id: 'a'.repeat(40), created: true })),
    switch: vi.fn(() => Promise.resolve({ changes: NO_CHANGES, restartNeeded: false })),
  }
  const ctx = {
    on: () => {},
    get: (name: string) => (name === 'homeAuth' ? homeAuthOf(face, home) : undefined),
    connection: { fetch: { register: (route: Route) => { routes.set(route.path, route) } } },
  }
  registerVersionRoutes(ctx as never, service as never)
  return { routes, service }
}

function report(face: FaceWorld, home: Unlock = {}) {
  const routes = new Map<string, Route>()
  const scope = {
    get: (name: string) => (name === 'homeAuth' ? homeAuthOf(face, home) : undefined),
    connection: { fetch: { register: (route: Route) => { routes.set(route.path, route) } } },
  }
  applyReport({ inject: (_names: string[], mounted: (scope: object) => void) => { mounted(scope) } } as never, ReportConfig({}))
  return routes.get(REPORT_ROUTE)!
}

const device = (extra: object = {}) => ({ principal: { kind: REACH_DEVICE, deviceId: 'd1', listener: 'reach', ...extra } })
const post = (path: string, body: string, grant?: string) => new Request(`http://x${path}`, { method: 'POST', headers: grant === undefined ? {} : { 'delorun-grant': grant }, body })
const get = (path: string, grant?: string) => new Request(`http://x${path}`, { headers: grant === undefined ? {} : { 'delorun-grant': grant } })
const UNLOCKS: readonly Unlock[] = [{ elevation: { id: 'e1' } }, { page: true }, { elevation: { id: 'g1', grace: true } }, {}]

/** Run one request as the Connection does: admit the Peer, then answer it. */
async function through(route: Route, request: Request, peer: object = device()): Promise<number | 'refused'> {
  if (route.admitPeer?.(request, peer as never) !== true) return 'refused'
  return (await route.fetch(request)).status
}

describe('the versions routes under Face ID', () => {
  const SAVE_BODY = JSON.stringify({ name: 'before the update' })
  const SWITCH_BODY = JSON.stringify({ version: 'a'.repeat(40) })

  it('refuses save and switch to a device with a passkey that holds an unlock, a PIN page unlock, the grace or no grant, and never reaches the service', async () => {
    // Pins `gateByClass`: without the grant check the legacy unlock would admit the first two.
    for (const home of UNLOCKS) {
      const { routes, service } = versions(faceWorld('d1', 'reach'), home)
      for (const [path, body] of [[PROFILE_VERSION_ROUTES.save, SAVE_BODY], [PROFILE_VERSION_ROUTES.switch, SWITCH_BODY]] as const) {
        const route = routes.get(path)!
        const request = post(path, body)
        expect(route.admitPeer!(request, device(home.page === true ? { unlockId: 'live' } : {}) as never), path).toBe(true)
        const refusal = await route.fetch(request)
        expect([refusal.status, await refusal.json()], `${path} ${JSON.stringify(home)}`).toEqual([403, expect.objectContaining({ error: 'ELEVATION_REQUIRED' })])
      }
      expect(service.save).not.toHaveBeenCalled()
      expect(service.switch).not.toHaveBeenCalled()
    }
  })

  it('admits exactly the body a grant was made for, once, and no other body', async () => {
    // Pins the request hash: without it a grant for one version would switch to another.
    const world = faceWorld('d1', 'reach')
    const { routes, service } = versions(world)
    const route = routes.get(PROFILE_VERSION_ROUTES.switch)!
    const grant = world.grantFor('bundle-local/profile-switch', { path: PROFILE_VERSION_ROUTES.switch, body: SWITCH_BODY })
    expect(await through(route, post(PROFILE_VERSION_ROUTES.switch, JSON.stringify({ version: 'b'.repeat(40) }), grant))).toBe(403)
    expect(service.switch).not.toHaveBeenCalled()
    expect(await through(route, post(PROFILE_VERSION_ROUTES.switch, SWITCH_BODY, grant))).toBe(200)
    expect(service.switch).toHaveBeenCalledWith('a'.repeat(40))
    // Pins the single use: without `consume` the same grant would switch again.
    expect(await through(route, post(PROFILE_VERSION_ROUTES.switch, SWITCH_BODY, grant))).toBe(403)
    expect(service.switch).toHaveBeenCalledTimes(1)
    const saved = world.grantFor('bundle-local/profile-save', { path: PROFILE_VERSION_ROUTES.save, body: SAVE_BODY })
    expect(await through(routes.get(PROFILE_VERSION_ROUTES.save)!, post(PROFILE_VERSION_ROUTES.save, SAVE_BODY, saved))).toBe(200)
    expect(service.save).toHaveBeenCalledWith('before the update')
  })

  it('answers list and changes to a device with no unlock and no grant', async () => {
    // Pins the `free` class: gating the reads like save would refuse a locked phone the versions list.
    const { routes } = versions(faceWorld('d1', 'reach'))
    for (const path of [PROFILE_VERSION_ROUTES.list, `${PROFILE_VERSION_ROUTES.changes}?version=${'a'.repeat(40)}`]) {
      expect(await through(routes.get(path.split('?')[0]!)!, get(path)), path).toBe(200)
    }
  })

  it('never asks the computer: a request that skips admitPeer reaches the service', async () => {
    // Pins `principal === undefined`: without it the owner's Peer would be asked for a grant.
    const { routes, service } = versions(faceWorld('d1', 'reach'))
    expect((await routes.get(PROFILE_VERSION_ROUTES.save)!.fetch(post(PROFILE_VERSION_ROUTES.save, SAVE_BODY))).status).toBe(200)
    expect((await routes.get(PROFILE_VERSION_ROUTES.switch)!.fetch(post(PROFILE_VERSION_ROUTES.switch, SWITCH_BODY))).status).toBe(200)
    expect([service.save.mock.calls.length, service.switch.mock.calls.length]).toEqual([1, 1])
  })
})

describe('the report details route under Face ID', () => {
  it('refuses a device with a passkey that holds an unlock, a PIN page unlock, the grace or no grant, as the excerpt can hold home paths', async () => {
    // Pins `gateByClass`: without the grant check the legacy unlock would admit the first two.
    for (const home of UNLOCKS) {
      const route = report(faceWorld('d1', 'reach'), home)
      const request = get(REPORT_ROUTE)
      expect(route.admitPeer!(request, device(home.page === true ? { unlockId: 'live' } : {}) as never)).toBe(true)
      const refusal = await route.fetch(request)
      expect([refusal.status, await refusal.json()], JSON.stringify(home)).toEqual([403, expect.objectContaining({ error: 'ELEVATION_REQUIRED' })])
    }
  })

  it('admits a GET with the grant made for it, once, and no grant made for another path', async () => {
    // Pins the request hash and the single use. A GET has an empty body, so the path is what tells grants apart.
    const world = faceWorld('d1', 'reach')
    const route = report(world)
    const other = world.grantFor('bundle-local/report-details', { method: 'GET', path: '/api/other', body: '' })
    expect(await through(route, get(REPORT_ROUTE, other))).toBe(403)
    const grant = world.grantFor('bundle-local/report-details', { method: 'GET', path: REPORT_ROUTE, body: '' })
    expect(await through(route, get(REPORT_ROUTE, grant))).toBe(200)
    expect(await through(route, get(REPORT_ROUTE, grant))).toBe(403)
  })

  it('never asks the computer: a request that skips admitPeer is answered', async () => {
    // Pins `principal === undefined`: without it the owner's Peer would be asked for a grant.
    const route = report(faceWorld('d1', 'reach'))
    expect((await route.fetch(get(REPORT_ROUTE))).status).toBe(200)
  })
})
