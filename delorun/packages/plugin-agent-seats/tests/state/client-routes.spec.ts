/**
 * The client's request bodies, produced by `createSeatClient`, against the Host routes' own parsers: a field the two
 * sides name differently fails here, not in a live run.
 */
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { createSeatClient, SEAT_ROUTES } from '../../src/client/host-routes.ts'
import { SEAT_NOTICE_RECORD, SEAT_STATUS_RECORD } from '../../src/state/index.ts'
import { stateWorld, type StateWorld } from './support.ts'

/** A `fetch` that hands each request to the mounted Host route of the same path. */
function hostFetch(w: StateWorld): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const route = w.mount.routes.find(candidate => candidate.path === input)
    if (route === undefined) return new Response('no such route', { status: 404 })
    return route.fetch(new Request(`http://delorun.test${input}`, init))
  }
}

describe('the client\'s Resume and model requests', () => {
  it('name the routes the Host mounts', async () => {
    const w = await stateWorld()
    expect(w.mount.routes.map(route => route.path).sort()).toEqual(Object.values(SEAT_ROUTES).sort())
  })

  it('reach the Host\'s Resume route with the child it reads', async () => {
    const w = await stateWorld({ now: () => 9000 })
    appendPluginRecord(w.session, SEAT_STATUS_RECORD, { state: 'limit', resetAt: 5000 })
    await createSeatClient(hostFetch(w)).resume(w.child)
    expect(w.mount.store.viewOf(w.child)?.state).toBe('idle')
  })

  it('reach the Host\'s model route with the child and model id it reads', async () => {
    const w = await stateWorld()
    const picker = { offered: [{ id: 'gpt-a', label: 'GPT A' }], planDefault: 'gpt-a' }
    appendPluginRecord(w.session, SEAT_STATUS_RECORD, { state: 'model-needed', modelPicker: picker })
    await createSeatClient(hostFetch(w)).chooseModel(w.child, 'gpt-a')
    expect(w.mount.choices.get('workspace-1')).toBe('gpt-a')
    expect(w.session.snapshotEvents().some(event => JSON.stringify(event).includes(SEAT_NOTICE_RECORD))).toBe(true)
  })
})
