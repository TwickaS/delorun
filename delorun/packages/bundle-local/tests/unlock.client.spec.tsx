// @vitest-environment jsdom
/**
 * The place store and the Devices section's unlock blocks: the store tells a device from the home's own computer, a
 * device's section offers no unlock and says each sensitive action asks for Face ID or the PIN, and the computer's
 * section lists the unlock requests it approves, declines and ends.
 *
 * Each denial-relevant test's comment names the change whose return makes it fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import {
  approveElevation, DEVICE_ROUTES, ELEVATION_POLL_MS, ELEVATION_ROUTES, readElevation, readElevationsAtComputer, revokeElevation,
  type ElevationId, type ElevationRequestId,
} from '../src/client/devices-api.ts'
import { en } from '../src/client/devices-locales.ts'
import { clockTime, DevicesSection, ELEVATE_COMMAND, type DevicesSectionProps } from '../src/client/DevicesSection.tsx'
import { applyUnlock } from '../src/client/index.ts'
import { createUnlockSource, type UnlockSource, type UnlockView } from '../src/client/unlock.ts'
import { AWAY, fakeHost, staticPairing, staticUnlock, type Answer } from './fake-host.ts'

const NOW = Date.UTC(2026, 10, 12, 14, 0, 0)
const CODE = '12345678'
const PENDING = { kind: 'pending', requestId: 'request-1', code: CODE, expiresAt: NOW + 300_000 }
const ELEVATED = { kind: 'elevated', elevationId: 'elevation-1', endsAt: NOW + 900_000 }
const NONE = { kind: 'none' }
const ok = (body: unknown, status = 200): Answer => ({ status, body })
const refusal = (status: number, error: string): Answer => ({ status, body: { error, message: `${error} sentence` } })
const t = makeTranslate(en)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: NOW })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** Let timers up to `ms` from now run, and the answers they wait for settle, inside React's act. */
const settle = (ms = 0): Promise<void> => act(async () => {
  await vi.advanceTimersByTimeAsync(ms)
  for (let turn = 0; turn < 10; turn++) await vi.advanceTimersByTimeAsync(0)
})

describe('the unlock routes', () => {
  it('read, list, approve and revoke with the routes\' JSON', async () => {
    const host = fakeHost({
      [`GET ${ELEVATION_ROUTES.state}`]: ok(ELEVATED),
      [`GET ${ELEVATION_ROUTES.pending}`]: ok({ pending: [{ requestId: 'r', deviceId: 'd', requestedAt: NOW, expiresAt: NOW + 1 }], running: [] }),
      [`POST ${ELEVATION_ROUTES.approve}`]: ok({ id: 'e', deviceId: 'd', listener: 'reach-tailscale-private', sessionId: 's', startedAt: NOW, endsAt: NOW + 1 }),
      [`POST ${ELEVATION_ROUTES.revoke}`]: ok({ revoked: true }),
    })
    await expect(readElevation(host.fetch)).resolves.toEqual(ELEVATED)
    await expect(readElevationsAtComputer(host.fetch)).resolves.toMatchObject({ pending: [{ requestId: 'r' }], running: [] })
    await expect(approveElevation(host.fetch, 'r' as ElevationRequestId, CODE)).resolves.toMatchObject({ id: 'e' })
    await expect(revokeElevation(host.fetch, 'e' as ElevationId)).resolves.toBe(true)
    expect(host.received.filter(request => request.key.startsWith('POST')).map(request => request.body)).toEqual([{ requestId: 'r', typedCode: CODE }, { id: 'e' }])
  })

  it('read no device where no device unlocks, and refuse an answer that is not a state', async () => {
    await expect(readElevation(fakeHost({ [`GET ${ELEVATION_ROUTES.state}`]: refusal(421, 'HOST_MISMATCH') }).fetch)).resolves.toBeUndefined()
    await expect(readElevation(fakeHost().fetch)).resolves.toBeUndefined()
    await expect(readElevation(fakeHost({ [`GET ${ELEVATION_ROUTES.state}`]: refusal(401, 'NOT_SIGNED_IN') }).fetch)).rejects.toMatchObject({ failure: { code: 'NOT_SIGNED_IN' } })
    await expect(readElevation(fakeHost({ [`GET ${ELEVATION_ROUTES.state}` as const]: 'unreachable' as const }).fetch)).rejects.toMatchObject({ failure: { kind: 'unreachable' } })
    // A code that is not eight digits is not shown.
    for (const body of [{ ...PENDING, code: '1234' }, { kind: 'elevated', endsAt: 'later' }, { kind: 'other' }]) {
      await expect(readElevation(fakeHost({ [`GET ${ELEVATION_ROUTES.state}`]: ok(body) }).fetch)).rejects.toMatchObject({ failure: { kind: 'unreadable' } })
    }
  })
})

