/**
 * What the studio decides on its Changes routes and from where: who may use each control with no grant store and
 * on, changes to Delorun itself (Apply, Undo, Discard, Make my copy), and the protection switch both ways.
 *
 * Each test's comment names the check whose removal makes it fail, so the suite is also the mutation record.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { harnessCopyDirectory, readChangeLog, readHarnessLog, readNotices, readProtection } from '@delorun/changes'
import { describe, expect, it, vi } from 'vitest'
import { mayUse } from '../src/access.ts'
import { ACTION_PATHS, HARNESS_PATHS, NOTICE_SEEN_PATH, PROTECTION_PATHS, SETUP_PATHS, SHOW_PATH, STATE_PATH, type ChangesAction } from '../src/routes.ts'
import type { FaceAccess } from '../src/routes.ts'
import type { ActorView, ChangesControl } from '../src/wire.ts'
import { CREDENTIAL, DEVICE_HOST, grantWorld, fromDevice, get, json, post, routeHarness, routeHome, RUNTIME, RUNTIME_FILE, send, serveRoutes, TEST_DEVICE } from './routes-fixture.ts'

// Each case starts a server on a loopback port and writes a temporary home; under a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 60_000 })

/** Where a phone may use a control: with a grant for the call only (no unlock opens it), or never. */
type Reach = 'grant-only' | 'computer-only'

/** Every `POST` route of the section with where a phone may use it. */
const ROUTE_REACH: readonly { readonly path: string, readonly reach: Reach }[] = [
  // Taking back, and everything else: a grant for the call, which no unlock stands in for.
  { path: ACTION_PATHS.undo, reach: 'grant-only' },
  { path: ACTION_PATHS.discard, reach: 'grant-only' },
  { path: HARNESS_PATHS.discard, reach: 'grant-only' },
  ...(['apply', 'off', 'on', 'work', 'done', 'safe-mode', 'exit-safe-mode', 'create', 'request', 'reveal'] as const satisfies readonly ChangesAction[]).map(action => ({ path: ACTION_PATHS[action], reach: 'grant-only' as const })),
  ...Object.values(SETUP_PATHS).map(path => ({ path, reach: 'grant-only' as const })),
  { path: HARNESS_PATHS.apply, reach: 'grant-only' },
  { path: HARNESS_PATHS.undo, reach: 'grant-only' },
  { path: HARNESS_PATHS.copy, reach: 'grant-only' },
  { path: PROTECTION_PATHS.off, reach: 'grant-only' },
  // Dismissing the notice of a phone's change: the computer only.
  { path: NOTICE_SEEN_PATH, reach: 'computer-only' },
]

/** The codes a request refused for where it came from is answered with. */
const WHERE_REFUSALS = ['LOOPBACK_REQUIRED', 'ELEVATION_REQUIRED', 'CROSS_SITE']

