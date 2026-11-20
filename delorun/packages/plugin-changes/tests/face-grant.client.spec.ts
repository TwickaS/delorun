/**
 * The Changes controller's Face ID step: a control the state says needs Face ID asks for a grant covering exactly the call
 * and sends it in `Delorun-Grant`; a cancel sends nothing; every other control and a page without the service send as before.
 *
 * Each test's comment names the behaviour whose removal makes it fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangesController } from '../src/client/controller.ts'
import type { FaceGrant } from '../src/client/face-grant.ts'
import { ACTION_PATHS, type ChangesControl, type ChangesStateView, type MayView } from '../src/wire.ts'

const posts: { path: string; body: unknown; grant: string | null }[] = []

/** Stand in for the harness: every POST answers a discard, the state read fails (the controller keeps what it holds). */
beforeEach(() => {
  posts.length = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return new Response('{}', { status: 500 })
    const headers = new Headers(init.headers)
    posts.push({ path, body: JSON.parse(String(init.body)), grant: headers.get('Delorun-Grant') })
    return new Response('{}', { status: 200 })
  }))
  vi.stubGlobal('document', { baseURI: 'https://studio.test/' })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

/** A controller whose state says what each control needs. */
function controller(needs: Partial<Record<ChangesControl, MayView>>, faceGrant: (() => FaceGrant | undefined) | undefined) {
  const changes = new ChangesController({ report: () => {}, ...(faceGrant === undefined ? {} : { faceGrant }) })
  const may = new Proxy({}, { get: (_target, key: string) => needs[key as ChangesControl] ?? { ok: true } })
  changes.state.set({ status: 'ready', state: { access: { may } } as ChangesStateView })
  return changes
}

describe('the Changes controller\'s Face ID step', () => {
  it('asks for a grant covering exactly the call, then sends it in Delorun-Grant', async () => {
    // The home hashes method, path and body itself; the page must name the same call and carry the grant's id.
    const grant = vi.fn<FaceGrant>(async () => 'g1')
    const changes = controller({ 'plugin-discard': { ok: false, needs: 'face' } }, () => grant)
    expect(await changes.discard('c1')).toEqual({ kind: 'done' })
    expect(grant).toHaveBeenCalledExactlyOnceWith({ action: 'changes/plugin-discard', call: { method: 'POST', path: ACTION_PATHS.discard, body: { id: 'c1' } } })
    expect(posts).toEqual([{ path: ACTION_PATHS.discard.slice(1), body: { id: 'c1' }, grant: 'g1' }])
  })
  it('hashes the path the page fetches, including the studio\'s path prefix', async () => {
    // The home hashes the URL it receives; a studio under /studio/ must name that path or every grant is refused.
    vi.stubGlobal('document', { baseURI: 'https://studio.test/studio/' })
    const grant = vi.fn<FaceGrant>(async () => 'g1')
    const changes = controller({ 'plugin-discard': { ok: false, needs: 'face' } }, () => grant)
    await changes.discard('c1')
    expect(grant).toHaveBeenCalledExactlyOnceWith({ action: 'changes/plugin-discard', call: { method: 'POST', path: `/studio${ACTION_PATHS.discard}`, body: { id: 'c1' } } })
  })
  it('sends nothing when the person cancels', async () => {
    // A cancelled sheet must not reach the route.
    const changes = controller({ 'plugin-discard': { ok: false, needs: 'face' } }, () => async () => undefined)
    expect(await changes.discard('c1')).toEqual({ kind: 'refused' })
    expect(posts).toEqual([])
  })
  it('asks nothing for a control the home lets through', async () => {
    // A free control, and a computer or a locked page, send as before.
    const grant = vi.fn<FaceGrant>(async () => 'g1')
    const changes = controller({}, () => grant)
    await changes.protectionOn()
    expect(grant).not.toHaveBeenCalled()
    expect(posts).toHaveLength(1)
    expect(posts[0]?.grant).toBeNull()
  })
  it('sends plain when the page has no Face ID service', async () => {
    // Without the bundle's row the home's own refusal is the answer; the page must not hang on a missing service.
    const changes = controller({ 'plugin-discard': { ok: false, needs: 'face' } }, () => undefined)
    await changes.discard('c1')
    expect(posts).toEqual([{ path: ACTION_PATHS.discard.slice(1), body: { id: 'c1' }, grant: null }])
  })
})
