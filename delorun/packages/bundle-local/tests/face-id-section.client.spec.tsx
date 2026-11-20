// @vitest-environment jsdom
/**
 * The Face ID settings section: the phone's list and the computer's code entry.
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
const entry = { credentialId: 'c1', createdAt: Date.UTC(2026, 10, 18), lastUsedAt: null, synced: false }
const pinView = (phase: PinView['phase']): PinView => ({ phase, secret: 'pin' })

function section(script: Parameters<typeof fakeHost>[0], over: { computer?: boolean; phase?: PinView['phase'] } = {}) {
  const host = fakeHost(script)
  const props = { t, close: () => {}, fetch: host.fetch, atComputer: () => over.computer ?? false, usePin: <S,>(select: (view: PinView) => S): S => select(pinView(over.phase ?? 'on')), browser: fakeBrowser() } as FaceIdSectionProps
  render(<FaceIdSection {...props} />)
  return host
}

afterEach(cleanup)

describe('FaceIdSection', () => {
  it('on a phone, lists this device and offers Add Face ID when it has none', async () => {
    // The phone's section starts from its own passkeys.
    section({ [`GET ${PASSKEY_ROUTES.state}`]: { status: 200, body: { passkeys: [], ticket: false } } })
    fireEvent.click(await screen.findByRole('button', { name: 'Add Face ID' }))
    expect(await screen.findByRole('button', { name: 'Show the code' })).toBeTruthy()
  })
  it('on a phone with a passkey, lists it', async () => {
    // A device with a passkey shows it with its added date.
    section({ [`GET ${PASSKEY_ROUTES.state}`]: { status: 200, body: { passkeys: [entry], ticket: false } } }, { phase: 'off' })
    expect(await screen.findByText('Added 18 Nov · this device only')).toBeTruthy()
  })
  it('offers Confirm for Show all devices on a phone with a passkey while its first passkey read is still on its way', async () => {
    // A section that took "no passkey" until its read answered showed a passkey phone "nothing to confirm with" (F-5).
    const host = fakeHost({ [`GET ${PASSKEY_ROUTES.state}`]: { status: 200, body: { passkeys: [entry], ticket: false } } })
    let held = true
    const fetch: typeof host.fetch = (input, init) => (held && String(input).includes(PASSKEY_ROUTES.state) ? new Promise<Response>(() => {}) : host.fetch(input, init))
    const props = { t, close: () => {}, fetch, atComputer: () => false, usePin: <S,>(select: (view: PinView) => S): S => select(pinView('off')), browser: fakeBrowser() } as FaceIdSectionProps
    render(<FaceIdSection {...props} />)
    held = false
    fireEvent.click(screen.getByRole('button', { name: 'Show all devices' }))
    expect(await screen.findByRole('button', { name: /^Confirm with/ })).toBeTruthy()
    expect(document.querySelector('[data-face-id-sheet]')?.textContent).not.toContain('nothing to confirm with')
  })
  it('at the computer, shows the code entry', async () => {
    // The computer takes the code the phone shows.
    section({
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
    overlay({ [`GET ${PASSKEY_ROUTES.state}`]: state(true) })
    expect(await screen.findByRole('button', { name: 'Set up your device' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
    expect(screen.queryByRole('button', { name: 'Set up your device' })).toBeNull()
  })
  it('shows nothing without a ticket or at the computer', async () => {
    // No ticket, no step; the computer page asks nothing.
    overlay({ [`GET ${PASSKEY_ROUTES.state}`]: state(false) })
    await screen.findByText(/^$/, undefined, { timeout: 50 }).catch(() => undefined)
    expect(document.querySelector('[data-face-id-pairing]')).toBeNull()
    cleanup()
    const computer = overlay({}, true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(computer.received).toHaveLength(0)
  })
  it('stays hidden when the state cannot be read', async () => {
    // A failed read must not show a step that cannot work.
    overlay({ [`GET ${PASSKEY_ROUTES.state}`]: { status: 500, body: { error: 'X', message: 'x' } } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(document.querySelector('[data-face-id-pairing]')).toBeNull()
  })
})
