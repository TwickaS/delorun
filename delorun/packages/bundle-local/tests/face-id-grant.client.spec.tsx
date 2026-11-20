// @vitest-environment jsdom
/**
 * The Face ID confirmation other plugins ask for through `ctx.delorunFaceGrant`: the store settles one request at a time, and
 * the overlay's sheet names the control and mints a grant hashed from exactly the call.
 *
 * Each test's comment names the behaviour whose removal makes it fail.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSyncExternalStore, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createFaceGrantSource } from '../src/client/face-grant.ts'
import { hashArgs, hashRequest } from '../src/client/face-id-hash.ts'
import { oneAtATime, remoteDenialLift } from '../src/client/face-retry.ts'
import { en } from '../src/client/face-id-locales.ts'
import { fakeApi, fakeBrowser } from '../src/client/face-id-fake.ts'
import { callActionOf, FaceIdGrantOverlay, type FaceIdGrantOverlayProps } from '../src/client/FaceIdGrantOverlay.tsx'
import type { PinView } from '../src/client/pin-lock.ts'
import { fakeHost } from './fake-host.ts'

const t = makeTranslate(en)
const call = { method: 'POST', path: '/delorun/changes/discard', body: { id: 'c1' } } as const
const request = { action: 'changes/plugin-discard', call }
const pinView = (phase: PinView['phase']): PinView => ({ phase, secret: 'pin' })

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
    const api = fakeApi({ devices: [{ deviceId: 'd', label: 'Phone', thisDevice: true, passkeys: [{ credentialId: 'c1', createdAt: 0, lastUsedAt: null, synced: false }] }] })
    const props = {
      t, fetch: fakeHost({}).fetch, api, browser: fakeBrowser(), settle: source.settle,
      usePending: <S,>(select: (pending: ReturnType<typeof source.hooks.pending.getSnapshot>) => S): S => select(source.hooks.pending.getSnapshot()),
      usePin: <S,>(select: (view: PinView) => S): S => select(pinView('on')),
    } as FaceIdGrantOverlayProps
    const granted = source.grant(request)
    const view = render(<FaceIdGrantOverlay {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: /Confirm with/ }))
    await expect(granted).resolves.toBe('g1')
    expect(api.calls.find(entry => entry.name === 'options')?.request).toEqual({ actions: [{ action: 'changes/plugin-discard', hash: await hashRequest(call) }] })
    act(() => { view.rerender(<FaceIdGrantOverlay {...props} />) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  // Reverting the state read leaves `hasPasskey` fixed, so a phone with no passkey is shown a sheet it cannot answer, or no keypad.
  it('opens a phone with no passkey, or one whose state cannot be read, on the PIN keypad and mints the grant through the PIN route', async () => {
    for (const unreadable of [false, true]) {
      const source = createFaceGrantSource()
      const base = fakeApi({ devices: [{ deviceId: 'd', label: 'Phone', thisDevice: true, passkeys: [] }] })
      const api = unreadable ? Object.assign(base, { state: () => Promise.reject(new Error('state unreadable')) }) : base
      const props = {
        t, fetch: fakeHost({}).fetch, api, browser: fakeBrowser(), settle: source.settle,
        usePending: <S,>(select: (pending: ReturnType<typeof source.hooks.pending.getSnapshot>) => S): S => select(source.hooks.pending.getSnapshot()),
        usePin: <S,>(select: (view: PinView) => S): S => select({ ...pinView('on'), secret: 'passcode' }),
      } as FaceIdGrantOverlayProps
      const granted = source.grant(request)
      render(<FaceIdGrantOverlay {...props} />)
      expect(screen.queryByRole('button', { name: /Confirm with/ })).toBeNull()
      fireEvent.change(await screen.findByLabelText('Passcode'), { target: { value: 'correct horse' } })
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
      await expect(granted).resolves.toBe('g2')
      expect(api.calls.some(call => call.name === 'options')).toBe(false)
      expect(api.calls.find(call => call.name === 'pin')?.request).toMatchObject({ actions: [{ action: 'changes/plugin-discard' }], secret: 'correct horse' })
      cleanup()
    }
  })
  it('never shows the previous request\'s sheet for a new pending request', async () => {
    // The sheet is kept with the request it was built for; a frame of the old words under a new request would be confirmed by mistake.
    const source = createFaceGrantSource()
    const props = {
      t, fetch: fakeHost({}).fetch, api: fakeApi(), browser: fakeBrowser(), settle: source.settle,
      usePending: <S,>(select: (pending: ReturnType<typeof source.hooks.pending.getSnapshot>) => S): S => select(source.hooks.pending.getSnapshot()),
      usePin: <S,>(select: (view: PinView) => S): S => select(pinView('on')),
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

describe('the terminal path on a phone (owner report on the iPhone)', () => {
  const opened: HTMLDialogElement[] = []
  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { opened.push(this); this.setAttribute('open', '') } })
  })
  afterEach(() => { Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); opened.splice(0) })
  const create = { request: { id: 't-1', cols: 80, rows: 24 } }

  /** The open terminal panel with the overlay, and the refused `terminal/create` the gateway asks the lift about. */
  function refusedCreate() {
    const source = createFaceGrantSource()
    const api = fakeApi({ devices: [{ deviceId: 'd', label: 'Phone', thisDevice: true, passkeys: [{ credentialId: 'c1', createdAt: 0, lastUsedAt: null, synced: false }] }] })
    function Page(): ReactNode {
      const pending = useSyncExternalStore(source.hooks.pending.subscribe, source.hooks.pending.getSnapshot)
      const props = {
        t, fetch: fakeHost({}).fetch, api, browser: fakeBrowser(), settle: source.settle,
        usePending: <S,>(select: (value: typeof pending) => S): S => select(pending),
        usePin: <S,>(select: (view: PinView) => S): S => select(pinView('on')),
      } as FaceIdGrantOverlayProps
      return <>
        <section data-sidebar-terminal="" style={{ position: 'fixed', inset: 0, zIndex: 2147483647 }}><p role="status">Starting…</p></section>
        <FaceIdGrantOverlay {...props} />
      </>
    }
    render(<Page />)
    const abort = new AbortController()
    const lifted = remoteDenialLift(oneAtATime(source.grant))({ endpoint: 'terminal/create', reason: 'elevation-required: terminal/create', args: create, signal: abort.signal })
    return { api, abort, lifted }
  }

  it('opens the sheet as a modal dialog over the open panel, and a confirm sends terminal/create again for that terminal', async () => {
    const { api, lifted } = refusedCreate()
    const confirm = await screen.findByRole('button', { name: /Confirm with/ })
    expect(opened).toHaveLength(1)
    expect(opened[0]?.contains(confirm)).toBe(true)
    expect(screen.getByRole('status').textContent).toBe('Starting…')
    fireEvent.click(confirm)
    await expect(lifted).resolves.toBe(true)
    expect(api.calls.find(entry => entry.name === 'options')?.request).toEqual({ actions: [{ action: 'terminal/create', hash: await hashArgs(create), hold: { feature: 'terminal', id: 't-1' } }] })
    await waitFor(() => { expect(document.querySelector('[data-face-id-sheet]')).toBeNull() })
  })

  it('hands the refusal back on a cancel, so the panel can say the terminal did not start', async () => {
    const { api, lifted } = refusedCreate()
    fireEvent.click(await screen.findByRole('button', { name: en['sheet.cancel'] }))
    await expect(lifted).resolves.toBe(false)
    expect(api.calls.some(entry => entry.name === 'options' || entry.name === 'verify')).toBe(false)
  })

  it('closes the sheet and mints nothing when the panel that asked is closed while the sheet is open', async () => {
    // The terminal view aborts its creation when it leaves the DOM; the sheet must go with it.
    const { api, abort, lifted } = refusedCreate()
    await screen.findByRole('button', { name: /Confirm with/ })
    act(() => { abort.abort() })
    await expect(lifted).resolves.toBe(false)
    await waitFor(() => { expect(document.querySelector('[data-face-id-sheet]')).toBeNull() })
    expect(api.calls.some(entry => entry.name === 'options' || entry.name === 'verify')).toBe(false)
  })
})
