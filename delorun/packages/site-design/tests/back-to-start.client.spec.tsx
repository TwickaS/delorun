// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackToStart } from '../src/back-to-start.tsx'
import { setLook } from '../src/look-store.ts'
import { DEFAULT_LOOK, LOOK_NAMES } from '../src/looks.ts'
import type { ThemeCopy } from '../src/shell-copy.ts'

const copy: ThemeCopy = {
  open: 'Open', title: 'Look', themes: 'Theme', scheme: 'Mode', device: 'System', light: 'Light', dark: 'Dark', back: 'Back to how it started',
  current: (name, scheme) => `This page is in ${name}${scheme === undefined ? '' : `, ${scheme.toLowerCase()}`}.`, names: LOOK_NAMES,
  toast: { region: 'Notifications', theme: name => name, scheme: name => name, undo: name => name, reset: 'Reset.' },
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
  document.documentElement.removeAttribute('data-look')
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('the way back to how the page started', () => {
  it('offers nothing while the page is as it started', async () => {
    render(<BackToStart copy={copy} />)
    await act(async () => {})
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText(/This page is in/)).toBeNull()
  })

  it('names the look and the scheme once a look is chosen, and goes away after the reset', async () => {
    render(<BackToStart copy={copy} />)
    await act(async () => { setLook({ ...DEFAULT_LOOK, look: 'ocean', scheme: 'dark' }) })
    expect(screen.getByText('This page is in Ocean, dark.')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Back to how it started' })) })
    expect(screen.queryByRole('button')).toBeNull()
    expect(document.documentElement.dataset['look']).toBeUndefined()
  })

  it('moves focus to a stable element after the reset', async () => {
    const target = document.createElement('a')
    target.href = '#x'
    document.body.append(target)
    vi.stubGlobal('requestAnimationFrame', (run: () => void) => { run(); return 0 })
    render(<BackToStart copy={copy} after={() => target} />)
    await act(async () => { setLook({ ...DEFAULT_LOOK, look: 'ember' }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Back to how it started' })) })
    expect(document.activeElement).toBe(target)
    target.remove()
  })
})
