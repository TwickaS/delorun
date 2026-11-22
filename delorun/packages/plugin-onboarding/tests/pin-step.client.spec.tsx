// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSteps, STEPS } from '../src/client/flow.tsx'
import { createGuide } from '../src/client/guide.ts'
import { en } from '../src/client/locales.ts'
import { PinStep } from '../src/client/steps/Pin.tsx'
import type { SetupRecord } from '../src/wire.ts'
import type { ReachState } from '../src/client/types.ts'
import { hostFake, stepServices } from './fixtures.client.ts'

afterEach(cleanup)

const OFF = { enabled: false, idleMinutes: 15, lockWhenHidden: false, paused: false }
const ON = { enabled: true, kind: 'pin', idleMinutes: 15, lockWhenHidden: false, paused: false }
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A fake home: PIN mode as `mode` reads, and what `/auth/pin/set` answers. */
function home(mode: unknown, set: () => Response = () => json({ enabled: true })) {
  const calls: { readonly path: string; readonly body: unknown }[] = []
  const fetch = vi.fn((input: string, init?: RequestInit) => {
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ path: input, body })
    return Promise.resolve(input.endsWith('/auth/pin/set') ? set() : json(mode))
  })
  const openSettings = vi.fn()
  return { calls, fetch, openSettings, services: stepServices({ pin: { fetch, openSettings } }) }
}

const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }) }
const type = (label: string, value: string) => { fireEvent.change(screen.getByLabelText(label), { target: { value } }) }
// There is no Set PIN button: Enter in a field submits, and Continue runs the same step through the guide's gate.
const submit = async () => { await act(async () => { fireEvent.submit(screen.getByLabelText(en['pin.setup.confirm']).closest('form') as HTMLFormElement) }); await settle() }
const mount = async (h: ReturnType<typeof home>) => {
  const guide = createGuide(hostFake().host)
  render(<PinStep services={h.services} guide={guide} />)
  await settle()
  return guide
}
/** Mount and press Continue on the cards, which opens the entry and holds. */
const mountAtEntry = async (h: ReturnType<typeof home>) => {
  const guide = await mount(h)
  await act(async () => { expect(await guide.passGates()).toBe(false) })
  await settle()
  return guide
}

