// @vitest-environment jsdom
/**
 * The Devices section reads the reach state and the device list from the home, adds a device through the approval
 * window, removes a device after confirmation, and says in place when the home needs the person at its own computer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { apply as connectionApply } from '@deepseek-ai/dsh-client-connection/client'
import { makeTranslate, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { IconLinkOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PermissionSwitchConsent } from '@deepseek-ai/dsh-client-ui-permission-presets/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  ABOUT_SECTION_ID, ABOUT_SECTION_ORDER, apply, CONSENT_TOAST_ID, DEVICES_SECTION_ID, DEVICES_SECTION_ORDER, EXTERNAL_AGENT_ACTION_ID,
  EXTERNAL_AGENTS_SECTION_ID, EXTERNAL_AGENTS_SECTION_ORDER, FULL_ACCESS_ACTION_ID, FULL_ACCESS_CONSENT_ID, inject, MCP_REVIEW_ID,
  MCP_WAITING_NOTICE_ID, NETWORK_SECTION_ID, SETUP_COMMANDS_SECTION_ID, SETUP_COMMANDS_SECTION_ORDER, PAIRING_NOTICE_ID, NETWORK_SECTION_ORDER, SETUP_VERSIONS_SECTION_ID, SETUP_VERSIONS_SECTION_ORDER, PERMISSIONS_SECTION_ID, PERMISSIONS_SECTION_ORDER, PRIVACY_SECTION_ID,
  PLUGIN_INSTALLS_SECTION_ID, PLUGIN_INSTALLS_SECTION_ORDER, PRIVACY_SECTION_ORDER, readReachStatus, PIN_MODE_SECTION_ID, PIN_MODE_SECTION_ORDER, FACE_ID_SECTION_ID, FACE_ID_GRANT_ID, FACE_ID_OVERLAY_ID, FACE_ID_ANSWER_ID, FACE_ID_SECTION_ORDER, REMOTE_NOTICE_ID,
} from '../src/client/index.ts'
import {
  approveDevice, DEVICE_ROUTES, HostRequestError, hostFailureOf, isRefused, openApprovalWindow, PENDING_POLL_MS,
  readDevices, readPendingDevices, removeDevice, type ApprovalRequestId, type DeviceId, type HostFetch,
} from '../src/client/devices-api.ts'
import { en, zh } from '../src/client/devices-locales.ts'
import { approvalCode, DevicesSection, failureText, REACH_ON_COMMAND, type DevicesSectionProps } from '../src/client/DevicesSection.tsx'
import { AWAY, fakeHost, staticPairing, staticUnlock } from './fake-host.ts'
import type { ExternalAgentsSectionInjected } from '../src/client/ExternalAgentsSection.tsx'
import { DELEGATION_CONSENT_ROW } from '@delorun/plugin-delegation-consent/wire'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0)

// The fixtures carry times around a fixed moment; the page's own clock reads that moment too, so a window the fixtures
// open is open whatever the day the suite runs. Specs that also step timers replace this with `fakeClock()`.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
})
const DEVICE_A = {
  id: 'a'.repeat(43), label: 'Pixel 9', platform: 'Android', address: 'https://home.example.ts.net',
  approvedAt: NOW - 86_400_000, approvedBy: 'local', lastSignInAt: NOW - 3_600_000,
}
const DEVICE_B = {
  id: 'b'.repeat(43), label: 'Work laptop', platform: 'macOS', address: 'https://home.example.ts.net',
  approvedAt: NOW - 172_800_000, approvedBy: null, lastSignInAt: null,
}
const OWNER = { claimedAt: NOW - 259_200_000, firstDeviceId: DEVICE_A.id }
const REQUEST = {
  requestId: 'request-1', label: 'iPad', platform: 'iPadOS', address: 'https://home.example.ts.net', createdAt: NOW - 10_000, expiresAt: NOW + 290_000,
  identity: null, windowless: false, wrongCodes: 0,
}
const VIEW = { mayAskWithoutWindow: 'own-user', showRequest: 'notice', windowMinutes: 5, requestExpiryMinutes: 5, pendingPerIdentity: 1 } as const
const READY = { status: 200, body: { available: true, hasOwner: true, options: [{ option: 'tailscale-private', state: 'ready', address: 'https://home.example.ts.net' }] } }
const refusal = (status: number, error: string, message = `${error} sentence`) => ({ status, body: { error, message } })
const loopbackRefusal = refusal(403, 'LOOPBACK_REQUIRED', 'Adding a device needs you at your computer: open the studio on the home\'s own computer')

/**
 * Render the section over a fake home.
 * @param host - the fake home.
 * @returns the render result.
 */
