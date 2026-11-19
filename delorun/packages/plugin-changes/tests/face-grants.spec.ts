/**
 * The Face ID class gate on the Changes routes: a `face` control needs a grant for exactly this call from a device that
 * holds a passkey, and no unlock, PIN window or approval grace stands in for it; a `free` control needs nothing; the
 * computer is never asked. Each case names the check whose removal makes it fail.
 */
import { authClassOf, GRANT_BODY_CAP_BYTES } from '@delorun/home-auth'
import { describe, expect, it, vi } from 'vitest'
import { CONTROL_LEVELS, LEGACY_LEVELS } from '../src/access.ts'
import { ACTION_PATHS, HARNESS_PATHS, NOTICE_SEEN_PATH, PROTECTION_PATHS, SETUP_PATHS, STATE_PATH } from '../src/routes.ts'
import { CREDENTIAL, DEVICE_HOST, grantWorld, fromDevice, json, post, routeHome, send, serveRoutes } from './routes-fixture.ts'

vi.setConfig({ testTimeout: 60_000 })

const WHERE_REFUSALS = ['LOOPBACK_REQUIRED', 'ELEVATION_REQUIRED', 'CROSS_SITE']

/** A device request with a grant header. */
function withGrant(unlock: 'fresh' | 'grace' | 'none', body: unknown, grantId: string | undefined) {
  const base = fromDevice(unlock, body)
  return { ...base, headers: [...base.headers ?? [], ...grantId === undefined ? [] : [`Delorun-Grant: ${grantId}`]] }
}

const FACE_ROUTES = [
  { control: 'plugin-apply', path: ACTION_PATHS.apply },
  { control: 'plugin-undo', path: ACTION_PATHS.undo },
  { control: 'plugin-discard', path: ACTION_PATHS.discard },
  { control: 'plugin-other', path: ACTION_PATHS.off },
  { control: 'harness-apply', path: HARNESS_PATHS.apply },
  { control: 'harness-discard', path: HARNESS_PATHS.discard },
  { control: 'protection-off', path: PROTECTION_PATHS.off },
] as const

/** The routes of the controls LEGACY_LEVELS holds to a grant: the set an unlocked phone could once open. */
const FORMER_FULL_ROUTES = [
  { control: 'plugin-apply', path: ACTION_PATHS.apply },
  { control: 'plugin-other', path: ACTION_PATHS.off },
  { control: 'harness-apply', path: HARNESS_PATHS.apply },
  { control: 'harness-undo', path: HARNESS_PATHS.undo },
  { control: 'make-copy', path: HARNESS_PATHS.copy },
  { control: 'protection-off', path: PROTECTION_PATHS.off },
] as const

