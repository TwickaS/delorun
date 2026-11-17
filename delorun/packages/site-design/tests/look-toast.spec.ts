import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThemeCopy } from '../src/shell-copy.ts'
import { DEFAULT_LOOK, LOOK_NAMES, type Look } from '../src/looks.ts'

const shown: Array<{ message: string; action?: { label: string; onClick: () => void } | undefined }> = []
const applied: Look[] = []

vi.mock('../../brand/src/toast.web.tsx', () => ({
  showToast: (toast: (typeof shown)[number]) => { shown.push(toast) },
  Toaster: () => null,
}))
vi.mock('../src/look-store.ts', () => ({ setLook: (look: Look) => { applied.push(look) } }))

const copy: ThemeCopy = {
  open: 'Change the look', title: 'Look', themes: 'Theme', scheme: 'Light or dark', light: 'Light', dark: 'Dark', back: 'Back to how it started', names: LOOK_NAMES,
  toast: { region: 'Notifications', theme: name => `Now ${name}.`, scheme: name => `Now ${name}.`, undo: name => `Back to ${name}`, reset: 'Reset.' },
}

describe('the toast after a change of look', () => {
  beforeEach(() => { shown.length = 0; applied.length = 0 })

  it('names the new theme and offers the earlier one by name', async () => {
    const { announceLook } = await import('../src/look-toast.tsx')
    const ocean: Look = { ...DEFAULT_LOOK, look: 'ocean' }
    announceLook(copy, DEFAULT_LOOK, ocean)
    expect(shown).toHaveLength(1)
    expect(shown[0]?.message).toBe('Now Ocean.')
    expect(shown[0]?.action?.label).toBe('Back to Soft')
    shown[0]?.action?.onClick()
    expect(applied).toEqual([DEFAULT_LOOK])
  })

  it('names the scheme when only light or dark changed', async () => {
    const { announceLook } = await import('../src/look-toast.tsx')
    announceLook(copy, { ...DEFAULT_LOOK, scheme: 'light' }, { ...DEFAULT_LOOK, scheme: 'dark' })
    expect(shown[0]?.message).toBe('Now Dark.')
    expect(shown[0]?.action?.label).toBe('Back to Light')
  })

  it('says nothing when nothing changed', async () => {
    const { announceLook } = await import('../src/look-toast.tsx')
    announceLook(copy, DEFAULT_LOOK, DEFAULT_LOOK)
    expect(shown).toEqual([])
  })

  it('says the reset in a sentence with no action, since it is itself the way back', async () => {
    const { announceReset } = await import('../src/look-toast.tsx')
    announceReset(copy)
    expect(shown).toEqual([{ message: 'Reset.' }])
  })
})
