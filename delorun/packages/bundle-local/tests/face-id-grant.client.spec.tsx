// @vitest-environment jsdom
/**
 * The Face ID confirmation other plugins ask for through `ctx.delorunFaceGrant`: the store settles one request at a time, and
 * the overlay's sheet names the control and mints a grant hashed from exactly the call.
 *
 * Each test's comment names the behaviour whose removal makes it fail.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createFaceGrantSource } from '../src/client/face-grant.ts'
import { hashRequest } from '../src/client/face-id-hash.ts'
import { en } from '../src/client/face-id-locales.ts'
import { fakeApi, fakeBrowser } from '../src/client/face-id-fake.ts'
import { callActionOf, FaceIdGrantOverlay, type FaceIdGrantOverlayProps } from '../src/client/FaceIdGrantOverlay.tsx'
import type { PinView } from '../src/client/pin-lock.ts'
import { fakeHost } from './fake-host.ts'

const t = makeTranslate(en)
const call = { method: 'POST', path: '/delorun/changes/discard', body: { id: 'c1' } } as const
const request = { action: 'changes/plugin-discard', call }
const pinView = (phase: PinView['phase']): PinView => ({ phase, secret: 'pin', busy: false, outcome: undefined, paused: false, asked: false })

afterEach(cleanup)

describe('the Face ID grant store', () => {
  it('resolves the pending request with the grant, and with undefined on cancel', async () => {
    // The calling plugin sends only on a grant id; undefined must mean no send.
    const source = createFaceGrantSource()
    const granted = source.grant(request)
    expect(source.hooks.pending.getSnapshot()?.request).toEqual(request)
    source.settle('g1')
    await expect(granted).resolves.toBe('g1')
    expect(source.hooks.pending.getSnapshot()).toBeNull()
    const cancelled = source.grant(request)
    source.settle(undefined)
    await expect(cancelled).resolves.toBeUndefined()
  })
  it('ends the earlier request as cancelled when a second one arrives', async () => {
    // One sheet at a time; the earlier call must not hang or send.
    const source = createFaceGrantSource()
    const first = source.grant(request)
    void source.grant({ ...request, action: 'changes/restart' })
    await expect(first).resolves.toBeUndefined()
  })
})

describe('the Face ID grant overlay', () => {
  it('hashes the grant from exactly the call and names the control', async () => {
    // The home compares the grant's hash with the bytes it receives; the title says what the person confirms.
    const action = await callActionOf(t, request)
    expect(action.title).toBe('Discard this plugin change?')
    expect(action.grant).toEqual({ actions: [{ action: 'changes/plugin-discard', hash: await hashRequest(call) }] })
    expect((await callActionOf(t, { action: 'changes/unknown', call })).title).toBe('Confirm this change?')
  })
  it('shows the sheet for the pending request and settles with the grant id', async () => {
    // Confirm mints the grant and hands its id to the waiting call.
    const source = createFaceGrantSource()
    const api = fakeApi({ devices: [{ deviceId: 'd', label: 'Phone', thisDevice: true, passkeys: [] }] })
    const props = {
      t, fetch: fakeHost({}).fetch, api, browser: fakeBrowser(), settle: source.settle,
      usePending: <S,>(select: (pending: ReturnType<typeof source.hooks.pending.getSnapshot>) => S): S => select(source.hooks.pending.getSnapshot()),
      usePin: <S,>(select: (view: PinView) => S): S => select(pinView('unlocked')),
    } as FaceIdGrantOverlayProps
    const granted = source.grant(request)
    const view = render(<FaceIdGrantOverlay {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: /Confirm with/ }))
    await expect(granted).resolves.toBe('g1')
    expect(api.calls.find(entry => entry.name === 'options')?.request).toEqual({ actions: [{ action: 'changes/plugin-discard', hash: await hashRequest(call) }] })
    act(() => { view.rerender(<FaceIdGrantOverlay {...props} />) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('never shows the previous request\'s sheet for a new pending request', async () => {
    // The sheet is kept with the request it was built for; a frame of the old words under a new request would be confirmed by mistake.
    const source = createFaceGrantSource()
    const props = {
      t, fetch: fakeHost({}).fetch, api: fakeApi(), browser: fakeBrowser(), settle: source.settle,
      usePending: <S,>(select: (pending: ReturnType<typeof source.hooks.pending.getSnapshot>) => S): S => select(source.hooks.pending.getSnapshot()),
      usePin: <S,>(select: (view: PinView) => S): S => select(pinView('unlocked')),
    } as FaceIdGrantOverlayProps
    void source.grant(request)
    const view = render(<FaceIdGrantOverlay {...props} />)
    await screen.findByText('Discard this plugin change?')
    void source.grant({ action: 'changes/unknown', call })
    act(() => { view.rerender(<FaceIdGrantOverlay {...props} />) })
    expect(screen.queryByText('Discard this plugin change?')).toBeNull()
    expect(await screen.findByText('Confirm this change?')).toBeTruthy()
  })
})
