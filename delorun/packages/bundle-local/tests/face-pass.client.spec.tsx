// @vitest-environment jsdom
/**
 * The Face ID pass on a paired device (`src/client/face-id-pass.ts`, `FacePassChip.tsx`, `FacePassSetting.tsx`, the
 * pass-aware confirmation of `face-grant.ts` and the approval card): the chip shows and counts down, Lock now and five
 * minutes hidden end the pass, and a covered action shows no sheet while an always-ask one still asks.
 *
 * Each test's comment names the behaviour whose removal makes it fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ApprovalAllowGate } from '@deepseek-ai/dsh-client-ui-approval/client'
import { en } from '../src/client/face-id-locales.ts'
import { fakeApi, fakeBrowser } from '../src/client/face-id-fake.ts'
import { createFaceGrantSource, PASS_GRANT_ID, passAware } from '../src/client/face-grant.ts'
import {
  ALWAYS_ASK_ACTIONS, createPassSource, PASS_CHANGED, PASS_HIDDEN_LOCK_MS, PASS_ROUTES, PASS_SETTING_ACTION, passLastsLine, passMinutesOf, type PassSource,
} from '../src/client/face-id-pass.ts'
import { FacePassChip, type FacePassChipProps } from '../src/client/FacePassChip.tsx'
import { FacePassSetting } from '../src/client/FacePassSetting.tsx'
import { FaceIdAnswerAction, type FaceIdAnswerProps } from '../src/client/FaceIdAnswerAction.tsx'
import type { FaceIdAction } from '../src/client/face-id-types.ts'
import type { PinView } from '../src/client/pin-lock.ts'
import { fakeHost, type Answer } from './fake-host.ts'

const t = makeTranslate(en)
const MINUTE = 60_000
const START = 1_000_000

let clock: number
const sources: PassSource[] = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  clock = START
})

afterEach(() => {
  for (const made of sources.splice(0)) made.dispose()
  cleanup()
  vi.useRealTimers()
})

const passAnswer = (endsAt: number | null, minutes = 15): Answer => ({ status: 200, body: { minutes, choices: [0, 5, 15, 30, 60], pass: endsAt === null ? null : { startedAt: START, endsAt } } })

/** A pass source over a fake home that answers a live pass ending at `endsAt`, and the page's visibility. */
async function source(endsAt: number | null, options: { computer?: boolean; minutes?: number } = {}): Promise<{ pass: PassSource; host: ReturnType<typeof fakeHost>; hide: () => void; show: () => void }> {
  const host = fakeHost({ [`GET ${PASS_ROUTES.pass}`]: passAnswer(endsAt, options.minutes), [`POST ${PASS_ROUTES.lock}`]: { status: 200, body: { ended: true } } })
  let visibility: DocumentVisibilityState = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  const pass = createPassSource({ fetch: host.fetch, atComputer: () => options.computer ?? false, now: () => clock })
  sources.push(pass)
  await vi.waitFor(() => { expect(host.count(`GET ${PASS_ROUTES.pass}`)).toBeGreaterThan(0) })
  await act(async () => { await Promise.resolve() })
  const change = (next: DocumentVisibilityState): void => { visibility = next; window.dispatchEvent(new Event('visibilitychange')) }
  return { pass, host, hide: () => { change('hidden') }, show: () => { change('visible') } }
}

const install: FaceIdAction = { title: 'Install', body: '', grant: { actions: [{ action: 'pluginManager/installBundle', hash: 'h' }] } }

