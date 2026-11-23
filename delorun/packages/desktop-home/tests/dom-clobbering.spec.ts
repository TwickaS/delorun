// @vitest-environment jsdom
/**
 * A page can turn an element's `id` or a form's input `name` into a property of `window`. Under the desktop's application
 * document that must never read as a home kind: `desktopHomeKind` compares the value to the three strings and nothing
 * looser, so an element, however it is named, gives the caller's own answer. Each case fails when the comparison becomes a
 * truthiness or `String()` test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { atComputer, desktopHomeKind } from '../src/index.ts'

beforeEach(() => { vi.stubGlobal('location', { protocol: 'dsh-app:', hostname: 'app' }) })
afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

/** What a browser resolves `window.delorunDesktop` to when markup names it: the named element. */
const named = (markup: string): unknown => {
  document.body.innerHTML = markup
  return document.getElementById('delorunDesktop')
}

describe('desktopHomeKind under DOM clobbering', () => {
  it('gives the fallback for an element whose id is the global', () => {
    vi.stubGlobal('delorunDesktop', named('<div id="delorunDesktop" homeKind="bundled"></div>'))
    expect(desktopHomeKind()).toBeUndefined()
    expect(atComputer(true)).toBe(true)
    expect(atComputer(false)).toBe(false)
  })

  it('gives the fallback for a form whose input is named homeKind', () => {
    for (const value of ['bundled', 'wsl', 'remote']) {
      const form = named(`<form id="delorunDesktop"><input name="homeKind" value="${value}"></form>`) as HTMLFormElement
      // A browser makes `form.homeKind` the named input element, never its value; jsdom does not, so the case does it.
      Object.defineProperty(form, 'homeKind', { value: form.elements.namedItem('homeKind') })
      expect(Reflect.get(form, 'homeKind')).toBeInstanceOf(HTMLInputElement)
      vi.stubGlobal('delorunDesktop', form)
      expect(desktopHomeKind()).toBeUndefined()
      expect(atComputer(true)).toBe(true)
      expect(atComputer(false)).toBe(false)
    }
  })

  it('gives the fallback for an element whose homeKind is a string-like object', () => {
    vi.stubGlobal('delorunDesktop', { homeKind: { toString: () => 'bundled', valueOf: () => 'bundled' } })
    expect(desktopHomeKind()).toBeUndefined()
    expect(atComputer(false)).toBe(false)
  })
})
