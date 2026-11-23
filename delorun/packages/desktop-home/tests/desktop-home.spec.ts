/**
 * The desktop home kind and the "at the computer" answer. The desktop's kind decides when it is one of the three values;
 * everything else, a hostile value included, leaves the caller's own answer untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { atComputer, desktopHomeKind } from '../src/index.ts'

const expose = (value: unknown): void => { Object.defineProperty(globalThis, 'delorunDesktop', { value, configurable: true, writable: true }) }

/** The desktop's application document, the only page whose preload exposes `delorunDesktop`. */
const APP_PAGE = { protocol: 'dsh-app:', hostname: 'app' }

beforeEach(() => { vi.stubGlobal('location', APP_PAGE) })
afterEach(() => {
  Reflect.deleteProperty(globalThis, 'delorunDesktop')
  vi.unstubAllGlobals()
})

describe('atComputer', () => {
  it.each([['bundled', true], ['wsl', true], ['remote', false]] as const)('%s decides %s whatever the fallback says', (homeKind, answer) => {
    expose(Object.freeze({ homeKind }))
    expect(atComputer(true)).toBe(answer)
    expect(atComputer(false)).toBe(answer)
    expect(desktopHomeKind()).toBe(homeKind)
  })

  it('returns the caller\'s own answer outside the desktop app', () => {
    expect(desktopHomeKind()).toBeUndefined()
    expect(atComputer(true)).toBe(true)
    expect(atComputer(false)).toBe(false)
  })

  it('treats null, a string and a number in place of the object as absent', () => {
    for (const hostile of [null, 'wsl', 'remote', 7, true]) {
      expose(hostile)
      expect(atComputer(true)).toBe(true)
      expect(atComputer(false)).toBe(false)
    }
  })

  it('treats a missing, null, non-string, or wrongly spelt home kind as absent', () => {
    for (const homeKind of [undefined, null, 1, true, {}, ['wsl'], 'WSL', 'wsl ', 'local', '']) {
      expose({ homeKind })
      expect(atComputer(true)).toBe(true)
      expect(atComputer(false)).toBe(false)
    }
    expose({})
    expect(atComputer(false)).toBe(false)
  })

  it('treats a getter that throws, on the object or its key, as absent', () => {
    Object.defineProperty(globalThis, 'delorunDesktop', { get: () => { throw new Error('refused') }, configurable: true })
    expect(atComputer(true)).toBe(true)
    expect(atComputer(false)).toBe(false)
    expose(Object.defineProperty({}, 'homeKind', { get: () => { throw new Error('refused') }, enumerable: true }))
    expect(atComputer(true)).toBe(true)
    expect(atComputer(false)).toBe(false)
  })

  it('ignores extra keys beside a valid home kind', () => {
    expose(Object.freeze({ homeKind: 'remote', token: 'x', atComputer: true }))
    expect(atComputer(true)).toBe(false)
    expose(Object.freeze({ homeKind: 'bundled', extra: 1 }))
    expect(atComputer(false)).toBe(true)
  })

  // Without the page check, any script of the web studio could define the object and every gate would follow it. Each
  // case fails when `desktopHomeKind` reads the global on a page that is not the application document.
  it.each(['bundled', 'wsl', 'remote'] as const)('ignores a %s value that a script planted on a web page', (homeKind) => {
    const pages = [
      { protocol: 'http:', hostname: 'localhost' },
      { protocol: 'https:', hostname: 'app' },
      { protocol: 'https:', hostname: 'laptop.example.test' },
      { protocol: 'http:', hostname: 'app' },
      { protocol: 'dsh-app:', hostname: 'other' },
      { protocol: 'file:', hostname: '' },
      { protocol: 'dsh-app', hostname: 'app' },
      { hostname: 'app' },
    ]
    for (const page of pages) {
      vi.stubGlobal('location', page)
      expose(Object.freeze({ homeKind }))
      expect(desktopHomeKind()).toBeUndefined()
      expect(atComputer(true)).toBe(true)
      expect(atComputer(false)).toBe(false)
    }
  })

  it('ignores the object when the page has no location, or one that is not an object or throws', () => {
    expose(Object.freeze({ homeKind: 'remote' }))
    for (const page of [undefined, null, 'dsh-app://app', 7]) {
      vi.stubGlobal('location', page)
      expect(atComputer(true)).toBe(true)
    }
    vi.stubGlobal('location', { get protocol(): string { throw new Error('refused') }, hostname: 'app' })
    expect(atComputer(false)).toBe(false)
  })
})
