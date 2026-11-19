/**
 * The Face ID class gate on the Changes routes: a `face` control needs a grant for exactly this call from a device that
 * holds a passkey, and no unlock, PIN window or approval grace stands in for it; a `free` control needs nothing; the
 * computer is never asked. Each case names the check whose removal makes it fail.
 */
import { authClassOf, GrantStore, hashRequest, type GrantHolder } from '@delorun/home-auth'
import { describe, expect, it, vi } from 'vitest'
import { CONTROL_LEVELS } from '../src/access.ts'
import { faceAccessOf } from '../src/face-access.ts'
import { ACTION_PATHS, HARNESS_PATHS, NOTICE_SEEN_PATH, PROTECTION_PATHS, SETUP_PATHS, STATE_PATH } from '../src/routes.ts'
import { CREDENTIAL, DEVICE_HOST, fromDevice, json, post, routeHome, send, serveRoutes, TEST_DEVICE } from './routes-fixture.ts'

vi.setConfig({ testTimeout: 60_000 })

const HOLDER: GrantHolder = { deviceId: TEST_DEVICE.id, listener: 'tailscale-private' as GrantHolder['listener'] }
const WHERE_REFUSALS = ['LOOPBACK_REQUIRED', 'ELEVATION_REQUIRED', 'CROSS_SITE']

/** A grant store and the access one device sees of it. */
function faceWorld(options: { readonly hasPasskey?: boolean, readonly enabled?: boolean } = {}) {
  const clock = { at: 1_000_000 }
  let counter = 0
  const store = new GrantStore({ now: () => clock.at, random: size => Uint8Array.from({ length: size }, () => (counter++ % 251) + 1) })
  const face = faceAccessOf(options.enabled === false ? undefined : store, options.hasPasskey ?? true, HOLDER)
  /** Mint a grant for one call and return the header that names it. */
  const grantFor = (control: string, path: string, body: unknown): string => {
    const hash = hashRequest({ method: 'POST', path, body: Buffer.from(JSON.stringify(body)) })
    if (hash === undefined) throw new Error('body over the cap')
    return store.mint(HOLDER, [{ action: `changes/${control}`, hash }], 'passkey').grantId
  }
  return { face, grantFor }
}

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

describe('Changes: face controls', () => {
  it('refuse a device that holds a passkey with no grant, whatever unlock it holds', async () => {
    // Pins `gate`: without the grant check a fresh unlock (a PIN or code) or the grace would admit the call.
    const { ctx } = routeHome()
    const world = faceWorld()
    const server = await serveRoutes(ctx, { powers: 'full', face: world.face })
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

  it('admit exactly the call a grant was made for, once', async () => {
    // Pins the body hash and the single use: a grant for body A must not admit body B, and a replay is refused.
    const { ctx } = routeHome()
    const world = faceWorld()
    const server = await serveRoutes(ctx, { powers: 'careful', face: world.face })
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
    const world = faceWorld()
    const server = await serveRoutes(ctx, { powers: 'careful', face: world.face })
    const grant = world.grantFor('plugin-apply', ACTION_PATHS.apply, { id: 'a' })
    expect(json(await send(server.port, ACTION_PATHS.undo, withGrant('none', { id: 'a' }, grant))).code).toBe('ELEVATION_REQUIRED')
    expect(json(await send(server.port, ACTION_PATHS.apply, withGrant('none', { id: 'a' }, undefined))).code).toBe('ELEVATION_REQUIRED')
    expect(json(await send(server.port, ACTION_PATHS.apply, withGrant('none', { id: 'a' }, 'not-the-grant'))).code).toBe('ELEVATION_REQUIRED')
    // The grant for the right call is still there, so a refusal used up nothing.
    expect(WHERE_REFUSALS).not.toContain(json(await send(server.port, ACTION_PATHS.apply, withGrant('none', { id: 'a' }, grant))).code)
  })

  it('never ask the computer', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx, { face: faceWorld().face })
    for (const { path } of FACE_ROUTES) expect(WHERE_REFUSALS).not.toContain(json(await post(server.port, path, {})).code)
  })

  it('keep the legacy unlock for a device with no passkey, and let it use a grant too', async () => {
    const { ctx } = routeHome()
    const world = faceWorld({ hasPasskey: false })
    const server = await serveRoutes(ctx, { powers: 'full', face: world.face })
    const path = ACTION_PATHS.apply
    expect(json(await send(server.port, path, fromDevice('none', {}))).code).toBe('ELEVATION_REQUIRED')
    expect(WHERE_REFUSALS).not.toContain(json(await send(server.port, path, fromDevice('fresh', {}))).code)
    expect(WHERE_REFUSALS).not.toContain(json(await send(server.port, path, withGrant('none', { id: 'a' }, world.grantFor('plugin-apply', path, { id: 'a' })))).code)
  })

  it('stay at the legacy levels while the flag is off', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx, { powers: 'careful', face: faceWorld({ enabled: false }).face })
    expect(json(await send(server.port, ACTION_PATHS.apply, fromDevice('fresh', {}))).code).toBe('LOOPBACK_REQUIRED')
  })

  it('say in the state that a passkey device needs Face ID', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx, { powers: 'full', face: faceWorld().face })
    const state = json(await send(server.port, STATE_PATH, { host: DEVICE_HOST, headers: [CREDENTIAL, 'x-test-remote: 1', 'x-test-unlock: fresh'] }))
    expect(state).toMatchObject({ access: { may: { 'plugin-apply': { ok: false, needs: 'face' }, 'protection-on': { ok: true }, 'notice-seen': { ok: false, needs: 'computer' } } } })
  })
})

describe('Changes: free controls', () => {
  it('work for a paired device with no unlock, no grant and a passkey', async () => {
    // Pins the `free` class: protection on only tightens, so a locked phone may turn it on.
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx, { powers: 'careful', face: faceWorld().face })
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
