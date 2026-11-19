// @vitest-environment jsdom
/**
 * The Face ID step for every sensitive call of a reach device (`src/client/face-retry.ts`): a Remote call or a plugin
 * Fetch call the home refuses for want of a grant opens the confirmation, mints a grant for exactly that call, and is
 * sent once more. The hashes are checked against the home's own functions.
 *
 * Each test's comment names the behaviour whose removal makes it fail.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { FaceGrantRequest } from '@delorun/plugin-changes/face-grant'
import { createPacksClient } from '@delorun/plugin-packs/client'
import { hashArgs as homeHashArgs, hashRequest as homeHashRequest } from '../../home-auth/src/grants.ts'
import { createFaceGrantSource, type FaceGrantSource } from '../src/client/face-grant.ts'
import { en } from '../src/client/face-id-locales.ts'
import { fakeApi, fakeBrowser } from '../src/client/face-id-fake.ts'
import { callActionOf, FaceIdGrantOverlay, type FaceIdGrantOverlayProps } from '../src/client/FaceIdGrantOverlay.tsx'
import { GRANT_HEADER, grantingFetch, NEVER_ASKED, oneAtATime, PICKER_HOLD_ID, remoteDenialLift } from '../src/client/face-retry.ts'
import type { GrantRequest, PasskeyApi } from '../src/client/face-id-types.ts'
import type { PinView } from '../src/client/pin-lock.ts'
import { fakeHost } from './fake-host.ts'
import { Context } from '@deepseek-ai/cordis'
import { applyFaceGrant, registerReportSlots } from '../src/client/index.ts'
import { loadReportDetails } from '../src/client/report-api.ts'
import type { HostFetch } from '../src/client/host-api.ts'
import { setNetwork } from '../src/client/network-api.ts'
import { acceptServer, setFullAccess, type PendingServer, type WorkspaceAccess } from '../src/client/consents-api.ts'

const t = makeTranslate(en)
const BASE = 'https://home.example.ts.net/studio/'
const pinView: PinView = { phase: 'unlocked', secret: 'passcode', busy: false, outcome: undefined, paused: false, asked: false }
const PASSKEY = { credentialId: 'c1', createdAt: 0, lastUsedAt: null, synced: false }

afterEach(cleanup)

/** A store, its queued confirmation, and a fake of the home's passkey routes. */
function world(options: { readonly passkey?: boolean } = {}): { source: FaceGrantSource; grant: ReturnType<typeof oneAtATime>; api: ReturnType<typeof fakeApi> } {
  const source = createFaceGrantSource()
  const api = fakeApi({ devices: [{ deviceId: 'd', label: 'Phone', thisDevice: true, passkeys: options.passkey === false ? [] : [PASSKEY] }] })
  return { source, grant: oneAtATime(source.grant), api }
}

/**
 * Wait for the pending confirmation, show its sheet, and answer it.
 * @returns the grant request the sheet sent, and the sheet's title.
 */
