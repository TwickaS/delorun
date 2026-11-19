/** The page's reach for a live agent's approvals follows where the page is and whether it holds a PIN unlock. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { provideAgentSeatReach } from '../src/client/agent-seat-reach.ts'
import type { PinSource } from '../src/client/pin-lock.ts'
import type { UnlockSource } from '../src/client/unlock.ts'

function setup(onComputer: boolean, phase: 'locked' | 'unlocked', pinAsks = true) {
  const listeners = new Set<() => void>()
  const state = { phase }
  const pin = {
    hooks: { pin: { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } } },
    ask: vi.fn(() => pinAsks),
  } as never as PinSource
  const unlock = { open: vi.fn() } as never as UnlockSource
  const ctx = new Context()
  provideAgentSeatReach(ctx, pin, unlock, onComputer)
  return { ctx, pin, unlock, state, listeners }
}

describe('the live agent reach', () => {
  it('counts the computer\'s own page as the computer', () => {
    expect(setup(true, 'locked').ctx.get('agentSeatReach').get()).toEqual({ kind: 'computer' })
  })

  it('lets a phone grant only while its page holds a PIN unlock', () => {
    const h = setup(false, 'locked')
    expect(h.ctx.get('agentSeatReach').get()).toEqual({ kind: 'locked-phone' })
    h.state.phase = 'unlocked'
    expect(h.ctx.get('agentSeatReach').get()).toEqual({ kind: 'unlocked-phone' })
  })

  it('tells a listener when the PIN state changes', () => {
    const h = setup(false, 'locked')
    const listener = vi.fn()
    const stop = h.ctx.get('agentSeatReach').subscribe(listener)
    for (const each of h.listeners) each()
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
    expect(h.listeners.size).toBe(0)
  })

  it('opens the PIN lock screen, or the unlock dialog where PIN mode is off', () => {
    const lock = setup(false, 'locked', true)
    lock.ctx.get('agentSeatReach').openUnlock()
    expect(lock.unlock.open).not.toHaveBeenCalled()
    const off = setup(false, 'locked', false)
    off.ctx.get('agentSeatReach').openUnlock()
    expect(off.unlock.open).toHaveBeenCalledTimes(1)
  })
})