describe('who may use each control', () => {
  it('a phone uses a control only where its class lets it: a grant for every face control whatever unlock it holds, nothing for the notice', async () => {
    const { ctx } = routeHome()
    expect(ROUTE_REACH.length).toBe(Object.keys(ACTION_PATHS).length + Object.keys(SETUP_PATHS).length + Object.keys(HARNESS_PATHS).length + 2)
    // No grant store, and a grant store for a device with no passkey, which a PIN grant serves.
    for (const flag of ['off', 'on'] as const) {
      const server = await serveRoutes(ctx, { face: grantWorld({ enabled: flag === 'on', hasPasskey: false }).face })
      for (const { path, reach } of ROUTE_REACH) {
        for (const unlock of ['fresh', 'grace', 'none'] as const) {
          const cell = `flag ${flag} ${unlock} ${path}`
          // Without the grant, no unlock opens a grant-only control: with no grant store it stays at the computer.
          const refused = reach === 'computer-only' ? 'LOOPBACK_REQUIRED' : (flag === 'off' ? 'LOOPBACK_REQUIRED' : 'ELEVATION_REQUIRED')
          if (refused !== undefined) {
            // Pins the class and the unlock in `gate`, before the body: without them a phone in its grace, or one whose unlock stands in for a grant, acts.
            // With a grant store the gate reads the body to look for a grant before it refuses, so the body is sent.
            const reply = await send(server.port, path, fromDevice(unlock, {}, flag === 'off'))
            expect(reply.status, cell).toBe(403)
            expect(json(reply).code, cell).toBe(refused)
          } else {
            const reply = await send(server.port, path, fromDevice(unlock, {}))
            expect(WHERE_REFUSALS, cell).not.toContain(json(reply).code)
          }
        }
      }
    }
  })

  it('the state says what each control needs, with the same decisions the routes make', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx)
    expect(json(await get(server.port, STATE_PATH))).toMatchObject({ atComputer: true, access: { actor: 'computer', may: { 'harness-apply': { ok: true }, 'notice-seen': { ok: true } } } })
    const grace = json(await send(server.port, STATE_PATH, { host: DEVICE_HOST, headers: [CREDENTIAL, 'x-test-remote: 1', 'x-test-unlock: grace'] }))
    expect(grace).toMatchObject({ atComputer: false, access: { actor: 'device-grace', may: { 'harness-apply': { ok: false, needs: 'computer' }, 'plugin-undo': { ok: false, needs: 'computer' }, 'notice-seen': { ok: false, needs: 'computer' } } } })
    const careful = await serveRoutes(ctx)
    const fresh = json(await send(careful.port, STATE_PATH, { host: DEVICE_HOST, headers: [CREDENTIAL, 'x-test-remote: 1', 'x-test-unlock: fresh'] }))
    expect(fresh).toMatchObject({ access: { actor: 'device-unlocked', may: { 'harness-apply': { ok: false, needs: 'computer' }, 'harness-discard': { ok: false, needs: 'computer' }, 'protection-on': { ok: true } } } })
    // Each cell of the table, for every actor.
    const grantOnly = ['plugin-apply', 'protection-off', 'restart'] as const satisfies readonly ChangesControl[]
    for (const actor of ['computer', 'device-unlocked', 'device-grace', 'device-locked'] as const satisfies readonly ActorView[]) {
      for (const control of grantOnly) {
        // No grant store: no grant exists, so the control stays at the computer.
        expect(mayUse(actor, control), `${actor} ${control}`).toEqual(actor === 'computer' ? { ok: true } : { ok: false, needs: 'computer' })
        // The flag on: a grant from every device, a PIN one where it holds no passkey; no unlock changes that.
        for (const hasPasskey of [false, true]) {
          expect(mayUse(actor, control, { enabled: true, hasPasskey }), `${actor} ${control} passkey ${String(hasPasskey)}`).toEqual(actor === 'computer' ? { ok: true } : { ok: false, needs: 'face' })
        }
      }
    }
    // A take-back control is a face control too: an unlock never opens it, with or without a passkey.
    expect(mayUse('device-unlocked', 'plugin-undo')).toEqual({ ok: false, needs: 'computer' })
    for (const hasPasskey of [false, true]) expect(mayUse('device-unlocked', 'plugin-undo', { enabled: true, hasPasskey })).toEqual({ ok: false, needs: 'face' })
  })

  it('a phone\'s request from another site is refused before its level or its body', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx)
    const own = fromDevice('fresh', {}, true)
    const foreign = [
      [CREDENTIAL, 'x-test-remote: 1', 'x-test-unlock: fresh', 'Origin: https://evil.example'],
      [CREDENTIAL, 'x-test-remote: 1', 'x-test-unlock: fresh', `Origin: http://${DEVICE_HOST}`],
      [CREDENTIAL, 'x-test-remote: 1', 'x-test-unlock: fresh'],
      [CREDENTIAL, 'x-test-remote: 1', 'x-test-unlock: fresh', `Origin: https://${DEVICE_HOST}`, 'Sec-Fetch-Site: cross-site'],
    ]
    for (const { path } of ROUTE_REACH) {
      for (const headers of foreign) {
        // Pins `isCrossSiteDevice`: without it a page the person visits on the phone posts the action with its cookie.
        const reply = await send(server.port, path, { ...own, headers })
        expect(reply.status, `${path} ${headers.join()}`).toBe(403)
        expect(json(reply)).toMatchObject({ code: 'CROSS_SITE' })
      }
    }
    expect(server.profileReads()).toBe(0)
  })
})

/**
 * A home whose running runtime has the person's copy, with the start file changed in it and waiting for review.
 * @returns the profile, the harness and the waiting change as `show?pending` lists it.
 */
async function waitingChange(face?: FaceAccess) {
  const { root, ctx } = routeHome()
  const harness = routeHarness(ctx.home)
  const server = await serveRoutes(ctx, { harness: () => harness, ...face === undefined ? {} : { face } })
  const copy = json(await post(server.port, HARNESS_PATHS.copy, {}))
  expect(copy).toEqual({ kind: 'copy', created: true, runtime: RUNTIME, place: `<Delorun home>/changes/harness/${RUNTIME}/copy/app` })
  writeFileSync(join(harnessCopyDirectory(ctx.home, RUNTIME), RUNTIME_FILE), 'export const start = 2\n')
  const listed = json(await get(server.port, `${SHOW_PATH}?pending`))
  const change = (listed.harness as { id: string, to: string, file: string }[])[0]!
  expect(listed).toMatchObject({ kind: 'pending-list', pending: [], harness: [{ file: RUNTIME_FILE, runtime: RUNTIME, status: 'modified' }] })
  return { root, ctx, harness, server, change }
}