describe('the place store', () => {
  it('is away from the start on the computer and sends no request', async () => {
    const host = fakeHost({ [`GET ${ELEVATION_ROUTES.state}`]: refusal(421, 'HOST_MISMATCH') })
    const unlock = createUnlockSource(host.fetch, true)
    expect(unlock.hooks.unlock.getSnapshot()).toEqual({ place: 'away' })
    await unlock.refresh()
    expect(host.received).toEqual([])
  })

  it('is a device when the home answers its unlock state, and tells its subscribers once', async () => {
    const unlock = createUnlockSource(fakeHost({ [`GET ${ELEVATION_ROUTES.state}`]: ok(NONE) }).fetch)
    expect(unlock.hooks.unlock.getSnapshot().place).toBe('unknown')
    const listener = vi.fn()
    unlock.hooks.unlock.subscribe(listener)
    await unlock.refresh()
    await unlock.refresh()
    expect(unlock.hooks.unlock.getSnapshot().place).toBe('device')
    expect(listener).toHaveBeenCalledOnce()
  })

  it('is away where the home answers HOST_MISMATCH or has no route', async () => {
    const mismatch = createUnlockSource(fakeHost({ [`GET ${ELEVATION_ROUTES.state}`]: refusal(421, 'HOST_MISMATCH') }).fetch)
    await mismatch.refresh()
    expect(mismatch.hooks.unlock.getSnapshot().place).toBe('away')
    const absent = createUnlockSource(fakeHost().fetch)
    await absent.refresh()
    expect(absent.hooks.unlock.getSnapshot().place).toBe('away')
  })

  it('stays as it was when the read does not complete, and reads again later', async () => {
    const host = fakeHost({ [`GET ${ELEVATION_ROUTES.state}` as const]: 'unreachable' as const })
    const unlock = createUnlockSource(host.fetch)
    await unlock.refresh()
    expect(unlock.hooks.unlock.getSnapshot().place).toBe('unknown')
    host.script[`GET ${ELEVATION_ROUTES.state}`] = ok(NONE)
    await unlock.refresh()
    expect(unlock.hooks.unlock.getSnapshot().place).toBe('device')
  })
})

describe('the plugin\'s unlock', () => {
  it('registers no overlay and reads the place now and after each connection reset', async () => {
    const host = fakeHost({ [`GET ${ELEVATION_ROUTES.state}`]: ok(NONE) })
    vi.stubGlobal('fetch', host.fetch)
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots')
    if (slots === undefined) throw new Error('no slot registry')
    try {
      slots.register({ name: 'root', children: { 'shell.overlay': { kind: 'list', scope: 'root' } }, inject: () => ({}) }, ({ renderSlot }) => <>{renderSlot('shell.overlay', {})}</>)
      let unlock: UnlockSource | undefined
      await ctx.plugin({ inject: ['slots'], apply: (scope: Context) => { unlock = applyUnlock(scope, host.fetch) } }).await()
      // Pins the removal of the unlock dialog and its overlay: a device holds no unlock to ask for or to end.
      expect(slots.entries('shell.overlay')).toEqual([])
      await settle()
      expect(unlock?.hooks.unlock.getSnapshot().place).toBe('device')
      expect(host.count(`GET ${ELEVATION_ROUTES.state}`)).toBe(1)
      // A call refused for want of a grant is lifted by a Face ID or PIN grant, so it does not read the place again.
      act(() => { ctx.emit('remote/call-denied', { endpoint: 'terminal/create', reason: 'elevation-required: terminal/create' }) })
      await settle()
      ctx.emit('connection/reset')
      await settle()
      expect(host.count(`GET ${ELEVATION_ROUTES.state}`)).toBe(2)
    } finally {
      await ctx.fiber.dispose()
      vi.unstubAllGlobals()
    }
  })
})

