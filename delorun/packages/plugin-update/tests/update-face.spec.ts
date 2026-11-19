/**
 * The update routes' classes under Face ID: update-begin, update-rollback and stop need a grant for exactly the call;
 * update-cancel, update-dismiss and update-check need nothing; the computer is never asked.
 */
import { describe, expect, it } from 'vitest'
import { faceAccessOf } from '../../plugin-changes/src/face-access.ts'
import { faceWorld } from '../../plugin-changes/tests/face-world.ts'
import { fromDevice, json, post, send, TEST_DEVICE } from '../../plugin-changes/tests/routes-fixture.ts'
import { UPDATE_PATHS } from '../src/wire.ts'
import { serveUpdate } from './update-fixture.ts'

/** A grant store, the device's access to it, and a way to grant one call. */
function world() {
  const listener = 'tailscale-private'
  const faces = faceWorld(TEST_DEVICE.id, listener)
  const grantFor = (path: string, body: unknown, control: string): string => faces.grantFor(`changes/${control}`, { path, body: JSON.stringify(body) })
  return { face: faceAccessOf(faces.store, true, { deviceId: TEST_DEVICE.id, listener: listener as Parameters<typeof faceAccessOf>[2]['listener'] }), grantFor }
}

describe('update routes under Face ID', () => {
  it('update-begin, update-rollback and stop refuse a passkey device with no grant, whatever its unlock', async () => {
    const update = await serveUpdate({ face: world().face })
    for (const unlock of ['fresh', 'grace', 'none'] as const) {
      for (const path of [UPDATE_PATHS.prepare, UPDATE_PATHS.apply, UPDATE_PATHS.rollback, UPDATE_PATHS.stop]) {
        const reply = await send(update.server.port, path, fromDevice(unlock, { chats: 'wait' }))
        expect(json(reply), `${path} ${unlock}`).toMatchObject({ code: 'ELEVATION_REQUIRED' })
      }
    }
    expect(update.channel.requests).toEqual([])
  })

  // Removing the flag check for the `grant` set in `mayUse` sends update-begin and update-rollback to the unlock path while the flag is off, where no grant can exist.
  it('update-begin and update-rollback stay at the computer while the Face ID flag is off, whatever unlock the device holds', async () => {
    const update = await serveUpdate()
    for (const unlock of ['fresh', 'grace', 'none'] as const) {
      for (const path of [UPDATE_PATHS.prepare, UPDATE_PATHS.apply, UPDATE_PATHS.rollback]) {
        const reply = await send(update.server.port, path, fromDevice(unlock, { chats: 'wait' }))
        expect(json(reply), `${path} ${unlock}`).toMatchObject({ code: 'LOOPBACK_REQUIRED' })
      }
    }
    expect(update.channel.requests).toEqual([])
  })

  it('stop takes a grant for its body and refuses a grant made for another body', async () => {
    const w = world()
    const update = await serveUpdate({ face: w.face })
    update.channel.answers.set('stop', [{ ok: true, phase: 'waiting' }])
    const grant = w.grantFor(UPDATE_PATHS.stop, { chats: 'wait' }, 'stop')
    const base = fromDevice('none', { chats: 'cancel' })
    const other = await send(update.server.port, UPDATE_PATHS.stop, { ...base, headers: [...base.headers ?? [], `Delorun-Grant: ${grant}`] })
    expect(json(other)).toMatchObject({ code: 'ELEVATION_REQUIRED' })
    expect(update.channel.requests).toEqual([])
  })

  it('update-cancel and update-dismiss work with no unlock and no grant; the computer is never asked', async () => {
    const update = await serveUpdate({ face: world().face })
    for (const path of [UPDATE_PATHS.cancel, UPDATE_PATHS.dismiss]) {
      for (const unlock of ['fresh', 'grace', 'none'] as const) {
        expect(['LOOPBACK_REQUIRED', 'ELEVATION_REQUIRED']).not.toContain(json(await send(update.server.port, path, fromDevice(unlock, {}))).code)
      }
    }
    expect(['LOOPBACK_REQUIRED', 'ELEVATION_REQUIRED']).not.toContain(json(await post(update.server.port, UPDATE_PATHS.stop, {})).code)
  })
})