function renderSection(host: ReturnType<typeof fakeHost>) {
  // The renderer's standard props are absent: the section reads none of them.
  const props = { t: makeTranslate(en), close: () => {}, fetch: host.fetch, ...staticUnlock(AWAY), ...staticPairing() } as DevicesSectionProps
  return render(<DevicesSection {...props} />)
}

/** Let timers up to `ms` from now run, and the answers they wait for settle, inside React's act. */
const settle = (ms = 0): Promise<void> => act(async () => {
  await vi.advanceTimersByTimeAsync(ms)
  // A Response body is read over several turns of the event loop.
  for (let turn = 0; turn < 10; turn++) await vi.advanceTimersByTimeAsync(0)
})

/** Use fake timers and a fixed clock, keeping the microtask queue real. */
function fakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: NOW })
}

/** The standard home: reach ready, one device of each kind. */
function standardHost() {
  return fakeHost({
    [`GET ${DEVICE_ROUTES.reachStatus}`]: READY,
    [`GET ${DEVICE_ROUTES.devices}`]: { status: 200, body: { owner: OWNER, devices: [DEVICE_A, DEVICE_B] } },
    [`POST ${DEVICE_ROUTES.window}`]: { status: 200, body: { closesAt: NOW + 300_000 } },
    [`GET ${DEVICE_ROUTES.pending}`]: { status: 200, body: { windowClosesAt: NOW + 300_000, pending: [REQUEST], pairing: VIEW } },
  })
}

/** A paired device's unlock view, as on a phone. */
const ON_DEVICE = { ...AWAY, place: 'device' } as const