describe('changes to Delorun itself', () => {
  it('a harness decision in the studio needs the studio proof', async () => {
    const { root, ctx, server, change } = await waitingChange()
    expect(change.to).toMatch(/^[0-9a-f]{64}$/u)
    const shown = await get(server.port, `${SHOW_PATH}?id=${change.id}`)
    expect(json(shown)).toMatchObject({ kind: 'harness-pending', change, review: { kind: 'harness-edit', files: [{ path: RUNTIME_FILE, status: 'modified' }] } })
    expect(shown.body).not.toContain(root)
    // Pins `reviewedTo`: a content version other than the one the review showed is refused, and nothing is applied.
    const stale = await post(server.port, HARNESS_PATHS.apply, { id: change.id, to: '0'.repeat(64) })
    expect(stale.status).toBe(409)
    expect(json(stale)).toMatchObject({ code: 'CHANGED_SINCE_REVIEW' })
    expect(json(await post(server.port, HARNESS_PATHS.apply, { id: change.id, to: change.to.slice(0, 12) }))).toMatchObject({ code: 'BAD_REQUEST' })
    expect((await readHarnessLog(ctx.home)).entries).toEqual([])
    const applied = json(await post(server.port, HARNESS_PATHS.apply, { id: change.id, to: change.to }))
    expect(applied).toMatchObject({ kind: 'harness', entry: { id: change.id, state: 'applied', decidedFrom: 'studio', undoable: true }, effect: { kind: 'restart' } })
    expect((await readHarnessLog(ctx.home)).entries).toMatchObject([{ id: change.id, state: 'applied', decidedFrom: 'studio' }])
    expect(json(await get(server.port, STATE_PATH))).toMatchObject({ harnessAvailable: { kind: 'available', runtime: RUNTIME, copy: true }, harness: [{ id: change.id, undoable: true }] })
    const undone = json(await post(server.port, HARNESS_PATHS.undo, { id: change.id }))
    expect(undone).toMatchObject({ kind: 'harness', entry: { id: change.id, state: 'undone', undoable: false }, effect: { kind: 'restart' } })
    // A change made again in the copy is discarded: the copy holds what the runtime runs again.
    writeFileSync(join(harnessCopyDirectory(ctx.home, RUNTIME), RUNTIME_FILE), 'export const start = 3\n')
    const again = (json(await get(server.port, `${SHOW_PATH}?pending`)).harness as { id: string }[])[0]!
    expect(json(await post(server.port, HARNESS_PATHS.discard, { id: again.id }))).toMatchObject({ kind: 'harness', entry: { id: again.id, state: 'discarded', decidedFrom: 'studio' } })
    expect(readFileSync(join(harnessCopyDirectory(ctx.home, RUNTIME), RUNTIME_FILE), 'utf8')).toBe(readFileSync(join(ctx.home, 'runtimes', RUNTIME, RUNTIME_FILE), 'utf8'))
    // Make my copy finds the copy it made.
    expect(json(await post(server.port, HARNESS_PATHS.copy, {}))).toMatchObject({ kind: 'copy', created: false })
  })

  it('a remote session cannot apply, discard or undo a harness change', async () => {
    const { ctx, server, change } = await waitingChange()
    const before = await readHarnessLog(ctx.home)
    for (const path of Object.values(HARNESS_PATHS)) {
      // No paired device's session, a locked phone and a phone in its grace.
      for (const request of [{ method: 'POST', headers: [CREDENTIAL, 'x-test-remote: 1'], body: { id: change.id, to: change.to }, withholdBody: true }, fromDevice('none', { id: change.id, to: change.to }, true), fromDevice('grace', { id: change.id, to: change.to }, true)]) {
        const reply = await send(server.port, path, request)
        expect(reply.status, path).toBe(403)
      }
    }
    // An unlocked phone with no grant store: Apply, Undo and Make my copy stay at the computer.
    for (const path of [HARNESS_PATHS.apply, HARNESS_PATHS.undo, HARNESS_PATHS.copy]) {
      expect(json(await send(server.port, path, fromDevice('fresh', { id: change.id, to: change.to }, true))), path).toMatchObject({ code: 'LOOPBACK_REQUIRED' })
    }
    expect(await readHarnessLog(ctx.home)).toEqual(before)
    expect(server.renewals()).toBe(0)
  })

  it('a phone with a PIN grant for the call applies a harness change, recorded as decided in the studio on that phone', async () => {
    const world = grantWorld({ hasPasskey: false })
    const { ctx, server, change } = await waitingChange(world.face)
    const body = { id: change.id, to: change.to }
    // Pins the grant: an unlock the person entered applies nothing.
    expect(json(await send(server.port, HARNESS_PATHS.apply, fromDevice('fresh', body)))).toMatchObject({ code: 'ELEVATION_REQUIRED' })
    const grant = world.grantFor('harness-apply', HARNESS_PATHS.apply, body, 'pin')
    const base = fromDevice('none', body)
    const applied = await send(server.port, HARNESS_PATHS.apply, { ...base, headers: [...base.headers ?? [], `Delorun-Grant: ${grant}`] })
    expect(json(applied)).toMatchObject({ kind: 'harness', entry: { id: change.id, state: 'applied', decidedFrom: 'studio', decidedOn: TEST_DEVICE.label } })
    expect((await readHarnessLog(ctx.home)).entries).toMatchObject([{ id: change.id, decidedFrom: 'studio', decidedOn: TEST_DEVICE }])
    // A later decision at the computer does not keep the phone's name.
    expect(json(await post(server.port, HARNESS_PATHS.undo, { id: change.id }))).toMatchObject({ kind: 'harness', entry: { state: 'undone', decidedFrom: 'studio' } })
    const [undone] = (await readHarnessLog(ctx.home)).entries
    expect(undone).toMatchObject({ state: 'undone', decidedFrom: 'studio' })
    expect(undone).not.toHaveProperty('decidedOn')
  })

  it('a Host that runs no installed release decides no change to Delorun itself', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx)
    for (const path of Object.values(HARNESS_PATHS)) {
      expect(json(await post(server.port, path, path === HARNESS_PATHS.apply ? { id: 'c0123456789', to: '0'.repeat(64) } : path === HARNESS_PATHS.copy ? {} : { id: 'c0123456789' })), path).toMatchObject({ code: 'HARNESS_UNAVAILABLE' })
    }
    expect(json(await get(server.port, STATE_PATH))).toMatchObject({ harnessAvailable: { kind: 'unavailable' } })
    expect(json(await get(server.port, `${SHOW_PATH}?pending`))).toEqual({ kind: 'pending-list', pending: [], harness: [] })
  })
})

