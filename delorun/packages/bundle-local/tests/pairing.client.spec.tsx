// @vitest-environment jsdom
/**
 * Pop-up pairing in the studio at the home's own computer: the notice for a device that asked without an approval
 * window, the code box, the store that reads the requests, and the pairing controls of Settings → Devices.
 */
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { DEVICE_ROUTES, PENDING_POLL_MS, type ApprovalRequestId, type PendingDevice } from '../src/client/devices-api.ts'
import { en } from '../src/client/devices-locales.ts'
import { PairingNotice, isTypingIn, type PairingNoticeProps } from '../src/client/PairingNotice.tsx'
import { PairingSettings } from '../src/client/PairingSettings.tsx'
import { createPairingSource, type PairingSource } from '../src/client/pairing-source.ts'
import { PairingWriter } from '../src/client/pairing-writer.ts'
import { fakeHost, staticPairing } from './fake-host.ts'

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0)
const t = makeTranslate(en)
const VIEW = { mayAskWithoutWindow: 'own-user', showRequest: 'notice', windowMinutes: 5, requestExpiryMinutes: 5, pendingPerIdentity: 1 } as const
const ASKING = {
  requestId: 'ask-1', label: 'Pixel 9', platform: 'Android', address: 'https://home.example.ts.net', createdAt: NOW - 5_000, expiresAt: NOW + 295_000,
  identity: { login: 'me@example.com', name: 'Me Example' }, windowless: true, wrongCodes: 0,
}
const IN_WINDOW = { ...ASKING, requestId: 'win-1', label: 'Old tablet', identity: null, windowless: false }
const answer = (pending: readonly unknown[], pairing: unknown = VIEW) => ({ status: 200, body: { windowClosesAt: null, pending, pairing } })
const refusal = (status: number, error: string, message = `${error} sentence`) => ({ status, body: { error, message } })
const PENDING = `GET ${DEVICE_ROUTES.pending}` as const

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: NOW }) })
afterEach(() => { cleanup(); vi.useRealTimers() })

/** Let timers up to `ms` from now run, and the answers they wait for settle, inside React's act. */
const settle = (ms = 0): Promise<void> => act(async () => {
  await vi.advanceTimersByTimeAsync(ms)
  for (let turn = 0; turn < 10; turn++) await vi.advanceTimersByTimeAsync(0)
})

/**
 * Render the overlay entry over a source that reads a fake home.
 * @param host - the fake home.
 * @returns the source.
 */
function renderNotice(host: ReturnType<typeof fakeHost>): PairingSource {
  const source = createPairingSource(host.fetch)
  const props = { t, ...source, usePairing: <T,>(select: (state: ReturnType<typeof source.hooks.pairing.getSnapshot>) => T): T => useSyncState(source, select) } as PairingNoticeProps
  render(<PairingNotice {...props} />)
  return source
}

/**
 * Read a store the way the renderer's bound hooks do.
 * @param source - the store.
 * @param select - the view of its state.
 * @returns the selection.
 */
function useSyncState<T>(source: PairingSource, select: (state: ReturnType<typeof source.hooks.pairing.getSnapshot>) => T): T {
  return useSyncExternalStore(source.hooks.pairing.subscribe, () => select(source.hooks.pairing.getSnapshot()))
}

