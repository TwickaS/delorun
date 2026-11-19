// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SignupForm } from '../src/components/signup-form.tsx'
import { SIGNUP_EN } from '../src/site/words/signup-en.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | undefined
let host: HTMLElement

beforeEach(() => {
  host = document.body.appendChild(document.createElement('div'))
})

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  host.remove()
  vi.unstubAllGlobals()
  delete window.turnstile
})

/**
 * Renders the form, fills it and submits it.
 * @returns the form's submit button.
 */
async function submit(): Promise<HTMLButtonElement> {
  root = createRoot(host)
  await act(async () => root!.render(createElement(SignupForm, { page: '/' })))
  host.querySelector<HTMLInputElement>('input[type="email"]')!.value = 'ada@example.com'
  host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked = true
  const button = host.querySelector<HTMLButtonElement>('button[type="submit"]')!
  await act(async () => host.querySelector('form')!.requestSubmit(button))
  return button
}

describe('the sign-up form', () => {
  it('is the form’s one filled button, filled with the text colour', async () => {
    const button = await submit()
    expect(button.dataset['variant']).toBe('solid')
  })

  it('shows a refused sign-up directly under the button as an alert the button names', async () => {
    window.turnstile = { render: (_container, options) => { options['error-callback'](); return 'widget' }, reset: () => undefined }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ siteKey: 'key' }))))
    const button = await submit()
    const alert = host.querySelector('[role="alert"]')!
    expect(alert.textContent).toBe(SIGNUP_EN.checkError)
    expect(button.parentElement).toBe(alert.parentElement)
    expect(button.getAttribute('aria-describedby')).toBe(alert.id)
    expect(host.querySelector('[role="status"]')!.textContent).toBe('')
  })

  it('announces the Worker’s refusal in the same place', async () => {
    window.turnstile = { render: (_container, options) => { queueMicrotask(() => options.callback('token')); return 'widget' }, reset: () => undefined }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('subscribe') ? { ok: false, message: 'That address cannot be added.' } : { siteKey: 'key' }))))
    const button = await submit()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    const alert = host.querySelector('[role="alert"]')!
    expect(alert.textContent).toBe('That address cannot be added.')
    expect(button.getAttribute('aria-describedby')).toBe(alert.id)
  })

  it('keeps both answer regions in the page while there is nothing to say', async () => {
    root = createRoot(host)
    await act(async () => root!.render(createElement(SignupForm, { page: '/' })))
    expect(host.querySelector('[role="status"]')!.textContent).toBe('')
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('')
    expect(host.querySelector('button[type="submit"]')!.hasAttribute('aria-describedby')).toBe(false)
  })
})
