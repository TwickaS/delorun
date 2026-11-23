/**
 * The desktop home kind and the "at the computer" answer. The desktop's kind decides when it is one of the three values;
 * everything else, a hostile value included, leaves the caller's own answer untouched.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { atComputer, desktopHomeKind } from '../src/index.ts'

const expose = (value: unknown): void => { Object.defineProperty(globalThis, 'delorunDesktop', { value, configurable: true, writable: true }) }

afterEach(() => { Reflect.deleteProperty(globalThis, 'delorunDesktop') })

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
})
