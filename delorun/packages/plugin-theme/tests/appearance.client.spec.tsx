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

describe('the Appearance section', () => {
  it('saves a preset accent, then the custom colour: the pick, the typed hex on Enter and on blur, and refuses a typed colour that is not #RRGGBB', async () => {
    const form = themeForm(STUDIO_ON)
    open(form)
    await click(screen.getByRole('radio', { name: 'Moss' }))
    await click(screen.getByRole('radio', { name: 'Moss' }))
    await click(screen.getByRole('radio', { name: 'Custom' }))
    const hex = screen.getByLabelText<HTMLInputElement>('Hex colour')
    fireEvent.change(hex, { target: { value: '#12ab34' } })
    await act(async () => { fireEvent.keyDown(hex, { key: 'Enter' }) })
    fireEvent.keyDown(hex, { key: 'a' })
    fireEvent.change(hex, { target: { value: '#00ff00' } })
    await act(async () => { fireEvent.blur(hex) })
    const picker = screen.getByLabelText<HTMLInputElement>('Custom accent colour')
    await act(async () => { fireEvent.change(picker, { target: { value: '#aabbcc' } }) })
    expect(form.writes).toEqual([
      ['accent', 'moss'], ['accent', 'custom'], ['customAccent', '#12AB34'], ['customAccent', '#00FF00'], ['customAccent', '#AABBCC'],
    ])
    fireEvent.change(hex, { target: { value: 'peach' } })
    expect(screen.getByText(en['accent.hexInvalid'])).toBeTruthy()
    expect(hex.getAttribute('aria-invalid')).toBe('true')
    await act(async () => { fireEvent.blur(hex) })
    expect(form.writes).toHaveLength(5)
    expect(picker.value).toBe('#e5734a')
  })

  it('starts the colour picker from Peach when the stored custom colour does not parse', () => {
    open(themeForm({ ...STUDIO_ON, accent: 'custom', customAccent: 'broken' }))
    expect(screen.getByLabelText<HTMLInputElement>('Hex colour').value).toBe('broken')
    expect(screen.getByLabelText<HTMLInputElement>('Custom accent colour').value).toBe('#e5734a')
  })

  it('saves the theme; a theme already chosen saves nothing, and a theme other than Soft sets the accent', async () => {
    const form = themeForm(STUDIO_ON)
    open(form)
    await click(within(group(en.palette)).getByRole('radio', { name: /Grove/ }))
    await click(within(group(en.palette)).getByRole('radio', { name: /Grove/ }))
    expect(form.writes).toEqual([['palette', 'grove']])
    expect(screen.getByText(en['accent.byTheme'])).toBeTruthy()
  })

  it('marks the theme\'s own accent as the chosen one under a theme and leaves every preset chip unchosen and disabled', async () => {
    open(themeForm({ ...STUDIO_ON, palette: 'ocean', accent: 'moss' }))
    const chips = within(group(en.accent)).getAllByRole('radio')
    expect(chips.map(chip => [chip.textContent, chip.getAttribute('aria-checked'), (chip as HTMLButtonElement).disabled])
      .filter(([, checked]) => checked === 'true')).toEqual([[en['accent.theme'], 'true', true]])
    expect(chips.filter(chip => chip.getAttribute('aria-checked') === 'true')).toHaveLength(1)
    expect(screen.getByRole('radio', { name: 'Moss' }).getAttribute('aria-checked')).toBe('false')
  })

  it('holds mode, theme, accent and contrast under one Colours heading that names the section', () => {
    open(themeForm(STUDIO_ON))
    const heading = screen.getByRole('heading', { level: 3, name: en.colours })
    expect(heading.closest('section')?.getAttribute('aria-labelledby')).toBe(heading.id)
    // The Branding block follows the Colours card as a second card of the same section.
    expect(screen.getAllByRole('heading', { level: 3 }).map(each => each.textContent)).toEqual([en.colours, brandingEn.title])
    expect(within(heading.closest('section') as HTMLElement).getAllByRole('heading', { level: 4 }).map(each => each.textContent)).toEqual([en.mode, en.palette, en.accent, en.contrast])
    expect(screen.queryByRole('radiogroup', { name: en.look })).toBeNull()
    expect(screen.queryByRole('radiogroup', { name: en.typeface })).toBeNull()
    expect(screen.queryByRole('radiogroup', { name: en.density })).toBeNull()
    expect(screen.queryByRole('radiogroup', { name: en.effort })).toBeNull()
  })

  it('saves the contrast when the slider is let go by pointer, key or blur, only when it moved, and resets to 100 from the notch', async () => {
    const form = themeForm({ ...STUDIO_ON, contrast: 140 })
    open(form)
    const slider = screen.getByRole('slider', { name: en.contrast })
    fireEvent.change(slider, { target: { value: '150' } })
    expect(screen.getByText('150%')).toBeTruthy()
    await act(async () => { fireEvent.pointerUp(slider) })
    expect(form.writes).toEqual([['contrast', 150]])
    fireEvent.change(slider, { target: { value: '150' } })
    await act(async () => { fireEvent.keyUp(slider) })
    fireEvent.change(slider, { target: { value: '60' } })
    await act(async () => { fireEvent.blur(slider) })
    await act(async () => { fireEvent.blur(slider) })
    expect(form.writes).toEqual([['contrast', 150], ['contrast', 60]])
    await click(screen.getByRole('button', { name: '100%' }))
    expect(form.writes.at(-1)).toEqual(['contrast', 100])
    await click(screen.getByRole('button', { name: '100%' }))
    expect(form.writes).toHaveLength(3)
  })

  it('previews the colour scheme tiles and sets upstream\'s preference', async () => {
    const form = themeForm(STUDIO_ON)
    const { set } = open(form)
    await click(within(group('Mode')).getByRole('radio', { name: /Dark/ }))
    await click(within(group('Mode')).getByRole('radio', { name: /System/ }))
    expect(set.mock.calls).toEqual([['dark'], ['system']])
    expect(within(group('Mode')).getByRole('radio', { name: /System/ }).getAttribute('aria-checked')).toBe('true')
  })

  it('locks the accent while a theme brings its own, because a saved accent would change nothing on screen', async () => {
    const form = themeForm({ ...STUDIO_ON, palette: 'ocean' })
    open(form)
    expect(screen.getByText(en['accent.byTheme'])).toBeTruthy()
    for (const radio of within(group('Accent')).getAllByRole('radio')) expect((radio as HTMLButtonElement).disabled).toBe(true)
    await click(screen.getByRole('radio', { name: 'Moss' }))
    expect(form.writes).toEqual([])
  })

  it('shows the theme chosen in Settings as selected and saves a theme change that applies a different look', async () => {
    const form = themeForm(STUDIO_ON)
    open(form)
    await click(screen.getByRole('radio', { name: en['palette.t3-code'] }))
    expect(form.writes).toEqual([['palette', 't3-code']])
    expect(screen.getByRole('radio', { name: en['palette.t3-code'] }).getAttribute('aria-checked')).toBe('true')
  })

  it('reports a write the Host refused or could not carry, and clears the report on the next save', async () => {
    const form = themeForm(STUDIO_ON)
    open(form)
    form.answer = false
    await click(screen.getByRole('radio', { name: 'Moss' }))
    expect(screen.getByRole('alert').textContent).toBe(en.saveFailed)
    form.answer = 'throw'
    await click(screen.getByRole('radio', { name: 'Cobalt' }))
    expect(screen.getByRole('alert')).toBeTruthy()
    form.answer = true
    await click(screen.getByRole('radio', { name: 'Mono' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('locks every choice while the document is not writable, and draws the defaults before the settings arrive', () => {
    const form = themeForm(undefined)
    open(form)
    expect(screen.getByRole('radio', { name: 'Peach' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'Moss' }).hasAttribute('disabled')).toBe(true)
    cleanup()
    const locked = themeForm(STUDIO_ON)
    locked.publish({ writable: false })
    open(locked)
    expect(screen.getByRole('radio', { name: 'Moss' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('slider', { name: en.contrast }).hasAttribute('disabled')).toBe(true)
  })

  it('has a Chinese text for every English key', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})