/**
 * The Devices section with a fixed unlock view.
 * @param host - the fake home.
 * @param view - the unlock view.
 * @returns the render result.
 */
function renderSection(host: ReturnType<typeof fakeHost>, view: UnlockView = AWAY) {
  const unlock = staticUnlock(view)
  const props = { t, close: () => {}, fetch: host.fetch, ...unlock, ...staticPairing() } as DevicesSectionProps
  return render(<DevicesSection {...props} />)
}

const DEVICE = {
  id: 'a'.repeat(43), label: 'Pixel 9', platform: 'Android', address: 'https://home.example.ts.net',
  approvedAt: NOW - 86_400_000, approvedBy: 'local', lastSignInAt: NOW - 3_600_000,
}
const READY = ok({ available: true, hasOwner: true, options: [{ option: 'tailscale-private', state: 'ready', address: 'https://home.example.ts.net' }] })

/** The computer's home: one approved device and the scripted unlock list. */
function computerHost(list: unknown) {
  return fakeHost({
    [`GET ${DEVICE_ROUTES.reachStatus}`]: READY,
    [`GET ${DEVICE_ROUTES.devices}`]: ok({ owner: { claimedAt: NOW, firstDeviceId: DEVICE.id }, devices: [DEVICE] }),
    [`GET ${ELEVATION_ROUTES.pending}`]: ok(list),
    [`POST ${ELEVATION_ROUTES.approve}`]: ok({ id: 'e', deviceId: DEVICE.id, startedAt: NOW, endsAt: NOW + 900_000 }),
    [`POST ${ELEVATION_ROUTES.revoke}`]: ok({ revoked: true }),
  })
}

