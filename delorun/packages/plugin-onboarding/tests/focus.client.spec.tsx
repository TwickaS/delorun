// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

const mobile = vi.hoisted(() => ({ value: false }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async original => ({
  ...await original<typeof import('@deepseek-ai/dsh-client-ui-primitives')>(),
  isMobileDevice: () => mobile.value,
}))

const { landFocus } = await import('../src/client/focus.ts')

afterEach(() => {
  document.body.replaceChildren()
  mobile.value = false
})

/** A page root holding the given markup. */
function page(markup: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = markup
  document.body.append(root)
  return root
}

const COMPOSER = '<div data-composer-card tabindex="-1"><div data-composer-input contenteditable="true" tabindex="-1"></div></div>'

describe('where focus lands when the guide closes', () => {
  it('lands in the message box on a device with a keyboard', () => {
    const root = page(`<button>First</button>${COMPOSER}`)
    landFocus(root)
    expect(document.activeElement?.hasAttribute('data-composer-input')).toBe(true)
  })

  it('lands on the message box\'s card on a phone or tablet, so the on-screen keyboard stays down', () => {
    mobile.value = true
    const root = page(`<button>First</button>${COMPOSER}`)
    landFocus(root)
    expect(document.activeElement?.hasAttribute('data-composer-card')).toBe(true)
  })

  it('skips a message box that cannot be edited, and controls that are hidden or inert', () => {
    const root = page('<div hidden><button>Hidden</button></div><div inert><button>Inert</button></div><button disabled>Off</button><a href="#x">Link</a><div data-composer-input contenteditable="false" tabindex="-1"></div>')
    landFocus(root)
    expect(document.activeElement?.textContent).toBe('Link')
  })

  it('changes nothing where the page has no control, or where focus already left the body', () => {
    const empty = page('<p>Text</p>')
    landFocus(empty)
    expect(document.activeElement).toBe(document.body)
    const root = page(`<button>Kept</button>${COMPOSER}`)
    ;(root.querySelector('button') as HTMLButtonElement).focus()
    landFocus(root)
    expect(document.activeElement?.textContent).toBe('Kept')
  })
})
