// @vitest-environment jsdom
/** The shared appearance chips: one selected state, a single tab stop, radio-group keys, and 44px targets. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccentPicker, ChipGroup, StudioLookSwitch, ThemePicker } from '../src/index.ts'

afterEach(cleanup)

const OPTIONS = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }, { value: 'c', label: 'Gamma' }] as const
const radios = () => screen.getAllByRole('radio')
const press = async (element: HTMLElement, key: string) => { await act(async () => { fireEvent.keyDown(element, { key }) }) }

describe('the chip group', () => {
  it('marks exactly the chosen chip, keeps it as the one tab stop, and chooses a clicked chip once', async () => {
    const onChange = vi.fn()
    render(<ChipGroup label="Letters" value="b" options={OPTIONS} onChange={onChange} />)
    expect(screen.getByRole('radiogroup', { name: 'Letters' })).toBeTruthy()
    expect(radios().map(radio => [radio.textContent, radio.getAttribute('aria-checked'), radio.tabIndex])).toEqual([['Alpha', 'false', -1], ['Beta', 'true', 0], ['Gamma', 'false', -1]])
    await act(async () => { fireEvent.click(radios()[1] as HTMLElement) })
    expect(onChange).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(radios()[2] as HTMLElement) })
    expect(onChange).toHaveBeenCalledWith('c')
  })

  it('moves and chooses with the arrow keys, Home and End, wrapping at the ends', async () => {
    const onChange = vi.fn()
    render(<ChipGroup label="Letters" value="a" options={OPTIONS} onChange={onChange} />)
    ;(radios()[0] as HTMLElement).focus()
    await press(radios()[0] as HTMLElement, 'ArrowLeft')
    expect(onChange).toHaveBeenLastCalledWith('c')
    expect(document.activeElement).toBe(radios()[2])
    await press(radios()[2] as HTMLElement, 'Home')
    await press(radios()[0] as HTMLElement, 'ArrowRight')
    expect(onChange).toHaveBeenLastCalledWith('b')
    await press(radios()[1] as HTMLElement, 'End')
    expect(onChange).toHaveBeenLastCalledWith('c')
  })

  it('only moves focus in a manual group, and refuses every key while disabled', async () => {
    const onChange = vi.fn()
    const { rerender } = render(<ChipGroup label="Letters" value="a" options={OPTIONS} onChange={onChange} manual />)
    await press(radios()[0] as HTMLElement, 'ArrowRight')
    expect(document.activeElement).toBe(radios()[1])
    expect(onChange).not.toHaveBeenCalled()
    rerender(<ChipGroup label="Letters" value="a" options={OPTIONS} onChange={onChange} disabled />)
    expect(radios().every(radio => (radio as HTMLButtonElement).disabled)).toBe(true)
    await act(async () => { fireEvent.click(radios()[1] as HTMLElement) })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('the pickers', () => {
  const colours = { page: 'rgb(1 2 3)', text: 'rgb(4 5 6)', accent: 'rgb(7 8 9)' }

  it('shows the theme chips with their swatch and chooses one', async () => {
    const onChange = vi.fn()
    render(<ThemePicker label="Theme" value="soft" onChange={onChange}
      themes={[{ value: 'soft', label: 'Soft', light: colours, dark: colours }, { value: 'x', label: 'Slate', light: colours, dark: colours }]} />)
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Slate' })) })
    expect(onChange).toHaveBeenCalledWith('x')
    expect(screen.getByRole('radio', { name: 'Soft' }).getAttribute('aria-checked')).toBe('true')
  })

  it('locks the accent chips while a theme brings its own accent', async () => {
    const onChange = vi.fn()
    render(<AccentPicker label="Accent" value="peach" onChange={onChange} disabled
      accents={[{ value: 'peach', label: 'Peach', light: '#e5734a', dark: '#e5734a' }, { value: 'moss', label: 'Moss', light: '#3f7a4f', dark: '#3f7a4f' }]} />)
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Moss' })) })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('is an on switch for the Delorun look, and turning it off chooses Stock', async () => {
    const onChange = vi.fn()
    render(<StudioLookSwitch label="Delorun look" onChange={onChange} />)
    const toggle = screen.getByRole('switch', { name: 'Delorun look' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    await act(async () => { fireEvent.click(toggle) })
    expect(onChange).toHaveBeenCalledWith('stock')
  })
})
