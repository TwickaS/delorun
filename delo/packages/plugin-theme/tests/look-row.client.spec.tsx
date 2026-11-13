// @vitest-environment jsdom
/** The General row that brings Delorun's look back: a switch that writes once and reports a refusal. */
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/config.ts'
import { en, zh } from '../src/client/look-locales.ts'
import { LookRow, type LookRowProps } from '../src/client/LookRow.tsx'
import { themeForm, type ThemeFormHandle } from './theme-form.client.ts'

afterEach(cleanup)

function open(form: ThemeFormHandle, useDeloLook: () => Promise<boolean>) {
  // The slot's runtime share is the renderer's; the row reads none of it.
  const props = { t: makeTranslate(en), settings: form.scope, useDeloLook } as LookRowProps
  render(<LookRow {...props} />)
  return screen.getByRole('switch', { name: en.title })
}

describe('the Delorun look row', () => {
  it('shows the switch off with a one-line description, and calls the write once while it is pending', async () => {
    let finish: (ok: boolean) => void = () => {}
    let calls = 0
    const control = open(themeForm(DEFAULT_SETTINGS), () => { calls += 1; return new Promise<boolean>((resolve) => { finish = resolve }) })
    expect(control.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(en.description)).toBeTruthy()
    await act(async () => { fireEvent.click(control) })
    expect(control.hasAttribute('disabled')).toBe(true)
    await act(async () => { fireEvent.click(control) })
    expect(calls).toBe(1)
    await act(async () => { finish(true) })
    expect(control.hasAttribute('disabled')).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports a refused write or a transport failure, and clears the report on the next try', async () => {
    const answers = [() => Promise.resolve(false), () => Promise.reject(new Error('transport')), () => Promise.resolve(true)]
    const control = open(themeForm(DEFAULT_SETTINGS), () => (answers.shift() ?? (() => Promise.resolve(true)))())
    await act(async () => { fireEvent.click(control) })
    expect(screen.getByRole('alert').textContent).toBe(en.saveFailed)
    await act(async () => { fireEvent.click(control) })
    expect(screen.getByRole('alert')).toBeTruthy()
    await act(async () => { fireEvent.click(control) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('is locked while the settings document is not writable', () => {
    const form = themeForm(DEFAULT_SETTINGS)
    form.publish({ writable: false })
    expect(open(form, () => Promise.resolve(true)).hasAttribute('disabled')).toBe(true)
  })

  it('has a Chinese text for every English key', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})
