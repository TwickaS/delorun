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
import { canonicalJson, hashArgs, hashRequest } from '../src/client/face-id-hash.ts'
import { FaceIdPin } from '../src/client/FaceIdPin.tsx'
import { FACE_ID_KINDS, type FaceIdAction, type PasskeyDevice } from '../src/client/face-id-types.ts'
import { FaceIdSheet } from '../src/client/FaceIdSheet.tsx'
import { AddFaceId, CODE_POLL_MS, FaceIdPairingStep, PasskeyCodeEntry } from '../src/client/FaceIdEnrol.tsx'
import { PasskeyDevices } from '../src/client/PasskeyDevices.tsx'

const t = makeTranslate(en)
const action: FaceIdAction = { grant: { actions: [{ action: 'plugin.install', hash: 'h' }] }, title: 'Install “Reports”?', body: 'It can read your files.', items: ['a', 'b', 'c', 'd', 'e'] }
const key = (value: string) => ({ credentialId: value, createdAt: Date.UTC(2026, 10, 18), lastUsedAt: Date.UTC(2026, 10, 19), synced: true })
const phone: PasskeyDevice = { deviceId: 'd1', label: 'iPhone', thisDevice: true, passkeys: [key('p1')] }
const laptop: PasskeyDevice = { deviceId: 'd2', label: 'Laptop', thisDevice: false, passkeys: [key('p2')] }

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
    expect(api.calls.map(call => call.name)).toEqual(['options', 'verify'])
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
    fireEvent.click(screen.getByRole('button', { name: 'Open Face ID settings' }))
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

describe('hashes', () => {
  it('canonicalises like the home and reproduces its vectors', async () => {
    // A hash that differs from the home's means every grant is refused.
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: undefined })).toBe('{"a":[true,null,"x"],"b":1}')
    expect(await hashArgs({})).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a')
    // SHA-256 of '{"credentialId":"abc"}' and of 'POST NUL /p NUL {"a":1}', computed with Node's crypto.
    expect(await hashArgs({ credentialId: 'abc' })).toBe('fce492991f0a6c56db05b1835f75f7d9a8fe08df976b0de08e876474f082e571')
    // The device removal's body, hashed in the same form as /auth/passkey/remove.
    expect(await hashArgs({ v: 1, deviceId: 'd2' })).toBe('46c43429148fcfe08ab8a3e2567c1088bb50ca8b681cb1a2de9e2aad95feeef5')
    expect(await hashRequest({ method: 'post', path: '/p', body: { a: 1 } })).toBe('d52ced0ec672b9fd47dcfd67064582b53c6936331a2b93a45296078c21cdc7f1')
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError)
    expect(() => canonicalJson(() => 1)).toThrow(TypeError)
  })
})

describe('FaceIdPairingStep', () => {
  const step = (over: Partial<Parameters<typeof FaceIdPairingStep>[0]> = {}) => {
    const props = { t, kind: 'faceId' as const, api: fakeApi(), browser: fakeBrowser(), onDone: vi.fn(), onSkip: vi.fn(), ...over }
    render(<FaceIdPairingStep {...props} />)
    return props
  }
  it('names Stolen Device Protection and registers', async () => {
    // The step must fetch options, create inside the tap and register.
    const api = fakeApi()
    const props = step({ api })
    expect(screen.getByText(/Stolen Device Protection/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Set up Face ID' }))
    await waitFor(() => { expect(props.onDone).toHaveBeenCalled() })
    expect(api.calls.map(call => call.name)).toEqual(['registerOptions', 'register'])
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
  const add = (api = fakeApi(), browser = fakeBrowser()) => {
    const props = { t, kind: 'faceId' as const, api, browser, onDone: vi.fn(), onCancel: vi.fn() }
    render(<AddFaceId {...props} />)
    return props
  }
  it('shows the code, waits for the computer, then creates the passkey on a second tap', async () => {
    // The code comes first; create needs its own tap once the ticket waits.
    vi.useFakeTimers()
    const api = fakeApi({ code: '12345678', ticket: [false, true] })
    const browser = fakeBrowser()
    const props = add(api, browser)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Show the code' })) })
    expect(screen.getByText('12345678')).toBeTruthy()
    expect(browser.calls).toEqual([])
    await act(async () => { await vi.advanceTimersByTimeAsync(CODE_POLL_MS * 2) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Set up Face ID' })) })
    expect(browser.calls).toEqual(['create'])
    expect(props.onDone).toHaveBeenCalled()
    expect(api.calls.map(call => call.name)).toContain('register')
  })
  it('reports a failed code request and a failed create', async () => {
    // A failure must show, not wait forever.
    const broken = fakeApi()
    broken.addRequest = async () => { throw new Error('no') }
    add(broken)
    fireEvent.click(screen.getByRole('button', { name: 'Show the code' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    cleanup()
    vi.useFakeTimers()
    add(fakeApi({ ticket: [true] }), fakeBrowser({ create: [{ kind: 'failed' }] }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Show the code' })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(CODE_POLL_MS) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Set up Face ID' })) })
    expect(screen.getByRole('alert')).toBeTruthy()
  })
  it('fails when the options or the registration are refused, and cancels', async () => {
    // A refused request must not hang on waiting.
    vi.useFakeTimers()
    const refused = fakeApi({ ticket: [true], failOptions: true })
    const props = add(refused)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Show the code' })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(CODE_POLL_MS) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Set up Face ID' })) })
    expect(screen.getByRole('alert')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onCancel).toHaveBeenCalled()
    cleanup()
    const api = fakeApi({ ticket: [true] })
    api.register = async () => { throw new Error('no') }
    add(api)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Show the code' })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(CODE_POLL_MS) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Set up Face ID' })) })
    expect(screen.getByRole('alert')).toBeTruthy()
  })
})

