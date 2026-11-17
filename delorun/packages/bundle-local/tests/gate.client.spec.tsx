// @vitest-environment jsdom
/**
 * A refused action is one of three states on a device: unlock (the notice states the minutes and offers Unlock), the
 * computer (the notice says why), or neither, which the caller reports as before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ELEVATION_REQUIRED, gateEn, gateOf, gateZh, unlockSentence, type GateTranslate } from '../src/client/gate.ts'
import { GateNotice } from '../src/client/GateNotice.tsx'
import { HostRequestError, LOOPBACK_REQUIRED } from '../src/client/host-api.ts'

afterEach(cleanup)

const refused = (code: string) => new HostRequestError('/x', { kind: 'refused', status: 403, code, message: 'no' })
const t: GateTranslate = (key, values) => Object.entries(values ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, value), gateEn[key])

describe('gateOf', () => {
  it('names the unlock and computer refusals and nothing else', () => {
    expect(gateOf(refused(ELEVATION_REQUIRED))).toEqual({ kind: 'unlock' })
    expect(gateOf(refused(LOOPBACK_REQUIRED))).toEqual({ kind: 'computer' })
    expect(gateOf(refused('BAD_REQUEST'))).toBeUndefined()
    expect(gateOf(new HostRequestError('/x', { kind: 'unreadable', status: 500 }))).toBeUndefined()
    expect(gateOf(new Error('x'))).toBeUndefined()
  })
})

describe('the gate copy', () => {
  it('has the same keys in both languages', () => {
    expect(Object.keys(gateZh)).toEqual(Object.keys(gateEn))
  })

  it('states the unlock minutes, singular and unknown included', () => {
    expect(unlockSentence(t, 15)).toContain('15 minutes')
    expect(unlockSentence(t, 1)).toContain('1 minute ')
    expect(unlockSentence(t, undefined)).toBe(gateEn['gate.unlockUnknown'])
  })
})

describe('GateNotice', () => {
  it('prompts for the unlock with its minutes and opens the dialog', () => {
    const open = vi.fn()
    render(<GateNotice gate={{ kind: 'unlock' }} t={t} minutes={15} onUnlock={open} reason="why" />)
    expect(screen.getByText(/15 minutes/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: gateEn['gate.unlockButton'] }))
    expect(open).toHaveBeenCalledOnce()
  })

  it('offers no button where no unlock can be opened', () => {
    render(<GateNotice gate={{ kind: 'unlock' }} t={t} minutes={15} reason="why" />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says it is done on the computer and why', () => {
    render(<GateNotice gate={{ kind: 'computer' }} t={t} reason="only there" />)
    expect(screen.getByText('Do this on your computer: only there')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
