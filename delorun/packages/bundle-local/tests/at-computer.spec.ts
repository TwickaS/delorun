/**
 * The plugin's "at the computer" gate: the connection's `isLoopback` on the web, the desktop app's home kind in the
 * desktop, where the page host is `app` and `isLoopback` is false.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pageAtComputer } from '../src/client/at-computer.ts'

afterEach(() => { vi.unstubAllGlobals() })

const ctxOf = (isLoopback: boolean) => ({ get: () => ({ isLoopback }) })

describe('pageAtComputer', () => {
  it.each([true, false])('answers the connection\'s own isLoopback (%s) outside the desktop app', (isLoopback) => {
    expect(pageAtComputer(ctxOf(isLoopback))).toBe(isLoopback)
  })

  it.each([['bundled', true], ['wsl', true], ['remote', false]] as const)('lets a %s desktop home decide (%s) over a false or true isLoopback', (homeKind, answer) => {
    vi.stubGlobal('delorunDesktop', Object.freeze({ homeKind }))
    expect(pageAtComputer(ctxOf(false))).toBe(answer)
    expect(pageAtComputer(ctxOf(true))).toBe(answer)
  })

  it('falls back to isLoopback for a value that is not a home kind', () => {
    for (const desktop of [null, 'bundled', { homeKind: 'Bundled' }, { homeKind: undefined }]) {
      vi.stubGlobal('delorunDesktop', desktop)
      expect(pageAtComputer(ctxOf(false))).toBe(false)
      expect(pageAtComputer(ctxOf(true))).toBe(true)
    }
  })
})
