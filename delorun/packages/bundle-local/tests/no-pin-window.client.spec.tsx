// @vitest-environment jsdom
/**
 * A device holds no PIN window (A483): with PIN mode on, nothing in the studio opens a PIN lock screen or posts
 * `/auth/pin/unlock`. The PIN is typed only into the Face ID grant sheet, which posts `/auth/passkey/pin`.
 *
 * Each test's comment names the change whose return makes it fail.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createFaceGrantSource } from '../src/client/face-grant.ts'
import { PASSKEY_ROUTES, httpPasskeyApi } from '../src/client/face-id-api.ts'
import { fakeBrowser } from '../src/client/face-id-fake.ts'
import { en } from '../src/client/face-id-locales.ts'
import { FaceIdGrantOverlay, type FaceIdGrantOverlayProps } from '../src/client/FaceIdGrantOverlay.tsx'
import { applyPin, applyUnlock } from '../src/client/index.ts'
import { createPinSource } from '../src/client/pin-lock.ts'
import { createUnlockSource } from '../src/client/unlock.ts'
import { ELEVATION_ROUTES } from '../src/client/devices-api.ts'
import { fakeHost, type Answer } from './fake-host.ts'

const t = makeTranslate(en)
const ok = (body: unknown, status = 200): Answer => ({ status, body })
const PIN_ON = ok({ kind: 'on', secret: 'passcode', idleMinutes: 15, paused: false })
const UNLOCK_CALL = 'POST /auth/pin/unlock'
const call = { method: 'POST', path: '/delorun/changes/discard', body: { id: 'c1' } } as const

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** A device's home with PIN mode on, no passkey enrolled, and every route a grant or an unlock request uses. */
function deviceHome() {
  return fakeHost({
    'GET /auth/pin/state': PIN_ON,
    [`GET ${ELEVATION_ROUTES.state}`]: ok({ kind: 'none' }),
    [`POST ${ELEVATION_ROUTES.request}`]: ok({ kind: 'pending', requestId: 'request-1', code: '12345678', expiresAt: Date.now() + 300_000 }, 201),
    [`GET ${PASSKEY_ROUTES.state}`]: ok({ passkeys: [], ticket: false }),
    [`POST ${PASSKEY_ROUTES.pin}`]: ok({ grantId: 'g1', expiresAt: Date.now() + 60_000 }),
  })
}

describe('a device with PIN mode on', () => {
  // Returning a request or dialog to the unlock store lets a device open the code dialog or post the PIN unlock.
  it('tells a device from the computer and never posts the PIN unlock', async () => {
    const host = deviceHome()
    const pin = createPinSource(host.fetch)
    const unlock = createUnlockSource(host.fetch)
    await act(async () => { await Promise.all([pin.refresh(), unlock.refresh()]) })
    expect(pin.hooks.pin.getSnapshot()).toEqual({ phase: 'on', secret: 'passcode' })
    expect(unlock.hooks.unlock.getSnapshot()).toEqual({ place: 'device' })
    expect(host.count(UNLOCK_CALL)).toBe(0)
    pin.dispose()
  })

  // Reverting the `shell.overlay` entry of `applyPin` returns the lock screen over the studio.
  it('registers no PIN lock overlay and no unlock overlay, and renders no lock screen', async () => {
    const host = deviceHome()
    vi.stubGlobal('fetch', host.fetch)
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots')
    if (slots === undefined) throw new Error('no slot registry')
    try {
      slots.register({ name: 'root', children: { 'shell.overlay': { kind: 'list', scope: 'root' } }, inject: () => ({}) }, ({ renderSlot }) => <>{renderSlot('shell.overlay', {})}</>)
      await ctx.plugin({
        inject: ['slots'],
        apply: (scope: Context) => {
          applyPin(scope, host.fetch)
          applyUnlock(scope, host.fetch)
        },
      }).await()
      expect(slots.entries('shell.overlay')).toEqual([])
      await act(async () => { await Promise.resolve() })
      expect(document.querySelector('[data-pin-lock]')).toBeNull()
      expect(host.count(UNLOCK_CALL)).toBe(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  // Reverting the Face ID sheet's PIN keypad to the unlock route (or adding a page unlock after it) puts `/auth/pin/unlock` in the log.
  it('confirms a refused action through the grant sheet keypad on /auth/passkey/pin, with no PIN unlock call', async () => {
    const host = deviceHome()
    const pin = createPinSource(host.fetch)
    await act(async () => { await pin.refresh() })
    const source = createFaceGrantSource()
    const props = {
      t, fetch: host.fetch, api: httpPasskeyApi(host.fetch), browser: fakeBrowser(), settle: source.settle,
      usePending: <S,>(select: (pending: ReturnType<typeof source.hooks.pending.getSnapshot>) => S): S => select(source.hooks.pending.getSnapshot()),
      usePin: bindSnapshotSelector(pin.hooks.pin),
    } as FaceIdGrantOverlayProps
    const granted = source.grant({ action: 'changes/plugin-discard', call })
    render(<FaceIdGrantOverlay {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm with PIN' }))
    fireEvent.change(await screen.findByLabelText('Passcode'), { target: { value: 'correct horse' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await expect(granted).resolves.toBe('g1')
    expect(host.count(`POST ${PASSKEY_ROUTES.pin}`)).toBe(1)
    expect(host.received.some(request => String(request.key).includes('/auth/pin/unlock'))).toBe(false)
    pin.dispose()
  })
})
