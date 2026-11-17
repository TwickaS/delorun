// @vitest-environment jsdom
/** The Appearance section saves each colour choice through the theme row's form, under one Colours heading. */
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppearanceSection, type AppearanceInjected, type SchemePreference } from '../src/client/AppearanceSection.tsx'
import { en as brandingEn } from '../src/client/branding-locales.ts'
import { en as pickerEn } from '@delorun/brand/icon-picker-locales'
import { en, zh } from '../src/client/locales.ts'
import { STUDIO_ON, themeForm, type ThemeFormHandle } from './theme-form.client.ts'

afterEach(cleanup)

/**
 * Render the section on a form.
 * @param form - the settings form.
 */
function open(form: ThemeFormHandle) {
  let preference: SchemePreference = 'system'
  const listeners = new Set<() => void>()
  const set = vi.fn((next: SchemePreference) => { preference = next; for (const listener of listeners) listener() })
  const face: AppearanceInjected = {
    settings: form.scope,
    brandingT: makeTranslate(brandingEn),
    pickerT: makeTranslate(pickerEn),
    scheme: { get: () => preference, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, set },
  }
  render(<AppearanceSection t={makeTranslate(en)} {...face} />)
  return { set }
}

const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }) }
const group = (name: string) => screen.getByRole('radiogroup', { name })

const tile = (name: string) => within(group(en.palette)).getByRole('radio', { name })

