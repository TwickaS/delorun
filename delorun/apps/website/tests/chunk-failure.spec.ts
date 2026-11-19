// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SUPPORT_EMAIL } from '../src/site/config.ts'
import { SIGNUP_FAILED } from '../src/site/words/signup-failed-en.ts'

// The lazy chunk fails to load, as on a dropped connection or after a deploy removed the old file.
vi.mock('../src/components/signup-form.tsx', () => { throw new Error('chunk failed to load') })

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ''
})

/**
 * Renders an element into the document and lets its lazy imports settle.
 * @param element - what to render.
 * @returns the container.
 */
async function render(element: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  await act(async () => { root!.render(element) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  return container
}

describe('a part whose chunk fails to load', () => {
  it('puts the address to write to in the sign-up form’s place', async () => {
    const { SignupForm } = await import('../src/components/signup.tsx')
    const page = await render(createElement('main', null, createElement('h1', null, 'Privacy'), createElement(SignupForm, { page: '/privacy' })))
    expect(page.querySelector('h1')!.textContent).toBe('Privacy')
    expect(page.textContent).toContain(SIGNUP_FAILED)
    expect(SIGNUP_FAILED).toContain(SUPPORT_EMAIL)
  })
})
