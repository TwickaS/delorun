// @vitest-environment jsdom
/**
 * The Face ID step on a granting approval card: it registers a gate only on a phone whose home has the flag on, mints the
 * grant for exactly the request's Session, call and grants marker, and lets a cancel send nothing.
 *
 * Each test's comment names the behaviour whose removal makes it fail.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ApprovalAllowGate } from '@deepseek-ai/dsh-client-ui-approval/client'
import { en } from '../src/client/face-id-locales.ts'
import { fakeApi, fakeBrowser } from '../src/client/face-id-fake.ts'
import { FaceIdAnswerAction, type FaceIdAnswerProps } from '../src/client/FaceIdAnswerAction.tsx'
import type { PinView } from '../src/client/pin-lock.ts'
import { fakeHost } from './fake-host.ts'

const t = makeTranslate(en)
const FLAGS = 'GET /api/delorunPreviewFlags.list' as const
const flags = (on: boolean) => ({ [FLAGS]: { status: 200, body: { flags: [{ id: 'unlock.passkeys', on }] } } })
const passkey = { credentialId: 'c1', createdAt: 0, lastUsedAt: null, synced: false }
const pinView = (phase: PinView['phase']): PinView => ({ phase, secret: 'pin', busy: false, outcome: undefined, paused: false, asked: false })

/** Render the step and hand back the gate it registered. */
function card(over: { on?: boolean; computer?: boolean; grants?: FaceIdAnswerProps['grants']; callId?: FaceIdAnswerProps['callId'] } = {}) {
  const host = fakeHost(flags(over.on ?? true))
  const api = fakeApi({ devices: [{ deviceId: 'd', label: 'Phone', thisDevice: true, passkeys: [passkey] }] })
  const gateAllow = vi.fn<(gate: ApprovalAllowGate | null) => void>()
  const props = {
    t, grants: 'grants' in over ? over.grants : 'full-access', callId: 'callId' in over ? over.callId : 'call-7', toolName: 'claude-code',
    gateAllow, sessionId: 'chat-1', fetch: host.fetch, api, browser: fakeBrowser(), atComputer: () => over.computer ?? false,
    usePin: <S,>(select: (view: PinView) => S): S => select(pinView('unlocked')),
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
    ['the flag is off', { on: false }],
    ['the page is the home\'s own computer', { computer: true }],
    ['the request grants nothing', { grants: undefined }],
    ['the request has no call id', { callId: undefined }],
  ])('registers no gate when %s', async (_name, over) => {
    // Every other answer, and the computer\'s own studio, must go through without a prompt.
    const { gateAllow, api } = card(over)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(gateAllow).not.toHaveBeenCalled()
    expect(api.calls.some(call => call.name === 'options')).toBe(false)
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
