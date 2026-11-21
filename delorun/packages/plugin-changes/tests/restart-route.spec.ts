/**
 * The studio's Restart routes: Apply's fence and level decide before the body is read and before the home process's
 * restart is asked, by every request a remote, locked or cross-site caller can make; a phone restarts only with a grant
 * for the call (a PIN grant where it holds no passkey), and never with no grant store; the home process's refusals keep their codes; and `state` names a restart as
 * needed only for a decided change the running Host does not run in a file that is not live.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { harnessCopyDirectory, type ChangesRestartHost, type HarnessRestartView, type RunningComposition } from '@delorun/changes'
import { describe, expect, it } from 'vitest'
import { restartStateOf } from '../src/restart-route.ts'
import { HARNESS_PATHS, RESTART_PATHS, SHOW_PATH } from '../src/wire.ts'
import type { FaceAccess } from '../src/routes.ts'
import { CREDENTIAL, grantWorld, fromDevice, get, json, post, routeHarness, routeHome, RUNTIME, RUNTIME_FILE, send, serveRoutes } from './routes-fixture.ts'

/** A stand-in for the home process's restart that records what it was asked. */
class FakeRestart implements ChangesRestartHost {
  readonly begun: { readonly stopChats: boolean, readonly drainTimeoutS: number }[] = []
  cancels = 0
  cleared = 0
  current: HarnessRestartView = { kind: 'idle' }
  refusal: string | undefined
  readonly running: RunningComposition

  /** @param running - what the Host booted with. */
  constructor(running: RunningComposition = { kind: 'known', files: {} }) {
    this.running = running
  }

  view(): HarnessRestartView {
    return this.current
  }

  runningChats(): number {
    return 2
  }

  async begin(request: { readonly stopChats: boolean, readonly drainTimeoutS: number }): Promise<{ readonly runningChats: number }> {
    if (this.refusal !== undefined) throw Object.assign(new Error('refused'), { code: this.refusal })
    this.begun.push(request)
    return Promise.resolve({ runningChats: 2 })
  }

  async cancel(): Promise<boolean> {
    this.cancels += 1
    return Promise.resolve(true)
  }

  clearFailure(): void {
    this.cleared += 1
  }
}

async function restartServer(face?: FaceAccess, withRestart = true) {
  const restart = withRestart ? new FakeRestart() : undefined
  const { ctx } = routeHome()
  const server = await serveRoutes(ctx, { restartRoute: { restart: () => restart, waitSeconds: 600 }, ...face === undefined ? {} : { face } })
  return { server, restart }
}