describe('the Devices section\'s unlock', () => {
  it('on a device, offers no Unlock, Show the code or Lock now and says each action asks for Face ID or the PIN', async () => {
    // The device list reads, so only the place keeps the computer's unlock requests off a device.
    const host = computerHost({ pending: [], running: [] })
    renderSection(host, { place: 'device' })
    await settle()
    // Pins the removal of the device's code unlock (A483): bringing back its buttons or its dialog opener fails this.
    expect(screen.getByText(en['unlock.section.faceId'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Show the code' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Lock now' })).toBeNull()
    expect(screen.queryByText(en['unlock.requests.title'])).toBeNull()
    expect(screen.queryByText(ELEVATE_COMMAND)).toBeNull()
    expect(host.count(`GET ${ELEVATION_ROUTES.pending}`)).toBe(0)
  })

  it('at the computer, shows the unlock requests and not the Face ID line', async () => {
    const host = computerHost({ pending: [], running: [] })
    renderSection(host)
    await settle()
    expect(screen.getByText(en['unlock.requests.title'])).toBeTruthy()
    expect(screen.queryByText(en['unlock.section.faceId'])).toBeNull()
  })

  it('at the computer, approves a request with the typed code, declines one and ends a running unlock', async () => {
    const host = computerHost({
      pending: [
        { requestId: 'request-1', deviceId: DEVICE.id, requestedAt: NOW - 10_000, expiresAt: NOW + 290_000 },
        { requestId: 'request-2', deviceId: 'removed', requestedAt: NOW - 5_000, expiresAt: NOW + 295_000 },
      ],
      running: [{ id: 'elevation-1', deviceId: DEVICE.id, startedAt: NOW, endsAt: ELEVATED.endsAt }],
    })
    renderSection(host)
    await settle()
    const first = document.querySelector('[data-elevation-request-id="request-1"]') as HTMLElement
    expect(within(first).getByText('Pixel 9')).toBeTruthy()
    expect(within(document.querySelector('[data-elevation-request-id="request-2"]') as HTMLElement).getByText(en['unlock.removedDevice'])).toBeTruthy()
    const approve = within(first).getByRole('button', { name: en['unlock.requests.approve'] }) as HTMLButtonElement
    expect(approve.disabled).toBe(true)
    fireEvent.change(within(first).getByRole('textbox', { name: t('unlock.requests.code', { label: 'Pixel 9' }) }), { target: { value: '1234 5678' } })
    fireEvent.click(approve)
    await settle()
    expect(host.received.find(request => request.key === `POST ${ELEVATION_ROUTES.approve}`)?.body).toEqual({ requestId: 'request-1', typedCode: CODE })
    fireEvent.click(within(document.querySelector('[data-elevation-request-id="request-2"]') as HTMLElement).getByRole('button', { name: en['unlock.requests.decline'] }))
    await settle()
    const running = document.querySelector('[data-elevation-id="elevation-1"]') as HTMLElement
    expect(running.textContent).toContain(t('unlock.running.until', { time: clockTime(t, ELEVATED.endsAt) }))
    fireEvent.click(within(running).getByRole('button', { name: en['unlock.running.end'] }))
    await settle()
    expect(host.received.filter(request => request.key === `POST ${ELEVATION_ROUTES.revoke}`).map(request => request.body)).toEqual([{ id: 'request-2' }, { id: 'elevation-1' }])
    expect(screen.getAllByText(ELEVATE_COMMAND).length).toBeGreaterThan(0)
  })

  it('at the computer, says a wrong code in place, keeps reading the list, and hides it without the routes', async () => {
    const host = computerHost({ pending: [{ requestId: 'request-1', deviceId: DEVICE.id, requestedAt: NOW, expiresAt: NOW + 300_000 }], running: [] })
    host.script[`POST ${ELEVATION_ROUTES.approve}`] = refusal(403, 'APPROVAL_CODE_MISMATCH')
    host.script[`POST ${ELEVATION_ROUTES.revoke}`] = 'unreachable'
    renderSection(host)
    await settle()
    const row = document.querySelector('[data-elevation-request-id="request-1"]') as HTMLElement
    fireEvent.change(within(row).getByRole('textbox'), { target: { value: '87654321' } })
    fireEvent.click(within(row).getByRole('button', { name: en['unlock.requests.approve'] }))
    await settle()
    expect(within(document.querySelector('[data-elevation-request-id="request-1"]') as HTMLElement).getByRole('alert').textContent).toBe('APPROVAL_CODE_MISMATCH sentence')
    fireEvent.click(within(document.querySelector('[data-elevation-request-id="request-1"]') as HTMLElement).getByRole('button', { name: en['unlock.requests.decline'] }))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe(en['failed.unreachable'])
    host.script[`GET ${ELEVATION_ROUTES.pending}`] = ok({ pending: [], running: [{ id: 'elevation-2', deviceId: DEVICE.id, startedAt: NOW, endsAt: ELEVATED.endsAt }] })
    host.script[`POST ${ELEVATION_ROUTES.revoke}`] = refusal(403, 'LOOPBACK_REQUIRED')
    const before = host.count(`GET ${ELEVATION_ROUTES.pending}`)
    await settle(ELEVATION_POLL_MS)
    expect(host.count(`GET ${ELEVATION_ROUTES.pending}`)).toBe(before + 1)
    fireEvent.click(screen.getByRole('button', { name: en['unlock.running.end'] }))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe(t('loopback', { action: en['action.unlockRevoke'] }))
    host.script[`GET ${ELEVATION_ROUTES.pending}`] = ok({ pending: [], running: [] })
    await settle(ELEVATION_POLL_MS)
    expect(screen.getByText(en['unlock.requests.none'])).toBeTruthy()
    host.script[`GET ${ELEVATION_ROUTES.pending}`] = 'unreachable'
    await settle(ELEVATION_POLL_MS)
    expect(screen.getByRole('alert').textContent).toBe(en['failed.unreachable'])
    cleanup()
    const absent = computerHost({})
    delete absent.script[`GET ${ELEVATION_ROUTES.pending}`]
    renderSection(absent)
    await settle(ELEVATION_POLL_MS)
    expect(screen.queryByText(en['unlock.requests.title'])).toBeNull()
    expect(absent.count(`GET ${ELEVATION_ROUTES.pending}`)).toBe(1)
  })

  it('shows no terminal switch and never asks the home for one: a device always needs an unlock for a terminal', async () => {
    const host = computerHost({ pending: [], running: [] })
    renderSection(host)
    await settle()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(host.received.filter(request => request.key.includes('/auth/elevation/terminal'))).toEqual([])
    expect(screen.queryByText(/without an unlock/i)).toBeNull()
  })
})
