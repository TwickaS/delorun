/**
 * The update routes' classes under Face ID: update-begin, update-rollback and stop need a grant for exactly the call;
 * update-cancel, update-dismiss and update-check need nothing; the computer is never asked.
 */
import { GrantStore, hashRequest, type GrantHolder } from '@delorun/home-auth'
import { describe, expect, it } from 'vitest'
import { faceAccessOf } from '../../plugin-changes/src/face-access.ts'
import { fromDevice, json, post, send } from '../../plugin-changes/tests/routes-fixture.ts'
import { UPDATE_PATHS } from '../src/wire.ts'
import { serveUpdate } from './update-fixture.ts'

const HOLDER: GrantHolder = { deviceId: 'device-test-1', listener: 'tailscale-private' as GrantHolder['listener'] }

/** A grant store, the device's access to it, and a way to grant one call. */
function world() {
  const store = new GrantStore({ now: () => 1_000_000, random: size => Uint8Array.from({ length: size }, (_, i) => i + 1) })
  const grantFor = (path: string, body: unknown, control: string): string => {
    const hash = hashRequest({ method: 'POST', path, body: Buffer.from(JSON.stringify(body)) })
    if (hash === undefined) throw new Error('body over the cap')
    return store.mint(HOLDER, [{ action: `changes/${control}`, hash }], 'passkey').grantId
  }
  return { face: faceAccessOf(store, true, HOLDER), grantFor }
}

describe('update routes under Face ID', () => {
  it('update-begin, update-rollback and stop refuse a passkey device with no grant, whatever its unlock', async () => {
    const update = await serveUpdate({ powers: 'full', face: world().face })
    for (const unlock of ['fresh', 'grace', 'none'] as const) {
      for (const path of [UPDATE_PATHS.prepare, UPDATE_PATHS.apply, UPDATE_PATHS.rollback, UPDATE_PATHS.stop]) {
        const reply = await send(update.server.port, path, fromDevice(unlock, { chats: 'wait' }))
        expect(json(reply), `${path} ${unlock}`).toMatchObject({ code: 'ELEVATION_REQUIRED' })
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