describe('the pairing store', () => {
  it('keeps the requests that arrived without a window and the home\'s choices, and reads again every two seconds', async () => {
    const host = fakeHost({ [PENDING]: answer([ASKING, IN_WINDOW]) })
    const source = createPairingSource(host.fetch)
    const stop = source.start()
    await settle()
    expect(source.hooks.pairing.getSnapshot()).toMatchObject({ place: 'computer', view: VIEW, requests: [{ requestId: 'ask-1' }] })
    await settle(PENDING_POLL_MS)
    expect(host.count(PENDING)).toBe(2)
    stop()
    await settle(PENDING_POLL_MS * 3)
    expect(host.count(PENDING)).toBe(2)
  })

  it('stops reading once the home says this studio is remote, and shows no request', async () => {
    const host = fakeHost({ [PENDING]: refusal(403, 'LOOPBACK_REQUIRED') })
    const source = createPairingSource(host.fetch)
    source.start()
    await settle(PENDING_POLL_MS * 3)
    expect(source.hooks.pairing.getSnapshot()).toMatchObject({ place: 'remote', requests: [] })
    expect(host.count(PENDING)).toBe(1)
  })

  it('keeps the last read when a read fails, and tries again', async () => {
    const host = fakeHost({ [PENDING]: answer([ASKING]) })
    const source = createPairingSource(host.fetch)
    source.start()
    await settle()
    host.script[PENDING] = 'unreachable'
    await settle(PENDING_POLL_MS)
    expect(source.hooks.pairing.getSnapshot().requests).toHaveLength(1)
    host.script[PENDING] = answer([])
    await settle(PENDING_POLL_MS)
    expect(source.hooks.pairing.getSnapshot().requests).toHaveLength(0)
  })

  it('closes a code box whose request is gone', async () => {
    const host = fakeHost({ [PENDING]: answer([ASKING]) })
    const source = createPairingSource(host.fetch)
    source.start()
    await settle()
    source.openCode('ask-1' as ApprovalRequestId)
    expect(source.hooks.pairing.getSnapshot().open).toBe('ask-1')
    host.script[PENDING] = answer([])
    await settle(PENDING_POLL_MS)
    expect(source.hooks.pairing.getSnapshot().open).toBeUndefined()
  })

  it('reports a refused code as gone when the request no longer waits', async () => {
    const host = fakeHost({ [PENDING]: answer([ASKING]), [`POST ${DEVICE_ROUTES.approve}`]: refusal(403, 'APPROVAL_CODE_MISMATCH') })
    const source = createPairingSource(host.fetch)
    source.start()
    await settle()
    const refused = source.approve('ask-1' as ApprovalRequestId, '1234 5678')
    host.script[PENDING] = answer([])
    await settle()
    expect(await refused).toMatchObject({ kind: 'failed', gone: true })
    expect(host.received.find(request => request.key === `POST ${DEVICE_ROUTES.approve}`)?.body).toEqual({ requestId: 'ask-1', typedCode: '12345678' })
  })
})