describe('the protection switch', () => {
  it('the studio turns protection off only after the second confirmation', async () => {
    const { ctx, server } = await waitingChange()
    expect(json(await post(server.port, PROTECTION_PATHS.on, {}))).toEqual({ protection: 'on', unreviewedSinceOff: 0 })
    // Pins the second ask: without it one press turns protection off.
    const asked = await post(server.port, PROTECTION_PATHS.off, {})
    expect(asked.status).toBe(409)
    expect(json(asked)).toMatchObject({ code: 'CONFIRM_PROTECTION', willLoad: { plugins: [], harnessFiles: 1 } })
    expect(await readProtection(ctx.home)).toBe('on')
    expect(json(await post(server.port, PROTECTION_PATHS.off, { confirmed: false }))).toMatchObject({ code: 'CONFIRM_PROTECTION' })
    expect(json(await post(server.port, PROTECTION_PATHS.off, { confirmed: 'yes' }))).toMatchObject({ code: 'BAD_REQUEST' })
    expect(json(await post(server.port, PROTECTION_PATHS.off, { confirmed: true }))).toEqual({ protection: 'off', unreviewedSinceOff: 0 })
    expect(await readProtection(ctx.home)).toBe('off')
    // Pins `decidedFrom: presence.kind` in `changeProtection`: a studio "off" is logged as decided in the studio.
    expect((await readChangeLog(ctx.home, ctx.profile)).entries).toMatchObject([{ kind: 'guard-weakening', state: 'applied', decidedFrom: 'studio' }])
    // The person at the computer gets no notice of their own change.
    expect(await readNotices(ctx.home)).toEqual([])
  })

  it('a remote session cannot change protection', async () => {
    const { ctx } = routeHome()
    const careful = await serveRoutes(ctx)
    expect(json(await post(careful.port, PROTECTION_PATHS.on, {}))).toMatchObject({ protection: 'on' })
    for (const path of Object.values(PROTECTION_PATHS)) {
      expect(json(await send(careful.port, path, { method: 'POST', headers: [CREDENTIAL, 'x-test-remote: 1'], body: { confirmed: true }, withholdBody: true })), path).toMatchObject({ code: 'LOOPBACK_REQUIRED' })
      // Turning protection on is a `free` control (face-grants.spec.ts), so only off is refused to a phone in its grace.
      if (path === PROTECTION_PATHS.off) expect(json(await send(careful.port, path, fromDevice('grace', { confirmed: true }, true))), path).toMatchObject({ code: 'LOOPBACK_REQUIRED' })
    }
    // With no grant store an unlocked phone cannot turn protection off.
    expect(json(await send(careful.port, PROTECTION_PATHS.off, fromDevice('fresh', { confirmed: true }, true)))).toMatchObject({ code: 'LOOPBACK_REQUIRED' })
    expect(await readProtection(ctx.home)).toBe('on')
    // With a PIN grant for the call it can, after the second ask; the change is kept as a notice for the computer.
    const world = grantWorld({ hasPasskey: false })
    const full = await serveRoutes(ctx, { face: world.face })
    // A grant covers the call without its confirmation field, so the one for `{}` admits the ask and the confirmed request alike.
    const withPin = (body: object) => {
      const base = fromDevice('none', body)
      return { ...base, headers: [...base.headers ?? [], `Delorun-Grant: ${world.grantFor('protection-off', PROTECTION_PATHS.off, {}, 'pin')}`] }
    }
    expect(json(await send(full.port, PROTECTION_PATHS.off, fromDevice('fresh', { confirmed: true })))).toMatchObject({ code: 'ELEVATION_REQUIRED' })
    expect(json(await send(full.port, PROTECTION_PATHS.off, withPin({})))).toMatchObject({ code: 'CONFIRM_PROTECTION' })
    expect(json(await send(full.port, PROTECTION_PATHS.off, withPin({ confirmed: true })))).toEqual({ protection: 'off', unreviewedSinceOff: 0 })
    expect((await readChangeLog(ctx.home, ctx.profile)).entries).toMatchObject([{ kind: 'guard-weakening', decidedFrom: 'studio' }])
    // Turning it on again tightens: an unlocked phone may.
    expect(json(await send(careful.port, PROTECTION_PATHS.on, fromDevice('fresh', {})))).toEqual({ protection: 'on', unreviewedSinceOff: 0 })
    const notices = await readNotices(ctx.home)
    expect(notices).toMatchObject([{ level: 'off', device: TEST_DEVICE.label, deviceId: TEST_DEVICE.id }, { level: 'on', device: TEST_DEVICE.label }])
    // The computer reads the notices; a phone does not, and cannot dismiss them.
    expect(json(await get(careful.port, STATE_PATH))).toMatchObject({ notices: [{ id: notices[0]!.id, level: 'off', device: TEST_DEVICE.label }, { id: notices[1]!.id, level: 'on' }] })
    expect(json(await send(full.port, STATE_PATH, { host: DEVICE_HOST, headers: [CREDENTIAL, 'x-test-remote: 1', 'x-test-unlock: fresh'] }))).toMatchObject({ notices: [] })
    expect(json(await send(full.port, NOTICE_SEEN_PATH, fromDevice('fresh', { id: notices[0]!.id }, true)))).toMatchObject({ code: 'LOOPBACK_REQUIRED' })
    expect(json(await post(careful.port, NOTICE_SEEN_PATH, { id: notices[0]!.id }))).toEqual({ dismissed: true })
    expect(await readNotices(ctx.home)).toEqual([notices[1]])
  })

  it('a cross-site request cannot change protection', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx)
    const port = String(server.port)
    for (const path of [...Object.values(PROTECTION_PATHS), NOTICE_SEEN_PATH]) {
      for (const headers of [['Sec-Fetch-Site: cross-site'], ['Origin: http://evil.example'], ['Origin: null'], [`Origin: https://127.0.0.1:${port}`]]) {
        // Pins the site check in `gate`: without it a page the person visits turns protection off with the studio's cookie.
        const reply = await send(server.port, path, { method: 'POST', headers: [CREDENTIAL, ...headers], body: { confirmed: true }, withholdBody: true })
        expect(reply.status, `${path} ${headers.join()}`).toBe(403)
        expect(json(reply)).toMatchObject({ code: 'CROSS_SITE' })
      }
    }
    expect(server.profileReads()).toBe(0)
    expect(await readNotices(ctx.home)).toEqual([])
  })
})
