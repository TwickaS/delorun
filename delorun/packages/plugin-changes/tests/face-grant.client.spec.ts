/**
 * The Changes controller's Face ID step: a control the state says needs Face ID asks for a grant covering exactly the call
 * and sends it in `Delorun-Grant`; a cancel sends nothing; every other control and a page without the service send as before.
 *
 * Each test's comment names the behaviour whose removal makes it fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangesController } from '../src/client/controller.ts'
import { PASS_GRANT_ID, type FaceGrant } from '../src/client/face-grant.ts'
import { ACTION_PATHS, PROTECTION_PATHS, type ChangesControl, type ChangesStateView, type MayView } from '../src/wire.ts'

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
  it('asks again with a sheet when the home refuses a call sent under a pass that ended in between', async () => {
    // Removing the fallback leaves Apply failing with "confirm" after a Lock now in another tab (review P3-3).
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      posts.push({ path, body: JSON.parse(String(init?.body)), grant: headers.get('Delorun-Grant') })
      return headers.get('Delorun-Grant') === PASS_GRANT_ID
        ? new Response(JSON.stringify({ error: 'ELEVATION_REQUIRED', code: 'ELEVATION_REQUIRED', message: 'm', action: 'changes/plugin-discard' }), { status: 403 })
        : new Response('{}', { status: 200 })
    }))
    const answers = [PASS_GRANT_ID, 'g2']
    const grant = vi.fn<FaceGrant>(async () => answers.shift())
    const changes = controller({ 'plugin-discard': { ok: false, needs: 'face' } }, () => grant)
    expect(await changes.discard('c1')).toEqual({ kind: 'done' })
    expect(grant).toHaveBeenCalledTimes(2)
    expect(posts.map(post => post.grant)).toEqual([PASS_GRANT_ID, 'g2'])
  })
  it('asks Face ID once for a call and its second confirmation, and again for a call it did not carry the grant to', async () => {
    // Asking for the confirmed request again makes the person confirm with Face ID twice (A434).
    let first = true
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      const body: unknown = JSON.parse(String(init?.body))
      posts.push({ path, body, grant: headers.get('Delorun-Grant') })
      if (first) {
        first = false
        return new Response(JSON.stringify({ error: 'CONFIRM_PROTECTION', code: 'CONFIRM_PROTECTION', message: 'm', willLoad: { plugins: [], harnessFiles: 0 } }), { status: 409 })
      }
      return new Response('{}', { status: 200 })
    }))
    const grant = vi.fn<FaceGrant>(async () => 'g1')
    const changes = controller({ 'protection-off': { ok: false, needs: 'face' } }, () => grant)
    expect(await changes.protectionOff(false)).toMatchObject({ kind: 'confirm-protection' })
    expect(await changes.protectionOff(true)).toMatchObject({ kind: 'done' })
    // The grant covers the call without its confirmation field, as the home hashes it.
    expect(grant).toHaveBeenCalledExactlyOnceWith({ action: 'changes/protection-off', call: { method: 'POST', path: PROTECTION_PATHS.off, body: {} } })
    expect(posts.map(post => post.grant)).toEqual(['g1', 'g1'])
    // A grant is carried once: the next confirmed call asks again.
    await changes.protectionOff(true)
    expect(grant).toHaveBeenCalledTimes(2)
  })
  it('sends plain when the page has no Face ID service', async () => {
    // Without the bundle's row the home's own refusal is the answer; the page must not hang on a missing service.
    const changes = controller({ 'plugin-discard': { ok: false, needs: 'face' } }, () => undefined)
    await changes.discard('c1')
    expect(posts).toEqual([{ path: ACTION_PATHS.discard.slice(1), body: { id: 'c1' }, grant: null }])
  })
})