describe('the Appearance section', () => {
  it('shows a preset as chosen with no accent picker, and writes only the palette when a tile is chosen', async () => {
    const form = themeForm(STUDIO_ON)
    open(form)
    expect(tile(en['palette.soft']).getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByRole('radiogroup', { name: en.accent })).toBeNull()
    expect(screen.queryByLabelText(en['accent.hex'])).toBeNull()
    expect(screen.queryByRole('slider', { name: en.contrast })).toBeNull()
    await click(tile(en['palette.grove']))
    await click(tile(en['palette.grove']))
    expect(form.writes).toEqual([['palette', 'grove']])
    expect(tile(en['palette.grove']).getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByRole('radiogroup', { name: en.accent })).toBeNull()
  })

  it('lists the presets then Custom as tiles, in one grid', () => {
    open(themeForm(STUDIO_ON))
    expect(within(group(en.palette)).getAllByRole('radio').map(each => each.textContent)).toEqual(
      ['soft', 't3-code', 't3-chat', 'grove', 'ocean', 'ember', 'iris', 'custom'].map(id => en[`palette.${id}` as keyof typeof en]))
  })

  it('moves between tiles with the arrow keys, Home and End, choosing the one it reaches', async () => {
    const form = themeForm(STUDIO_ON)
    open(form)
    const soft = tile(en['palette.soft'])
    soft.focus()
    await act(async () => { fireEvent.keyDown(soft, { key: 'ArrowRight' }) })
    expect(document.activeElement).toBe(tile(en['palette.t3-code']))
    await act(async () => { fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' }) })
    expect(document.activeElement).toBe(tile(en['palette.custom']))
    expect(form.writes[0]).toEqual(['palette', 't3-code'])
    expect(form.writes.at(-1)).toEqual(['palette', 'custom'])
  })

  it('reveals the custom panel only for Custom, seeded from the preset the person had, and writes the custom values together', async () => {
    const form = themeForm({ ...STUDIO_ON, palette: 'ocean' })
    open(form)
    await click(tile(en['palette.custom']))
    // Ocean's accent seeds the free colour; the palette is written last.
    expect(form.writes.map(([field]) => field)).toEqual(['accent', 'customAccent', 'contrast', 'palette'])
    expect(form.writes[0]?.[1]).toBe('custom')
    expect(form.writes[1]?.[1]).toMatch(/^#[0-9A-F]{6}$/)
    expect(form.writes[3]?.[1]).toBe('custom')
    expect(screen.getByRole('radiogroup', { name: en.accent })).toBeTruthy()
    expect(screen.getByRole('slider', { name: en.contrast })).toBeTruthy()
    await click(tile(en['palette.grove']))
    expect(screen.queryByRole('radiogroup', { name: en.accent })).toBeNull()
  })

  it('writes a custom accent preset, the typed hex on Enter and on blur, the picked colour, and refuses a hex that is not #RRGGBB', async () => {
    const form = themeForm({ ...STUDIO_ON, palette: 'custom', accent: 'peach' })
    open(form)
    await click(screen.getByRole('radio', { name: 'Moss' }))
    const hex = screen.getByLabelText<HTMLInputElement>('Hex colour')
    fireEvent.change(hex, { target: { value: '#12ab34' } })
    await act(async () => { fireEvent.keyDown(hex, { key: 'Enter' }) })
    fireEvent.change(hex, { target: { value: '#00ff00' } })
    await act(async () => { fireEvent.blur(hex) })
    const picker = screen.getByLabelText<HTMLInputElement>('Custom accent colour')
    await act(async () => { fireEvent.change(picker, { target: { value: '#aabbcc' } }) })
    expect(form.writes.filter(([field]) => field === 'customAccent').map(([, value]) => value).slice(1)).toEqual(['#12AB34', '#00FF00', '#AABBCC'])
    expect(form.writes.filter(([field]) => field === 'accent').map(([, value]) => value)).toEqual(['moss', 'custom', 'custom', 'custom'])
    const before = form.writes.length
    fireEvent.change(hex, { target: { value: 'peach' } })
    expect(screen.getByText(en['accent.hexInvalid'])).toBeTruthy()
    expect(hex.getAttribute('aria-invalid')).toBe('true')
    await act(async () => { fireEvent.blur(hex) })
    expect(form.writes).toHaveLength(before)
  })

  it('reads a stored preset beside a changed accent as the Custom theme it drew', async () => {
    const form = themeForm({ ...STUDIO_ON, palette: 'soft', accent: 'cobalt' })
    open(form)
    expect(tile(en['palette.custom']).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'Cobalt' }).getAttribute('aria-checked')).toBe('true')
    await click(screen.getByRole('radio', { name: 'Moss' }))
    expect(form.writes.at(-1)).toEqual(['palette', 'custom'])
    expect(form.writes.find(([field]) => field === 'accent')?.[1]).toBe('moss')
  })

  it('starts the colour picker from Peach when the stored custom colour does not parse', () => {
    open(themeForm({ ...STUDIO_ON, palette: 'custom', accent: 'custom', customAccent: 'broken' }))
    expect(screen.getByLabelText<HTMLInputElement>('Hex colour').value).toBe('#E5734A')
    expect(screen.getByLabelText<HTMLInputElement>('Custom accent colour').value).toBe('#e5734a')
  })

  it('holds the mode and the themes under one Colours heading that names the section', () => {
    open(themeForm(STUDIO_ON))
    const heading = screen.getByRole('heading', { level: 3, name: en.colours })
    expect(heading.closest('section')?.getAttribute('aria-labelledby')).toBe(heading.id)
    // The Branding block follows the Colours card as a second card of the same section.
    expect(screen.getAllByRole('heading', { level: 3 }).map(each => each.textContent)).toEqual([en.colours, brandingEn.title])
    expect(within(heading.closest('section') as HTMLElement).getAllByRole('heading', { level: 4 }).map(each => each.textContent)).toEqual([en.palette])
    expect(screen.queryByRole('radiogroup', { name: en.typeface })).toBeNull()
    expect(screen.queryByRole('radiogroup', { name: en.density })).toBeNull()
    expect(screen.queryByRole('radiogroup', { name: en.effort })).toBeNull()
  })

  it('saves the contrast of the Custom theme when the slider is let go by pointer, key or blur, only when it moved, and resets to 100 from the notch', async () => {
    const form = themeForm({ ...STUDIO_ON, palette: 'custom', contrast: 140 })
    open(form)
    const contrast = () => form.writes.filter(([field]) => field === 'contrast').map(([, value]) => value)
    const slider = screen.getByRole('slider', { name: en.contrast })
    fireEvent.change(slider, { target: { value: '150' } })
    expect(screen.getByText('150%')).toBeTruthy()
    await act(async () => { fireEvent.pointerUp(slider) })
    expect(contrast()).toEqual([150])
    fireEvent.change(slider, { target: { value: '150' } })
    await act(async () => { fireEvent.keyUp(slider) })
    fireEvent.change(slider, { target: { value: '60' } })
    await act(async () => { fireEvent.blur(slider) })
    await act(async () => { fireEvent.blur(slider) })
    expect(contrast()).toEqual([150, 60])
    await click(screen.getByRole('button', { name: '100%' }))
    expect(contrast()).toEqual([150, 60, 100])
    await click(screen.getByRole('button', { name: '100%' }))
    expect(contrast()).toHaveLength(3)
  })

  it('sets upstream\'s colour scheme preference from the one segmented row', async () => {
    const form = themeForm(STUDIO_ON)
    const { set } = open(form)
    await click(within(group(en.mode)).getByRole('radio', { name: /Dark/ }))
    await click(within(group(en.mode)).getByRole('radio', { name: /System/ }))
    expect(set.mock.calls).toEqual([['dark'], ['system']])
    await click(within(group(en.mode)).getByRole('radio', { name: /Light/ }))
    expect(set.mock.calls).toEqual([['dark'], ['system'], ['light']])
    expect(within(group(en.mode)).getAllByRole('radio').map(each => each.textContent)).toEqual(['Light', 'Dark', 'System'])
  })

  it('previews the tile under the pointer or focus, and returns to the chosen theme when it leaves', async () => {
    open(themeForm(STUDIO_ON))
    const sample = () => screen.getByRole('img', { name: en.preview })
    const accent = () => sample().style.getPropertyValue('--l-accent')
    const chosen = accent()
    await act(async () => { fireEvent.pointerEnter(tile(en['palette.grove'])) })
    expect(accent()).not.toBe(chosen)
    await act(async () => { fireEvent.pointerLeave(group(en.palette)) })
    expect(accent()).toBe(chosen)
    await act(async () => { tile(en['palette.iris']).focus() })
    expect(accent()).not.toBe(chosen)
  })

  it('reports a write the Host refused or could not carry, and clears the report on the next save', async () => {
    const form = themeForm(STUDIO_ON)
    open(form)
    form.answer = false
    await click(tile(en['palette.grove']))
    expect(screen.getByRole('alert').textContent).toBe(en.saveFailed)
    form.answer = 'throw'
    await click(tile(en['palette.ocean']))
    expect(screen.getByRole('alert')).toBeTruthy()
    form.answer = true
    await click(tile(en['palette.iris']))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('locks every choice while the document is not writable, and draws the defaults before the settings arrive', () => {
    const form = themeForm(undefined)
    open(form)
    expect(tile(en['palette.soft']).getAttribute('aria-checked')).toBe('true')
    expect(tile(en['palette.grove']).hasAttribute('disabled')).toBe(true)
    cleanup()
    const locked = themeForm({ ...STUDIO_ON, palette: 'custom' })
    locked.publish({ writable: false })
    open(locked)
    expect(screen.getByRole('radio', { name: 'Moss' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('slider', { name: en.contrast }).hasAttribute('disabled')).toBe(true)
  })

  it('has a Chinese text for every English key', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})