describe('the notice and the code box', () => {
  it('names the Tailscale user, the device and its platform, with Enter code and Decline, and takes no focus', async () => {
    const host = fakeHost({ [PENDING]: answer([ASKING]) })
    renderNotice(host)
    await settle()
    expect(screen.getByText(`A device asks to connect: Me Example · Pixel 9 · Android`)).toBeTruthy()
    expect(screen.getByRole('button', { name: en['pairing.notice.enter'] })).toBeTruthy()
    expect(screen.getByRole('button', { name: en['pairing.notice.decline'] })).toBeTruthy()
    expect(document.activeElement).toBe(document.body)
  })

  it('shows nothing for a request that came in an approval window, or for no request', async () => {
    renderNotice(fakeHost({ [PENDING]: answer([IN_WINDOW]) }))
    await settle()
    expect(screen.queryByRole('button', { name: en['pairing.notice.enter'] })).toBeNull()
  })

  it('shows nothing in a remote studio', async () => {
    renderNotice(fakeHost({ [PENDING]: refusal(403, 'LOOPBACK_REQUIRED') }))
    await settle()
    expect(screen.queryByRole('button', { name: en['pairing.notice.enter'] })).toBeNull()
  })

  it('shows nothing when the home shows no request here', async () => {
    renderNotice(fakeHost({ [PENDING]: answer([ASKING], { ...VIEW, showRequest: 'none' }) }))
    await settle()
    expect(screen.queryByRole('button', { name: en['pairing.notice.enter'] })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('declines a request at the home and says so', async () => {
    const host = fakeHost({ [PENDING]: answer([ASKING]), [`POST ${DEVICE_ROUTES.cancel}`]: { status: 200, body: { cancelled: 'ask-1' } } })
    renderNotice(host)
    await settle()
    host.script[PENDING] = answer([])
    fireEvent.click(screen.getByRole('button', { name: en['pairing.notice.decline'] }))
    await settle()
    expect(host.received.find(request => request.key === `POST ${DEVICE_ROUTES.cancel}`)?.body).toEqual({ requestId: 'ask-1' })
    expect(screen.getByText('The request from Pixel 9 is declined.')).toBeTruthy()
  })

  it('opens the code box from Enter code and approves at the eighth digit, from a paste with spaces', async () => {
    const host = fakeHost({ [PENDING]: answer([ASKING]), [`POST ${DEVICE_ROUTES.approve}`]: { status: 200, body: { device: { id: 'x', label: 'Pixel 9', address: 'a' } } } })
    renderNotice(host)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en['pairing.notice.enter'] }))
    const dialog = screen.getByRole('dialog', { name: en['pairing.box.title'] })
    expect(within(dialog).getByText('Tailscale user: Me Example')).toBeTruthy()
    expect(within(dialog).getByText('Pixel 9 · Android')).toBeTruthy()
    const field = within(dialog).getByLabelText(en['pairing.box.code']) as HTMLInputElement
    expect(field.inputMode).toBe('numeric')
    fireEvent.change(field, { target: { value: '1234' } })
    expect(host.count(`POST ${DEVICE_ROUTES.approve}`)).toBe(0)
    host.script[PENDING] = answer([])
    fireEvent.change(field, { target: { value: '1234 5678' } })
    await settle()
    expect(host.received.find(request => request.key === `POST ${DEVICE_ROUTES.approve}`)?.body).toEqual({ requestId: 'ask-1', typedCode: '12345678' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('Pixel 9 is connected.')).toBeTruthy()
  })

  it('counts a wrong code in place and keeps the box for another try', async () => {
    const host = fakeHost({ [PENDING]: answer([ASKING]), [`POST ${DEVICE_ROUTES.approve}`]: refusal(403, 'APPROVAL_CODE_MISMATCH', 'That code does not match') })
    renderNotice(host)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en['pairing.notice.enter'] }))
    host.script[PENDING] = answer([{ ...ASKING, wrongCodes: 1 }])
    fireEvent.change(screen.getByLabelText(en['pairing.box.code']), { target: { value: '00000000' } })
    await settle()
    expect(screen.getByRole('alert').textContent).toBe('That code does not match. Wrong codes: 1 of 3.')
    expect((screen.getByLabelText(en['pairing.box.code']) as HTMLInputElement).value).toBe('')
  })

  it('closes the box and says so when the third wrong code cancels the request', async () => {
    const host = fakeHost({ [PENDING]: answer([{ ...ASKING, wrongCodes: 2 }]), [`POST ${DEVICE_ROUTES.approve}`]: refusal(403, 'APPROVAL_CODE_MISMATCH') })
    renderNotice(host)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en['pairing.notice.enter'] }))
    host.script[PENDING] = answer([])
    fireEvent.change(screen.getByLabelText(en['pairing.box.code']), { target: { value: '00000000' } })
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText(en['pairing.box.cancelled'])).toBeTruthy()
  })

  it('declines from inside the code box', async () => {
    const host = fakeHost({ [PENDING]: answer([ASKING]), [`POST ${DEVICE_ROUTES.cancel}`]: { status: 200, body: { cancelled: 'ask-1' } } })
    renderNotice(host)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en['pairing.notice.enter'] }))
    host.script[PENDING] = answer([])
    fireEvent.click(screen.getByRole('button', { name: en['pairing.box.decline'] }))
    await settle()
    expect(host.count(`POST ${DEVICE_ROUTES.cancel}`)).toBe(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  describe('in dialog mode', () => {
    const DIALOG = { ...VIEW, showRequest: 'dialog' } as const

    it('opens the code box at once', async () => {
      renderNotice(fakeHost({ [PENDING]: answer([ASKING], DIALOG) }))
      await settle()
      expect(screen.getByRole('dialog', { name: en['pairing.box.title'] })).toBeTruthy()
    })

    it('waits while a field is being typed in, shows the notice, and opens the box when the field is left', async () => {
      const field = document.createElement('input')
      document.body.append(field)
      field.focus()
      expect(isTypingIn(document.activeElement)).toBe(true)
      renderNotice(fakeHost({ [PENDING]: answer([ASKING], DIALOG) }))
      await settle()
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.getByRole('button', { name: en['pairing.notice.enter'] })).toBeTruthy()
      expect(document.activeElement).toBe(field)
      field.blur()
      await settle(PENDING_POLL_MS)
      expect(screen.getByRole('dialog', { name: en['pairing.box.title'] })).toBeTruthy()
      field.remove()
    })
  })
})

