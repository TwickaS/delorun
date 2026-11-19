// @vitest-environment jsdom
/**
 * The Face ID settings section: hidden behind the preview flag, then the phone's list and the computer's code entry.
 *
 * Each test's comment names the behaviour whose removal makes it fail.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/face-id-locales.ts'
import { fakeBrowser } from '../src/client/face-id-fake.ts'
import { PASSKEY_ROUTES } from '../src/client/face-id-api.ts'
import { FaceIdSection, type FaceIdSectionProps } from '../src/client/FaceIdSection.tsx'
import { FaceIdPairingOverlay } from '../src/client/FaceIdPairingOverlay.tsx'
import type { PinView } from '../src/client/pin-lock.ts'
import { fakeHost } from './fake-host.ts'

const t = makeTranslate(en)
const FLAGS = 'GET /api/delorunPreviewFlags.list' as const
const flags = (on: boolean) => ({ status: 200, body: { flags: [{ id: 'unlock.passkeys', on }] } })
const entry = { credentialId: 'c1', createdAt: Date.UTC(2026, 10, 18), lastUsedAt: null, synced: false }
const pinView = (phase: PinView['phase']): PinView => ({ phase, secret: 'pin', busy: false, outcome: undefined, paused: false, asked: false })

function section(script: Parameters<typeof fakeHost>[0], over: { computer?: boolean; phase?: PinView['phase'] } = {}) {
  const host = fakeHost(script)
  const props = { t, close: () => {}, fetch: host.fetch, atComputer: () => over.computer ?? false, usePin: <S,>(select: (view: PinView) => S): S => select(pinView(over.phase ?? 'unlocked')), browser: fakeBrowser() } as FaceIdSectionProps
  render(<FaceIdSection {...props} />)
  return host
}

afterEach(cleanup)

describe('FaceIdSection', () => {
  it('shows one line and calls no passkey route while the flag is off', async () => {
    // A flag-off section must never reach the passkey routes.
    const host = section({ [FLAGS]: flags(false) })
    expect(await screen.findByText(/preview feature/)).toBeTruthy()
    expect(host.received.some(request => request.key.includes('/auth/passkey'))).toBe(false)
  })
  it('treats an unreadable flags route as off', async () => {
    // A profile without the flags route has no Face ID.
    section({})
    expect(await screen.findByText(/preview feature/)).toBeTruthy()
  })
  it('on a phone with the flag on, lists this device and offers Add Face ID when it has none', async () => {
    // The phone's section starts from its own passkeys.
    section({ [FLAGS]: flags(true), [`GET ${PASSKEY_ROUTES.state}`]: { status: 200, body: { passkeys: [], ticket: false } } })
    fireEvent.click(await screen.findByRole('button', { name: 'Add Face ID' }))
    expect(await screen.findByRole('button', { name: 'Show the code' })).toBeTruthy()
  })
  it('on a phone with a passkey, lists it', async () => {
    // A device with a passkey shows it with its added date.
    section({ [FLAGS]: flags(true), [`GET ${PASSKEY_ROUTES.state}`]: { status: 200, body: { passkeys: [entry], ticket: false } } }, { phase: 'off' })
    expect(await screen.findByText('Added 18 Nov · this device only')).toBeTruthy()
  })
  it('at the computer, shows the code entry', async () => {
    // The computer takes the code the phone shows.
    section({
      [FLAGS]: flags(true),
      [`GET ${PASSKEY_ROUTES.addPending}`]: { status: 200, body: { pending: [] } },
      [`GET ${PASSKEY_ROUTES.devices}`]: { status: 200, body: { devices: [] } },
      [`GET ${PASSKEY_ROUTES.state}`]: { status: 200, body: { passkeys: [], ticket: false } },
    }, { computer: true })
    expect(await screen.findByLabelText('Code from the device')).toBeTruthy()
  })
})

describe('FaceIdPairingOverlay', () => {
  const state = (ticket: boolean) => ({ status: 200, body: { passkeys: [], ticket } })
  function overlay(script: Parameters<typeof fakeHost>[0], computer = false) {
    const host = fakeHost(script)
    render(<FaceIdPairingOverlay t={t} fetch={host.fetch} atComputer={() => computer} browser={fakeBrowser()} />)
    return host
  }
  it('offers Set up Face ID once when a ticket waits, and Skip hides it', async () => {
    // The ticket from the computer's approval starts the step on the phone.
    overlay({ [FLAGS]: flags(true), [`GET ${PASSKEY_ROUTES.state}`]: state(true) })
    expect(await screen.findByRole('button', { name: 'Set up your device' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
    expect(screen.queryByRole('button', { name: 'Set up your device' })).toBeNull()
  })
  it('shows nothing without a ticket, with the flag off, or at the computer', async () => {
    // No ticket, no step; the flag-off and computer pages ask nothing.
    overlay({ [FLAGS]: flags(true), [`GET ${PASSKEY_ROUTES.state}`]: state(false) })
    await screen.findByText(/^$/, undefined, { timeout: 50 }).catch(() => undefined)
    expect(document.querySelector('[data-face-id-pairing]')).toBeNull()
    cleanup()
    const off = overlay({ [FLAGS]: flags(false) })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(off.received.some(request => request.key.includes('/auth/passkey'))).toBe(false)
    cleanup()
    const computer = overlay({ [FLAGS]: flags(true) }, true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(computer.received).toHaveLength(0)
  })
  it('stays hidden when the state cannot be read', async () => {
    // A failed read must not show a step that cannot work.
    overlay({ [FLAGS]: flags(true), [`GET ${PASSKEY_ROUTES.state}`]: { status: 500, body: { error: 'X', message: 'x' } } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(document.querySelector('[data-face-id-pairing]')).toBeNull()
  })
})
