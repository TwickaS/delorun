// @vitest-environment jsdom
/** The announcements of the connection to Delorun: one polite live region, always on the page, that says each change. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { connectionAnnouncement, ConnectionStatus } from '../src/client/ConnectionStatus.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

type State = 'connected' | 'connecting' | 'disconnected' | undefined

/** The region over a connection state a test changes. */
function show(initial: State) {
  const state = createSnapshotStore<State>(initial)
  render(<ConnectionStatus useConnectionState={bindSnapshotSelector(state)} t={makeTranslate(en)} />)
  const region = screen.getByRole('status')
  return { region, set: (next: State) => { act(() => { state.set(next) }) } }
}

describe('the connection announcements', () => {
  it('are a polite, whole-message live region that is on the page before anything is said', () => {
    const { region } = show('connected')
    expect([region.getAttribute('aria-live'), region.getAttribute('aria-atomic'), region.textContent]).toEqual(['polite', 'true', ''])
  })

  it('say Delorun is reconnecting, that it is back, and that the device is offline, as the state changes', () => {
    const { region, set } = show(undefined)
    set('connected')
    expect(region.textContent).toBe('')
    set('connecting')
    expect(region.textContent).toBe(en['connection.reconnecting'])
    set('connected')
    expect(region.textContent).toBe(en['connection.back'])
    set('disconnected')
    expect(region.textContent).toBe(en['connection.offline'])
    set('connected')
    expect(region.textContent).toBe(en['connection.back'])
  })

  it('say nothing for the first connection or before any outcome', () => {
    expect(connectionAnnouncement(undefined, 'connected')).toBeUndefined()
    expect(connectionAnnouncement('connected', 'connected')).toBeUndefined()
    expect(connectionAnnouncement('connecting', undefined)).toBeUndefined()
  })

  it('are worded in Chinese too, without a closing full stop', () => {
    for (const key of ['connection.reconnecting', 'connection.offline', 'connection.back'] as const) {
      expect(zh[key].length).toBeGreaterThan(0)
      expect(zh[key].endsWith('。')).toBe(false)
    }
  })
})