describe('typing targets', () => {
  it.each([['input'], ['textarea'], ['select']])('counts a %s', (tag) => {
    expect(isTypingIn(document.createElement(tag))).toBe(true)
  })
  it('counts an editable element, and neither a button nor nothing', () => {
    const editable = document.createElement('div')
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    expect(isTypingIn(editable)).toBe(true)
    expect(isTypingIn(document.createElement('button'))).toBe(false)
    expect(isTypingIn(null)).toBe(false)
  })
})

describe('the pairing controls in Settings → Devices', () => {
  /** Render the part over the fixed state of {@link staticPairing}. */
  function renderSettings(overrides: Parameters<typeof staticPairing>[0] = {}) {
    const pairing = staticPairing(overrides)
    const state = pairing.usePairing(current => current)
    const form = pairing.usePairingForm(current => current)
    const mutation = pairing.usePairingMutation(current => current)
    render(<PairingSettings t={t} time={() => 'today'} state={state} form={form} mutation={mutation} set={pairing.setPairing}
      openCode={pairing.openPairingCode} decline={pairing.declinePairing} />)
    return pairing
  }

  it('shows Delorun\'s choices when the row sets none', () => {
    renderSettings()
    const may = screen.getByRole('radiogroup', { name: en['pairing.may.title'] })
    expect(within(may).getByRole('radio', { name: en['pairing.may.own-user'] }).getAttribute('aria-checked')).toBe('true')
    expect(within(screen.getByRole('radiogroup', { name: en['pairing.show.title'] })).getByRole('radio', { name: en['pairing.show.notice'] }).getAttribute('aria-checked')).toBe('true')
    expect((screen.getByLabelText(en['pairing.window.title']) as HTMLInputElement).value).toBe('5')
    expect(screen.getByText(en['pairing.fixed'])).toBeTruthy()
  })

  it('shows the value the row holds over the home\'s, and writes a choice', () => {
    const pairing = renderSettings({ form: { value: { pairing: { mayAskWithoutWindow: 'tailnet' } } } })
    const may = screen.getByRole('radiogroup', { name: en['pairing.may.title'] })
    expect(within(may).getByRole('radio', { name: en['pairing.may.tailnet'] }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(may).getByRole('radio', { name: en['pairing.may.window-only'] }))
    expect(pairing.setPairing).toHaveBeenCalledWith('mayAskWithoutWindow', 'window-only')
  })

  it.each([['windowMinutes', 'pairing.window.title', '9', 9], ['requestExpiryMinutes', 'pairing.expiry.title', '3', 3], ['pendingPerIdentity', 'pairing.per.title', '2', 2]] as const)('writes %s within its bounds', (field, title, typed, written) => {
    const pairing = renderSettings()
    const input = screen.getByLabelText(en[title])
    fireEvent.change(input, { target: { value: typed } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(pairing.setPairing).toHaveBeenCalledWith(field, written)
  })

  it.each([['0'], ['16'], ['2.5'], ['']])('does not write %s, which is outside the bounds or not whole', (typed) => {
    const pairing = renderSettings()
    const input = screen.getByLabelText(en['pairing.window.title'])
    fireEvent.change(input, { target: { value: typed } })
    fireEvent.blur(input)
    expect(pairing.setPairing).not.toHaveBeenCalled()
    expect((input as HTMLInputElement).value).toBe('5')
  })

  it('disables every control while a write crosses the wire, and says when a write failed', () => {
    renderSettings({ mutation: { busy: true, failed: true } })
    expect(screen.getByRole('alert').textContent).toBe(en['pairing.failed'])
    for (const radio of screen.getAllByRole('radio')) expect((radio as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText(en['pairing.window.title']) as HTMLInputElement).disabled).toBe(true)
  })

  it('lists the devices asking, with Enter code and Decline', () => {
    const pairing = renderSettings({ state: { requests: [ASKING as PendingDevice] } })
    const row = document.querySelector('[data-request-id="ask-1"]') as HTMLElement
    expect(within(row).getByText('Pixel 9')).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: en['pairing.waiting.enter'] }))
    expect(pairing.openPairingCode).toHaveBeenCalledWith('ask-1')
    fireEvent.click(within(row).getByRole('button', { name: en['pairing.waiting.decline'] }))
    expect(pairing.declinePairing).toHaveBeenCalledWith('ask-1')
  })

  it('says to change this at the computer on a remote studio, with no control', () => {
    renderSettings({ state: { place: 'remote' } })
    expect(screen.getByText(en['pairing.computerOnly'])).toBeTruthy()
    expect(screen.queryByRole('radio')).toBeNull()
  })

  it('shows nothing before the first read', () => {
    renderSettings({ state: { place: 'unknown', view: undefined } })
    expect(document.querySelector('[data-pairing]')).toBeNull()
  })
})

