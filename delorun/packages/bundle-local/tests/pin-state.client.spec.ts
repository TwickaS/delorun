/**
 * PIN mode's state for this device: what the Face ID sheets read to show the keypad and name its secret.
 *
 * Each test's comment names the behaviour whose removal makes it fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RETRY_MS, createPinSource } from '../src/client/pin-lock.ts'
import { readPinState } from '../src/client/pin-api.ts'
import { applyPin } from '../src/client/index.ts'
import { fakeHost, type Answer } from './fake-host.ts'

const ok = (body: unknown): Answer => ({ status: 200, body })
const refusal = (status: number, error: string): Answer => ({ status, body: { error, message: `${error} sentence` } })
const ON = ok({ kind: 'on', secret: 'passcode', idleMinutes: 15, paused: false })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('PIN mode state source', () => {
  // Without the mode's secret kind the keypad would ask a passcode home for digits.
  it('reads the mode on with its secret, and off when the home says off or has no route', async () => {
    const host = fakeHost({ 'GET /auth/pin/state': ON })
    const source = createPinSource(host.fetch)
    expect(source.hooks.pin.getSnapshot()).toEqual({ phase: 'unknown', secret: 'pin' })
    const heard = vi.fn()
    const stop = source.hooks.pin.subscribe(heard)
    await source.refresh()
    expect(source.hooks.pin.getSnapshot()).toEqual({ phase: 'on', secret: 'passcode' })
    host.script['GET /auth/pin/state'] = ok({ kind: 'off' })
    await source.refresh()
    expect(source.hooks.pin.getSnapshot().phase).toBe('off')
    host.script['GET /auth/pin/state'] = ON
    await source.refresh()
    host.script['GET /auth/pin/state'] = { status: 404, body: { error: 'NOT_FOUND', message: 'No such route' } }
    await source.refresh()
    expect(source.hooks.pin.getSnapshot().phase).toBe('off')
    expect(heard).toHaveBeenCalledTimes(4)
    stop()
    heard.mockClear()
    await source.refresh()
    expect(heard).not.toHaveBeenCalled()
  })

  // Without the computer check, the page on the home's own computer would read a route that answers HOST_MISMATCH.
  it('reads nothing on the home\'s own computer, and treats HOST_MISMATCH as off', async () => {
    const host = fakeHost({ 'GET /auth/pin/state': ON })
    const computer = createPinSource(host.fetch, true)
    await computer.refresh()
    expect(computer.hooks.pin.getSnapshot().phase).toBe('off')
    expect(host.count('GET /auth/pin/state')).toBe(0)
    await expect(readPinState(fakeHost({ 'GET /auth/pin/state': refusal(403, 'HOST_MISMATCH') }).fetch)).resolves.toBeUndefined()
  })

  // Without the retry, a first read that fails leaves the keypad's state unknown until the connection resets.
  it('tries a first read that did not complete again, and stops once disposed', async () => {
    const host = fakeHost({ 'GET /auth/pin/state': 'unreachable' })
    const source = createPinSource(host.fetch)
    await source.refresh()
    expect(source.hooks.pin.getSnapshot().phase).toBe('unknown')
    host.script['GET /auth/pin/state'] = ON
    await vi.advanceTimersByTimeAsync(RETRY_MS)
    expect(source.hooks.pin.getSnapshot().phase).toBe('on')
    host.script['GET /auth/pin/state'] = 'unreachable'
    await source.refresh()
    expect(source.hooks.pin.getSnapshot().phase).toBe('on')
    expect(vi.getTimerCount()).toBe(0)
    const closing = createPinSource(fakeHost({ 'GET /auth/pin/state': 'unreachable' }).fetch)
    await closing.refresh()
    closing.dispose()
    await closing.refresh()
    expect(vi.getTimerCount()).toBe(0)
  })

  // Without the dispose guard, an answer that lands after unload would publish to a dead page.
  it('drops an answer that lands after dispose', async () => {
    const host = fakeHost({ 'GET /auth/pin/state': ON })
    const source = createPinSource(host.fetch)
    const reading = source.refresh()
    source.dispose()
    await reading
    expect(source.hooks.pin.getSnapshot().phase).toBe('unknown')
    const failing = createPinSource(fakeHost({ 'GET /auth/pin/state': 'unreachable' }).fetch)
    const failed = failing.refresh()
    failing.dispose()
    await failed
    expect(vi.getTimerCount()).toBe(0)
  })

  // Without the connection/reset read, a device that reconnects keeps the state it read before.
  it('reads again after each connection reset', async () => {
    const host = fakeHost({ 'GET /auth/pin/state': ON })
    const ctx = new Context()
    const pin = applyPin(ctx, host.fetch)
    await vi.advanceTimersByTimeAsync(0)
    ctx.emit('connection/reset')
    await vi.advanceTimersByTimeAsync(0)
    expect(host.count('GET /auth/pin/state')).toBe(2)
    await ctx.fiber.dispose()
    expect(pin.hooks.pin.getSnapshot().phase).toBe('on')
  })
})