describe('the Devices section on a device', () => {
  // A device reads a list without addresses, approvers or the first device (home-auth's devicesHandler); requiring them
  // again shows "could not be read" in place of the list on every phone.
  it('lists the devices from the list the home sends a device', async () => {
    const host = fakeHost({
      [`GET ${DEVICE_ROUTES.reachStatus}`]: READY,
      [`GET ${DEVICE_ROUTES.devices}`]: { status: 200, body: {
        owner: { claimedAt: OWNER.claimedAt },
        devices: [DEVICE_A, DEVICE_B].map(({ address: _address, approvedBy: _approvedBy, ...rest }) => rest),
        current: DEVICE_A.id,
        unlocks: [],
      } },
    })
    const props = { t: makeTranslate(en), close: () => {}, fetch: host.fetch, ...staticUnlock(ON_DEVICE), ...staticPairing({ state: { place: 'remote' } }) } as DevicesSectionProps
    render(<DevicesSection {...props} />)
    await settle()
    expect(screen.getByText(DEVICE_A.label)).toBeTruthy()
    expect(screen.getByText(DEVICE_B.label)).toBeTruthy()
    expect(screen.getByText(DEVICE_A.platform)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    // Adding a device is computer-only (E1): the phone reads where to do it and gets no button the home would refuse.
    expect(screen.getByText(en['add.atComputer'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.add })).toBeNull()
  })
})

describe('the Devices section without Phone powers', () => {
  // Removing the Phone powers block from the section brings back a choice for a level that no longer exists; the section never asks for the route.
  it('shows no Phone powers choice, at the computer or on a phone, and never asks for the route', async () => {
    for (const view of [AWAY, ON_DEVICE]) {
      const host = fakeHost({
        [`GET ${DEVICE_ROUTES.reachStatus}`]: READY,
        [`GET ${DEVICE_ROUTES.devices}`]: { status: 200, body: { owner: OWNER, devices: [DEVICE_A] } },
      })
      const props = { t: makeTranslate(en), close: () => {}, fetch: host.fetch, ...staticUnlock(view), ...staticPairing() } as DevicesSectionProps
      const { unmount } = render(<DevicesSection {...props} />)
      await screen.findByText(DEVICE_A.label)
      await settle()
      expect(screen.queryByText(/Phone powers/i)).toBeNull()
      expect(host.received.map(request => request.key).filter(key => key.includes('phone-powers'))).toEqual([])
      unmount()
    }
  })
})

describe('the Devices section', () => {
  it('says only that remote access is not available in a profile without reach', async () => {
    const host = fakeHost()
    renderSection(host)
    expect(await screen.findByText(en['reach.unavailable'])).toBeTruthy()
    expect(screen.queryByText(en.intro)).toBeNull()
    expect(screen.queryByRole('button', { name: en.add })).toBeNull()
    expect(host.count(`GET ${DEVICE_ROUTES.devices}`)).toBe(0)
  })

  it('shows no devices yet, and no error, before the home has an owner', async () => {
    const host = fakeHost({ [`GET ${DEVICE_ROUTES.reachStatus}`]: READY, [`GET ${DEVICE_ROUTES.devices}`]: refusal(403, 'NO_OWNER') })
    renderSection(host)
    expect(await screen.findByText(en['devices.none'])).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not ask for the device list while the reach status says nobody has claimed the home', async () => {
    const unclaimed = { status: 200, body: { ...READY.body, hasOwner: false } }
    const host = fakeHost({ [`GET ${DEVICE_ROUTES.reachStatus}`]: unclaimed, [`GET ${DEVICE_ROUTES.devices}`]: refusal(403, 'NO_OWNER') })
    renderSection(host)
    expect(await screen.findByText(en['devices.none'])).toBeTruthy()
    expect(host.count(`GET ${DEVICE_ROUTES.devices}`)).toBe(0)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reads the owner flag of the reach status', async () => {
    const host = fakeHost({ [`GET ${DEVICE_ROUTES.reachStatus}`]: { status: 200, body: { ...READY.body, hasOwner: false } } })
    expect((await readReachStatus(host.fetch))?.hasOwner).toBe(false)
  })

  it('shows no devices yet for an owner whose list is empty', async () => {
    const host = fakeHost({ [`GET ${DEVICE_ROUTES.reachStatus}`]: READY, [`GET ${DEVICE_ROUTES.devices}`]: { status: 200, body: { owner: OWNER, devices: [] } } })
    renderSection(host)
    expect(await screen.findByText(en['devices.none'])).toBeTruthy()
  })

  it('lists each device with its platform, address, approval and last sign-in', async () => {
    const host = standardHost()
    renderSection(host)
    expect(await screen.findByText('Pixel 9')).toBeTruthy()
    expect(screen.getByText(`Remote access is on at ${READY.body.options[0]?.address ?? ''}`)).toBeTruthy()
    const [first, second] = screen.getAllByRole('listitem')
    if (first === undefined || second === undefined) throw new Error('two devices expected')
    expect(first.textContent).toContain('Android · https://home.example.ts.net')
    expect(first.textContent).toContain('Approved at this computer')
    expect(first.textContent).toContain('Last signed in')
    expect(second.textContent).toContain('Work laptop')
    expect(second.textContent).not.toContain('at this computer')
    expect(second.textContent).toContain(en['device.neverSignedIn'])
  })

  it.each([
    { state: 'off', shown: en['reach.off'] },
    { state: 'starting', shown: en['reach.starting'] },
    { state: 'degraded', shown: en['reach.degraded'] },
    { state: 'stopping', shown: en['reach.stopping'] },
    { state: 'blocked', shown: en['reach.blocked'] },
    { state: 'failed', shown: en['reach.failed'] },
    { state: 'ready', shown: en['reach.readyNoAddress'] },
  ])('states the reach state $state', async ({ state, shown }) => {
    const host = fakeHost({
      [`GET ${DEVICE_ROUTES.reachStatus}`]: { status: 200, body: { available: true, hasOwner: true, options: [{ option: 'tailscale-private', state }] } },
      [`GET ${DEVICE_ROUTES.devices}`]: refusal(403, 'NO_OWNER'),
    })
    const { container } = renderSection(host)
    expect(await screen.findByText(shown, { exact: false })).toBeTruthy()
    expect(container.querySelector(`[data-reach-state="${state}"]`)).not.toBeNull()
    if (state === 'off') expect(screen.getByText(REACH_ON_COMMAND).tagName).toBe('CODE')
  })

  it.each(['blocked', 'failed'])('states the Host\'s sentence for a %s option', async (state) => {
    const detail = 'Tailscale is not signed in on this computer.'
    const host = fakeHost({
      [`GET ${DEVICE_ROUTES.reachStatus}`]: { status: 200, body: { available: true, hasOwner: true, options: [{ option: 'tailscale-private', state, cause: 'TAILSCALE_LOGGED_OUT', detail }] } },
      [`GET ${DEVICE_ROUTES.devices}`]: refusal(403, 'NO_OWNER'),
    })
    renderSection(host)
    expect(await screen.findByText(detail)).toBeTruthy()
  })

  it('adds a device: opens the window and reads the pending requests every two seconds while it is open', async () => {
    fakeClock()
    const host = standardHost()
    renderSection(host)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    await settle()
    expect(host.count(`POST ${DEVICE_ROUTES.window}`)).toBe(1)
    expect(host.received.find(request => request.key === `POST ${DEVICE_ROUTES.window}`)?.body).toEqual({})
    expect(screen.getByText(en.waiting)).toBeTruthy()
    expect(screen.getByText('iPad')).toBeTruthy()
    expect((screen.getByRole('button', { name: en.add }) as HTMLButtonElement).disabled).toBe(true)
    expect(host.count(`GET ${DEVICE_ROUTES.pending}`)).toBe(1)
    await settle(PENDING_POLL_MS)
    expect(host.count(`GET ${DEVICE_ROUTES.pending}`)).toBe(2)
    // The Host closes the window: the waiting statement goes and the reads stop.
    host.script[`GET ${DEVICE_ROUTES.pending}`] = { status: 200, body: { windowClosesAt: null, pending: [], pairing: VIEW } }
    await settle(PENDING_POLL_MS)
    expect(host.count(`GET ${DEVICE_ROUTES.pending}`)).toBe(3)
    expect(screen.queryByText(en.waiting)).toBeNull()
    await settle(PENDING_POLL_MS * 3)
    expect(host.count(`GET ${DEVICE_ROUTES.pending}`)).toBe(3)
  })

  it('stops reading the pending requests once the window\'s closing time passes', async () => {
    fakeClock()
    const host = standardHost()
    host.script[`POST ${DEVICE_ROUTES.window}`] = { status: 200, body: { closesAt: NOW + PENDING_POLL_MS * 1.5 } }
    host.script[`GET ${DEVICE_ROUTES.pending}`] = { status: 200, body: { windowClosesAt: NOW + PENDING_POLL_MS * 1.5, pending: [], pairing: VIEW } }
    renderSection(host)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    await settle()
    expect(screen.getByText(en.waiting)).toBeTruthy()
    await settle(PENDING_POLL_MS)
    expect(host.count(`GET ${DEVICE_ROUTES.pending}`)).toBe(2)
    expect(screen.getByText(en.waiting)).toBeTruthy()
    // The next read would come after the closing time: there is none, and the waiting statement goes.
    await settle(PENDING_POLL_MS * 4)
    expect(host.count(`GET ${DEVICE_ROUTES.pending}`)).toBe(2)
    expect(screen.queryByText(en.waiting)).toBeNull()
  })

  it('approves a request with the typed code, stops reading pending requests and refreshes the list', async () => {
    fakeClock()
    const host = standardHost()
    host.script[`POST ${DEVICE_ROUTES.approve}`] = { status: 200, body: { device: { id: 'c'.repeat(43), label: 'iPad', address: REQUEST.address } } }
    renderSection(host)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    await settle()
    const input = screen.getByRole('textbox', { name: 'Code shown on iPad' })
    const approve = screen.getByRole('button', { name: en['pending.approve'] }) as HTMLButtonElement
    fireEvent.change(input, { target: { value: '1234 567' } })
    expect(approve.disabled).toBe(true)
    fireEvent.change(input, { target: { value: '1234-5678' } })
    expect(approve.disabled).toBe(false)
    host.script[`GET ${DEVICE_ROUTES.devices}`] = { status: 200, body: { owner: OWNER, devices: [DEVICE_A, DEVICE_B, { ...DEVICE_A, id: 'c'.repeat(43), label: 'iPad' }] } }
    fireEvent.click(approve)
    await settle()
    expect(host.received.find(request => request.key === `POST ${DEVICE_ROUTES.approve}`)?.body).toEqual({ requestId: 'request-1', typedCode: '12345678' })
    expect(screen.queryByText(en.waiting)).toBeNull()
    expect(host.count(`GET ${DEVICE_ROUTES.devices}`)).toBe(2)
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    const reads = host.count(`GET ${DEVICE_ROUTES.pending}`)
    await settle(PENDING_POLL_MS * 3)
    expect(host.count(`GET ${DEVICE_ROUTES.pending}`)).toBe(reads)
  })

  it('shows the Host\'s sentence in place for a wrong code, and keeps it once the request is cancelled', async () => {
    fakeClock()
    const host = standardHost()
    const mismatch = 'The code does not match. Check the code on the device and type it again.'
    host.script[`POST ${DEVICE_ROUTES.approve}`] = refusal(400, 'APPROVAL_CODE_MISMATCH', mismatch)
    renderSection(host)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    await settle()
    fireEvent.change(screen.getByRole('textbox', { name: 'Code shown on iPad' }), { target: { value: '11112222' } })
    fireEvent.submit(screen.getByRole('textbox', { name: 'Code shown on iPad' }).closest('form') ?? document.body)
    await settle()
    const row = screen.getByText('iPad').closest('[data-request-id]')
    if (!(row instanceof HTMLElement)) throw new Error('no pending row')
    expect(within(row).getByRole('alert').textContent).toBe(mismatch)
    expect(screen.getByText(en.waiting)).toBeTruthy()
    // A third wrong code cancels the request; the refusal stays in the waiting area.
    host.script[`GET ${DEVICE_ROUTES.pending}`] = { status: 200, body: { windowClosesAt: NOW + 300_000, pending: [], pairing: VIEW } }
    await settle(PENDING_POLL_MS)
    expect(screen.queryByText('iPad')).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe(mismatch)
  })

  it('cancels a waiting device the person does not recognise, and shows a refusal in its row', async () => {
    fakeClock()
    const host = standardHost()
    host.script[`POST ${DEVICE_ROUTES.cancel}`] = refusal(410, 'APPROVAL_EXPIRED', 'This request is no longer waiting.')
    renderSection(host)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en['pending.cancel'] }))
    await settle()
    const row = screen.getByText('iPad').closest('[data-request-id]')
    if (!(row instanceof HTMLElement)) throw new Error('no pending row')
    expect(within(row).getByRole('alert').textContent).toBe('This request is no longer waiting.')
    host.script[`POST ${DEVICE_ROUTES.cancel}`] = { status: 200, body: { cancelled: 'request-1' } }
    fireEvent.click(screen.getByRole('button', { name: en['pending.cancel'] }))
    await settle()
    expect(host.received.filter(request => request.key === `POST ${DEVICE_ROUTES.cancel}`).map(request => request.body))
      .toEqual([{ requestId: 'request-1' }, { requestId: 'request-1' }])
    // The cancelled request leaves the list at once; the Host no longer lists it either.
    expect(screen.queryByText('iPad')).toBeNull()
  })

  it('removes a device only after confirmation and refreshes the list', async () => {
    const host = standardHost()
    host.script[`POST ${DEVICE_ROUTES.remove}`] = { status: 200, body: { removed: true, sessions: 1, connections: 2 } }
    renderSection(host)
    const row = (await screen.findByText('Work laptop')).closest('li')
    if (row === null) throw new Error('no device row')
    fireEvent.click(within(row).getByRole('button', { name: en['device.remove'] }))
    let dialog = screen.getByRole('dialog', { name: 'Remove Work laptop?' })
    expect(within(dialog).getByText(en['remove.body'])).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en['remove.cancel'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(host.count(`POST ${DEVICE_ROUTES.remove}`)).toBe(0)
    fireEvent.click(within(row).getByRole('button', { name: en['device.remove'] }))
    dialog = screen.getByRole('dialog', { name: 'Remove Work laptop?' })
    host.script[`GET ${DEVICE_ROUTES.devices}`] = { status: 200, body: { owner: OWNER, devices: [DEVICE_A] } }
    fireEvent.click(within(dialog).getByRole('button', { name: en['remove.confirm'] }))
    await vi.waitFor(() => { expect(screen.queryByText('Work laptop')).toBeNull() })
    expect(host.received.find(request => request.key === `POST ${DEVICE_ROUTES.remove}`)?.body).toEqual({ v: 1, deviceId: DEVICE_B.id })
    expect(host.count(`GET ${DEVICE_ROUTES.devices}`)).toBe(2)
  })

  it('closes the removal dialog from its close control without removing', async () => {
    const host = standardHost()
    renderSection(host)
    fireEvent.click((await screen.findAllByRole('button', { name: en['device.remove'] }))[0] ?? document.body)
    fireEvent.click(screen.getByRole('button', { name: en['remove.close'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(host.count(`POST ${DEVICE_ROUTES.remove}`)).toBe(0)
  })

  describe('at a remote studio, where the home refuses device management', () => {
    const atYourComputer = (action: string): string => `This needs you at your computer: ${action}.`

    it('says so for reading the remote access state and the device list', async () => {
      const host = fakeHost({ [`GET ${DEVICE_ROUTES.reachStatus}`]: loopbackRefusal, [`GET ${DEVICE_ROUTES.devices}`]: loopbackRefusal })
      renderSection(host)
      expect(await screen.findByText(atYourComputer(en['action.status']))).toBeTruthy()
      expect(await screen.findByText(atYourComputer(en['action.list']))).toBeTruthy()
      expect(screen.queryByText(loopbackRefusal.body.message)).toBeNull()
    })

    it('says so for adding a device', async () => {
      const host = standardHost()
      host.script[`POST ${DEVICE_ROUTES.window}`] = loopbackRefusal
      renderSection(host)
      fireEvent.click(await screen.findByRole('button', { name: en.add }))
      expect((await screen.findByRole('alert')).textContent).toBe(atYourComputer(en['action.add']))
      expect(screen.queryByText(en.waiting)).toBeNull()
    })

    it('says so for approving a device', async () => {
      const host = standardHost()
      host.script[`POST ${DEVICE_ROUTES.approve}`] = loopbackRefusal
      renderSection(host)
      fireEvent.click(await screen.findByRole('button', { name: en.add }))
      fireEvent.change(await screen.findByRole('textbox', { name: 'Code shown on iPad' }), { target: { value: '12345678' } })
      fireEvent.click(screen.getByRole('button', { name: en['pending.approve'] }))
      expect((await screen.findByRole('alert')).textContent).toBe(atYourComputer(en['action.approve']))
    })

    it('says so for cancelling a device request', async () => {
      const host = standardHost()
      host.script[`POST ${DEVICE_ROUTES.cancel}`] = loopbackRefusal
      renderSection(host)
      fireEvent.click(await screen.findByRole('button', { name: en.add }))
      fireEvent.click(await screen.findByRole('button', { name: en['pending.cancel'] }))
      expect((await screen.findByRole('alert')).textContent).toBe(atYourComputer(en['action.cancel']))
    })

    it('says so for reading the pending requests, and stops reading them', async () => {
      const host = standardHost()
      host.script[`GET ${DEVICE_ROUTES.pending}`] = loopbackRefusal
      renderSection(host)
      fireEvent.click(await screen.findByRole('button', { name: en.add }))
      expect((await screen.findByRole('alert')).textContent).toBe(atYourComputer(en['action.approve']))
      expect(screen.queryByText(en.waiting)).toBeNull()
    })

    it('says so for removing a device, and keeps the device', async () => {
      const host = standardHost()
      host.script[`POST ${DEVICE_ROUTES.remove}`] = loopbackRefusal
      renderSection(host)
      const row = (await screen.findByText('Pixel 9')).closest('li')
      if (row === null) throw new Error('no device row')
      fireEvent.click(within(row).getByRole('button', { name: en['device.remove'] }))
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['remove.confirm'] }))
      expect((await within(row).findByRole('alert')).textContent).toBe(atYourComputer(en['action.remove']))
      expect(screen.getByText('Pixel 9')).toBeTruthy()
    })
  })

  it('stops reading the pending requests when it unmounts', async () => {
    fakeClock()
    const host = standardHost()
    const { unmount } = renderSection(host)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    await settle()
    expect(host.count(`GET ${DEVICE_ROUTES.pending}`)).toBe(1)
    unmount()
    await settle(PENDING_POLL_MS * 5)
    expect(host.count(`GET ${DEVICE_ROUTES.pending}`)).toBe(1)
  })

  it.each(['answers', 'fails'] as const)('ignores a pending read that %s after it unmounts', async (outcome) => {
    fakeClock()
    const host = standardHost()
    const late = Promise.withResolvers<{ status: number; body: unknown }>()
    host.script[`GET ${DEVICE_ROUTES.pending}`] = late.promise
    const { unmount } = renderSection(host)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    await settle()
    unmount()
    late.resolve(outcome === 'answers' ? { status: 200, body: { windowClosesAt: NOW + 300_000, pending: [REQUEST], pairing: VIEW } } : loopbackRefusal)
    await settle(PENDING_POLL_MS * 3)
    expect(host.count(`GET ${DEVICE_ROUTES.pending}`)).toBe(1)
  })

  it.each(['answers', 'fails'] as const)('ignores a reach state that %s after it unmounts', async (outcome) => {
    const late = Promise.withResolvers<{ status: number; body: unknown }>()
    const host = fakeHost({ [`GET ${DEVICE_ROUTES.reachStatus}`]: late.promise })
    const { unmount } = renderSection(host)
    unmount()
    late.resolve(outcome === 'answers' ? READY : loopbackRefusal)
    await act(async () => { await late.promise })
    expect(host.count(`GET ${DEVICE_ROUTES.reachStatus}`)).toBe(1)
    expect(host.count(`GET ${DEVICE_ROUTES.devices}`)).toBe(0)
  })

  it.each([
    { name: 'an unreachable home', answer: 'unreachable' as const, shown: en['failed.unreachable'] },
    { name: 'an answer that is not JSON', answer: { status: 200, text: '<html>' }, shown: en['failed.unreadable'] },
    { name: 'an answer of the wrong form', answer: { status: 200, body: { available: true, hasOwner: true, options: [{ option: 'x', state: 'asleep' }] } }, shown: en['failed.unreadable'] },
    { name: 'a refusal of the wrong form', answer: { status: 500, body: { problem: true } }, shown: en['failed.unreadable'] },
    { name: 'another refusal', answer: refusal(500, 'INTERNAL', 'The home could not read its reach state.'), shown: 'The home could not read its reach state.' },
  ])('says what failed for $name', async ({ answer, shown }) => {
    const host = fakeHost({ [`GET ${DEVICE_ROUTES.reachStatus}`]: answer, [`GET ${DEVICE_ROUTES.devices}`]: refusal(403, 'NO_OWNER') })
    renderSection(host)
    expect((await screen.findByRole('alert')).textContent).toBe(shown)
  })

  it('has a Chinese entry for every English key', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})

describe('the device requests', () => {
  it('send same-origin requests, with JSON bodies on POST', async () => {
    const host = fakeHost({
      [`GET ${DEVICE_ROUTES.reachStatus}`]: READY,
      [`POST ${DEVICE_ROUTES.window}`]: { status: 200, body: { closesAt: NOW } },
      [`GET ${DEVICE_ROUTES.pending}`]: { status: 200, body: { windowClosesAt: null, pending: [], pairing: VIEW } },
      [`POST ${DEVICE_ROUTES.approve}`]: { status: 200, body: { device: { id: DEVICE_A.id, label: 'x', address: 'y' } } },
      [`POST ${DEVICE_ROUTES.remove}`]: { status: 200, body: { removed: false, sessions: 0, connections: 0 } },
      [`GET ${DEVICE_ROUTES.devices}`]: refusal(403, 'NO_OWNER'),
    })
    expect(await readReachStatus(host.fetch)).toEqual(READY.body)
    expect(await readDevices(host.fetch)).toBeUndefined()
    expect(await openApprovalWindow(host.fetch)).toBe(NOW)
    expect(await readPendingDevices(host.fetch)).toEqual({ windowClosesAt: null, pending: [], pairing: VIEW })
    expect((await approveDevice(host.fetch, 'r' as ApprovalRequestId, '12345678')).device.id).toBe(DEVICE_A.id)
    expect(await removeDevice(host.fetch, DEVICE_A.id as DeviceId)).toEqual({ removed: false, sessions: 0, connections: 0 })
    for (const { init } of host.received) expect(init?.credentials).toBe('same-origin')
    const posts = host.received.filter(request => request.key.startsWith('POST'))
    expect(posts).toHaveLength(3)
    for (const { init } of posts) expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
  })

  it('read a 404 as a profile without reach, and throw other failures', async () => {
    expect(await readReachStatus(fakeHost().fetch)).toBeUndefined()
    await expect(readReachStatus(fakeHost({ [`GET ${DEVICE_ROUTES.reachStatus}`]: 'unreachable' as const }).fetch)).rejects.toBeInstanceOf(HostRequestError)
    await expect(readDevices(fakeHost({ [`GET ${DEVICE_ROUTES.devices}`]: loopbackRefusal }).fetch)).rejects.toThrow('LOOPBACK_REQUIRED')
  })

  it('name the failure of any caught error', () => {
    const cause = new Error('bug')
    expect(hostFailureOf(cause)).toEqual({ kind: 'unreachable', cause })
    expect(isRefused(cause, 'NO_OWNER')).toBe(false)
    expect(failureText(makeTranslate(en), cause, 'list')).toBe(en['failed.unreachable'])
    expect(new HostRequestError('/x', { kind: 'unreachable', cause }).cause).toBe(cause)
  })

  it('read a typed code without its spaces and hyphens', () => {
    expect(approvalCode(' 1234 - 5678 ')).toBe('12345678')
  })
})

const SESSION = 'session-1' as Parameters<PermissionSwitchConsent['confirm']>[0]

describe('the plugin', () => {
  it('registers the Devices section right after Privacy, with the browser\'s fetch, and the refused-answer notice', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SlotRegistry).await()
      ctx.provide('locale', new LocaleRuntime(ctx))
      // Read only when the "Allow for this chat" choice switches a live chat.
      ctx.provide('sessions', {})
      new TestRemote(ctx, { settings: { describe: vi.fn(async () => ({ ok: true as const, value: { writable: true, hasDocument: true, namespaces: [] } })) } })
      await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
      const slots = ctx.get('slots')
      if (slots === undefined) throw new Error('no slot registry')
      slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' }, 'settings.section.icon': { kind: 'list', scope: 'root', inline: true }, 'shell.overlay': { kind: 'list', scope: 'root' }, 'settings.onboarding': { kind: 'list', scope: 'root' }, 'sidebar.brand.mark': { kind: 'single', scope: 'root' }, 'sidebar.brand.name': { kind: 'single', scope: 'root' }, 'conversation.approval.action': { kind: 'list', scope: 'session' }, 'conversation.input.dock': { kind: 'list', scope: 'session' } }, inject: () => ({}) },
        ({ renderSlot }) => <>{renderSlot('settings.section', { close: () => {} })}</>)
      await ctx.plugin({ inject: [], apply: connectionApply }).await()
      await ctx.plugin({ inject, apply }).await()
      const sections = slots.entries('settings.section').map(entry => entry.options)
      expect(sections).toMatchObject([
        { id: PLUGIN_INSTALLS_SECTION_ID, order: PLUGIN_INSTALLS_SECTION_ORDER },
        { id: PRIVACY_SECTION_ID, order: PRIVACY_SECTION_ORDER }, { id: DEVICES_SECTION_ID, order: DEVICES_SECTION_ORDER },
        { id: PIN_MODE_SECTION_ID, order: PIN_MODE_SECTION_ORDER },
        { id: FACE_ID_SECTION_ID, order: FACE_ID_SECTION_ORDER },
        { id: PERMISSIONS_SECTION_ID, order: PERMISSIONS_SECTION_ORDER },
        { id: EXTERNAL_AGENTS_SECTION_ID, order: EXTERNAL_AGENTS_SECTION_ORDER },
        { id: NETWORK_SECTION_ID, order: NETWORK_SECTION_ORDER }, { id: SETUP_VERSIONS_SECTION_ID, order: SETUP_VERSIONS_SECTION_ORDER }, { id: ABOUT_SECTION_ID, order: ABOUT_SECTION_ORDER },
        { id: SETUP_COMMANDS_SECTION_ID, order: SETUP_COMMANDS_SECTION_ORDER },
      ])
      expect(DEVICES_SECTION_ORDER).toBe(PRIVACY_SECTION_ORDER + 1)
      expect(sections.map(section => typeof section.label === 'function' ? section.label() : section.label))
        .toEqual(['Plugin downloads', 'Privacy', en.nav, 'PIN mode', 'Face ID', 'Permissions', 'External agents', 'Network', 'Setup versions', 'About', 'How Delorun runs'])
      // The preview notice's copy lookup reads the Privacy dictionary.
      const notice = slots.entries('settings.onboarding')[0]?.inject?.() as { t: (key: string) => string }
      expect(notice.t('notice.continue')).toBe('Continue')
      expect(slots.entries('shell.overlay').map(entry => entry.options.id)).toEqual([PAIRING_NOTICE_ID, FACE_ID_GRANT_ID, FACE_ID_OVERLAY_ID, REMOTE_NOTICE_ID, FULL_ACCESS_CONSENT_ID, MCP_REVIEW_ID, CONSENT_TOAST_ID])
      // Each overlay and each section with a store (the About section has none) read their store's view and actions.
      for (const entry of [...slots.entries('shell.overlay'), ...slots.entries('settings.section').filter(section => section.options.id !== ABOUT_SECTION_ID)]) expect(entry.inject?.()).toBeTypeOf('object')
      // The card that an MCP server wants to start sits above the composer, not over the transcript.
      expect(slots.entries('conversation.input.dock').map(entry => entry.options.id)).toEqual([MCP_WAITING_NOTICE_ID])
      // Each approval card action is bound to the card's chat.
      const actions = slots.entries('conversation.approval.action')
      expect(actions.map(entry => entry.options.id)).toEqual([FACE_ID_ANSWER_ID, FULL_ACCESS_ACTION_ID, EXTERNAL_AGENT_ACTION_ID])
      for (const action of actions) expect((action.inject as ((sessionId: typeof SESSION) => object) | undefined)?.(SESSION)).toMatchObject({ sessionId: SESSION })
      await expect(ctx.get('permissionSwitchConsent')?.confirm(SESSION, 'ask')).resolves.toBe(true)
      expect(slots.entries('settings.section.icon').filter(entry => entry.options.id === DEVICES_SECTION_ID).map(entry => [entry.options.id, entry.component])).toEqual([[DEVICES_SECTION_ID, IconLinkOutlineMedium]])
      const browserFetch = vi.fn(async () => Response.json(READY.body))
      vi.stubGlobal('fetch', browserFetch)
      const devicesEntry = slots.entries('settings.section')[2]
      const face = devicesEntry?.inject?.() as { fetch: HostFetch }
      // A stable request function: the section's requests restart when it changes.
      expect((devicesEntry?.inject?.() as { fetch: HostFetch }).fetch).toBe(face.fetch)
      expect(await readReachStatus(face.fetch)).toEqual(READY.body)
      expect(browserFetch).toHaveBeenCalledWith(DEVICE_ROUTES.reachStatus, expect.objectContaining({ credentials: 'same-origin' }))
      // The External agents section's settings read and write the consent row's Host form.
      const agentsInject = slots.entries('settings.section').find(entry => entry.options.id === EXTERNAL_AGENTS_SECTION_ID)?.inject as (() => ExternalAgentsSectionInjected) | undefined
      const agents = agentsInject?.()
      if (agents === undefined) throw new Error('no External agents section face')
      expect(agents.hooks.agentSettings).toBe(ctx.get('configForms')?.get(DELEGATION_CONSENT_ROW))
      await agents.setAgentSetting('runTimeoutMinutes', 45)
      expect(agents.hooks.agentSettingsMutation.getSnapshot()).toEqual({ busy: false, failed: true })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