describe('the studio\'s Restart', () => {
  it('a cross-site request cannot restart', async () => {
    const { server, restart } = await restartServer()
    for (const path of Object.values(RESTART_PATHS)) {
      for (const headers of [['Sec-Fetch-Site: cross-site'], ['Origin: https://elsewhere.example'], ['Origin: null']]) {
        const reply = await send(server.port, path, { method: 'POST', headers: [CREDENTIAL, ...headers], body: {}, withholdBody: true })
        expect(reply.status, `${path} ${headers.join()}`).toBe(403)
        expect(json(reply)).toMatchObject({ code: 'CROSS_SITE' })
      }
      // A phone's page whose Origin is not its own studio address.
      const device = fromDevice('fresh', {}, true)
      const reply = await send(server.port, path, { ...device, headers: [...(device.headers ?? []).filter(header => !header.startsWith('Origin:')), 'Origin: https://elsewhere.example'] })
      expect(json(reply), path).toMatchObject({ code: 'CROSS_SITE' })
    }
    expect(restart?.begun).toEqual([])
    expect(restart?.cancels).toBe(0)
  })

  it('a remote or locked session cannot restart', async () => {
    for (const flag of ['off', 'on'] as const) {
      const { server, restart } = await restartServer(grantWorld({ enabled: flag === 'on', hasPasskey: false }).face)
      for (const path of Object.values(RESTART_PATHS)) {
        // No paired device's session, a locked phone and a phone in its approval grace, with and without a grant store: with
        // no grant store a phone is sent to the computer whatever its unlock; with one a phone needs a grant, which no unlock replaces.
        const noDevice = await send(server.port, path, { method: 'POST', headers: [CREDENTIAL, 'x-test-remote: 1'], body: {}, withholdBody: true })
        expect(noDevice.status, `${flag} ${path}`).toBe(403)
        expect(json(noDevice), `${flag} ${path}`).toMatchObject({ code: 'LOOPBACK_REQUIRED' })
        const locked = flag === 'off' ? 'LOOPBACK_REQUIRED' : 'ELEVATION_REQUIRED'
        for (const unlock of ['none', 'grace'] as const) {
          const reply = await send(server.port, path, fromDevice(unlock, {}, flag === 'off'))
          expect(reply.status, `${flag} ${path} ${unlock}`).toBe(403)
          expect(json(reply), `${flag} ${path} ${unlock}`).toMatchObject({ code: locked })
        }
      }
      expect(restart?.begun).toEqual([])
      expect(restart?.cancels).toBe(0)
      expect(server.renewals()).toBe(0)
    }
  })

  // Moving `restart` from `face` in CONTROL_LEVELS, or removing the grant-store check in `mayUse`, lets a running unlock restart Delorun from a phone with no passkey.
  it('an unlocked phone cannot restart, whatever the grant store; a PIN grant for the call restarts, once', async () => {
    const off = await restartServer(grantWorld({ enabled: false }).face)
    for (const path of Object.values(RESTART_PATHS)) {
      expect(json(await send(off.server.port, path, fromDevice('fresh', {}, true))), path).toMatchObject({ code: 'LOOPBACK_REQUIRED' })
    }
    expect(off.restart?.begun).toEqual([])

    const world = grantWorld({ hasPasskey: false })
    const on = await restartServer(world.face)
    for (const path of Object.values(RESTART_PATHS)) {
      expect(json(await send(on.server.port, path, fromDevice('fresh', {}))), path).toMatchObject({ code: 'ELEVATION_REQUIRED' })
    }
    expect(on.restart?.begun).toEqual([])
    const base = fromDevice('none', {})
    const withGrant = { ...base, headers: [...base.headers ?? [], `Delorun-Grant: ${world.grantFor('restart', RESTART_PATHS.restart, {}, 'pin')}`] }
    const reply = await send(on.server.port, RESTART_PATHS.restart, withGrant)
    expect(reply.status).toBe(200)
    expect(json(reply)).toEqual({ kind: 'restarting', runningChats: 2 })
    expect(on.restart?.begun).toEqual([{ stopChats: false, drainTimeoutS: 600 }])
    // The grant is used up: the same request again is refused.
    expect(json(await send(on.server.port, RESTART_PATHS.restart, withGrant)), 'replay').toMatchObject({ code: 'ELEVATION_REQUIRED' })
  })

  it('at the computer begins a restart, stops chats only when asked and cancels a waiting one', async () => {
    const { server, restart } = await restartServer()
    expect(json(await post(server.port, RESTART_PATHS.restart, { stopChats: true }))).toEqual({ kind: 'restarting', runningChats: 2 })
    expect(json(await post(server.port, RESTART_PATHS.restart, {}))).toEqual({ kind: 'restarting', runningChats: 2 })
    expect(restart?.begun).toEqual([{ stopChats: true, drainTimeoutS: 600 }, { stopChats: false, drainTimeoutS: 600 }])
    const extra = await post(server.port, RESTART_PATHS.restart, { stopChats: 'yes' })
    expect(extra.status).toBe(400)
    expect(json(await post(server.port, RESTART_PATHS.restart, { now: true }))).toMatchObject({ code: 'BAD_REQUEST' })
    expect(json(await post(server.port, RESTART_PATHS.cancel, {}))).toEqual({ cancelled: true })
    expect(restart?.cancels).toBe(1)
  })

  it('answers the home process\'s refusals with their codes, and a Host without a restart with RESTART_UNAVAILABLE', async () => {
    const { server, restart } = await restartServer()
    for (const [code, answered] of [['RESTART_IN_PROGRESS', 'RESTART_IN_PROGRESS'], ['UPDATE_IN_PROGRESS', 'UPDATE_IN_PROGRESS'], ['NO_RUNTIME_STORE', 'RESTART_UNAVAILABLE']] as const) {
      restart!.refusal = code
      const reply = await post(server.port, RESTART_PATHS.restart, {})
      expect(reply.status, code).toBe(409)
      expect(json(reply)).toMatchObject({ code: answered })
    }
    const none = await restartServer(undefined, false)
    for (const path of Object.values(RESTART_PATHS)) {
      const reply = await post(none.server.port, path, {})
      expect(reply.status, path).toBe(409)
      expect(json(reply)).toMatchObject({ code: 'RESTART_UNAVAILABLE' })
    }
  })
})