describe('the PIN step', () => {
  let writes: ReturnType<typeof vi.spyOn>
  beforeEach(() => { writes = vi.spyOn(Storage.prototype, 'setItem') })
  afterEach(() => { writes.mockRestore() })

  it('says in plain words what the PIN is for and that it is set at this computer', async () => {
    await mount(home(OFF))
    expect(screen.getByText(en['pin.lead'])).toBeTruthy()
    expect(en['pin.choice.set.1']).toContain('adding plugins')
    expect(en['pin.choice.set.1']).toContain('full access')
    expect(screen.getByText(en['pin.here'])).toBeTruthy()
  })

  it('sends the PIN through the existing route with the home\'s own idle settings, shows PIN mode on, and keeps the secret out of storage', async () => {
    const h = home(OFF)
    await mountAtEntry(h)
    type(en['pin.setup.pinLabel'], '824619')
    type(en['pin.setup.confirm'], '824619')
    await submit()
    expect(h.calls.find(call => call.path.endsWith('/auth/pin/set'))?.body).toEqual({ secret: '824619', idleMinutes: 15, lockWhenHidden: false })
    expect(screen.getByText(en['pin.on'])).toBeTruthy()
    expect(screen.queryByLabelText(en['pin.setup.pinLabel'])).toBeNull()
    expect(writes).not.toHaveBeenCalled()
    expect(JSON.stringify([window.localStorage, window.sessionStorage])).not.toContain('824619')
  })

  it('takes a passcode as well', async () => {
    const h = home(OFF)
    await mountAtEntry(h)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['pin.setup.usePasscode'] })) })
    type(en['pin.setup.passLabel'], 'correct horse battery')
    type(en['pin.setup.confirm'], 'correct horse battery')
    await submit()
    expect(screen.getByText(en['pin.on.passcode'])).toBeTruthy()
  })

  it('blocks two entries that differ and sends nothing', async () => {
    const h = home(OFF)
    await mountAtEntry(h)
    type(en['pin.setup.pinLabel'], '824619')
    type(en['pin.setup.confirm'], '824618')
    await submit()
    expect(screen.getByRole('alert').textContent).toBe(en['pin.problem.mismatch'])
    expect(h.calls.some(call => call.path.endsWith('/auth/pin/set'))).toBe(false)
  })

  it('clears a refusal once an entry changes: a valid matching PIN shows no error', async () => {
    const h = home(OFF)
    await mountAtEntry(h)
    await submit()
    expect(screen.getByRole('alert')).toBeTruthy()
    type(en['pin.setup.pinLabel'], '824619')
    type(en['pin.setup.confirm'], '824619')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByLabelText(en['pin.setup.confirm']).getAttribute('aria-invalid')).toBeNull()
  })

  it('blocks a PIN that is too short with an actionable sentence', async () => {
    const h = home(OFF)
    await mountAtEntry(h)
    type(en['pin.setup.pinLabel'], '8246')
    type(en['pin.setup.confirm'], '8246')
    await submit()
    expect(screen.getByRole('alert').textContent).toBe(en['pin.problem.pinShort'])
    expect(h.calls.some(call => call.path.endsWith('/auth/pin/set'))).toBe(false)
  })

  it('shows the home\'s refusal away from the computer in place and clears the typed secret', async () => {
    const h = home(OFF, () => json({ error: 'LOOPBACK_REQUIRED', message: 'no' }, 403))
    await mountAtEntry(h)
    type(en['pin.setup.pinLabel'], '824619')
    type(en['pin.setup.confirm'], '824619')
    await submit()
    expect(screen.getByRole('alert').textContent).toBe(en['pin.loopback'])
    expect((screen.getByLabelText(en['pin.setup.pinLabel']) as HTMLInputElement).value).toBe('')
    expect(screen.queryByText(en['pin.on'])).toBeNull()
  })

  it('leaves PIN mode off when the person skips: nothing is sent', async () => {
    const h = home(OFF)
    await mount(h)
    expect(h.calls.map(call => call.path)).toEqual(['/auth/pin/mode'])
  })

  it('shows PIN mode on, with a link to Settings, when it is already on', async () => {
    const h = home(ON)
    await mount(h)
    expect(screen.getByText(en['pin.on'])).toBeTruthy()
    expect(screen.queryByLabelText(en['pin.setup.pinLabel'])).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['pin.changeInSettings'] })) })
    expect(h.openSettings).toHaveBeenCalledOnce()
  })

  it('sets a typed PIN when Continue is pressed, and holds Continue when it cannot', async () => {
    const h = home(OFF)
    const guide = await mountAtEntry(h)
    type(en['pin.setup.pinLabel'], '824619')
    type(en['pin.setup.confirm'], '824618')
    await settle()
    expect(await guide.passGates()).toBe(false)
    type(en['pin.setup.pinLabel'], '824619')
    type(en['pin.setup.confirm'], '824619')
    await settle()
    let open = false
    await act(async () => { open = await guide.passGates() })
    expect(open).toBe(true)
    expect(h.calls.filter(call => call.path.endsWith('/auth/pin/set'))).toHaveLength(1)
  })

  it('shows two cards as one radio group, with Set a PIN chosen and arrow keys moving the choice', async () => {
    await mount(home(OFF))
    const group = screen.getByRole('radiogroup', { name: en['pin.choice.label'] })
    const [set, later] = Array.from(group.querySelectorAll<HTMLElement>('[role=radio]'))
    expect(set?.getAttribute('aria-checked')).toBe('true')
    expect(later?.getAttribute('aria-checked')).toBe('false')
    expect(later?.getAttribute('tabindex')).toBe('-1')
    await act(async () => { fireEvent.keyDown(set as HTMLElement, { key: 'ArrowRight' }) })
    expect(later?.getAttribute('aria-checked')).toBe('true')
  })

  it('lets Continue go on without a PIN when Not now is chosen, and sends nothing', async () => {
    const h = home(OFF)
    const guide = await mount(h)
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: new RegExp(en['pin.choice.later.title']) })) })
    await act(async () => { expect(await guide.passGates()).toBe(true) })
    expect(h.calls.some(call => call.path.endsWith('/auth/pin/set'))).toBe(false)
  })

  it('opens the entry on Continue with Set a PIN, shows the checks live and goes back to the cards', async () => {
    await mountAtEntry(home(OFF))
    expect(screen.getByText(en['pin.stored.title'])).toBeTruthy()
    const checks = screen.getByRole('list', { name: en['pin.checks.label'] })
    expect(checks.querySelectorAll('[data-met]')).toHaveLength(0)
    type(en['pin.setup.pinLabel'], '824619')
    type(en['pin.setup.confirm'], '824619')
    expect(checks.querySelectorAll('[data-met]')).toHaveLength(3)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['pin.setup.back'] })) })
    expect(screen.getByRole('radiogroup')).toBeTruthy()
  })

  it('reads a failed read as an in-place error with a retry', async () => {
    const h = home(OFF)
    h.fetch.mockImplementationOnce(() => Promise.resolve(json({ error: 'LOOPBACK_REQUIRED', message: 'no' }, 403)))
    await mount(h)
    expect(screen.getByRole('alert').textContent).toContain(en['pin.loopback'])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['pin.retry'] })) })
    await settle()
    expect(screen.getByRole('radiogroup')).toBeTruthy()
  })
})

