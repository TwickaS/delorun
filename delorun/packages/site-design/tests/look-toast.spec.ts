import { describe, expect, it, vi } from 'vitest'
import type { ThemeCopy } from '../src/shell-copy.ts'
import { DEFAULT_LOOK, LOOK_NAMES, type Look } from '../src/looks.ts'

const applied: Look[] = []
vi.mock('../src/look-store.ts', () => ({ setLook: (look: Look) => { applied.push(look) } }))

const copy: ThemeCopy = {
  open: 'Change the look', title: 'Look', themes: 'Theme', scheme: 'Light or dark', device: 'System', light: 'Light', dark: 'Dark', back: 'Back to how it started', names: LOOK_NAMES,
  toast: { region: 'Notifications', theme: name => `Now ${name}.`, scheme: name => `Now ${name}.`, undo: name => `Back to ${name}`, reset: 'Reset.' },
}

describe('the toast after a change of look', () => {
  it('names the new theme and offers the earlier one by name', async () => {
    const { lookToast } = await import('../src/look-toast.tsx')
    const toast = lookToast(copy, DEFAULT_LOOK, { ...DEFAULT_LOOK, look: 'ocean' })
    expect(toast?.message).toBe('Now Ocean.')
    expect(toast?.action?.label).toBe('Back to Soft')
    toast?.action?.onClick()
    expect(applied).toEqual([DEFAULT_LOOK])
  })

  it('names the scheme when only light or dark changed', async () => {
    const { lookToast } = await import('../src/look-toast.tsx')
    const toast = lookToast(copy, { ...DEFAULT_LOOK, scheme: 'light' }, { ...DEFAULT_LOOK, scheme: 'dark' })
    expect(toast?.message).toBe('Now Dark.')
    expect(toast?.action?.label).toBe('Back to Light')
  })

  it('names the device when the chosen scheme is removed', async () => {
    const { lookToast } = await import('../src/look-toast.tsx')
    const toast = lookToast(copy, { ...DEFAULT_LOOK, scheme: 'dark' }, { ...DEFAULT_LOOK, scheme: undefined })
    expect(toast?.message).toBe('Now System.')
    expect(toast?.action?.label).toBe('Back to Dark')
  })

  it('says nothing when nothing changed', async () => {
    const { lookToast } = await import('../src/look-toast.tsx')
    expect(lookToast(copy, DEFAULT_LOOK, DEFAULT_LOOK)).toBeUndefined()
  })
})