async function answer(source: FaceGrantSource, api: PasskeyApi & { readonly calls: readonly { readonly name: string; readonly request: unknown }[] }, how: 'faceId' | 'pin' | 'cancel'): Promise<{ readonly sent: GrantRequest | undefined; readonly title: string }> {
  await waitFor(() => { expect(source.hooks.pending.getSnapshot()).not.toBeNull() })
  const shown = source.hooks.pending.getSnapshot()
  const props = {
    t, fetch: fakeHost({}).fetch, api, browser: fakeBrowser(), settle: source.settle,
    usePending: <S,>(select: (pending: ReturnType<typeof source.hooks.pending.getSnapshot>) => S): S => select(source.hooks.pending.getSnapshot()),
    usePin: <S,>(select: (view: PinView) => S): S => select(pinView),
  } as FaceIdGrantOverlayProps
  render(<FaceIdGrantOverlay {...props} />)
  const dialog = await screen.findByRole('dialog')
  const title = dialog.querySelector('h2,h3')?.textContent ?? dialog.textContent
  if (how === 'faceId') fireEvent.click(await screen.findByRole('button', { name: /Confirm with/ }))
  if (how === 'pin') {
    fireEvent.change(await screen.findByLabelText('Passcode'), { target: { value: 'correct horse' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  }
  if (how === 'cancel') fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => { expect(source.hooks.pending.getSnapshot()).not.toBe(shown) })
  const sent = api.calls.filter(entry => entry.name === 'options' || entry.name === 'pin').at(-1)?.request as GrantRequest | undefined
  cleanup()
  return { sent, title }
}

const refusal = (action?: string): Response => Response.json({ error: 'ELEVATION_REQUIRED', message: 'Confirm with Face ID or your PIN first', ...action === undefined ? {} : { action } }, { status: 403 })

describe('a Remote call the home refuses for want of a grant', () => {
  const ARGS = { id: 'reports', version: '1.2.0' }
  const denial = (endpoint: string, args: Readonly<Record<string, unknown>>, reason = `elevation-required: ${endpoint}`) => ({ endpoint, reason, args, signal: new AbortController().signal })

  // Removing the lift leaves every elevated Remote action a dead end on a phone; hashing anything but the wire arguments makes the home refuse the retry.
  it('opens the sheet, mints a grant for exactly the method and its arguments, and asks for the call to be sent again', async () => {
    const { source, grant, api } = world()
    const lifted = remoteDenialLift(grant)(denial('pluginManager/installBundle', ARGS))
    const { sent, title } = await answer(source, api, 'faceId')
    await expect(lifted).resolves.toBe(true)
    expect(title).toContain('Install a plugin')
    expect(sent).toEqual({ actions: [{ action: 'pluginManager/installBundle', hash: homeHashArgs(ARGS) }] })
  })

  // Removing the reason check would ask for Face ID where no grant can help, such as a computer-only action.
  it('asks nothing for a refusal no grant lifts', async () => {
    const { source, grant } = world()
    for (const reason of ['loopback-required: credentials/set', 'resource-unlisted: session/cancel']) {
      await expect(remoteDenialLift(grant)({ ...denial('credentials/set', {}), reason })).resolves.toBe(false)
    }
    await expect(remoteDenialLift(grant)({ endpoint: 'x/y', reason: undefined, args: {}, signal: new AbortController().signal })).resolves.toBe(false)
    expect(source.hooks.pending.getSnapshot()).toBeNull()
  })

  // Resolving true on a cancel would send the refused call again with no grant; a cancel must send nothing.
  it('sends nothing more when the person cancels', async () => {
    const { source, grant, api } = world()
    const lifted = remoteDenialLift(grant)(denial('settings/update', { ns: 'x', patch: {} }))
    const { sent } = await answer(source, api, 'cancel')
    await expect(lifted).resolves.toBe(false)
    expect(sent).toBeUndefined()
  })

  // Dropping the passkey read shows a phone with no passkey a Face ID button it cannot answer.
  it('opens on the PIN keypad on a device with no passkey and mints the grant through the PIN route', async () => {
    const { source, grant, api } = world({ passkey: false })
    const lifted = remoteDenialLift(grant)(denial('credentials/set', { ref: 'DEEPSEEK_API_KEY', value: 'sk-new' }))
    const { sent, title } = await answer(source, api, 'pin')
    await expect(lifted).resolves.toBe(true)
    expect(title).toContain('Save a model key')
    expect(api.calls.some(entry => entry.name === 'options')).toBe(false)
    expect(sent).toMatchObject({ actions: [{ action: 'credentials/set', hash: homeHashArgs({ ref: 'DEEPSEEK_API_KEY', value: 'sk-new' }) }], secret: 'correct horse' })
  })

  // Without the hold, every later read of the new terminal would ask again.
  it('gives terminal/create the hold of the terminal it creates', async () => {
    const { source, grant, api } = world()
    const created = { sessionId: 's1', request: { id: 'term-1', cols: 80, rows: 24 } }
    const lifted = remoteDenialLift(grant)(denial('terminal/create', created))
    const { sent, title } = await answer(source, api, 'faceId')
    await expect(lifted).resolves.toBe(true)
    expect(title).toContain('Open a terminal')
    expect(sent).toEqual({ actions: [{ action: 'terminal/create', hash: homeHashArgs(created), hold: { feature: 'terminal', id: 'term-1' } }] })
  })

  // Without the hold, a reloaded terminal tab asks again for each of its streams.
  it.each([
    ['terminal/attach', { agentId: 's1', id: 'term-2' }],
  ] as const)('gives %s the hold of the terminal it reopens', async (endpoint, args) => {
    const { source, grant, api } = world()
    const lifted = remoteDenialLift(grant)(denial(endpoint, args))
    const { sent, title } = await answer(source, api, 'faceId')
    await expect(lifted).resolves.toBe(true)
    expect(title).toContain('Open a terminal')
    expect(sent).toEqual({ actions: [{ action: endpoint, hash: homeHashArgs(args), hold: { feature: 'terminal', id: 'term-2' } }] })
  })

  // Asking about a call the studio sends on load or reconnect puts a sheet nobody asked for in front of the person,
  // ahead of the action they tapped (review P1-1).
  it('never asks about a background call, and leaves the person\'s confirmation as it is', async () => {
    const { source, grant, api } = world()
    const install = remoteDenialLift(grant)(denial('pluginManager/installBundle', ARGS))
    await waitFor(() => { expect(source.hooks.pending.getSnapshot()).not.toBeNull() })
    const shown = source.hooks.pending.getSnapshot()
    for (const endpoint of Object.keys(NEVER_ASKED)) {
      await expect(remoteDenialLift(grant)(denial(endpoint, { manifests: [] }))).resolves.toBe(false)
    }
    expect(source.hooks.pending.getSnapshot()).toBe(shown)
    const { sent, title } = await answer(source, api, 'faceId')
    await expect(install).resolves.toBe(true)
    expect(title).toContain('Install a plugin')
    expect(sent).toEqual({ actions: [{ action: 'pluginManager/installBundle', hash: homeHashArgs(ARGS) }] })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(source.hooks.pending.getSnapshot()).toBeNull()
  })

  // Asking about terminal/retain opens one sheet per saved terminal tab on every load, in chats nobody is looking at
  // (review r2 P2-1, r3 P3-2); the terminal on screen asks through terminal/attach.
  it('never asks about the window hold a saved terminal tab keeps, and still asks when the terminal on screen attaches', async () => {
    const { source, grant } = world()
    await expect(remoteDenialLift(grant)(denial('terminal/retain', { sessionId: 's1', id: 't' }))).resolves.toBe(false)
    expect(source.hooks.pending.getSnapshot()).toBeNull()
    const attaching = remoteDenialLift(grant)(denial('terminal/attach', { sessionId: 's1', id: 't' }))
    await waitFor(() => { expect(source.hooks.pending.getSnapshot()?.request).toMatchObject({ action: 'terminal/attach', hold: { feature: 'terminal', id: 't' } }) })
    source.settle(undefined)
    await expect(attaching).resolves.toBe(false)
  })

  // Keeping the sheet of a cancelled call mints a grant nothing uses, and a reconnect would queue a second sheet for the same call (review r2 P3-2).
  it('skips the sheet of a call cancelled while it waited, and closes the sheet of a call cancelled while it shows', async () => {
    const { source, grant, api } = world()
    const showing = new AbortController()
    const waiting = new AbortController()
    const first = remoteDenialLift(grant)({ ...denial('terminal/attach', { id: 't-1' }), signal: showing.signal })
    const second = remoteDenialLift(grant)({ ...denial('terminal/attach', { id: 't-2' }), signal: waiting.signal })
    await waitFor(() => { expect(source.hooks.pending.getSnapshot()).not.toBeNull() })
    waiting.abort()
    showing.abort()
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    expect(source.hooks.pending.getSnapshot()).toBeNull()
    expect(api.calls.filter(call => call.name === 'options' || call.name === 'pin')).toEqual([])
  })

  // A picker hold id other than the home's would open a hold no later read matches (`face-grants.spec.ts` pins it to the home's).
  it('gives directoryPicker/list the picker\'s hold', async () => {
    const { source, grant, api } = world()
    const lifted = remoteDenialLift(grant)(denial('directoryPicker/list', { path: '/home/me' }))
    const { sent, title } = await answer(source, api, 'faceId')
    await expect(lifted).resolves.toBe(true)
    expect(title).toContain('Browse your computer')
    expect(sent).toEqual({ actions: [{ action: 'directoryPicker/list', hash: homeHashArgs({ path: '/home/me' }), hold: { feature: 'picker', id: PICKER_HOLD_ID } }] })
  })

  // Without the queue the second refusal would end the first confirmation as cancelled.
  it('asks for two refusals one after the other', async () => {
    const { source, grant, api } = world()
    const first = remoteDenialLift(grant)(denial('settings/update', { a: 1 }))
    const second = remoteDenialLift(grant)(denial('settings/update', { a: 2 }))
    await answer(source, api, 'faceId')
    await expect(first).resolves.toBe(true)
    await answer(source, api, 'faceId')
    await expect(second).resolves.toBe(true)
  })
})

describe('a plugin Fetch call the home refuses for want of a grant', () => {
  // Hashing another path, query or body than the home reads makes the retry fail; omitting the header leaves the grant unused.
  it('mints a grant over the method, the path with its query and the body, and sends the call once more with Delorun-Grant', async () => {
    const { source, grant, api } = world()
    const body = '{ "names": ["@delorun/reports"] }'
    const send = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(refusal('plugin-packs/add')).mockResolvedValueOnce(Response.json({ ok: true }))
    const answered = grantingFetch(send, grant, () => BASE)('api/delorunPacks.add?from=card', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    const { sent, title } = await answer(source, api, 'faceId')
    expect((await answered).status).toBe(200)
    expect(title).toContain('Install a plugin')
    const path = '/studio/api/delorunPacks.add?from=card'
    expect(sent).toEqual({ actions: [{ action: 'plugin-packs/add', hash: homeHashRequest({ method: 'POST', path, body: new TextEncoder().encode(body) }) }] })
    expect(send).toHaveBeenCalledTimes(2)
    expect(new Headers(send.mock.calls[1]?.[1]?.headers).get(GRANT_HEADER)).toBe('g1')
    expect(new Headers(send.mock.calls[1]?.[1]?.headers).get('content-type')).toBe('application/json')
    expect(send.mock.calls[1]?.[1]?.body).toBe(body)
  })

  // Resending on a cancel would make a second refused request; the caller must get the home's own refusal.
  it('returns the refusal and sends nothing more when the person cancels', async () => {
    const { source, grant, api } = world()
    const send = vi.fn((_input: string, _init?: RequestInit) => Promise.resolve(refusal('plugin-permission-defaults/network-set')))
    const answered = grantingFetch(send, grant, () => BASE)('/api/delorunNetwork.set', { method: 'POST', body: '{"path":"/w"}' })
    await answer(source, api, 'cancel')
    const reply = await answered
    expect(reply.status).toBe(403)
    expect(await reply.json()).toMatchObject({ error: 'ELEVATION_REQUIRED' })
    expect(send).toHaveBeenCalledOnce()
    expect(api.calls.some(entry => entry.name === 'options' || entry.name === 'pin')).toBe(false)
  })

  // A refusal that names no action (a body too large to hash, or any other 403) has no grant to ask for.
  it('passes any other answer through without asking', async () => {
    const { source, grant } = world()
    for (const reply of [refusal(), Response.json({ error: 'LOOPBACK_REQUIRED', action: 'x' }, { status: 403 }), new Response('no', { status: 403 }), Response.json({ ok: true })]) {
      const send = vi.fn((_input: string, _init?: RequestInit) => Promise.resolve(reply))
      expect(await grantingFetch(send, grant, () => BASE)('api/x', { method: 'POST', body: '{}' })).toBe(reply)
      expect(send).toHaveBeenCalledOnce()
    }
    expect(source.hooks.pending.getSnapshot()).toBeNull()
  })

  // A caller that minted its own grant (the Changes controllers) must not be asked twice.
  it('leaves a request that already names a grant alone', async () => {
    const { source, grant } = world()
    const send = vi.fn((_input: string, _init?: RequestInit) => Promise.resolve(refusal('changes/plugin-apply')))
    await grantingFetch(send, grant, () => BASE)('api/x', { method: 'POST', body: '{}', headers: { [GRANT_HEADER]: 'g0' } })
    expect(send).toHaveBeenCalledOnce()
    expect(source.hooks.pending.getSnapshot()).toBeNull()
  })
})

describe('the sheet\'s words', () => {
  const words = async (request: FaceGrantRequest): Promise<string> => (await callActionOf(t, request)).title
  it('describe each surface family in plain words, with a plain fallback', async () => {
    expect(await words({ action: 'plugin-packs/add', call: { method: 'POST', path: '/p', body: { names: ['a'] } } })).toBe('Install a plugin')
    expect(await words({ action: 'plugin-permission-defaults/set-full-access', call: { method: 'POST', path: '/p', body: { workspace: '/home/me/site', reviewId: 'r', on: true, confirmed: true } } })).toBe('Turn on full access for site')
    expect(await words({ action: 'plugin-permission-defaults/set-full-access', call: { method: 'POST', path: '/p', body: '{"workspace":"/home/me/site","on":false}' } })).toBe('Turn off full access for site')
    expect(await words({ action: 'plugin-permission-defaults/network-set', call: { method: 'POST', path: '/p', body: {} } })).toBe('Change network access')
    expect(await words({ action: 'plugin-mcp-consent/accept', call: { method: 'POST', path: '/p', body: { serverName: 'files', reviewId: 'r', confirmed: true } } })).toBe('Allow the MCP server “files”')
    expect(await words({ action: 'terminal/close', call: { args: { id: 't' } } })).toBe('Open a terminal')
    expect(await words({ action: 'settings/replace', call: { args: {} } })).toBe('Change a setting')
    expect(await words({ action: 'credentials/unset', call: { args: {} } })).toBe('Remove a model key')
    expect(await words({ action: 'someone/else', call: { args: {} } })).toBe('Confirm this action')
    expect((await callActionOf(t, { action: 'plugin-packs/add', call: { method: 'POST', path: '/p', body: { names: ['a', 'b'] } } })).items).toEqual(['a', 'b'])
  })
})

describe('the packs install surface', () => {
  // Without the granting fetch, a phone's install is refused and the item waits for an unlock that cannot admit it.
  it('installs through the granting fetch: one confirmation, then the add is sent again with the grant', async () => {
    const { source, grant, api } = world()
    const send = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(refusal('plugin-packs/add')).mockResolvedValueOnce(Response.json({ ok: true, value: { packs: [], queue: [] } }))
    const added = createPacksClient(grantingFetch(send, grant, () => BASE)).enqueue({ names: ['@delorun/reports'] })
    const { sent } = await answer(source, api, 'faceId')
    await expect(added).resolves.toMatchObject({ ok: true })
    expect(sent).toMatchObject({ actions: [{ action: 'plugin-packs/add' }] })
    expect(new Headers(send.mock.calls[1]?.[1]?.headers).get(GRANT_HEADER)).toBe('g1')
  })
})

describe('the bundle\'s own Fetch surfaces', () => {
  // Each sends through the studio's granting fetch; the second answer is a refusal only the home's handler gives, so it proves the retry reached the route with the grant.
  const stale = (): Response => Response.json({ error: 'STALE_REVIEW', message: 'The review changed.' }, { status: 409 })
  const cases = [
    { name: 'full access', action: 'plugin-permission-defaults/set-full-access', title: 'Turn on full access for site', send: (fetch: HostFetch) => setFullAccess(fetch, { workspace: '/home/me/site', reviewId: 'r1' } as WorkspaceAccess, true) },
    { name: 'network', action: 'plugin-permission-defaults/network-set', title: 'Change network access', send: (fetch: HostFetch) => setNetwork(fetch, { path: '/home/me/site', network: { access: 'off', hosts: [] } as never }) },
    { name: 'MCP accept', action: 'plugin-mcp-consent/accept', title: 'Allow the MCP server “files”', send: (fetch: HostFetch) => acceptServer(fetch, { serverName: 'files', reviewId: 'r2' } as PendingServer) },
  ] as const
  for (const surface of cases) {
    it(`asks once and sends ${surface.name} again with the grant`, async () => {
      const { source, grant, api } = world()
      const send = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>().mockResolvedValueOnce(refusal(surface.action)).mockResolvedValueOnce(stale())
      const sent = surface.send(grantingFetch(send, grant, () => BASE))
      // Observed below; handled here so the rejection is not reported before the sheet is answered.
      sent.catch((_refused: unknown) => undefined)
      const { title } = await answer(source, api, 'faceId')
      await expect(sent).rejects.toMatchObject({ failure: { code: 'STALE_REVIEW' } })
      expect(title).toContain(surface.title)
      expect(new Headers(send.mock.calls[1]?.[1]?.headers).get(GRANT_HEADER)).toBe('g1')
      expect(send.mock.calls[1]?.[1]?.body).toBe(send.mock.calls[0]?.[1]?.body)
    })
  }
})

describe('the plugin\'s Face ID wiring', () => {
  async function wired(onComputer: boolean, refused = 'plugin-packs/add'): Promise<{ lifts: unknown[]; ctx: Context; studioFetch: HostFetch; fetch: ReturnType<typeof vi.fn>; source: FaceGrantSource }> {
    const ctx = new Context()
    const lifts: unknown[] = []
    ctx.provide('remote', { $liftDenials: (lift: unknown) => { lifts.push(lift); return () => {} } } as never)
    const fetch = vi.fn((_input: string, _init?: RequestInit) => Promise.resolve(refusal(refused)))
    let applied: ReturnType<typeof applyFaceGrant> | undefined
    await ctx.plugin({ apply: (scope: Context) => { applied = applyFaceGrant(scope, fetch, onComputer) } }).await()
    await new Promise(resolve => setTimeout(resolve, 0))
    if (applied === undefined) throw new Error('not applied')
    return { lifts, ctx, studioFetch: applied.fetch, fetch, source: applied.source }
  }

  // Asking on the computer would put a Face ID sheet in front of the owner for calls the home never refuses there.
  it('never asks on the home\'s own computer: no Remote lift, and the page\'s own fetch', async () => {
    const { lifts, ctx, studioFetch, fetch } = await wired(true)
    expect(lifts).toEqual([])
    expect(studioFetch).toBe(fetch)
    expect(ctx.get('delorunFaceGrant')?.fetch).toBe(fetch)
    await ctx.fiber.dispose()
  })

  // Providing the bare grant lets a Changes or Update tap end a sheet that is showing as cancelled (review P3-3).
  it('gives Changes and Update the queued confirmation, so theirs waits for a sheet that is showing', async () => {
    const { lifts, ctx, source } = await wired(false)
    const api = fakeApi({ devices: [{ deviceId: 'd', label: 'Phone', thisDevice: true, passkeys: [PASSKEY] }] })
    const lift = lifts[0] as ReturnType<typeof remoteDenialLift>
    const refused = lift({ endpoint: 'settings/update', reason: 'elevation-required: settings/update', args: { a: 1 }, signal: new AbortController().signal })
    await waitFor(() => { expect(source.hooks.pending.getSnapshot()).not.toBeNull() })
    const shown = source.hooks.pending.getSnapshot()
    const changes = ctx.get('delorunFaceGrant')?.grant({ action: 'changes/restart', call: { method: 'POST', path: '/api/changes/restart', body: {} } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(source.hooks.pending.getSnapshot()).toBe(shown)
    await answer(source, api, 'faceId')
    await expect(refused).resolves.toBe(true)
    const second = await answer(source, api, 'faceId')
    await expect(changes).resolves.toEqual(expect.any(String))
    expect(second.title).toContain('Restart Delorun')
    await ctx.fiber.dispose()
  })

  // Giving About and the footer report the page's own fetch leaves a phone's report details refused with no sheet (review r2 P3-4, r3 P3-1).
  it('registers About and the footer report with the granting fetch, so a refused report detail on a device opens the sheet', async () => {
    const { ctx, source } = await wired(false, 'bundle-local/report-details')
    const injected: (() => { readonly fetchImpl: HostFetch })[] = []
    ctx.provide('slots', {
      inject: (_name: string, register: () => () => void) => register(),
      register: (slot: { readonly inject: () => { readonly fetchImpl: HostFetch } }) => { injected.push(slot.inject); return () => {} },
    } as never)
    registerReportSlots(ctx, () => 'About', undefined)
    expect(injected).toHaveLength(2)
    for (const inject of injected) {
      const loading = loadReportDetails(inject().fetchImpl).catch((_refused: unknown) => undefined)
      await waitFor(() => { expect(source.hooks.pending.getSnapshot()?.request.action).toBe('bundle-local/report-details') })
      source.settle(undefined)
      await loading
    }
    await ctx.fiber.dispose()
  })

  // Without the registration a phone's refused Remote calls never reach the sheet.
  it('registers the Remote lift and the granting fetch on a device', async () => {
    const { lifts, ctx, studioFetch, fetch } = await wired(false)
    expect(lifts).toHaveLength(1)
    expect(studioFetch).not.toBe(fetch)
    expect(ctx.get('delorunFaceGrant')?.fetch).toBe(studioFetch)
    await ctx.fiber.dispose()
  })
})
