// @vitest-environment jsdom
/**
 * A reach page whose session the home rotated (C4: a device approval, a removal, a passkey enrolment) reloads, so the
 * sign-in page signs it in again; any other answer leaves it reconnecting.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import { watchSessionRotation } from '../src/client/session-rotation.ts'

function connection(initial: ConnectionState | undefined = 'connected') {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    source: { getSnapshot: () => current, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
    set(next: ConnectionState) { current = next; for (const listener of listeners) listener() },
  }
}

describe('the session rotation watch', () => {
  it('reloads a page that lost its connection when the home answers its probe with 401', async () => {
    // Phone A stayed on "Lost the connection to Delorun. Reconnecting." after Phone B was approved (e2e flow 8).
    const link = connection()
    const reload = vi.fn()
    const probe = vi.fn(async () => 401)
    watchSessionRotation(link.source, probe, reload)
    link.set('connecting')
    await vi.waitFor(() => { expect(reload).toHaveBeenCalledOnce() })
    expect(probe).toHaveBeenCalledOnce()
  })

  it('leaves the page reconnecting when the session still admits it, the home is out of reach, or the page reconnects', async () => {
    const link = connection()
    const reload = vi.fn()
    const answers = [200, 403]
    const probe = vi.fn(async () => {
      const next = answers.shift()
      if (next === undefined) throw new TypeError('Failed to fetch')
      return next
    })
    watchSessionRotation(link.source, probe, reload)
    link.set('connecting')
    await vi.waitFor(() => { expect(probe).toHaveBeenCalledTimes(1) })
    await Promise.resolve()
    link.set('disconnected')
    await vi.waitFor(() => { expect(probe).toHaveBeenCalledTimes(2) })
    await Promise.resolve()
    link.set('connecting')
    await vi.waitFor(() => { expect(probe).toHaveBeenCalledTimes(3) })
    link.set('connected')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(probe).toHaveBeenCalledTimes(3)
    expect(reload).not.toHaveBeenCalled()
  })

  it('asks once at a time and never reloads after it stopped', async () => {
    const link = connection()
    const reload = vi.fn()
    let answer: ((status: number) => void) | undefined
    const probe = vi.fn(() => new Promise<number>((resolve) => { answer = resolve }))
    const stop = watchSessionRotation(link.source, probe, reload)
    link.set('connecting')
    link.set('disconnected')
    expect(probe).toHaveBeenCalledOnce()
    stop()
    answer?.(401)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(reload).not.toHaveBeenCalled()
  })
})
