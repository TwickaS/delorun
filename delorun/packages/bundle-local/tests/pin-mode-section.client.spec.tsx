// @vitest-environment jsdom
/**
 * The PIN mode section lets the person at the computer turn the mode on with a secret typed twice, change its settings,
 * turn it off and resume unlocks, refuses a mismatched or weak secret before any request, never keeps the secret after
 * submit, saves the options without the secret, asks one confirmation before turning off, and shows a device one read-only line without a request.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { HostFetch } from '../src/client/host-api.ts'
import { PIN_COMPUTER_ROUTES } from '../src/client/pin-api.ts'
import { secretProblem } from '../src/client/pin-rules.ts'
import { en, zh } from '../src/client/pin-mode-locales.ts'
import { PinModeSection, type PinModeSectionProps } from '../src/client/PinModeSection.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

type Answer = { status: number; body: unknown }
type RouteKey = `${'GET' | 'POST'} ${string}`

/**
 * A fake home answering each route with the next scripted answer, the last one repeating.
 * @param script - the answers by route.
 * @returns the fake `fetch` and the received requests.
 */
function fakeHost(script: Partial<Record<RouteKey, Answer | Answer[]>> = {}) {
  const received: { key: RouteKey; body: unknown }[] = []
  const fetch: HostFetch = async (input, init) => {
    const key: RouteKey = `${init?.method === 'POST' ? 'POST' : 'GET'} ${input}`
    received.push({ key, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    const entry = script[key] ?? { status: 404, body: { error: 'NOT_FOUND', message: 'No such route' } }
    const answer = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry
    if (answer === undefined) throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(answer.body), { status: answer.status })
  }
  return { fetch, received, count: (key: RouteKey) => received.filter(request => request.key === key).length }
}

const OFF: Answer = { status: 200, body: { enabled: false, idleMinutes: 15, lockWhenHidden: false, paused: false } }
const ON: Answer = { status: 200, body: { enabled: true, kind: 'pin', idleMinutes: 20, lockWhenHidden: true, paused: false } }
const PAUSED: Answer = { status: 200, body: { enabled: true, kind: 'pin', idleMinutes: 20, lockWhenHidden: false, paused: true } }
const MODE: RouteKey = `GET ${PIN_COMPUTER_ROUTES.mode}`
const SET: RouteKey = `POST ${PIN_COMPUTER_ROUTES.set}`
const OPTIONS: RouteKey = `POST ${PIN_COMPUTER_ROUTES.options}`
const OFF_ROUTE: RouteKey = `POST ${PIN_COMPUTER_ROUTES.off}`
const RESUME: RouteKey = `POST ${PIN_COMPUTER_ROUTES.resume}`

/**
 * Render the section.
 * @param host - the fake home.
 * @param atComputer - whether the page is on the computer.
 * @returns the render result.
 */
function renderSection(host: ReturnType<typeof fakeHost>, atComputer = true) {
  const props = { t: makeTranslate(en), close: () => {}, fetch: host.fetch, atComputer: () => atComputer } as PinModeSectionProps
  return render(<PinModeSection {...props} />)
}

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement
const type = (name: string, value: string) => { fireEvent.change(field(name), { target: { value } }) }

describe('the PIN mode section', () => {
  it('shows a device one read-only line and sends no request', () => {
    const host = fakeHost({ [MODE]: ON })
    renderSection(host, false)
    expect(screen.getByText(en.atComputer)).toBeTruthy()
    expect(screen.queryByLabelText(en['secret.label'])).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(host.received).toEqual([])
  })

  it('shows the computer the state and the entry form, with fields that do not zoom a phone', async () => {
    renderSection(fakeHost({ [MODE]: OFF }))
    expect(await screen.findByText(en['state.off'])).toBeTruthy()
    const secret = field(en['secret.label'])
    expect(secret.type).toBe('password')
    expect(secret.getAttribute('inputmode')).toBe('text')
    expect(field(en['idle.label']).getAttribute('inputmode')).toBe('numeric')
    expect(screen.getByRole('button', { name: en.on })).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.off })).toBeNull()
  })

  it('refuses a mismatched, weak or out-of-range entry before any request', async () => {
    const host = fakeHost({ [MODE]: OFF })
    renderSection(host)
    await screen.findByText(en['state.off'])
    const submit = () => fireEvent.click(screen.getByRole('button', { name: en.on }))
    type(en['secret.label'], '483920')
    type(en['secret.confirm'], '483921')
    submit()
    expect((await screen.findByRole('alert')).textContent).toBe(en['problem.mismatch'])
    type(en['secret.label'], '123456')
    type(en['secret.confirm'], '123456')
    submit()
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en['problem.pinWeak']) })
    type(en['secret.label'], '483920')
    type(en['secret.confirm'], '483920')
    type(en['idle.label'], '0')
    submit()
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en['problem.idle']) })
    expect(host.count(SET)).toBe(0)
  })

  it('turns the mode on, sends the secret once, clears it and never stores it', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const host = fakeHost({ [MODE]: [OFF, ON], [SET]: { status: 200, body: { enabled: true, secret: 'pin' } } })
    renderSection(host)
    await screen.findByText(en['state.off'])
    type(en['secret.label'], '483920')
    type(en['secret.confirm'], '483920')
    type(en['idle.label'], '20')
    fireEvent.click(screen.getByLabelText(en['hidden.label']))
    fireEvent.click(screen.getByRole('button', { name: en.on }))
    await screen.findByText(en['state.pin'])
    expect(host.received.filter(request => request.key === SET).map(request => request.body))
      .toEqual([{ secret: '483920', idleMinutes: 20, lockWhenHidden: true }])
    // The entry form is gone once the mode is on, so no field keeps the secret.
    expect(screen.queryByLabelText(en['secret.label'])).toBeNull()
    expect(screen.getByRole('button', { name: en.change })).toBeTruthy()
    expect(setItem).not.toHaveBeenCalled()
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain('483920')
    expect(document.body.textContent).not.toContain('483920')
  })

  it('clears the secret and shows the home\'s sentence when the home refuses it', async () => {
    const host = fakeHost({ [MODE]: OFF, [SET]: { status: 400, body: { error: 'PIN_WEAK', message: 'The home says no' } } })
    renderSection(host)
    await screen.findByText(en['state.off'])
    type(en['secret.label'], '483920')
    type(en['secret.confirm'], '483920')
    fireEvent.click(screen.getByRole('button', { name: en.on }))
    expect((await screen.findByRole('alert')).textContent).toBe('The home says no')
    expect(field(en['secret.label']).value).toBe('')
  })

  it('turns the mode off only after one in-place confirmation', async () => {
    const host = fakeHost({ [MODE]: [ON, OFF], [OFF_ROUTE]: { status: 200, body: { enabled: false } } })
    renderSection(host)
    expect(await screen.findByText(en['state.pin'])).toBeTruthy()
    expect(screen.getByText(`${en['state.settings'].replace('{minutes}', '20')} ${en['state.hidden']}`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.off }))
    expect(screen.getByText(en['off.confirm'])).toBeTruthy()
    expect(host.count(OFF_ROUTE)).toBe(0)
    // Keeping the mode on withdraws the question and sends nothing.
    fireEvent.click(screen.getByRole('button', { name: en['off.no'] }))
    expect(screen.queryByText(en['off.confirm'])).toBeNull()
    expect(host.count(OFF_ROUTE)).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: en.off }))
    fireEvent.click(screen.getByRole('button', { name: en['off.yes'] }))
    await screen.findByText(en['state.off'])
    expect(host.count(OFF_ROUTE)).toBe(1)
  })

  it('saves the idle time and lock-when-hidden with no secret field and no secret sent', async () => {
    const host = fakeHost({ [MODE]: [ON, ON], [OPTIONS]: { status: 200, body: { idleMinutes: 30, lockWhenHidden: false } } })
    renderSection(host)
    await screen.findByText(en['state.pin'])
    // Pins the point of the options form: while the mode is on, the PIN is not asked for to change them.
    expect(screen.queryByLabelText(en['secret.label'])).toBeNull()
    expect(screen.queryByLabelText(en['secret.confirm'])).toBeNull()
    type(en['idle.label'], '30')
    fireEvent.click(screen.getByLabelText(en['hidden.label']))
    fireEvent.click(screen.getByRole('button', { name: en.change }))
    await waitFor(() => { expect(host.count(OPTIONS)).toBe(1) })
    expect(host.received.find(request => request.key === OPTIONS)?.body).toEqual({ idleMinutes: 30, lockWhenHidden: false })
    expect(host.count(SET)).toBe(0)
  })

  it('refuses an out-of-range idle time on save before any request', async () => {
    const host = fakeHost({ [MODE]: ON })
    renderSection(host)
    await screen.findByText(en['state.pin'])
    type(en['idle.label'], '61')
    fireEvent.click(screen.getByRole('button', { name: en.change }))
    expect((await screen.findByRole('alert')).textContent).toBe(en['problem.idle'])
    expect(host.count(OPTIONS)).toBe(0)
  })

  it('changes the PIN in its own disclosure: both fields and the rules apply, and the saved options go with it', async () => {
    const host = fakeHost({ [MODE]: [ON, ON], [SET]: { status: 200, body: { enabled: true, secret: 'pin' } } })
    renderSection(host)
    await screen.findByText(en['state.pin'])
    fireEvent.click(screen.getByRole('button', { name: en['pin.toggle'] }))
    const save = () => fireEvent.click(screen.getByRole('button', { name: en['pin.save'] }))
    type(en['secret.label'], '483920')
    type(en['secret.confirm'], '483921')
    save()
    expect((await screen.findByRole('alert')).textContent).toBe(en['problem.mismatch'])
    type(en['secret.label'], '123456')
    type(en['secret.confirm'], '123456')
    save()
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en['problem.pinWeak']) })
    expect(host.count(SET)).toBe(0)
    type(en['secret.label'], '483920')
    type(en['secret.confirm'], '483920')
    save()
    await waitFor(() => { expect(host.count(SET)).toBe(1) })
    expect(host.received.find(request => request.key === SET)?.body).toEqual({ secret: '483920', idleMinutes: 20, lockWhenHidden: true })
    await waitFor(() => { expect(screen.queryByLabelText(en['secret.label'])).toBeNull() })
    expect(document.body.textContent).not.toContain('483920')
  })

  it('resumes unlocks after a pause', async () => {
    const host = fakeHost({ [MODE]: [PAUSED, ON], [RESUME]: { status: 200, body: { paused: false } } })
    renderSection(host)
    expect(await screen.findByText(en.paused)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.resume }))
    await waitFor(() => { expect(screen.queryByText(en.paused)).toBeNull() })
    expect(host.count(RESUME)).toBe(1)
  })

  it('names the settings waiting to be put back and says they return automatically', async () => {
    const waiting = { status: 200, body: { ...OFF.body as object, setBackWaiting: [{ ns: 'network', field: 'lan' }, { ns: 'shell', field: 'yolo' }] } }
    const host = fakeHost({ [MODE]: waiting })
    renderSection(host)
    const notice = await screen.findByRole('status')
    expect(notice.textContent).toContain(en['setBack.title'])
    expect(notice.textContent).toContain('network lan')
    expect(notice.textContent).toContain('shell yolo')
    expect(notice.textContent).not.toContain('network.lan')
    expect(notice.textContent).toContain(en['setBack.auto'])
    expect(screen.queryByRole('button', { name: /try now/i })).toBeNull()
  })

  it('names a waiting computer-only settings row in words', async () => {
    const waiting = { status: 200, body: { ...OFF.body as object, setBackWaiting: [{ ns: 'delorun-reach', field: '*' }, { ns: 'delorun-home-auth', field: '*' }] } }
    renderSection(fakeHost({ [MODE]: waiting }))
    const notice = await screen.findByRole('status')
    expect(notice.textContent).toContain(en['setBack.name.reach'])
    expect(notice.textContent).toContain(en['setBack.name.homeAuth'])
    expect(notice.textContent).not.toContain('delorun-reach')
  })

  it('shows the status as a pill beside the sentence', async () => {
    renderSection(fakeHost({ [MODE]: ON }))
    expect(await screen.findByText(en['pill.on'])).toBeTruthy()
    expect(screen.getByText(en['state.pin']).getAttribute('data-state')).toBe('on')
  })

  it('shows no set-back notice when nothing waits', async () => {
    const host = fakeHost({ [MODE]: { status: 200, body: { ...OFF.body as object, setBackWaiting: [] } } })
    renderSection(host)
    await screen.findByText(en['state.off'])
    expect(screen.queryByText(en['setBack.auto'], { exact: false })).toBeNull()
  })

  it('says in place when the home refuses a device, has no routes or does not answer', async () => {
    renderSection(fakeHost({ [MODE]: { status: 403, body: { error: 'LOOPBACK_REQUIRED', message: 'x' } } }))
    expect((await screen.findByRole('alert')).textContent).toBe(en.loopback)
    cleanup()
    renderSection(fakeHost())
    expect(await screen.findByText(en.unavailable)).toBeTruthy()
  })
})

describe('the secret rules', () => {
  it('match the home\'s rules', () => {
    expect(secretProblem('483920')).toBeUndefined()
    expect(secretProblem('48392')).toBe('pinShort')
    expect(secretProblem('111111')).toBe('pinWeak')
    expect(secretProblem('345678')).toBe('pinWeak')
    expect(secretProblem('696969')).toBe('pinWeak')
    expect(secretProblem('short')).toBe('passcodeShort')
    expect(secretProblem('aaaaaaaaaa')).toBe('passcodeRepeat')
    expect(secretProblem('correct horse')).toBeUndefined()
    expect(secretProblem('a'.repeat(129))).toBe('tooLong')
  })
  it('have a Chinese entry for every English one', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})
