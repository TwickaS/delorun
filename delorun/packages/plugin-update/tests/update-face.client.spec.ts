/**
 * The update controller's Face ID step: Prepare and Apply each ask for a grant covering exactly their call; a cancel
 * sends nothing and reports a refusal the screen words.
 *
 * Each test's comment names the behaviour whose removal makes it fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PASS_GRANT_ID, type FaceGrant } from '@delorun/plugin-changes/face-grant'
import { UpdateController } from '../src/client/controller.ts'
import { UPDATE_PATHS, type UpdateControl, type UpdateMayView, type UpdateStateView } from '../src/wire.ts'

const posts: { path: string; grant: string | null }[] = []

beforeEach(() => {
  posts.length = 0
  vi.stubGlobal('document', { baseURI: 'https://studio.test/' })
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return new Response('{}', { status: 500 })
    posts.push({ path, grant: new Headers(init.headers).get('Delorun-Grant') })
    return new Response('{}', { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

/** A controller whose state says what each control needs. */
function controller(needs: Partial<Record<UpdateControl, UpdateMayView>>, faceGrant: () => FaceGrant | undefined) {
  const update = new UpdateController({ reload: () => {}, faceGrant })
  const may = new Proxy({}, { get: (_target, key: string) => needs[key as UpdateControl] ?? { ok: true } })
  update.state.set({ status: 'ready', state: { access: { may }, progress: { kind: 'idle' } } as UpdateStateView, reconnecting: false })
  return update
}

describe('the update controller\'s Face ID step', () => {
  it('asks for a grant covering the prepare call and sends it', async () => {
    // Prepare is an update-begin call; it needs its own grant for its own body.
    const grant = vi.fn<FaceGrant>(async () => 'g1')
    const update = controller({ 'update-begin': { ok: false, needs: 'face' } }, () => grant)
    await update.prepare()
    expect(grant).toHaveBeenCalledExactlyOnceWith({ action: 'changes/update-begin', call: { method: 'POST', path: UPDATE_PATHS.prepare, body: {} } })
    expect(posts).toEqual([{ path: UPDATE_PATHS.prepare.slice(1), grant: 'g1' }])
  })
  it('asks again with a sheet when the home refuses a call sent under a pass that ended in between', async () => {
    // Removing the fallback leaves Prepare refused after the pass ended between the check and the send (review P3-3).
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      const grant = new Headers(init?.headers).get('Delorun-Grant')
      posts.push({ path, grant })
      return grant === PASS_GRANT_ID ? new Response(JSON.stringify({ code: 'ELEVATION_REQUIRED', message: 'm' }), { status: 403 }) : new Response('{}', { status: 200 })
    }))
    const answers = [PASS_GRANT_ID, 'g2']
    const grant = vi.fn<FaceGrant>(async () => answers.shift())
    const update = controller({ 'update-begin': { ok: false, needs: 'face' } }, () => grant)
    await update.prepare()
    expect(posts.filter(post => post.path === UPDATE_PATHS.prepare.slice(1)).map(post => post.grant)).toEqual([PASS_GRANT_ID, 'g2'])
  })
  it('sends nothing and reports a cancelled refusal when the person cancels', async () => {
    // A cancelled sheet must not reach the route, and the screen needs a refusal to word.
    const update = controller({ 'update-begin': { ok: false, needs: 'face' } }, () => async () => undefined)
    expect(await update.prepare()).toEqual({ ok: false, refusal: { code: 'FACE_CANCELLED', message: '' } })
    expect(posts).toEqual([])
  })
  it('asks nothing for a control the home lets through', async () => {
    // The release check is free and must send as before.
    const grant = vi.fn<FaceGrant>(async () => 'g1')
    await controller({}, () => grant).check()
    expect(grant).not.toHaveBeenCalled()
    expect(posts[0]?.grant).toBeNull()
  })
})
