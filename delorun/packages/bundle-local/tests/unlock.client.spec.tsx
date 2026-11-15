// @vitest-environment jsdom
/**
 * The remote studio's unlock: the unlock routes' requests, the store's states (asking, waiting with the code, unlocked,
 * and the honest outcomes: expired, declined, unreachable, the home's limit), the dialog and the banner it drives, the
 * plugin's wiring to `remote/call-denied` and `connection/reset`, and the Devices section's unlock blocks on a device
 * and at the computer.
 *
 * Each denial-relevant test's comment names the check whose removal makes it fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import {
  approveElevation, DEVICE_ROUTES, ELEVATED_POLL_MS, ELEVATION_POLL_MS, ELEVATION_ROUTES, lockElevation, readElevation,
  readElevationsAtComputer, requestElevation, revokeElevation, type ElevationId, type ElevationRequestId,
} from '../src/client/devices-api.ts'
import { en, zh } from '../src/client/devices-locales.ts'
import { DevicesSection, type DevicesSectionProps } from '../src/client/DevicesSection.tsx'
import { applyUnlock, UNLOCK_OVERLAY_ID } from '../src/client/index.ts'
import { createUnlockSource, type UnlockSource, type UnlockView } from '../src/client/unlock.ts'
import { clockTime, ELEVATE_COMMAND, groupedCode, UnlockOverlay } from '../src/client/UnlockOverlay.tsx'
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

/**
 * A device's home: its unlock state answers `state`, a request answers the pending state.
 * @param state - the state `GET /auth/elevation` answers first.
 * @returns the fake home.
 */
function deviceHost(state: unknown = NONE) {
  return fakeHost({
    [`GET ${ELEVATION_ROUTES.state}`]: ok(state),
    [`POST ${ELEVATION_ROUTES.request}`]: ok(PENDING, 201),
    [`POST ${ELEVATION_ROUTES.lock}`]: ok(NONE),
  })
}

/**
 * Render the overlay over a store.
 * @param unlock - the store.
 * @returns the render result.
 */
function renderOverlay(unlock: UnlockSource, translate = t) {
  return render(<UnlockOverlay t={translate} useUnlock={bindSnapshotSelector(unlock.hooks.unlock)} request={unlock.request}
    cancel={unlock.cancel} lock={unlock.lock} dismissEnded={unlock.dismissEnded} />)
}