describe('the pass chip', () => {
  function chip(pass: PassSource): void {
    const props = { t, usePass: <S,>(select: (state: ReturnType<PassSource['current']>) => S): S => select(pass.current()), lockNow: pass.lockNow, now: () => clock } as FacePassChipProps
    render(<FacePassChip {...props} />)
  }

  // Removing the chip's countdown leaves the first count on screen; removing its end check leaves it after the pass.
  it('shows "Unlocked · 14 min" and counts down, then disappears at the end', async () => {
    const { pass } = await source(START + 14 * MINUTE)
    chip(pass)
    expect(screen.getByText('Unlocked · 14 min')).toBeTruthy()
    clock += 5 * MINUTE
    act(() => { vi.advanceTimersByTime(15_000) })
    expect(screen.getByText('Unlocked · 9 min')).toBeTruthy()
    clock += 9 * MINUTE
    act(() => { vi.advanceTimersByTime(9 * MINUTE) })
    cleanup()
    chip(pass)
    expect(screen.queryByText(/Unlocked/)).toBeNull()
  })

  // Removing the lock call from the chip leaves the pass running after Lock now.
  it('ends the pass with Lock now', async () => {
    const { pass, host } = await source(START + 14 * MINUTE)
    host.script[`GET ${PASS_ROUTES.pass}`] = passAnswer(null)
    chip(pass)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Lock now' })) })
    expect(host.count(`POST ${PASS_ROUTES.lock}`)).toBe(1)
    expect(pass.current().endsAt).toBeNull()
  })

  it('never shows at the computer, which has no pass', async () => {
    const { pass } = await source(START + 14 * MINUTE, { computer: true })
    expect(pass.current().endsAt).toBeNull()
    chip(pass)
    expect(screen.queryByText(/Unlocked/)).toBeNull()
  })
})

describe('the pass source', () => {
  // Removing the hidden timer leaves a pass running on a phone left in a pocket; removing its clear on return locks a page that came back.
  it('calls Lock now after five minutes hidden, and not when the page comes back sooner', async () => {
    const { host, hide, show } = await source(START + 30 * MINUTE)
    hide()
    act(() => { vi.advanceTimersByTime(PASS_HIDDEN_LOCK_MS - 1_000) })
    show()
    act(() => { vi.advanceTimersByTime(PASS_HIDDEN_LOCK_MS) })
    expect(host.count(`POST ${PASS_ROUTES.lock}`)).toBe(0)
    hide()
    await act(async () => { vi.advanceTimersByTime(PASS_HIDDEN_LOCK_MS) })
    expect(host.count(`POST ${PASS_ROUTES.lock}`)).toBe(1)
  })

  it('reads the pass again when a Face ID verified', async () => {
    const { host } = await source(null)
    const before = host.count(`GET ${PASS_ROUTES.pass}`)
    window.dispatchEvent(new Event(PASS_CHANGED))
    expect(host.count(`GET ${PASS_ROUTES.pass}`)).toBe(before + 1)
  })

  // Removing the always-ask or end checks in covers skips a sheet the home would refuse.
  it('covers a strong action while the pass is live, never an always-ask one, and nothing near or after the end', async () => {
    const { pass } = await source(START + MINUTE)
    expect(pass.covers('pluginManager/installBundle')).toBe(true)
    for (const action of ALWAYS_ASK_ACTIONS) expect(pass.covers(action), action).toBe(false)
    clock = START + MINUTE - 1_000
    expect(pass.covers('pluginManager/installBundle')).toBe(false)
  })
})

describe('no sheet under a pass', () => {
  // Removing passAware makes Changes, Update and a seat's answer ask again in a pass.
  it('resolves a covered action without a sheet, and still asks for an always-ask one', async () => {
    const { pass } = await source(START + 10 * MINUTE)
    const sheets = createFaceGrantSource()
    const grant = passAware(sheets.grant, pass)
    await expect(grant({ action: 'changes/plugin-apply', call: { method: 'POST', path: '/delorun/changes/apply', body: {} } })).resolves.toBe(PASS_GRANT_ID)
    expect(sheets.hooks.pending.getSnapshot()).toBeNull()
    const asked = grant({ action: PASS_SETTING_ACTION, call: { args: { minutes: 60 } } })
    expect(sheets.hooks.pending.getSnapshot()?.request.action).toBe(PASS_SETTING_ACTION)
    sheets.settle(undefined)
    await expect(asked).resolves.toBeUndefined()
  })

  // Removing the pass check in the approval card opens a sheet for an answer the home admits by the pass.
  it('lets an approval answer go with no sheet', async () => {
    const { pass } = await source(START + 10 * MINUTE)
    const gateAllow = vi.fn<(gate: ApprovalAllowGate | null) => void>()
    const api = fakeApi({ devices: [{ deviceId: 'd', label: 'Phone', thisDevice: true, passkeys: [{ credentialId: 'c1', createdAt: 0, lastUsedAt: null, synced: false }] }] })
    const props = {
      t, grants: 'full-access', callId: 'call-7' as ToolCallId, toolName: 'x', allow: async () => {}, answered: false, canAnswer: () => true, gateAllow,
      sessionId: 'chat-1', fetch: fakeHost({}).fetch, api, browser: fakeBrowser(), atComputer: () => false, pass,
      usePin: <S,>(select: (view: PinView) => S): S => select({ phase: 'on', secret: 'pin' }),
    } as FaceIdAnswerProps
    render(<FaceIdAnswerAction {...props} />)
    await vi.waitFor(() => { expect(gateAllow).toHaveBeenCalled() })
    const gate = gateAllow.mock.calls.findLast(([next]) => next !== null)?.[0]
    let sent: Promise<boolean> | undefined
    act(() => { sent = gate?.() })
    await expect(sent).resolves.toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.calls.some(call => call.name === 'options')).toBe(false)
  })
})

