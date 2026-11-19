// @vitest-environment jsdom
/**
 * The Face ID step on a granting approval card: it registers a gate only on a phone, mints the
 * grant for exactly the request's Session, call and grants marker, and lets a cancel send nothing.
 *
 * Each test's comment names the behaviour whose removal makes it fail.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ApprovalAllowGate } from '@deepseek-ai/dsh-client-ui-approval/client'
import { en } from '../src/client/face-id-locales.ts'
import { fakeApi, fakeBrowser } from '../src/client/face-id-fake.ts'
import { FaceIdAnswerAction, type FaceIdAnswerProps } from '../src/client/FaceIdAnswerAction.tsx'
import type { PinView } from '../src/client/pin-lock.ts'
import { fakeHost } from './fake-host.ts'

const t = makeTranslate(en)
const passkey = { credentialId: 'c1', createdAt: 0, lastUsedAt: null, synced: false }
const pinView = (phase: PinView['phase']): PinView => ({ phase, secret: 'pin', busy: false, outcome: undefined, paused: false, asked: false })

/** Render the step and hand back the gate it registered. */
function card(over: { passkeys?: boolean | undefined; stateFails?: true; secret?: PinView['secret']; computer?: boolean | undefined; callId?: ToolCallId | undefined; grants?: FaceIdAnswerProps['grants'] } = {}) {
  const host = fakeHost({})
  const base = fakeApi({ devices: [{ deviceId: 'd', label: 'Phone', thisDevice: true, passkeys: over.passkeys === false ? [] : [passkey] }] })
  const api = over.stateFails === true ? Object.assign(base, { state: () => Promise.reject(new Error('state unreadable')) }) : base
  const gateAllow = vi.fn<(gate: ApprovalAllowGate | null) => void>()
  const props = {
    t, grants: over.grants ?? 'full-access', callId: 'callId' in over ? over.callId : 'call-7' as ToolCallId, toolName: 'claude-code',
    allow: async () => {}, answered: false, canAnswer: () => true, gateAllow, sessionId: 'chat-1', fetch: host.fetch, api, browser: fakeBrowser(), atComputer: () => over.computer ?? false,
    usePin: <S,>(select: (view: PinView) => S): S => select({ ...pinView('unlocked'), secret: over.secret ?? 'pin' }),
  } as FaceIdAnswerProps
  render(<FaceIdAnswerAction {...props} />)
  const gate = (): ApprovalAllowGate => {
    const set = gateAllow.mock.calls.findLast(([next]) => next !== null)?.[0]
    if (!set) throw new Error('no gate set')
    return set
  }
  return { api, host, gateAllow, gate }
}

afterEach(cleanup)

describe('the approval card\'s Face ID step', () => {
  it('mints a grant for exactly the request\'s Session, call, grants marker and allowed-once, then lets the answer go', async () => {
    // The home keys the answer grant on all four; a missing or wider key would be refused or admit a persistent allow.
    const { api, gate, gateAllow } = card()
    await waitFor(() => { expect(gateAllow).toHaveBeenCalled() })
    let sent: Promise<boolean> | undefined
    act(() => { sent = gate()() })
    fireEvent.click(await screen.findByRole('button', { name: /Confirm with/ }))
    await expect(sent).resolves.toBe(true)
    expect(api.calls.find(call => call.name === 'options')?.request)
      .toEqual({ answer: { agent: 'chat-1', callId: 'call-7', grants: 'full-access', value: 'allowed-once' } })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('names the request in the sheet', async () => {
    // The sheet says what is being allowed, in the grant kind\'s own words.
    const { gate, gateAllow } = card({ grants: 'external-agent' })
    await waitFor(() => { expect(gateAllow).toHaveBeenCalled() })
    act(() => { void gate()() })
    expect(await screen.findByText('Start an external agent?')).toBeTruthy()
    expect(screen.getByText('This once, claude-code runs outside the sandbox with your own account.')).toBeTruthy()
  })
  it('sends nothing when the sheet is cancelled', async () => {
    // A cancel must resolve the gate false so the card sends no answer.
    const { gate, gateAllow } = card()
    await waitFor(() => { expect(gateAllow).toHaveBeenCalled() })
    let sent: Promise<boolean> | undefined
    act(() => { sent = gate()() })
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await expect(sent).resolves.toBe(false)
  })
  it.each([
    ['the page is the home\'s own computer', { computer: true }],
    ['the request has no call id', { callId: undefined }],
  ])('registers no gate when %s', async (_name, over) => {
    // Every other answer, and the computer\'s own studio, must go through without a prompt.
    const { gateAllow, api } = card(over)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(gateAllow).not.toHaveBeenCalled()
    expect(api.calls.some(call => call.name === 'options')).toBe(false)
  })
  // Reverting the keypad start in FaceIdGrantFlow shows a passkey sheet to a phone that has none.
  it('opens straight on the PIN keypad on a phone with no passkey, and mints a one-action grant through the PIN route, never a page unlock', async () => {
    const { api, gate, gateAllow } = card({ passkeys: false, secret: 'passcode' })
    await waitFor(() => { expect(gateAllow).toHaveBeenCalled() })
    let sent: Promise<boolean> | undefined
    act(() => { sent = gate()() })
    expect(screen.queryByRole('button', { name: 'Use PIN instead' })).toBeNull()
    fireEvent.change(await screen.findByLabelText('Passcode'), { target: { value: 'correct horse' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await expect(sent).resolves.toBe(true)
    expect(api.calls.find(call => call.name === 'pin')?.request).toEqual({ answer: { agent: 'chat-1', callId: 'call-7', grants: 'full-access', value: 'allowed-once' }, secret: 'correct horse' })
    expect(api.calls.some(call => call.name === 'options')).toBe(false)
  })
  // Reverting the Back-cancels rule for a phone with no passkey would drop it onto a passkey sheet it cannot use.
  it('sends nothing when the keypad of a phone with no passkey is left', async () => {
    const { gate, gateAllow } = card({ passkeys: false, secret: 'passcode' })
    await waitFor(() => { expect(gateAllow).toHaveBeenCalled() })
    let sent: Promise<boolean> | undefined
    act(() => { sent = gate()() })
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }))
    await expect(sent).resolves.toBe(false)
  })
  // Removing the catch on the state read leaves the gate waiting for ever when the passkey state cannot be read.
  it('opens the PIN keypad, not a passkey sheet, when the passkey state cannot be read', async () => {
    const { gate, gateAllow } = card({ stateFails: true, secret: 'passcode' })
    await waitFor(() => { expect(gateAllow).toHaveBeenCalled() })
    act(() => { void gate()() })
    expect(await screen.findByLabelText('Passcode')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Confirm with/ })).toBeNull()
  })
  it('removes the gate and settles an open sheet as cancelled when it unmounts', async () => {
    // A withdrawn card must not hold a stale gate.
    const { gate, gateAllow } = card()
    await waitFor(() => { expect(gateAllow).toHaveBeenCalled() })
    let sent: Promise<boolean> | undefined
    act(() => { sent = gate()() })
    cleanup()
    await expect(sent).resolves.toBe(false)
    expect(gateAllow).toHaveBeenLastCalledWith(null)
  })
})