describe('Changes: face controls', () => {
  // Adding a control to the `grant` set without a route here, or in the restart and update specs, leaves it without a denial case.
  it('cover every control LEGACY_LEVELS holds to a grant here or in the restart and update specs', () => {
    const covered: readonly string[] = FORMER_FULL_ROUTES.map(route => route.control)
    const held = Object.entries(LEGACY_LEVELS).filter(([, level]) => level === 'grant').map(([control]) => control)
    expect(held.filter(control => !covered.includes(control)).sort()).toEqual(['restart', 'update-begin', 'update-rollback'])
  })

  it('refuse a device that holds a passkey with no grant, whatever unlock it holds', async () => {
    // Pins `gate`: without the grant check a fresh unlock (a PIN or code) or the grace would admit the call.
    const { ctx } = routeHome()
    const world = grantWorld()
    const server = await serveRoutes(ctx, { face: world.face })
    for (const { path } of FACE_ROUTES) {
      for (const unlock of ['fresh', 'grace', 'none'] as const) {
        const reply = await send(server.port, path, fromDevice(unlock, {}))
        expect(reply.status, `${unlock} ${path}`).toBe(403)
        expect(json(reply).code, `${unlock} ${path}`).toBe('ELEVATION_REQUIRED')
      }
    }
    for (const path of Object.values(SETUP_PATHS)) {
      expect(json(await send(server.port, path, fromDevice('fresh', {}))).code, path).toBe('ELEVATION_REQUIRED')
    }
  })

  // Removing the `grant` rows of LEGACY_LEVELS, or the grant-store check in `mayUse`, lets a running unlock (a code or a PIN window) open the set an unlocked phone could once open, for a device with no passkey.
  it('refuse every control that changes what runs to a device with no passkey and a running unlock, and open it to a PIN grant for the call', async () => {
    const { ctx } = routeHome()
    const world = grantWorld({ hasPasskey: false })
    const server = await serveRoutes(ctx, { face: world.face })
    const former = [
      ...FORMER_FULL_ROUTES,
      ...Object.values(SETUP_PATHS).map(path => ({ control: 'plugin-other', path })),
    ]
    for (const { control, path } of former) {
      for (const unlock of ['fresh', 'grace', 'none'] as const) {
        const reply = await send(server.port, path, fromDevice(unlock, {}))
        expect(reply.status, `${unlock} ${path}`).toBe(403)
        expect(json(reply).code, `${unlock} ${path}`).toBe('ELEVATION_REQUIRED')
      }
      const grant = world.grantFor(control, path, { id: 'a' }, 'pin')
      expect(WHERE_REFUSALS, path).not.toContain(json(await send(server.port, path, withGrant('none', { id: 'a' }, grant))).code)
    }
  })

  // Removing the `face.enabled` branch in `mayUse` sends a grant, which cannot exist with no grant store, to the unlock path.
  it('keep every control that changes what runs at the computer with no grant store, whatever unlock a device holds', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx, { face: grantWorld({ enabled: false }).face })
    for (const { path } of [...FORMER_FULL_ROUTES, ...Object.values(SETUP_PATHS).map(path => ({ path }))]) {
      for (const unlock of ['fresh', 'grace', 'none'] as const) {
        expect(json(await send(server.port, path, fromDevice(unlock, {}))).code, `${unlock} ${path}`).toBe('LOOPBACK_REQUIRED')
      }
    }
  })

  it('bind the query string a grant was made for', async () => {
    // Pins the hash over path and query: a grant for one query must not admit the same path with another or none.
    const { ctx } = routeHome()
    const world = grantWorld()
    const server = await serveRoutes(ctx, { face: world.face })
    const path = ACTION_PATHS.apply
    const grant = world.grantFor('plugin-apply', `${path}?a=1`, { id: 'a' })
    for (const target of [path, `${path}?a=2`, `${path}?a=1&b=2`]) {
      expect(json(await send(server.port, target, withGrant('none', { id: 'a' }, grant))).code, target).toBe('ELEVATION_REQUIRED')
    }
    expect(WHERE_REFUSALS).not.toContain(json(await send(server.port, `${path}?a=1`, withGrant('none', { id: 'a' }, grant))).code)
  })

  it('refuse a body over the grant cap whatever grant it carries, and leave the grant unused', async () => {
    // Pins the 1 MiB cap: a body that cannot be hashed is covered by no grant.
    const { ctx } = routeHome()
    const world = grantWorld()
    const server = await serveRoutes(ctx, { face: world.face })
    const path = ACTION_PATHS.apply
    const grant = world.grantFor('plugin-apply', path, { id: 'a' })
    const oversized = JSON.stringify({ id: 'a', pad: 'x'.repeat(GRANT_BODY_CAP_BYTES) })
    expect(json(await send(server.port, path, withGrant('none', oversized, grant))).code).toBe('ELEVATION_REQUIRED')
    expect(WHERE_REFUSALS).not.toContain(json(await send(server.port, path, withGrant('none', { id: 'a' }, grant))).code)
  })

  it('admit exactly the call a grant was made for, once', async () => {
    // Pins the body hash and the single use: a grant for body A must not admit body B, and a replay is refused.
    const { ctx } = routeHome()
    const world = grantWorld()
    const server = await serveRoutes(ctx, { face: world.face })
    const path = ACTION_PATHS.apply
    const grant = world.grantFor('plugin-apply', path, { id: 'a' })
    const other = await send(server.port, path, withGrant('none', { id: 'b' }, grant))
    expect(json(other).code).toBe('ELEVATION_REQUIRED')
    const admitted = await send(server.port, path, withGrant('none', { id: 'a' }, grant))
    expect(WHERE_REFUSALS).not.toContain(json(admitted).code)
    const replay = await send(server.port, path, withGrant('none', { id: 'a' }, grant))
    expect(json(replay).code).toBe('ELEVATION_REQUIRED')
  })

  it('refuse a grant for another control or path, and a body with no header naming the grant', async () => {
    const { ctx } = routeHome()
    const world = grantWorld()
    const server = await serveRoutes(ctx, { face: world.face })
    const grant = world.grantFor('plugin-apply', ACTION_PATHS.apply, { id: 'a' })
    expect(json(await send(server.port, ACTION_PATHS.undo, withGrant('none', { id: 'a' }, grant))).code).toBe('ELEVATION_REQUIRED')
    expect(json(await send(server.port, ACTION_PATHS.apply, withGrant('none', { id: 'a' }, undefined))).code).toBe('ELEVATION_REQUIRED')
    expect(json(await send(server.port, ACTION_PATHS.apply, withGrant('none', { id: 'a' }, 'not-the-grant'))).code).toBe('ELEVATION_REQUIRED')
    // The grant for the right call is still there, so a refusal used up nothing.
    expect(WHERE_REFUSALS).not.toContain(json(await send(server.port, ACTION_PATHS.apply, withGrant('none', { id: 'a' }, grant))).code)
  })

  it('never ask the computer', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx, { face: grantWorld().face })
    for (const { path } of FACE_ROUTES) expect(WHERE_REFUSALS).not.toContain(json(await post(server.port, path, {})).code)
  })

  it('keep the unlock for the take-back controls of a device with no passkey, and let it use a grant too', async () => {
    const { ctx } = routeHome()
    const world = grantWorld({ hasPasskey: false })
    const server = await serveRoutes(ctx, { face: world.face })
    const path = ACTION_PATHS.undo
    expect(json(await send(server.port, path, fromDevice('none', {}))).code).toBe('ELEVATION_REQUIRED')
    expect(WHERE_REFUSALS).not.toContain(json(await send(server.port, path, fromDevice('fresh', {}))).code)
    expect(WHERE_REFUSALS).not.toContain(json(await send(server.port, path, withGrant('none', { id: 'a' }, world.grantFor('plugin-undo', path, { id: 'a' })))).code)
  })

  it('stay at the unlock with no grant store, for the take-back controls', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx, { face: grantWorld({ enabled: false }).face })
    expect(json(await send(server.port, ACTION_PATHS.undo, fromDevice('none', {}))).code).toBe('ELEVATION_REQUIRED')
    expect(WHERE_REFUSALS).not.toContain(json(await send(server.port, ACTION_PATHS.undo, fromDevice('fresh', {}))).code)
  })

  it('say in the state that a passkey device needs Face ID', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx, { face: grantWorld().face })
    const state = json(await send(server.port, STATE_PATH, { host: DEVICE_HOST, headers: [CREDENTIAL, 'x-test-remote: 1', 'x-test-unlock: fresh'] }))
    expect(state).toMatchObject({ access: { may: { 'plugin-apply': { ok: false, needs: 'face' }, 'protection-on': { ok: true }, 'notice-seen': { ok: false, needs: 'computer' } } } })
  })
})

describe('Changes: free controls', () => {
  it('work for a paired device with no unlock, no grant and a passkey', async () => {
    // Pins the `free` class: protection on only tightens, so a locked phone may turn it on.
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx, { face: grantWorld().face })
    for (const unlock of ['fresh', 'grace', 'none'] as const) {
      expect(WHERE_REFUSALS, unlock).not.toContain(json(await send(server.port, PROTECTION_PATHS.on, fromDevice(unlock, {}))).code)
    }
    expect(json(await send(server.port, NOTICE_SEEN_PATH, fromDevice('fresh', {}))).code).toBe('LOOPBACK_REQUIRED')
  })
})

describe('Changes: the control table and AUTH_CLASSES', () => {
  it('give every control the same class', () => {
    // Pins the link: a control whose class here differs from its `changes:` row, or that has no row, fails.
    const differing = Object.entries(CONTROL_LEVELS).filter(([control, level]) => authClassOf(`changes:${control}`) !== level).map(([control]) => control)
    expect(differing).toEqual([])
    expect(authClassOf('changes:setup')).toBe('face')
    expect(authClassOf('changes:reads')).toBe('free')
  })
})