describe('where the PIN step shows', () => {
  const ids = (reach: ReachState, phone: 'untouched' | 'on' | 'skipped' | 'done' = 'untouched', options: { readonly first?: boolean; readonly pinOn?: boolean } = {}): string[] => {
    const guide = createGuide(hostFake().host)
    const record = { reachSetUp: false } as SetupRecord
    return buildSteps({ services: stepServices(), guide, record, extra: [], reach, phone, target: { kind: 'other' }, notice: undefined, keepCurrent: false, first: options.first ?? false, pinOn: options.pinOn ?? false }).map(step => step.id)
  }

  it('shows on a first open at the computer with reach set up and PIN mode off, and leaves out the Phone access step', () => {
    expect(ids('set-up', 'untouched', { first: true })).toEqual([STEPS.welcome.id, STEPS.providers.id, STEPS.pin.id, STEPS.ready.id])
  })

  it('leaves out of a first open at the computer where PIN mode is already on, and keeps in the full guide', () => {
    expect(ids('set-up', 'untouched', { first: true, pinOn: true })).toEqual([STEPS.welcome.id, STEPS.providers.id, STEPS.ready.id])
    expect(ids('set-up', 'untouched', { pinOn: true })).toContain(STEPS.pin.id)
  })

  it('shows the computer-only version on a first open at a phone, and not where PIN mode is on', () => {
    expect(ids('remote', 'untouched', { first: true })).toEqual([STEPS.welcome.id, STEPS.providers.id, STEPS.pin.id, STEPS.ready.id])
    expect(ids('remote', 'untouched', { first: true, pinOn: true })).toEqual([STEPS.welcome.id, STEPS.providers.id, STEPS.ready.id])
  })

  it('leaves out of a first open where the home has no reach, or reach is off', () => {
    expect(ids('absent', 'untouched', { first: true })).not.toContain(STEPS.pin.id)
    expect(ids('off', 'untouched', { first: true })).toEqual([STEPS.welcome.id, STEPS.providers.id, STEPS.ready.id])
  })

  it('shows after Phone access at the computer with reach already on', () => {
    expect(ids('set-up')).toContain(STEPS.pin.id)
    const order = ids('set-up')
    expect(order.indexOf(STEPS.pin.id)).toBeLessThan(order.indexOf(STEPS.workspace.id))
  })

  it('shows once the Phone access step finds reach on, and not when it was skipped or is still off', () => {
    expect(ids('off', 'on')).toContain(STEPS.pin.id)
    expect(ids('off', 'skipped')).not.toContain(STEPS.pin.id)
    expect(ids('off', 'done')).not.toContain(STEPS.pin.id)
    expect(ids('off')).not.toContain(STEPS.pin.id)
  })

  it('is skipped where there is no reach, and a phone gets the computer-only version', () => {
    expect(ids('remote', 'on')).toContain(STEPS.pin.id)
    expect(ids('absent')).not.toContain(STEPS.pin.id)
  })
})