describe('the unlock routes', () => {
  it('read, ask, lock, list, approve and revoke with the routes\' JSON', async () => {
    const host = fakeHost({
      [`GET ${ELEVATION_ROUTES.state}`]: ok(ELEVATED),
      [`POST ${ELEVATION_ROUTES.request}`]: ok(PENDING, 201),
      [`POST ${ELEVATION_ROUTES.lock}`]: ok(NONE),
      [`GET ${ELEVATION_ROUTES.pending}`]: ok({ pending: [{ requestId: 'r', deviceId: 'd', requestedAt: NOW, expiresAt: NOW + 1 }], running: [] }),
      [`POST ${ELEVATION_ROUTES.approve}`]: ok({ id: 'e', deviceId: 'd', listener: 'reach-tailscale-private', sessionId: 's', startedAt: NOW, endsAt: NOW + 1 }),
      [`POST ${ELEVATION_ROUTES.revoke}`]: ok({ revoked: true }),
    })
    await expect(readElevation(host.fetch)).resolves.toEqual(ELEVATED)
    await expect(requestElevation(host.fetch)).resolves.toEqual(PENDING)
    await expect(lockElevation(host.fetch)).resolves.toEqual(NONE)
    await expect(readElevationsAtComputer(host.fetch)).resolves.toMatchObject({ pending: [{ requestId: 'r' }], running: [] })
    await expect(approveElevation(host.fetch, 'r' as ElevationRequestId, CODE)).resolves.toMatchObject({ id: 'e' })
    await expect(revokeElevation(host.fetch, 'e' as ElevationId)).resolves.toBe(true)
    expect(host.received.filter(request => request.key.startsWith('POST')).map(request => request.body)).toEqual([{}, {}, { requestId: 'r', typedCode: CODE }, { id: 'e' }])
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

describe('the unlock store', () => {
  it('is away from the start on the computer and sends no request', async () => {
    const host = fakeHost({ [`GET ${ELEVATION_ROUTES.state}`]: refusal(421, 'HOST_MISMATCH') })
    const unlock = createUnlockSource(host.fetch, Date.now, true)
    expect(unlock.hooks.unlock.getSnapshot()).toMatchObject({ place: 'away', dialog: null })
    await unlock.refresh()
    unlock.refused('elevation-required: terminal/create')
    unlock.open()
    await settle()
    expect(unlock.hooks.unlock.getSnapshot()).toMatchObject({ place: 'away', dialog: null })
    expect(host.count(`GET ${ELEVATION_ROUTES.state}`)).toBe(0)
  })

  it('stays away on the computer, where a refusal opens nothing', async () => {
    const unlock = createUnlockSource(fakeHost({ [`GET ${ELEVATION_ROUTES.state}`]: refusal(421, 'HOST_MISMATCH') }).fetch)
    await unlock.refresh()
    unlock.refused('elevation-required: terminal/create')
    unlock.open()
    await settle()
    expect(unlock.hooks.unlock.getSnapshot()).toMatchObject({ place: 'away', dialog: null })
  })

  it('opens the dialog only for a refusal that needs an unlock', async () => {
    const unlock = createUnlockSource(deviceHost().fetch)
    await unlock.refresh()
    // Pins the prefix check: a refusal the computer keeps is no request to unlock.
    for (const reason of [undefined, 'loopback-required: credentials/set', 'resource-unlisted: session/cancel']) unlock.refused(reason)
    expect(unlock.hooks.unlock.getSnapshot().dialog).toBeNull()
    unlock.refused('elevation-required: terminal/create')
    expect(unlock.hooks.unlock.getSnapshot().dialog).toEqual({ action: 'terminal/create', busy: false, outcome: undefined })
    unlock.refused('elevation-required:')
    expect(unlock.hooks.unlock.getSnapshot().dialog).toMatchObject({ action: undefined })
    unlock.dispose()
  })

  it('asks, waits with the code, and closes once the computer approves', async () => {
    const host = deviceHost()
    const unlock = createUnlockSource(host.fetch)
    await unlock.refresh()
    unlock.open()
    await unlock.request()
    expect(unlock.hooks.unlock.getSnapshot()).toMatchObject({ state: PENDING, dialog: { busy: false, outcome: undefined } })
    host.script[`GET ${ELEVATION_ROUTES.state}`] = ok(ELEVATED)
    await settle(ELEVATION_POLL_MS)
    expect(unlock.hooks.unlock.getSnapshot()).toMatchObject({ state: ELEVATED, dialog: null })
    unlock.dispose()
  })

  it('tells a declined request from an expired one, and an unreachable computer from both', async () => {
    const host = deviceHost()
    const unlock = createUnlockSource(host.fetch)
    await unlock.refresh()
    unlock.open()
    await unlock.request()
    host.script[`GET ${ELEVATION_ROUTES.state}`] = 'unreachable'
    await settle(ELEVATION_POLL_MS)
    expect(unlock.hooks.unlock.getSnapshot()).toMatchObject({ state: PENDING, dialog: { outcome: 'unreachable' } })
    host.script[`GET ${ELEVATION_ROUTES.state}`] = ok(PENDING)
    await settle(ELEVATION_POLL_MS)
    expect(unlock.hooks.unlock.getSnapshot().dialog).toMatchObject({ outcome: undefined })
    // Gone before its expiry: the computer declined it or it was cancelled there.
    host.script[`GET ${ELEVATION_ROUTES.state}`] = ok(NONE)
    await settle(ELEVATION_POLL_MS)
    expect(unlock.hooks.unlock.getSnapshot()).toMatchObject({ state: NONE, dialog: { outcome: 'declined' } })
    // Asked again and left until its expiry.
    host.script[`GET ${ELEVATION_ROUTES.state}`] = ok(PENDING)
    await unlock.request()
    await settle(PENDING.expiresAt - Date.now() - 1)
    host.script[`GET ${ELEVATION_ROUTES.state}`] = ok(NONE)
    await settle(ELEVATION_POLL_MS)
    expect(unlock.hooks.unlock.getSnapshot()).toMatchObject({ state: NONE, dialog: { outcome: 'expired' } })
    unlock.dispose()
  })

  it('discards a read that started before the device asked, which would otherwise call the new request declined', async () => {
    const host = deviceHost()
    const unlock = createUnlockSource(host.fetch)
    await unlock.refresh()
    // Pins the change count in refresh: the read answers `none` only after the request answered `pending`.
    let answer = (_value: { status: number; body: unknown }): void => {}
    host.script[`GET ${ELEVATION_ROUTES.state}`] = new Promise(resolve => { answer = resolve })
    const late = unlock.refresh()
    await unlock.request()
    answer({ status: 200, body: NONE })
    await late
    expect(unlock.hooks.unlock.getSnapshot().state).toEqual(PENDING)
    let fail = (_reason: Error): void => {}
    host.script[`GET ${ELEVATION_ROUTES.state}`] = new Promise((_resolve, reject) => { fail = reject })
    const failing = unlock.refresh()
    await unlock.lock()
    fail(new TypeError('Failed to fetch'))
    await failing
    expect(unlock.hooks.unlock.getSnapshot().state).toEqual(NONE)
    unlock.dispose()
  })

  it('says when the home holds its limit, when the computer is unreachable and when the request fails', async () => {
    const host = deviceHost()
    const unlock = createUnlockSource(host.fetch)
    await unlock.refresh()
    unlock.open()
    for (const [answer, outcome] of [[refusal(429, 'APPROVAL_PENDING_LIMIT'), 'limit'], ['unreachable', 'unreachable'], [refusal(403, 'ORIGIN_MISMATCH'), 'failed']] as const) {
      host.script[`POST ${ELEVATION_ROUTES.request}`] = answer
      await unlock.request()
      expect(unlock.hooks.unlock.getSnapshot().dialog).toEqual({ action: undefined, busy: false, outcome })
    }
    unlock.dispose()
  })

  it('withdraws a waiting request on cancel, even when the computer does not answer', async () => {
    const host = deviceHost()
    const unlock = createUnlockSource(host.fetch)
    await unlock.refresh()
    unlock.open()
    await unlock.request()
    await unlock.cancel()
    expect(unlock.hooks.unlock.getSnapshot()).toMatchObject({ state: NONE, dialog: null })
    expect(host.count(`POST ${ELEVATION_ROUTES.lock}`)).toBe(1)
    unlock.open()
    await unlock.request()
    host.script[`POST ${ELEVATION_ROUTES.lock}`] = 'unreachable'
    await unlock.cancel()
    expect(unlock.hooks.unlock.getSnapshot()).toMatchObject({ state: NONE, dialog: null })
    // With nothing waiting, cancel only closes the dialog.
    unlock.open()
    await unlock.cancel()
    expect(host.count(`POST ${ELEVATION_ROUTES.lock}`)).toBe(2)
    unlock.dispose()
  })

  it('locks from the device, says when the lock did not reach the computer, and notices an unlock ended elsewhere', async () => {
    const host = deviceHost(ELEVATED)
    const unlock = createUnlockSource(host.fetch)
    await unlock.refresh()
    expect(unlock.hooks.unlock.getSnapshot()).toMatchObject({ place: 'device', state: ELEVATED })
    host.script[`POST ${ELEVATION_ROUTES.lock}`] = 'unreachable'
    await unlock.lock()
    expect(unlock.hooks.unlock.getSnapshot()).toMatchObject({ state: ELEVATED, lockFailed: true })
    host.script[`POST ${ELEVATION_ROUTES.lock}`] = ok(NONE)
    await unlock.lock()
    expect(unlock.hooks.unlock.getSnapshot()).toMatchObject({ state: NONE, ended: 1, lockFailed: false })
    unlock.dismissEnded()
    expect(unlock.hooks.unlock.getSnapshot().ended).toBe(0)
    // An unlock the computer ends shows up at the next read.
    host.script[`GET ${ELEVATION_ROUTES.state}`] = ok(ELEVATED)
    await unlock.refresh()
    host.script[`GET ${ELEVATION_ROUTES.state}`] = ok(NONE)
    await settle(ELEVATED_POLL_MS)
    expect(unlock.hooks.unlock.getSnapshot()).toMatchObject({ state: NONE, ended: 2 })
    // A read that fails while unlocked keeps the state and tries again.
    host.script[`GET ${ELEVATION_ROUTES.state}`] = ok(ELEVATED)
    await unlock.refresh()
    host.script[`GET ${ELEVATION_ROUTES.state}`] = refusal(401, 'SESSION_EXPIRED')
    await settle(ELEVATED_POLL_MS)
    expect(unlock.hooks.unlock.getSnapshot().state).toEqual(ELEVATED)
    unlock.dispose()
    await settle(ELEVATED_POLL_MS)
  })

  it('keeps reading while unlocked when Lock now fails during a read', async () => {
    const host = deviceHost(ELEVATED)
    const unlock = createUnlockSource(host.fetch)
    await unlock.refresh()
    // Pins the schedule after a failed lock: the overtaken read is discarded and must not end the polling.
    let answer = (_value: { status: number; body: unknown }): void => {}
    host.script[`GET ${ELEVATION_ROUTES.state}`] = new Promise(resolve => { answer = resolve })
    // The timer's own read is on its way, so no timer is armed while it waits.
    await settle(ELEVATED_POLL_MS)
    host.script[`POST ${ELEVATION_ROUTES.lock}`] = 'unreachable'
    await unlock.lock()
    answer({ status: 200, body: ELEVATED })
    await settle()
    host.script[`GET ${ELEVATION_ROUTES.state}`] = ok(NONE)
    const before = host.count(`GET ${ELEVATION_ROUTES.state}`)
    await settle(ELEVATED_POLL_MS)
    expect(host.count(`GET ${ELEVATION_ROUTES.state}`)).toBe(before + 1)
    expect(unlock.hooks.unlock.getSnapshot().state).toEqual(NONE)
    unlock.dispose()
  })

  it('arms no read when a request answers after the plugin unloaded', async () => {
    const host = deviceHost()
    let answer = (_value: { status: number; body: unknown }): void => {}
    host.script[`POST ${ELEVATION_ROUTES.request}`] = new Promise(resolve => { answer = resolve })
    const unlock = createUnlockSource(host.fetch)
    await unlock.refresh()
    const asking = unlock.request()
    unlock.dispose()
    answer({ status: 201, body: PENDING })
    await asking
    await settle(ELEVATION_POLL_MS)
    expect(host.count(`GET ${ELEVATION_ROUTES.state}`)).toBe(1)
  })

  it('reads nothing more once disposed', async () => {
    const host = deviceHost(PENDING)
    const unlock = createUnlockSource(host.fetch)
    const reading = unlock.refresh()
    unlock.dispose()
    await reading
    expect(unlock.hooks.unlock.getSnapshot().place).toBe('unknown')
    const failing = createUnlockSource(fakeHost({ [`GET ${ELEVATION_ROUTES.state}` as const]: 'unreachable' as const }).fetch)
    const failed = failing.refresh()
    failing.dispose()
    await failed
    await settle(ELEVATED_POLL_MS)
    expect(host.count(`GET ${ELEVATION_ROUTES.state}`)).toBe(1)
  })
})

describe('the unlock dialog and banner', () => {
  it('asks with friendly words and never the raw refusal, then shows the code and where to type it', async () => {
    const host = deviceHost()
    const unlock = createUnlockSource(host.fetch)
    await unlock.refresh()
    renderOverlay(unlock)
    act(() => { unlock.refused('elevation-required: terminal/create') })
    const dialog = screen.getByRole('dialog', { name: en['unlock.title'] })
    expect(dialog.textContent).toContain(en['unlock.needed'])
    expect(dialog.textContent).not.toContain('elevation-required')
    expect(dialog.textContent).not.toContain('terminal/create')
    fireEvent.click(within(dialog).getByRole('button', { name: en['unlock.start'] }))
    await settle()
    const code = screen.getByText(groupedCode(CODE))
    expect(code.getAttribute('aria-label')).toBe('1 2 3 4 5 6 7 8')
    expect(document.activeElement).toBe(code)
    expect(screen.getByRole('dialog').textContent).toContain(ELEVATE_COMMAND)
    expect(screen.getByRole('status').textContent).toBe(t('unlock.waiting', { time: clockTime(t, PENDING.expiresAt) }))
    host.script[`GET ${ELEVATION_ROUTES.state}`] = 'unreachable'
    await settle(ELEVATION_POLL_MS)
    expect(screen.getByRole('status').textContent).toBe(en['unlock.unreachable'])
    fireEvent.click(screen.getByRole('button', { name: en['unlock.cancel'] }))
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    unlock.dispose()
  })

  it('shows an outcome with Try again, and closes with Not now', async () => {
    const host = deviceHost()
    host.script[`POST ${ELEVATION_ROUTES.request}`] = refusal(429, 'APPROVAL_PENDING_LIMIT')
    const unlock = createUnlockSource(host.fetch)
    await unlock.refresh()
    renderOverlay(unlock)
    act(() => { unlock.open() })
    expect(screen.getByRole('dialog').textContent).not.toContain(en['unlock.needed'])
    fireEvent.click(screen.getByRole('button', { name: en['unlock.start'] }))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe(en['unlock.limit'])
    fireEvent.click(screen.getByRole('button', { name: en['unlock.retry'] }))
    await settle()
    // The footer's Close, after the header's close button of the same name.
    fireEvent.click(screen.getAllByRole('button', { name: en['unlock.close'] }).at(-1) as HTMLElement)
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => { unlock.open() })
    fireEvent.click(screen.getByRole('button', { name: en['unlock.notNow'] }))
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    unlock.dispose()
  })

  it('keeps the dialog open while the request is on its way', async () => {
    const host = deviceHost()
    let answer = (_value: { status: number; body: unknown }): void => {}
    host.script[`POST ${ELEVATION_ROUTES.request}`] = new Promise(resolve => { answer = resolve })
    const unlock = createUnlockSource(host.fetch)
    await unlock.refresh()
    renderOverlay(unlock)
    act(() => { unlock.open() })
    fireEvent.click(screen.getByRole('button', { name: en['unlock.start'] }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await settle()
    expect(screen.getByRole('dialog')).toBeTruthy()
    answer({ status: 201, body: PENDING })
    await settle()
    expect(screen.getByText(groupedCode(CODE))).toBeTruthy()
    unlock.dispose()
  })

  it('shows the banner while unlocked, locks from it, and says once that sensitive actions are locked again', async () => {
    const host = deviceHost(ELEVATED)
    const unlock = createUnlockSource(host.fetch)
    await unlock.refresh()
    renderOverlay(unlock)
    const banner = screen.getByRole('status')
    expect(banner.textContent).toContain(t('unlock.banner', { time: clockTime(t, ELEVATED.endsAt) }))
    expect(banner.getAttribute('aria-live')).toBe('polite')
    host.script[`POST ${ELEVATION_ROUTES.lock}`] = 'unreachable'
    fireEvent.click(within(banner).getByRole('button', { name: en['unlock.lockNow'] }))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe(en['unlock.lockFailed'])
    host.script[`POST ${ELEVATION_ROUTES.lock}`] = ok(NONE)
    fireEvent.click(screen.getByRole('button', { name: en['unlock.lockNow'] }))
    await settle()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText(en['unlock.ended'])).toBeTruthy()
    await settle(60_000)
    expect(screen.queryByText(en['unlock.ended'])).toBeNull()
    expect(unlock.hooks.unlock.getSnapshot().ended).toBe(0)
    unlock.dispose()
  })

  it('names the end time in Chinese too', () => {
    const zht = makeTranslate(zh)
    expect(zht('unlock.banner', { time: clockTime(zht, NOW) })).toMatch(/^敏感操作已解锁，至 \d{2}:\d{2}$/)
    expect(zht('unlock.needed')).toBe('这需要先在你的电脑上快速解锁。')
  })
})

describe('the plugin\'s unlock', () => {
  it('opens the dialog on a call refused for an unlock, and reads again after the connection resets', async () => {
    const host = deviceHost()
    vi.stubGlobal('fetch', host.fetch)
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots')
    if (slots === undefined) throw new Error('no slot registry')
    try {
      slots.register({ name: 'root', children: { 'shell.overlay': { kind: 'list', scope: 'root' } }, inject: () => ({}) }, ({ renderSlot }) => <>{renderSlot('shell.overlay', {})}</>)
      let unlock: UnlockSource | undefined
      await ctx.plugin({ inject: ['slots'], apply: (scope: Context) => { unlock = applyUnlock(scope, host.fetch) } }).await()
      const [overlay] = slots.entries('shell.overlay')
      expect(overlay?.options).toMatchObject({ id: UNLOCK_OVERLAY_ID })
      expect(overlay?.inject?.()).toMatchObject({ hooks: unlock?.hooks })
      await settle()
      expect(host.count(`GET ${ELEVATION_ROUTES.state}`)).toBe(1)
      // Pins the wiring: upstream reports the refusal, and the store turns it into the request to unlock.
      act(() => { ctx.emit('remote/call-denied', { endpoint: 'terminal/create', reason: 'elevation-required: terminal/create' }) })
      expect(unlock?.hooks.unlock.getSnapshot().dialog).toMatchObject({ action: 'terminal/create' })
      await settle()
      ctx.emit('connection/reset')
      await settle()
      expect(host.count(`GET ${ELEVATION_ROUTES.state}`)).toBe(3)
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
 * @returns the render result and the action spies.
 */
function renderSection(host: ReturnType<typeof fakeHost>, view: UnlockView = AWAY) {
  const unlock = staticUnlock(view)
  const props = { t, close: () => {}, fetch: host.fetch, ...unlock, ...staticPairing() } as DevicesSectionProps
  return { ...render(<DevicesSection {...props} />), ...unlock }
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
  it('on a device, offers Unlock, shows the waiting code, and locks a running unlock', async () => {
    const host = fakeHost({ [`GET ${DEVICE_ROUTES.reachStatus}`]: READY, [`GET ${DEVICE_ROUTES.devices}`]: refusal(403, 'LOOPBACK_REQUIRED') })
    const device = (state: UnlockView['state']): UnlockView => ({ ...AWAY, place: 'device', state })
    const none = renderSection(host, device({ kind: 'none' }))
    await settle()
    expect(screen.getByText(en['unlock.section.locked'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['unlock.start'] }))
    expect(none.openUnlock).toHaveBeenCalledOnce()
    cleanup()
    const pending = renderSection(host, device(PENDING as UnlockView['state']))
    await settle()
    expect(screen.getByText(en['unlock.section.pending'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['unlock.section.show'] }))
    expect(pending.openUnlock).toHaveBeenCalledOnce()
    cleanup()
    const elevated = renderSection(host, device(ELEVATED as UnlockView['state']))
    await settle()
    expect(screen.getByText(t('unlock.section.unlocked', { time: clockTime(t, ELEVATED.endsAt) }))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['unlock.lockNow'] }))
    expect(elevated.lockUnlock).toHaveBeenCalledOnce()
    // The computer's list is never read on a device, whose device list is refused.
    expect(host.count(`GET ${ELEVATION_ROUTES.pending}`)).toBe(0)
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
    expect(screen.queryByText(en['unlock.section.title'])).toBeNull()
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
