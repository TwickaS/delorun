// @vitest-environment jsdom
/**
 * PIN mode's lock screen on a device: the routes' requests, the store's phases and outcomes, the lock triggers (Lock,
 * idle, hidden page, restored page, closing page, `401 UNLOCK_INVALID`), the touch throttle, and the screen's keypad.
 *
 * Each test's comment names the behaviour whose removal makes it fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { currentUnlockToken, setUnlockToken } from '../src/client/page-unlock-token.ts'
import { PIN_ROUTES, UNLOCK_HEADER, pinMissOf } from '../src/client/pin-api.ts'
import { en } from '../src/client/pin-locales.ts'
import { createPinSource, TOUCH_INTERVAL_MS, type PinSource } from '../src/client/pin-lock.ts'
import { attachPinTriggers } from '../src/client/pin-triggers.ts'
import { PinLock } from '../src/client/PinLock.tsx'
import { ELEVATION_ROUTES } from '../src/client/devices-api.ts'
import { applyPin, applyUnlock, PIN_LOCK_OVERLAY_ID, UNLOCK_OVERLAY_ID } from '../src/client/index.ts'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { GateFailure } from '../src/client/GateNotice.tsx'
import { HostRequestError } from '../src/client/host-api.ts'
import { installGateUnlock, noteUnlockedAction } from '../src/client/gate-unlock.ts'
import { createUnlockSource, type UnlockView } from '../src/client/unlock.ts'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { fakeHost, type Answer } from './fake-host.ts'

/**
 * Show the lock screen as an action that needs the unlock does: ask for it, then render it.
 * @param source - the lock's store.
 * @returns the render result.
 */
function renderLock(source: PinSource) {
  source.ask()
  return render(<PinLock t={t} usePin={bindSnapshotSelector(source.hooks.pin)} unlock={source.unlock} dismiss={source.dismiss} />)
}

const NOW = Date.UTC(2026, 10, 14, 9, 0, 0)
const IDLE = 15 * 60_000
const TOKEN = 'page-token-secret-value'
const ok = (body: unknown, status = 200): Answer => ({ status, body })
const refusal = (status: number, error: string, message = `${error} sentence`, fields: object = {}): Answer => ({ status, body: { error, message, ...fields } })
const t = makeTranslate(en)
const stateOn = (extra: object = {}): Answer => ok({ kind: 'on', secret: 'pin', idleMinutes: 15, paused: false, unlock: null, ...extra })
const unlockedState = (extra: object = {}): Answer => stateOn({ unlock: { unlockId: 'u1', endsAt: NOW + 12 * 3_600_000, idleEndsAt: NOW + IDLE }, ...extra })
const unlockedAnswer = ok({ token: TOKEN, unlockId: 'u1', endsAt: NOW + 12 * 3_600_000, idleEndsAt: NOW + IDLE })
const key = (route: string, method: 'GET' | 'POST' = 'POST') => `${method} ${route}` as const

let sources: PinSource[] = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: NOW })
  setUnlockToken(null)
})

afterEach(() => {
  for (const source of sources) source.dispose()
  sources = []
  cleanup()
  setUnlockToken(null)
  vi.useRealTimers()
})

const settle = (ms = 0): Promise<void> => act(async () => {
  await vi.advanceTimersByTimeAsync(ms)
  for (let turn = 0; turn < 10; turn++) await vi.advanceTimersByTimeAsync(0)
})

/**
 * A store over a fake home, refreshed once.
 * @param script - the home's answers.
 * @returns the store and the host.
 */
async function open(script: Parameters<typeof fakeHost>[0]) {
  const host = fakeHost(script)
  const source = createPinSource(host.fetch)
  sources.push(source)
  await source.refresh()
  await settle()
  return { host, source }
}

const phase = (source: PinSource) => source.hooks.pin.getSnapshot().phase
const headerOf = (init: RequestInit | undefined): string | undefined => (init?.headers as Record<string, string> | undefined)?.[UNLOCK_HEADER]

