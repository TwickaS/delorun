// @vitest-environment jsdom
/**
 * The Face ID screens: the action sheet's tap-to-prompt order and its cancel, failure and no-passkey outcomes, the
 * pairing step, "Add Face ID" with its code, the computer's code entry and the passkey list's removals.
 *
 * Each test's comment names the behaviour whose removal makes it fail.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en, zh } from '../src/client/face-id-locales.ts'
import { faceIdKindOf, fromBase64Url, passkeyFailure, toBase64Url } from '../src/client/face-id-browser.ts'
import { fakeApi, fakeBrowser } from '../src/client/face-id-fake.ts'
import { FACE_ID_KINDS, type FaceIdAction, type PasskeyDevice } from '../src/client/face-id-types.ts'
import { FaceIdSheet } from '../src/client/FaceIdSheet.tsx'
import { AddFaceId, CODE_POLL_MS, FaceIdPairingStep, PasskeyCodeEntry } from '../src/client/FaceIdEnrol.tsx'
import { PasskeyDevices } from '../src/client/PasskeyDevices.tsx'

const t = makeTranslate(en)
const action: FaceIdAction = { name: 'plugin.install', title: 'Install “Reports”?', body: 'It can read your files.', bodyHash: 'h', items: ['a', 'b', 'c', 'd', 'e'] }
const key = (value: string) => ({ id: value, kind: 'faceId' as const, addedAt: Date.UTC(2026, 10, 18), usesToday: 2, synced: true })
const phone: PasskeyDevice = { id: 'd1', label: 'iPhone', thisDevice: true, passkeys: [key('p1')] }
const laptop: PasskeyDevice = { id: 'd2', label: 'Laptop', thisDevice: false, lastSeenAt: Date.UTC(2026, 10, 17), passkeys: [] }

afterEach(() => { cleanup(); vi.useRealTimers() })

function sheet(over: Partial<Parameters<typeof FaceIdSheet>[0]> = {}) {
  const props = { t, action, kind: 'faceId' as const, api: fakeApi(), browser: fakeBrowser(), hasPasskey: true, fallback: 'pin' as const,
    onGranted: vi.fn(), onCancel: vi.fn(), onFallback: vi.fn(), ...over }
  render(<FaceIdSheet {...props} />)
  return props
}

describe('dictionaries', () => {
  it('has the same keys in English and Chinese', () => {
    // Removing a Chinese entry leaves the locale incomplete.
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})

describe('browser helpers', () => {
  it('round-trips base64url', () => {
    // A padding or alphabet slip breaks every challenge the home sends.
    const bytes = new Uint8Array([251, 255, 0, 1, 2]).buffer
    expect([...fromBase64Url(toBase64Url(bytes))]).toEqual([251, 255, 0, 1, 2])
  })
  it('sorts dismissals as cancels and everything else as failures', () => {
    // A dismissal counted as a failure would show an error for a person's own cancel.
    expect(passkeyFailure(Object.assign(new Error('x'), { name: 'NotAllowedError' }))).toEqual({ kind: 'cancelled' })
    expect(passkeyFailure(new Error('x'))).toEqual({ kind: 'failed' })
  })
  it('names the platform unlock for every kind', () => {
    // The button names this noun; a wrong guess misnames the unlock.
    expect(faceIdKindOf({ userAgent: 'iPhone', platform: 'iPhone', maxTouchPoints: 5 })).toBe('faceId')
    expect(faceIdKindOf({ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0 })).toBe('touchId')
    expect(faceIdKindOf({ userAgent: 'Windows', platform: 'Win32', maxTouchPoints: 0 })).toBe('windowsHello')
    expect(faceIdKindOf({ userAgent: 'Android', platform: 'Linux armv8', maxTouchPoints: 5 })).toBe('fingerprint')
    expect(faceIdKindOf({ userAgent: 'X11', platform: 'Linux', maxTouchPoints: 0 })).toBe('deviceLock')
    expect(FACE_ID_KINDS).toHaveLength(5)
  })
})

describe('FaceIdSheet', () => {
  it('does not prompt on open and lists at most three items', () => {
    // An auto-prompt on open would lose Safari's gesture window.
    const browser = fakeBrowser()
    sheet({ browser })
    expect(browser.calls).toEqual([])
    expect(screen.getByText('Install “Reports”?')).toBeTruthy()
    expect(screen.getByText('and 2 more')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirm with Face ID' })).toBeTruthy()
  })
  it('fetches options then asks the browser, and reports the grant', async () => {
    // Skipping the verify call would never produce a grant.
    const api = fakeApi()
    const browser = fakeBrowser()
    const props = sheet({ api, browser })
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm with Face ID' }))
    await waitFor(() => { expect(props.onGranted).toHaveBeenCalledWith('g1') })
    expect(api.calls.map(call => call.name)).toEqual(['assertionOptions', 'verifyAssertion'])
    expect(browser.calls).toEqual(['get'])
  })
  it('shows the PIN link straight after a cancel, without an error alert', async () => {
    // Extension 4: a cancel leads to the PIN link at once.
    const props = sheet({ browser: fakeBrowser({ get: [{ kind: 'cancelled' }] }) })
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm with Face ID' }))
    const link = await screen.findByRole('button', { name: 'Use PIN instead' })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(link)
    expect(props.onFallback).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Try Face ID again' })).toBeTruthy()
  })
  it('offers Approve at the computer when no PIN is set', async () => {
    // Without a PIN the way down is the computer.
    sheet({ fallback: 'computer', browser: fakeBrowser({ get: [{ kind: 'failed' }] }) })
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm with Face ID' }))
    expect(await screen.findByRole('button', { name: 'Approve at the computer' })).toBeTruthy()
    expect(screen.getByText('Face ID did not work.')).toBeTruthy()
  })
  it('fails when the options or the verification are refused', async () => {
    // A refused request must not be reported as a grant.
    const props = sheet({ api: fakeApi({ failOptions: true }) })
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm with Face ID' }))
    expect(await screen.findByText('Face ID did not work.')).toBeTruthy()
    expect(props.onGranted).not.toHaveBeenCalled()
    cleanup()
    const second = sheet({ api: fakeApi({ failVerify: true }) })
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm with Face ID' }))
    expect(await screen.findByText('Face ID did not work.')).toBeTruthy()
    expect(second.onGranted).not.toHaveBeenCalled()
  })
  it('goes straight to the way down without a passkey or support', async () => {
    // A device with no passkey must not offer a prompt that cannot work.
    const onOpenDevices = vi.fn()
    sheet({ hasPasskey: false, onOpenDevices })
    expect(screen.queryByRole('button', { name: 'Confirm with Face ID' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open Devices' }))
    expect(onOpenDevices).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Use PIN instead' })).toBeTruthy()
    cleanup()
    sheet({ browser: fakeBrowser({ available: false }) })
    expect(await screen.findByText('This browser cannot use Face ID here.')).toBeTruthy()
  })
  it('names Touch ID or Windows Hello on a computer and cancels on Escape', async () => {
    // B5: wording follows the platform.
    const props = sheet({ kind: 'windowsHello' })
    expect(await screen.findByRole('button', { name: 'Confirm with Windows Hello' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(props.onCancel).toHaveBeenCalled()
  })
})

describe('FaceIdPairingStep', () => {
  const step = (over: Partial<Parameters<typeof FaceIdPairingStep>[0]> = {}) => {
    const props = { t, kind: 'faceId' as const, api: fakeApi(), browser: fakeBrowser(), ticket: 'tk', onDone: vi.fn(), onSkip: vi.fn(), ...over }
    render(<FaceIdPairingStep {...props} />)
    return props
  }
  it('names Stolen Device Protection and registers with the ticket', async () => {
    // The ticket is what ties enrolment to the pairing approval.
    const api = fakeApi()
    const props = step({ api })
    expect(screen.getByText(/Stolen Device Protection/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Set up Face ID' }))
    await waitFor(() => { expect(props.onDone).toHaveBeenCalled() })
    expect(api.calls[0]).toEqual({ name: 'registrationOptions', request: { ticket: 'tk' } })
  })
  it('retries once, then offers Continue without a passkey', async () => {
    // Two failures must not trap a person in the pairing.
    const props = step({ browser: fakeBrowser({ create: [{ kind: 'failed' }] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Set up Face ID' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Try Face ID again' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    expect(props.onSkip).toHaveBeenCalled()
  })
  it('skips, and fails on refused options or registration', async () => {
    // Skip leaves the device paired; refusals count as failures.
    const props = step({ api: fakeApi({ failOptions: true }) })
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
    expect(props.onSkip).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Set up Face ID' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    cleanup()
    const api = fakeApi()
    api.register = async () => { throw new Error('no') }
    step({ api })
    fireEvent.click(screen.getByRole('button', { name: 'Set up Face ID' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})

describe('AddFaceId', () => {
  const add = (api = fakeApi({ code: '12345678' }), browser = fakeBrowser()) => {
    const props = { t, kind: 'faceId' as const, api, browser, onDone: vi.fn(), onCancel: vi.fn() }
    render(<AddFaceId {...props} />)
    return props
  }
  it('shows the code and finishes when the computer accepts it', async () => {
    // The phone must show the code and poll for the computer's answer.
    vi.useFakeTimers()
    const props = add(fakeApi({ code: '12345678', state: ['pending', 'done'] }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Set up Face ID' })) })
    expect(screen.getByText('12345678')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(CODE_POLL_MS * 2) })
    expect(props.onDone).toHaveBeenCalled()
  })
  it('reports a refused code and a failed setup', async () => {
    // A refusal must show, not wait forever.
    vi.useFakeTimers()
    add(fakeApi({ code: '12345678', state: ['refused'] }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Set up Face ID' })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(CODE_POLL_MS) })
    expect(screen.getByText(/did not accept the code/)).toBeTruthy()
    cleanup()
    vi.useRealTimers()
    add(fakeApi(), fakeBrowser({ create: [{ kind: 'failed' }] }))
    fireEvent.click(screen.getByRole('button', { name: 'Set up Face ID' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
  it('finishes at once when no code is needed, and cancels', async () => {
    // A `done` answer needs no code screen.
    const props = add(fakeApi())
    fireEvent.click(screen.getByRole('button', { name: 'Set up Face ID' }))
    await waitFor(() => { expect(props.onDone).toHaveBeenCalled() })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onCancel).toHaveBeenCalled()
  })
  it('fails when the options request is refused', async () => {
    // A refused options request must not hang on "waiting".
    add(fakeApi({ failOptions: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Set up Face ID' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})

describe('PasskeyCodeEntry', () => {
  it('confirms eight digits and reports a mismatch', async () => {
    // Confirm stays disabled until the code is complete; a wrong code shows the mismatch.
    const onDone = vi.fn()
    const api = fakeApi({ matched: false })
    render(<PasskeyCodeEntry t={t} api={api} onDone={onDone} />)
    const confirm = screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Code from the device'), { target: { value: '1234 5678' } })
    fireEvent.click(confirm)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
    expect(api.calls.at(-1)).toEqual({ name: 'confirmCode', request: '12345678' })
  })
  it('finishes on a match and treats a refused request as a mismatch', async () => {
    // A thrown request must not leave the form stuck busy.
    const onDone = vi.fn()
    render(<PasskeyCodeEntry t={t} api={fakeApi()} onDone={onDone} />)
    fireEvent.change(screen.getByLabelText('Code from the device'), { target: { value: '12345678' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => { expect(onDone).toHaveBeenCalled() })
    cleanup()
    const api = fakeApi()
    api.confirmCode = async () => { throw new Error('no') }
    render(<PasskeyCodeEntry t={t} api={api} onDone={onDone} />)
    fireEvent.change(screen.getByLabelText('Code from the device'), { target: { value: '12345678' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})

describe('PasskeyDevices', () => {
  const list = (over: Partial<Parameters<typeof PasskeyDevices>[0]> = {}) => {
    const api = over.api ?? fakeApi({ devices: [phone, laptop] })
    const props = { t, api, browser: fakeBrowser(), kind: 'faceId' as const, atComputer: false, fallback: 'pin' as const, hasPasskey: true,
      onAdd: vi.fn(), onFallback: vi.fn(), hashOf: () => 'hash', ...over }
    render(<PasskeyDevices {...props} />)
    return { ...props, api: api as ReturnType<typeof fakeApi> }
  }
  it('lists each device with its passkeys and Add Face ID where this device has none', async () => {
    // The list must show name, added date and usage per passkey.
    const props = list({ api: fakeApi({ devices: [{ ...phone, passkeys: [] }, phone, laptop] }) })
    expect((await screen.findAllByText('iPhone')).length).toBe(2)
    expect(screen.getAllByText('This device').length).toBe(2)
    expect(screen.getByText('Used 2 times today')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add Face ID' }))
    expect(props.onAdd).toHaveBeenCalled()
  })
  it('asks for Face ID before a phone removes another device, then removes with the grant', async () => {
    // L92: a phone's removal needs a Face ID grant.
    const props = list()
    await screen.findByText('Laptop')
    fireEvent.click(screen.getByRole('button', { name: 'Remove device' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm with Face ID' }))
    await waitFor(() => { expect(props.api.calls.some(call => call.name === 'removeDevice')).toBe(true) })
    expect(props.api.calls.find(call => call.name === 'removeDevice')?.request).toEqual({ deviceId: 'd2', grantId: 'g1' })
    await waitFor(() => { expect(screen.queryByText('Laptop')).toBeNull() })
  })
  it('removes a passkey from a phone through the sheet, and cancelling removes nothing', async () => {
    // Cancel must leave the list unchanged.
    const props = list()
    await screen.findByText('Laptop')
    fireEvent.click(screen.getByRole('button', { name: 'Remove Face ID' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(props.api.calls.some(call => call.name === 'removePasskey')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Face ID' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm with Face ID' }))
    await waitFor(() => { expect(props.api.calls.some(call => call.name === 'removePasskey')).toBe(true) })
  })
  it('removes at once on the computer and reports a failed list or removal', async () => {
    // The computer needs no prompt; failures show an alert.
    const props = list({ atComputer: true })
    await screen.findByText('Laptop')
    fireEvent.click(screen.getByRole('button', { name: 'Remove device' }))
    await waitFor(() => { expect(props.api.calls.at(-1)?.name).toBe('removeDevice') })
    expect(props.api.calls.at(-1)?.request).toEqual({ deviceId: 'd2', grantId: undefined })
    cleanup()
    const broken = fakeApi({ devices: [laptop] })
    broken.removeDevice = async () => { throw new Error('no') }
    list({ api: broken, atComputer: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Remove device' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    cleanup()
    const noList = fakeApi()
    noList.list = async () => { throw new Error('no') }
    list({ api: noList })
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})