describe('PasskeyCodeEntry', () => {
  const pending = [{ requestId: 'r1', deviceId: 'd1', deviceLabel: 'iPhone', expiresAt: 0 }]
  it('confirms eight digits for the pending device and reports a mismatch', async () => {
    // Confirm stays disabled until the code is complete; a wrong code shows the mismatch.
    const onDone = vi.fn()
    const api = fakeApi({ matched: false, pending })
    render(<PasskeyCodeEntry t={t} api={api} onDone={onDone} />)
    expect(await screen.findByText('iPhone')).toBeTruthy()
    const confirm = screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Code from the device'), { target: { value: '1234 5678' } })
    fireEvent.click(confirm)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
    expect(api.calls.at(-1)).toEqual({ name: 'approveAdd', request: { requestId: 'r1', code: '12345678' } })
  })
  it('finishes on a match, lets the person pick among several devices, and treats a refused request as a mismatch', async () => {
    // A thrown request must not leave the form stuck busy.
    const onDone = vi.fn()
    const two = [...pending, { requestId: 'r2', deviceId: 'd2', deviceLabel: 'iPad', expiresAt: 0 }]
    const api = fakeApi({ pending: two })
    render(<PasskeyCodeEntry t={t} api={api} onDone={onDone} />)
    fireEvent.click(await screen.findByRole('button', { name: 'iPad' }))
    fireEvent.change(screen.getByLabelText('Code from the device'), { target: { value: '12345678' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => { expect(onDone).toHaveBeenCalled() })
    expect(api.calls.at(-1)?.request).toEqual({ requestId: 'r2', code: '12345678' })
    cleanup()
    const broken = fakeApi({ pending })
    broken.approveAdd = async () => { throw new Error('no') }
    render(<PasskeyCodeEntry t={t} api={broken} onDone={onDone} />)
    await screen.findByText('iPhone')
    fireEvent.change(screen.getByLabelText('Code from the device'), { target: { value: '12345678' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
  it('says so when no device is asking', async () => {
    // With nothing pending the entry stays disabled.
    render(<PasskeyCodeEntry t={t} api={fakeApi()} onDone={vi.fn()} />)
    expect(await screen.findByText(/No device is asking/)).toBeTruthy()
    expect((screen.getByLabelText('Code from the device') as HTMLInputElement).disabled).toBe(true)
  })
})

describe('FaceIdPin', () => {
  it('mints a one-action grant from the secret and clears it, or shows a wrong answer', async () => {
    // The PIN fallback must send the secret with the same grant request as the sheet.
    const onGranted = vi.fn()
    const api = fakeApi()
    render(<FaceIdPin t={t} action={action} api={api} secret="passcode" onGranted={onGranted} onBack={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Passcode'), { target: { value: 'correct horse' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => { expect(onGranted).toHaveBeenCalledWith('g2') })
    expect(api.calls[0]).toEqual({ name: 'pin', request: { ...action.grant, secret: 'correct horse' } })
    cleanup()
    render(<FaceIdPin t={t} action={action} api={fakeApi({ failPin: true })} secret="passcode" onGranted={onGranted} onBack={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Passcode'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
  it('shows the keypad for a digit PIN and goes back', () => {
    // A digit PIN uses the shared cells; Back leaves the entry.
    const onBack = vi.fn()
    render(<FaceIdPin t={t} action={action} api={fakeApi()} secret="pin" onGranted={vi.fn()} onBack={onBack} />)
    expect(document.querySelector('[data-face-id-pin]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalled()
  })
})

describe('PasskeyDevices', () => {
  const list = (over: Partial<Parameters<typeof PasskeyDevices>[0]> = {}) => {
    const api = over.api ?? fakeApi({ devices: [phone, laptop] })
    const props = { t, api, browser: fakeBrowser(), kind: 'faceId' as const, atComputer: false, secret: 'pin' as const, hasPasskey: true,
      onAdd: vi.fn(), onAskComputer: vi.fn(), ...over }
    render(<PasskeyDevices {...props} />)
    return { ...props, api: api as ReturnType<typeof fakeApi> }
  }
  it('on a phone starts with this device only, and Show all devices asks for Face ID first', async () => {
    // L92: the cross-device list takes a grant for auth/passkey/devices.
    const props = list()
    expect(await screen.findByText('Added 18 Nov · synced across your devices')).toBeTruthy()
    expect(screen.queryByText('Laptop')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show all devices' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm with Face ID' }))
    expect(await screen.findByText('Laptop')).toBeTruthy()
    expect(props.api.calls.find(call => call.name === 'devices' && (call.request as { grantId?: string }).grantId === 'g1')).toBeTruthy()
    expect(props.api.calls.find(call => call.name === 'options')?.request).toEqual({ actions: [{ action: 'auth/passkey/devices', hash: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a' }] })
  })
  it('offers Add Face ID where this device has none', async () => {
    // A device with no passkey needs the way to add one.
    const props = list({ api: fakeApi({ devices: [{ ...phone, passkeys: [] }] }) })
    fireEvent.click(await screen.findByRole('button', { name: 'Add Face ID' }))
    expect(props.onAdd).toHaveBeenCalled()
  })
  it('removes another device from a phone only after Face ID, with the grant', async () => {
    // L92: a phone's removal needs a Face ID grant.
    const props = list()
    fireEvent.click(await screen.findByRole('button', { name: 'Show all devices' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm with Face ID' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove device' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm with Face ID' }))
    await waitFor(() => { expect(props.api.calls.some(call => call.name === 'removeDevice')).toBe(true) })
    expect(props.api.calls.find(call => call.name === 'removeDevice')?.request).toEqual({ deviceId: 'd2', grantId: 'g1' })
    expect(props.api.calls.filter(call => call.name === 'options').at(-1)?.request).toEqual({ actions: [{ action: 'auth/devices/remove', hash: '46c43429148fcfe08ab8a3e2567c1088bb50ca8b681cb1a2de9e2aad95feeef5' }] })
  })
  it('removes a passkey through the sheet, falls back to the PIN, and cancelling removes nothing', async () => {
    // Cancel must leave the list unchanged; the PIN grant is the same kind of grant.
    const props = list()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Face ID' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(props.api.calls.some(call => call.name === 'removePasskey')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Face ID' }))
    await screen.findByRole('dialog')
    cleanup()
    const second = list({ browser: fakeBrowser({ get: [{ kind: 'cancelled' }] }), secret: 'passcode' })
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Face ID' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm with Face ID' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Use PIN instead' }))
    fireEvent.change(await screen.findByLabelText('Passcode'), { target: { value: 'secret value' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => { expect(second.api.calls.some(call => call.name === 'removePasskey')).toBe(true) })
    expect(second.api.calls.find(call => call.name === 'removePasskey')?.request).toMatchObject({ credentialId: 'p1', grantId: 'g2' })
  })
  it('points at the computer when no PIN is set', async () => {
    // Without a PIN the sheet's way down is the computer.
    const props = list({ browser: fakeBrowser({ get: [{ kind: 'cancelled' }] }), secret: undefined })
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Face ID' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm with Face ID' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Approve at the computer' }))
    expect(props.onAskComputer).toHaveBeenCalled()
  })
  it('at the computer lists everything and removes at once; failures show an alert', async () => {
    // The computer needs no prompt.
    const props = list({ atComputer: true })
    expect(await screen.findByText('Laptop')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove device' }))
    await waitFor(() => { expect(props.api.calls.at(-1)?.name).toBe('devices') })
    expect(props.api.calls.some(call => call.name === 'removeDevice' && (call.request as { grantId?: string }).grantId === undefined)).toBe(true)
    cleanup()
    const broken = fakeApi({ devices: [laptop] })
    broken.removeDevice = async () => { throw new Error('no') }
    list({ api: broken, atComputer: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Remove device' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    cleanup()
    const noList = fakeApi()
    noList.devices = async () => { throw new Error('no') }
    list({ api: noList, atComputer: true })
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})