describe('the restart part of state', () => {
  it('names a restart as needed for an applied change the running Host does not run, and none once it runs it', async () => {
    const { ctx } = routeHome()
    const harness = routeHarness(ctx.home)
    const restart = new FakeRestart()
    const server = await serveRoutes(ctx, { harness: () => harness, restartState: () => restartStateOf(restart, harness), clearRestartFailure: () => { restart.clearFailure() } })
    expect(json(await get(server.port, '/delorun/changes/state'))).not.toHaveProperty('restart')
    await post(server.port, HARNESS_PATHS.copy, {})
    writeFileSync(join(harnessCopyDirectory(ctx.home, RUNTIME), RUNTIME_FILE), 'export const start = 2\n')
    const change = ((json(await get(server.port, `${SHOW_PATH}?pending`)).harness) as { id: string, to: string }[])[0]!
    await post(server.port, HARNESS_PATHS.apply, { id: change.id, to: change.to })
    expect(json(await get(server.port, '/delorun/changes/state'))).toMatchObject({ restart: { kind: 'needed', changes: 1, runningChats: 2, available: true } })

    // A Host that booted with the change runs it.
    const booted = new FakeRestart({ kind: 'known', files: { [RUNTIME_FILE]: change.to as never } })
    expect(await restartStateOf(booted, harness)).toBeUndefined()
    // A Host whose composition is unknown counts a restart as needed.
    expect(await restartStateOf(new FakeRestart({ kind: 'unknown' }), harness)).toMatchObject({ kind: 'needed', changes: 1 })
    // Undone back to the signed file, the Host that booted without it runs what the records compose.
    await post(server.port, HARNESS_PATHS.undo, { id: change.id })
    expect(json(await get(server.port, '/delorun/changes/state'))).not.toHaveProperty('restart')
  })

  it('shows a restart under way and the last one\'s failure, and a discard forgets that failure', async () => {
    const { ctx } = routeHome()
    const harness = routeHarness(ctx.home)
    const restart = new FakeRestart()
    restart.current = { kind: 'restarting', since: '2026-11-17T10:00:00.000Z', phase: 'waiting', runningChats: 1 }
    expect(await restartStateOf(restart, harness)).toEqual({ kind: 'restarting', since: '2026-11-17T10:00:00.000Z', phase: 'waiting', runningChats: 1 })
    restart.current = { kind: 'failed', at: '2026-11-17T10:01:00.000Z', failure: 'Delorun did not start with the changes', reason: 'health', leftOut: { id: 'c0123456789', file: RUNTIME_FILE } }
    expect(await restartStateOf(restart, harness)).toEqual({ kind: 'failed', at: '2026-11-17T10:01:00.000Z', failure: 'Delorun did not start with the changes', reason: 'health', leftOut: { id: 'c0123456789', file: RUNTIME_FILE } })
    expect(await restartStateOf(undefined, harness)).toBeUndefined()
    expect(await restartStateOf(restart, undefined)).toBeUndefined()

    const server = await serveRoutes(ctx, { harness: () => harness, restartState: () => restartStateOf(restart, harness), clearRestartFailure: () => { restart.clearFailure() } })
    await post(server.port, HARNESS_PATHS.copy, {})
    writeFileSync(join(harnessCopyDirectory(ctx.home, RUNTIME), RUNTIME_FILE), 'export const start = 4\n')
    const change = ((json(await get(server.port, `${SHOW_PATH}?pending`)).harness) as { id: string }[])[0]!
    await post(server.port, HARNESS_PATHS.discard, { id: change.id })
    expect(restart.cleared).toBe(1)
  })
})