describe('the lasts line', () => {
  // Removing a condition of passMinutesOf promises a pass the home does not open.
  it('promises a pass only for Face ID, above Every time, and never for an always-ask action', async () => {
    expect(passMinutesOf(install, 'passkey', 15)).toBe(15)
    expect(passMinutesOf(install, 'pin', 15)).toBeUndefined()
    expect(passMinutesOf(install, 'passkey', 0)).toBeUndefined()
    expect(passMinutesOf({ ...install, grant: { actions: [{ action: 'auth/devices/remove', hash: 'h' }] } }, 'passkey', 15)).toBeUndefined()
    expect(passMinutesOf({ ...install, grant: { answer: { agent: 'a', callId: 'c', grants: 'full-access', value: 'allowed-once' } } }, 'passkey', 30)).toBe(30)
    await source(null, { minutes: 30 })
    expect(passLastsLine(t, install, 'passkey')).toBe('Strong actions on this phone for 30 minutes')
    expect(passLastsLine(t, install, 'pin')).toBeUndefined()
  })
})

describe('Ask again after', () => {
  // Removing the grant step lets a phone change the setting with no Face ID; the home refuses it, and the row says so.
  it('asks a phone for Face ID with a grant over exactly the body, then saves with the grant header', async () => {
    const host = fakeHost({ [`POST ${PASS_ROUTES.pass}`]: passAnswer(null, 60) })
    const grant = vi.fn(() => Promise.resolve('grant-1'))
    render(<FacePassSetting t={t} fetch={host.fetch} pass={{ minutes: 15, choices: [0, 5, 15, 30, 60], endsAt: null }} atComputer={false} grant={grant} />)
    expect(screen.getByRole('radio', { name: '15 min' }).getAttribute('aria-checked')).toBe('true')
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: '60 min' })) })
    expect(grant).toHaveBeenCalledWith({ action: PASS_SETTING_ACTION, call: { args: { minutes: 60 } } })
    const sent = host.received.find(request => request.key === `POST ${PASS_ROUTES.pass}`)
    expect(sent?.body).toEqual({ minutes: 60 })
    expect(new Headers(sent?.init?.headers).get('Delorun-Grant')).toBe('grant-1')
    await vi.waitFor(() => { expect(screen.getByRole('radio', { name: '60 min' }).getAttribute('aria-checked')).toBe('true') })
  })

  it('saves at the computer with no grant, and sends nothing when the phone\'s sheet is cancelled', async () => {
    const host = fakeHost({ [`POST ${PASS_ROUTES.pass}`]: passAnswer(null, 0) })
    const grant = vi.fn(() => Promise.resolve(undefined))
    render(<FacePassSetting t={t} fetch={host.fetch} pass={{ minutes: 15, choices: [0, 5, 15, 30, 60], endsAt: null }} atComputer grant={grant} />)
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Every time' })) })
    expect(grant).not.toHaveBeenCalled()
    expect(host.count(`POST ${PASS_ROUTES.pass}`)).toBe(1)
    cleanup()
    const phone = fakeHost({})
    render(<FacePassSetting t={t} fetch={phone.fetch} pass={{ minutes: 15, choices: [0, 5, 15, 30, 60], endsAt: null }} atComputer={false} grant={grant} />)
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: '30 min' })) })
    expect(phone.count(`POST ${PASS_ROUTES.pass}`)).toBe(0)
  })
})