describe('the writer', () => {
  /** A form over a fixed snapshot whose `mutate` answers as given. */
  function writerOver(value: unknown, mutate: (ops: unknown) => Promise<boolean>) {
    type Form = ConstructorParameters<typeof PairingWriter>[0]
    const snapshot = { value } as Partial<ReturnType<Form['getSnapshot']>>
    const parts: Partial<Form> = { getSnapshot: () => snapshot as ReturnType<Form['getSnapshot']>, mutate: vi.fn(mutate) }
    const form = parts as Form
    return { writer: new PairingWriter(form), mutate: form.mutate as ReturnType<typeof vi.fn> }
  }

  it('sets one field of an existing section, leaving the others', async () => {
    const { writer, mutate } = writerOver({ pairing: { showRequest: 'dialog' } }, async () => true)
    await writer.set('windowMinutes', 7)
    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['pairing', 'windowMinutes'], value: 7 }])
    expect(writer.state.getSnapshot()).toEqual({ busy: false, failed: false })
  })

  it('creates the section when the row has none', async () => {
    const { writer, mutate } = writerOver({}, async () => true)
    await writer.set('mayAskWithoutWindow', 'tailnet')
    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['pairing'], value: { mayAskWithoutWindow: 'tailnet' } }])
  })

  it.each([['refused', async () => false], ['unreachable', async () => { throw new TypeError('offline') }]])('reports a %s write as failed', async (_name, mutate) => {
    const { writer } = writerOver({}, mutate)
    await writer.set('showRequest', 'none')
    expect(writer.state.getSnapshot()).toEqual({ busy: false, failed: true })
  })

  it('drops a write while another crosses the wire', async () => {
    let finish: (accepted: boolean) => void = () => {}
    const { writer, mutate } = writerOver({}, () => new Promise<boolean>((resolve) => { finish = resolve }))
    const first = writer.set('showRequest', 'none')
    await writer.set('showRequest', 'dialog')
    finish(true)
    await first
    expect(mutate).toHaveBeenCalledTimes(1)
  })
})