/** An unlocked page: the home has the mode on and the page has unlocked with the PIN. */
async function unlocked(extra: Parameters<typeof fakeHost>[0] = {}, state: object = {}) {
  const made = await open({
    [key(PIN_ROUTES.state, 'GET')]: stateOn(state),
    [key(PIN_ROUTES.unlock)]: unlockedAnswer,
    [key(PIN_ROUTES.touch)]: ok({ unlockId: 'u1', idleEndsAt: NOW + 2 * IDLE, endsAt: NOW + 12 * 3_600_000 }),
    [key(PIN_ROUTES.lock)]: ok({ locked: true }),
    ...extra,
  })
  await made.source.unlock('135792')
  await settle()
  return made
}

describe('the lock screen on a device', () => {
  it('leaves a fresh page open and locked when the mode is on, and shows the lock screen only when an action asks', async () => {
    // Fails without: the phase `locked` for a page with no token (a reload starts here, as the token is page memory), and a studio that opens without the PIN.
    const { source, host } = await open({ [key(PIN_ROUTES.state, 'GET')]: stateOn() })
    expect(phase(source)).toBe('locked')
    expect(headerOf(host.received[0]?.init)).toBeUndefined()
    const view = render(<PinLock t={t} usePin={bindSnapshotSelector(source.hooks.pin)} unlock={source.unlock} dismiss={source.dismiss} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    view.unmount()
    renderLock(source)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('asks only while locked, closes with Not now, and closes on a successful unlock', async () => {
    // Fails without: ask() answering false off a locked page, dismiss leaving the screen up, and an unlock leaving `asked` set.
    const { source } = await open({ [key(PIN_ROUTES.state, 'GET')]: stateOn(), [key(PIN_ROUTES.unlock, 'POST')]: ok({ token: TOKEN, unlockId: 'u1', endsAt: NOW + 3_600_000, idleEndsAt: NOW + IDLE }) })
    expect(source.ask()).toBe(true)
    expect(source.hooks.pin.getSnapshot().asked).toBe(true)
    renderLock(source)
    fireEvent.click(screen.getByRole('button', { name: en.notNow }))
    expect(source.hooks.pin.getSnapshot().asked).toBe(false)
    expect(screen.queryByRole('dialog')).toBeNull()
    source.ask()
    await act(async () => { await source.unlock('483920') })
    expect(source.hooks.pin.getSnapshot()).toMatchObject({ phase: 'unlocked', asked: false })
    expect(source.ask()).toBe(false)
  })

  it('does not ask on the computer or while the mode is off', async () => {
    const off = await open({ [key(PIN_ROUTES.state, 'GET')]: ok({ kind: 'off' }) })
    expect(off.source.ask()).toBe(false)
    expect(createPinSource(fakeHost({}).fetch, () => NOW, true).ask()).toBe(false)
  })

  it('stays out of the way when the mode is off, the home is older (404) or the page is on the computer', async () => {
    // Fails without: `off` for a 404, for `{kind: off}` and for the computer, which would cover today's overlay.
    const off = await open({ [key(PIN_ROUTES.state, 'GET')]: ok({ kind: 'off' }) })
    expect(phase(off.source)).toBe('off')
    const older = await open({})
    expect(phase(older.source)).toBe('off')
    const mismatch = await open({ [key(PIN_ROUTES.state, 'GET')]: refusal(403, 'HOST_MISMATCH') })
    expect(phase(mismatch.source)).toBe('off')
    const host = fakeHost({ [key(PIN_ROUTES.state, 'GET')]: stateOn() })
    const onComputer = createPinSource(host.fetch, Date.now, true)
    await onComputer.refresh()
    expect(phase(onComputer)).toBe('off')
    expect(host.received).toHaveLength(0)
    const { container } = renderLock(off.source)
    expect(container.textContent).toBe('')
  })

  it('unlocks with the PIN, holds the token in page memory only and sends it with the next read', async () => {
    // Fails without: setUnlockToken after the unlock, and without keeping the token out of storage, cookie and URL.
    const { source, host } = await unlocked()
    expect(phase(source)).toBe('unlocked')
    expect(host.received.find(request => request.key === key(PIN_ROUTES.unlock))?.body).toEqual({ secret: '135792' })
    expect(currentUnlockToken()).toBe(TOKEN)
    const everywhere = JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie, location.href])
    expect(everywhere).not.toContain(TOKEN)
    expect(everywhere).not.toContain('135792')
    host.script[key(PIN_ROUTES.state, 'GET')] = unlockedState()
    await source.refresh()
    expect(headerOf(host.received.at(-1)?.init)).toBe(TOKEN)
    expect(phase(source)).toBe('unlocked')
  })

  it('drops a token the home no longer knows', async () => {
    // Fails without: locking when the state says this page has no unlock though it holds a token.
    const { source, host } = await unlocked()
    host.script[key(PIN_ROUTES.state, 'GET')] = stateOn()
    await source.refresh()
    expect(phase(source)).toBe('locked')
    expect(currentUnlockToken()).toBeNull()
  })

  it.each([
    ['a wrong try, with the tries left', refusal(403, 'PIN_INVALID', 'That is not right. 4 tries left before this device is signed out', { triesLeft: 4, removed: false }), 'wrong', 'That is not right. 4 tries left before this device is signed out.'],
    ['the last try', refusal(403, 'PIN_INVALID', 'That is not right. 1 try left before this device is signed out', { triesLeft: 1, removed: false }), 'wrong', 'That is not right. 1 try left before this device is signed out.'],
    ['the fifth miss, which removes the device', refusal(403, 'PIN_INVALID', 'That is the last wrong try. This device is signed out. Approve it again at your computer', { triesLeft: 0, removed: true }), 'removed', 'Approve this device again at your computer'],
    ['unlocks paused home-wide', refusal(429, 'PIN_UNLOCKS_PAUSED', undefined, { paused: true }), 'paused', 'They resume when you resume them at your computer.'],
    ['an unreachable computer', 'unreachable', 'unreachable', 'can\'t be reached right now'],
    ['a listener where a PIN does not unlock', refusal(403, 'PIN_NOT_ALLOWED_ON_ADDRESS'), 'address', 'private Tailscale address'],
    ['any other refusal', refusal(500, 'INTERNAL_ERROR'), 'failed', 'The unlock did not work'],
  ] as const)('says %s in place', async (_name, answer, outcome, copy) => {
    // Fails without: the outcome of each refusal code and its copy on the lock screen.
    const { source } = await open({ [key(PIN_ROUTES.state, 'GET')]: stateOn(), [key(PIN_ROUTES.unlock)]: answer })
    renderLock(source)
    const field = screen.getByLabelText('PIN') as HTMLInputElement
    fireEvent.change(field, { target: { value: '135792' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    await settle()
    expect(source.hooks.pin.getSnapshot().outcome?.kind).toBe(outcome)
    expect(screen.getByRole('dialog').getAttribute('data-pin-lock')).toBe(outcome)
    expect(screen.getByRole('dialog').textContent).toContain(copy)
    expect(phase(source)).toBe('locked')
    expect(currentUnlockToken()).toBeNull()
    expect((screen.queryByLabelText('PIN') as HTMLInputElement | null)?.value ?? '').toBe('')
  })

  it('reads tries left and removal from the refusal\'s fields, never its sentence', () => {
    // Fails without: telling the fifth miss from a wrong try by the structured fields.
    expect(pinMissOf({ triesLeft: 2, removed: false })).toEqual({ kind: 'wrong', triesLeft: 2 })
    expect(pinMissOf({ triesLeft: 0, removed: true })).toEqual({ kind: 'removed' })
    expect(pinMissOf({})).toEqual({ kind: 'wrong', triesLeft: undefined })
    expect(pinMissOf(undefined)).toEqual({ kind: 'wrong', triesLeft: undefined })
  })

  it('shows the keypad, asks for six digits and clears the field when the request leaves', async () => {
    // Fails without: the six-digit minimum, the input attributes, and clearing the field on submit.
    const unlock = vi.fn(async () => {})
    const { source } = await open({ [key(PIN_ROUTES.state, 'GET')]: stateOn() })
    source.ask()
    render(<PinLock t={t} usePin={bindSnapshotSelector(source.hooks.pin)} unlock={unlock} dismiss={source.dismiss} />)
    const field = screen.getByLabelText('PIN') as HTMLInputElement
    expect(field.getAttribute('inputmode')).toBe('numeric')
    expect(field.getAttribute('autocomplete')).toBe('off')
    const submit = screen.getByRole('button', { name: 'Unlock' }) as HTMLButtonElement
    for (const digit of '13579') fireEvent.click(screen.getByRole('button', { name: digit }))
    expect(field.value).toBe('13579')
    expect(submit.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Delete the last digit' }))
    expect(field.value).toBe('1357')
    for (const digit of '92') fireEvent.click(screen.getByRole('button', { name: digit }))
    expect(field.value).toBe('135792')
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    expect(unlock).toHaveBeenCalledWith('135792')
    expect(field.value).toBe('')
    fireEvent.change(field, { target: { value: '12ab34' } })
    expect(field.value).toBe('1234')
  })

  it('fills one dot per digit typed and never writes a digit into the dots', async () => {
    // Fails without: the dots, which count digits and must not carry their value in text or attributes.
    const { source } = await open({ [key(PIN_ROUTES.state, 'GET')]: stateOn() })
    source.ask()
    const { container } = render(<PinLock t={t} usePin={bindSnapshotSelector(source.hooks.pin)} unlock={async () => {}} dismiss={() => {}} />)
    const dots = container.querySelector('[data-dots]') as HTMLElement
    expect(dots.children).toHaveLength(6)
    expect(dots.getAttribute('data-dots')).toBe('0')
    for (const digit of '8420') fireEvent.click(screen.getByRole('button', { name: digit }))
    expect(dots.getAttribute('data-dots')).toBe('4')
    expect(dots.textContent).toBe('')
    expect(dots.outerHTML).not.toContain('8420')
    expect(dots.getAttribute('aria-hidden')).toBe('true')
    for (const digit of '17935') fireEvent.click(screen.getByRole('button', { name: digit }))
    expect(dots.children).toHaveLength(9)
    fireEvent.click(screen.getByRole('button', { name: 'Delete the last digit' }))
    expect(dots.getAttribute('data-dots')).toBe('8')
  })

  it('shakes the dots on a wrong PIN and says the tries left, unless the person asked for less motion', () => {
    // Fails without: the shake on a wrong answer, or its removal under prefers-reduced-motion.
    const view = { phase: 'locked', secret: 'pin', busy: false, outcome: { kind: 'wrong', triesLeft: 3 }, paused: false, asked: true } as const
    const usePin = ((select: (current: typeof view) => unknown) => select(view)) as never
    const matchMedia = (reduce: boolean) => vi.fn((query: string) => ({ matches: query.includes('reduce') ? reduce : false }))
    vi.stubGlobal('matchMedia', matchMedia(false))
    const first = render(<PinLock t={t} usePin={usePin} unlock={async () => {}} dismiss={() => {}} />)
    expect(first.container.querySelector('[data-dots]')?.hasAttribute('data-shake')).toBe(true)
    expect(screen.getByRole('alert').textContent).toBe(en['wrong.other'].replace('{count}', '3'))
    first.unmount()
    vi.stubGlobal('matchMedia', matchMedia(true))
    const second = render(<PinLock t={t} usePin={usePin} unlock={async () => {}} dismiss={() => {}} />)
    expect(second.container.querySelector('[data-dots]')?.hasAttribute('data-shake')).toBe(false)
    expect(screen.getByRole('alert').textContent).toContain('3 tries left')
    vi.unstubAllGlobals()
  })

  it('shows each other outcome with its own heading and the one sentence that helps', () => {
    // Fails without: a heading and an icon for paused, unreachable, address and failed outcomes.
    const headings = { paused: 'paused.title', unreachable: 'unreachable.title', address: 'address.title', failed: 'failed.title' } as const
    for (const [kind, title] of Object.entries(headings) as [keyof typeof headings, (typeof headings)[keyof typeof headings]][]) {
      const view = { phase: 'locked', secret: 'pin', busy: false, outcome: { kind }, paused: false, asked: true } as const
      const { container, unmount } = render(<PinLock t={t} usePin={((select: (current: typeof view) => unknown) => select(view)) as never} unlock={async () => {}} dismiss={() => {}} />)
      const notice = container.querySelector(`[data-outcome="${kind}"]`) as HTMLElement
      expect(notice.textContent).toContain(en[title])
      expect(notice.textContent).toContain(en[kind])
      expect(notice.querySelector('svg')).not.toBeNull()
      unmount()
    }
  })

  it('asks for a passcode in a text field without a keypad when the home takes a passcode', async () => {
    // Fails without: the passcode kind, which takes any characters and no keypad.
    const { source } = await open({ [key(PIN_ROUTES.state, 'GET')]: stateOn({ secret: 'passcode' }) })
    renderLock(source)
    const field = screen.getByLabelText('Passcode') as HTMLInputElement
    expect(field.getAttribute('inputmode')).toBe('text')
    fireEvent.change(field, { target: { value: 'correct horse' } })
    expect(field.value).toBe('correct horse')
    expect(screen.queryByRole('button', { name: '1' })).toBeNull()
  })
})

describe('keeping the page unlocked, and locking it', () => {
  it('touches at most once a minute on input, and never on a poll', async () => {
    // Fails without: the throttle (a touch per input) and the rule that reads never touch.
    const { source, host } = await unlocked()
    const touches = () => host.count(key(PIN_ROUTES.touch))
    for (let n = 0; n < 5; n++) source.activity()
    expect(touches()).toBe(0)
    host.script[key(PIN_ROUTES.state, 'GET')] = unlockedState()
    await vi.advanceTimersByTimeAsync(TOUCH_INTERVAL_MS - 1000)
    await source.refresh()
    await source.refresh()
    expect(touches()).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    for (let n = 0; n < 5; n++) source.activity()
    await settle()
    expect(touches()).toBe(1)
    expect(headerOf(host.received.findLast(request => request.key === key(PIN_ROUTES.touch))?.init)).toBe(TOKEN)
    await vi.advanceTimersByTimeAsync(TOUCH_INTERVAL_MS - 1)
    source.activity()
    expect(touches()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    source.activity()
    await settle()
    expect(touches()).toBe(2)
  })

  it('locks at the idle end the home gave, and a touch moves that end', async () => {
    // Fails without: the local timer at idleEndsAt, and the new end a touch answers.
    const { source } = await unlocked()
    await vi.advanceTimersByTimeAsync(TOUCH_INTERVAL_MS)
    source.activity()
    await settle()
    // The touch moved the idle end to NOW + 2 * IDLE, so the first end passes without a lock.
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(phase(source)).toBe('unlocked')
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(phase(source)).toBe('locked')
    expect(currentUnlockToken()).toBeNull()
  })

  it('locks on a 401 UNLOCK_INVALID from a touch', async () => {
    // Fails without: the page locking when the home says the unlock is gone.
    const { source } = await unlocked({ [key(PIN_ROUTES.touch)]: refusal(401, 'UNLOCK_INVALID') })
    await vi.advanceTimersByTimeAsync(TOUCH_INTERVAL_MS)
    source.activity()
    await settle()
    expect(phase(source)).toBe('locked')
    expect(currentUnlockToken()).toBeNull()
  })

  it('locks on a 401 UNLOCK_INVALID from a state read', async () => {
    // Fails without: the same rule on the read the connection reset starts.
    const { source, host } = await unlocked()
    host.script[key(PIN_ROUTES.state, 'GET')] = refusal(401, 'UNLOCK_INVALID')
    await source.refresh()
    expect(phase(source)).toBe('locked')
    expect(currentUnlockToken()).toBeNull()
  })

  it('locks from Lock: tells the home with the token and drops it even when the home cannot be reached', async () => {
    // Fails without: the lock request, and dropping the token regardless of its answer.
    const { source, host } = await unlocked({ [key(PIN_ROUTES.lock)]: 'unreachable' as const })
    expect(source.holdsUnlock()).toBe(true)
    await source.lock()
    expect(headerOf(host.received.findLast(request => request.key === key(PIN_ROUTES.lock))?.init)).toBe(TOKEN)
    expect(phase(source)).toBe('locked')
    expect(currentUnlockToken()).toBeNull()
    expect(source.holdsUnlock()).toBe(false)
  })

  it('locks when the page is hidden only if the home asks for it', async () => {
    // Fails without: `lockWhenHidden` from the state, and its absence leaving the page unlocked.
    const asked = await unlocked({}, { lockWhenHidden: true })
    asked.source.hidden()
    await settle()
    expect(phase(asked.source)).toBe('locked')
    expect(asked.host.count(key(PIN_ROUTES.lock))).toBe(1)
    const notAsked = await unlocked({}, { lockWhenHidden: false })
    notAsked.source.hidden()
    await settle()
    expect(phase(notAsked.source)).toBe('unlocked')
    expect(notAsked.host.count(key(PIN_ROUTES.lock))).toBe(0)
  })

  it('drops the token of a page restored from the back-forward cache and reads the state again', async () => {
    // Fails without: `restored`, which locks a page the browser froze unlocked.
    const { source, host } = await unlocked()
    host.script[key(PIN_ROUTES.state, 'GET')] = unlockedState()
    source.restored()
    expect(currentUnlockToken()).toBeNull()
    expect(phase(source)).toBe('locked')
    await settle()
    expect(phase(source)).toBe('locked')
  })

  it('sends a keepalive lock when the page closes', async () => {
    // Fails without: `keepalive`, which lets the request outlive the page.
    const { source, host } = await unlocked()
    source.closing()
    await settle()
    const lock = host.received.findLast(request => request.key === key(PIN_ROUTES.lock))
    expect(lock?.init?.keepalive).toBe(true)
    expect(headerOf(lock?.init)).toBe(TOKEN)
    expect(currentUnlockToken()).toBeNull()
  })

  it('wires the browser events: input touches, a hidden page locks, pageshow and pagehide', async () => {
    // Fails without: each listener of attachPinTriggers.
    const { source, host } = await unlocked({}, { lockWhenHidden: true })
    const detach = attachPinTriggers(source, window)
    await vi.advanceTimersByTimeAsync(TOUCH_INTERVAL_MS)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    await settle()
    expect(host.count(key(PIN_ROUTES.touch))).toBe(1)
    window.dispatchEvent(new Event('pageshow'))
    expect(phase(source)).toBe('unlocked')
    const restore = new Event('pageshow') as Event & { persisted: boolean }
    restore.persisted = true
    window.dispatchEvent(restore)
    expect(phase(source)).toBe('locked')
    detach()
    const closing = await unlocked()
    const again = attachPinTriggers(closing.source, window)
    window.dispatchEvent(new Event('pagehide'))
    await settle()
    expect(closing.host.received.findLast(request => request.key === key(PIN_ROUTES.lock))?.init?.keepalive).toBe(true)
    again()
    const hiding = await unlocked({}, { lockWhenHidden: true })
    const last = attachPinTriggers(hiding.source, window)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    try {
      document.dispatchEvent(new Event('visibilitychange'))
      await settle()
      expect(phase(hiding.source)).toBe('locked')
    } finally {
      Reflect.deleteProperty(document, 'visibilityState')
      last()
    }
  })
})

describe('the plugin wiring', () => {
  it('the plugin\'s Lock ends the PIN unlock when the page holds one, and the elevation otherwise', async () => {
    // Fails without: composing the banner's Lock now with the PIN lock.
    const host = fakeHost({
      [key(PIN_ROUTES.state, 'GET')]: stateOn(),
      [key(PIN_ROUTES.unlock)]: unlockedAnswer,
      [key(PIN_ROUTES.lock)]: ok({ locked: true }),
      [key(ELEVATION_ROUTES.state, 'GET')]: ok({ kind: 'elevated', elevationId: 'e1', endsAt: NOW + IDLE }),
      [key(ELEVATION_ROUTES.lock)]: ok({ kind: 'none' }),
    })
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots')
    if (slots === undefined) throw new Error('no slot registry')
    try {
      slots.register({ name: 'root', children: { 'shell.overlay': { kind: 'list', scope: 'root' } }, inject: () => ({}) }, ({ renderSlot }) => <>{renderSlot('shell.overlay', {})}</>)
      let pin: PinSource | undefined
      await ctx.plugin({ inject: ['slots'], apply: (scope: Context) => {
        pin = applyPin(scope, host.fetch)
        applyUnlock(scope, host.fetch, false, pin)
      } }).await()
      await settle()
      const overlays = slots.entries('shell.overlay')
      expect(overlays.map(entry => (entry.options as { id: string }).id)).toEqual([PIN_LOCK_OVERLAY_ID, UNLOCK_OVERLAY_ID])
      const inject = overlays[1]?.inject?.() as { hooks: { unlock: HostObservable<UnlockView> }; request: () => Promise<void>; cancel: () => Promise<void>; lock: () => Promise<void>; dismissEnded: () => void }
      await pin?.unlock('135792')
      await settle()
      await inject.lock()
      await settle()
      expect(host.count(key(PIN_ROUTES.lock))).toBe(1)
      expect(host.count(key(ELEVATION_ROUTES.lock))).toBe(0)
      expect(currentUnlockToken()).toBeNull()
      await inject.lock()
      expect(host.count(key(ELEVATION_ROUTES.lock))).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('an action that needs an unlock, under PIN mode', () => {
  const READ: Answer = { status: 200, body: { kind: 'none', unlockMinutes: 15 } }

  it('asks the PIN lock screen and opens no code dialog; without PIN mode the code dialog opens', async () => {
    // Fails without: the hand-over to the PIN (the device would ask for a code at the computer under PIN mode), or the code dialog where the PIN does not apply.
    const host = fakeHost({ [key(ELEVATION_ROUTES.state, 'GET')]: READ })
    const asked = vi.fn(() => true)
    const withPin = createUnlockSource(host.fetch, () => NOW, false, asked)
    await withPin.refresh()
    withPin.refused('elevation-required: terminal/create')
    withPin.open()
    expect(asked).toHaveBeenCalledTimes(2)
    expect(withPin.hooks.unlock.getSnapshot().dialog).toBeNull()
    const withoutPin = createUnlockSource(host.fetch, () => NOW, false, () => false)
    await withoutPin.refresh()
    withoutPin.refused('elevation-required: terminal/create')
    expect(withoutPin.hooks.unlock.getSnapshot().dialog).toMatchObject({ action: 'terminal/create' })
  })
})

describe('the unlock slides on the home', () => {
  it('reads the end again after an action that needed the unlock, and does not prompt while unlocked', async () => {
    // Fails without: noteUnlockedAction refreshing the store (the banner would keep the old end), or a prompt while unlocked.
    let endsAt = NOW + 15 * 60_000
    const fetch = vi.fn(async () => new Response(JSON.stringify({ kind: 'elevated', elevationId: 'e1', endsAt }), { status: 200 }))
    const asked = vi.fn(() => false)
    const store = createUnlockSource(fetch as never, () => NOW, false, asked)
    await store.refresh()
    const dispose = installGateUnlock(store)
    endsAt += 5 * 60_000
    noteUnlockedAction()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(store.hooks.unlock.getSnapshot().state).toMatchObject({ kind: 'elevated', endsAt })
    expect(store.hooks.unlock.getSnapshot().dialog).toBeNull()
    dispose()
  })
})

describe('an action refused for the unlock is retried once the device unlocks', () => {
  it('retries once on the change to unlocked, not before and not again', async () => {
    // Fails without: the retry on unlock (the person would repeat the tap), or a retry loop while unlocked.
    let state: object = { kind: 'none', unlockMinutes: 15 }
    const fetch = vi.fn(async () => new Response(JSON.stringify(state), { status: 200 }))
    const store = createUnlockSource(fetch as never, () => NOW, false)
    await store.refresh()
    const dispose = installGateUnlock(store)
    const retry = vi.fn()
    const error = new HostRequestError('/x', { kind: 'refused', status: 403, code: 'ELEVATION_REQUIRED', message: 'no' })
    render(<GateFailure t={((key: string) => key) as never} error={error} text="no" retry={retry} />)
    expect(retry).not.toHaveBeenCalled()
    state = { kind: 'elevated', elevationId: 'e1', endsAt: NOW + 15 * 60_000 }
    await act(async () => { await store.refresh() })
    expect(retry).toHaveBeenCalledOnce()
    await act(async () => { await store.refresh() })
    expect(retry).toHaveBeenCalledOnce()
    dispose()
  })
})
