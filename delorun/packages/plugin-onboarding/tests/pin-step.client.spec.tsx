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
const submit = async () => { await act(async () => { fireEvent.submit(screen.getByLabelText(en['pin.label']).closest('form') as HTMLFormElement) }); await settle() }
const mount = async (h: ReturnType<typeof home>) => {
  const guide = createGuide(hostFake().host)
  render(<PinStep services={h.services} guide={guide} />)
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
    expect(en['pin.lead']).toContain('adding plugins')
    expect(en['pin.lead']).toContain('full access')
    expect(en['pin.lead']).toContain('only before actions that need an unlock')
    expect(screen.getByText(en['pin.here'])).toBeTruthy()
  })

  it('sends the PIN through the existing route with the home\'s own idle settings, shows PIN mode on, and keeps the secret out of storage', async () => {
    const h = home(OFF)
    await mount(h)
    type(en['pin.label'], '824619')
    type(en['pin.confirm'], '824619')
    await submit()
    expect(h.calls.find(call => call.path.endsWith('/auth/pin/set'))?.body).toEqual({ secret: '824619', idleMinutes: 15, lockWhenHidden: false })
    expect(screen.getByText(en['pin.on'])).toBeTruthy()
    expect(screen.queryByLabelText(en['pin.label'])).toBeNull()
    expect(writes).not.toHaveBeenCalled()
    expect(JSON.stringify([window.localStorage, window.sessionStorage])).not.toContain('824619')
  })

  it('takes a passcode as well', async () => {
    const h = home(OFF)
    await mount(h)
    type(en['pin.label'], 'correct horse battery')
    type(en['pin.confirm'], 'correct horse battery')
    await submit()
    expect(screen.getByText(en['pin.on.passcode'])).toBeTruthy()
  })

  it('blocks two entries that differ and sends nothing', async () => {
    const h = home(OFF)
    await mount(h)
    type(en['pin.label'], '824619')
    type(en['pin.confirm'], '824618')
    await submit()
    expect(screen.getByRole('alert').textContent).toBe(en['pin.problem.mismatch'])
    expect(h.calls.some(call => call.path.endsWith('/auth/pin/set'))).toBe(false)
  })

  it('blocks a PIN that is too short with an actionable sentence', async () => {
    const h = home(OFF)
    await mount(h)
    type(en['pin.label'], '8246')
    type(en['pin.confirm'], '8246')
    await submit()
    expect(screen.getByRole('alert').textContent).toBe(en['pin.problem.pinShort'])
    expect(h.calls.some(call => call.path.endsWith('/auth/pin/set'))).toBe(false)
  })

  it('shows the home\'s refusal away from the computer in place and clears the typed secret', async () => {
    const h = home(OFF, () => json({ error: 'LOOPBACK_REQUIRED', message: 'no' }, 403))
    await mount(h)
    type(en['pin.label'], '824619')
    type(en['pin.confirm'], '824619')
    await submit()
    expect(screen.getByRole('alert').textContent).toBe(en['pin.loopback'])
    expect((screen.getByLabelText(en['pin.label']) as HTMLInputElement).value).toBe('')
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
    expect(screen.queryByLabelText(en['pin.label'])).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['pin.changeInSettings'] })) })
    expect(h.openSettings).toHaveBeenCalledOnce()
  })

  it('sets a typed PIN when Continue is pressed, and holds Continue when it cannot', async () => {
    const h = home(OFF)
    const guide = await mount(h)
    type(en['pin.label'], '824619')
    type(en['pin.confirm'], '824618')
    await settle()
    expect(await guide.passGates()).toBe(false)
    type(en['pin.label'], '824619')
    type(en['pin.confirm'], '824619')
    await settle()
    let open = false
    await act(async () => { open = await guide.passGates() })
    expect(open).toBe(true)
    expect(h.calls.filter(call => call.path.endsWith('/auth/pin/set'))).toHaveLength(1)
  })

  it('has no separate Set PIN button, and the note says Continue sets it', async () => {
    await mount(home(OFF))
    expect(screen.queryByRole('button', { name: /set pin/i })).toBeNull()
    expect(screen.getByText(en['pin.skipNote'])).toBeTruthy()
    expect(en['pin.skipNote']).toContain('Continue sets the PIN')
  })

  it('reads a failed read as an in-place error with a retry', async () => {
    const h = home(OFF)
    h.fetch.mockImplementationOnce(() => Promise.resolve(json({ error: 'LOOPBACK_REQUIRED', message: 'no' }, 403)))
    await mount(h)
    expect(screen.getByRole('alert').textContent).toContain(en['pin.loopback'])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['pin.retry'] })) })
    await settle()
    expect(screen.getByLabelText(en['pin.label'])).toBeTruthy()
  })
})

describe('where the PIN step shows', () => {
  const ids = (reach: ReachState, phone: 'untouched' | 'on' | 'skipped' | 'done' = 'untouched'): string[] => {
    const guide = createGuide(hostFake().host)
    const record = { reachSetUp: false } as SetupRecord
    return buildSteps({ services: stepServices(), guide, record, extra: [], reach, phone, target: { kind: 'other' }, notice: undefined, keepCurrent: false }).map(step => step.id)
  }

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
