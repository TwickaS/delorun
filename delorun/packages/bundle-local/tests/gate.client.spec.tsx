// @vitest-environment jsdom
/**
 * A refused action is one of two states on a device: Face ID or the PIN (the notice says each call asks), or the
 * computer (the notice says why), or neither, which the caller reports as before.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ELEVATION_REQUIRED, gateEn, gateOf, gateZh, type GateTranslate } from '../src/client/gate.ts'
import { GateFailure, GateNotice } from '../src/client/GateNotice.tsx'
import { HostRequestError, LOOPBACK_REQUIRED } from '../src/client/host-api.ts'

afterEach(cleanup)

const refused = (code: string, fields?: Record<string, unknown>) => new HostRequestError('/x', { kind: 'refused', status: 403, code, message: 'no', ...fields === undefined ? {} : { fields } })
const t: GateTranslate = (key, values) => Object.entries(values ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, value), gateEn[key])

describe('gateOf', () => {
  it('names the Face ID and computer refusals and nothing else', () => {
    expect(gateOf(refused(ELEVATION_REQUIRED, { action: 'settings/update' }))).toEqual({ kind: 'face' })
    expect(gateOf(refused(LOOPBACK_REQUIRED))).toEqual({ kind: 'computer' })
    expect(gateOf(refused('BAD_REQUEST'))).toBeUndefined()
    expect(gateOf(new HostRequestError('/x', { kind: 'unreadable', status: 500 }))).toBeUndefined()
    expect(gateOf(new Error('x'))).toBeUndefined()
  })

  // Returning an `unlock` kind for a refusal that names no action brings back the Unlock prompt.
  it('stands for Face ID for an ELEVATION_REQUIRED refusal that names no grant action', () => {
    expect(gateOf(refused(ELEVATION_REQUIRED))).toEqual({ kind: 'face' })
  })
})

describe('the gate copy', () => {
  it('has the same keys in both languages', () => {
    expect(Object.keys(gateZh)).toEqual(Object.keys(gateEn))
  })

  it('names no unlock', () => {
    expect(Object.keys(gateEn).filter(key => key.startsWith('gate.unlock'))).toEqual([])
    expect(Object.values(gateEn).filter(text => /unlock/i.test(text))).toEqual([])
  })
})

describe('GateNotice', () => {
  it('says each call needs Face ID or the PIN, without a button', () => {
    render(<GateNotice gate={{ kind: 'face' }} t={t} reason="why" />)
    expect(screen.getByText(gateEn['gate.face'])).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says it is done on the computer and why', () => {
    render(<GateNotice gate={{ kind: 'computer' }} t={t} reason="only there" />)
    expect(screen.getByText('Do this on your computer: only there')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('GateFailure', () => {
  // Returning the `unlock` gate (its Unlock button and "Unlock this device" sentence) fails this.
  it('shows no Unlock button for a refusal that names no grant action', () => {
    render(<GateFailure t={t} error={refused(ELEVATION_REQUIRED)} text="the Host's sentence" />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText(gateEn['gate.face'])).toBeTruthy()
    expect(screen.queryByText(/unlock/i)).toBeNull()
  })

  it('shows another failure as an alert with its own sentence', () => {
    render(<GateFailure t={t} error={refused('BAD_REQUEST')} text="the Host's sentence" />)
    expect(screen.getByRole('alert').textContent).toBe('the Host\'s sentence')
  })
})
