// @vitest-environment jsdom
/** The Toast position control: six labelled zones in one radio group, chosen by click, Enter or arrow keys; and the setting's validation. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Config, DEFAULT_SETTINGS, TOAST_POSITIONS, type ToastPosition } from '../src/config.ts'
import { arrowTarget, ToastPositionPicker } from '../src/client/ToastPositionPicker.tsx'

afterEach(cleanup)

const NAMES = Object.fromEntries(TOAST_POSITIONS.map(position => [position, `Zone ${position}`])) as Record<ToastPosition, string>

/**
 * Draw the control.
 * @param value - the chosen position.
 * @param onChange - the change handler.
 * @param disabled - whether the control is disabled.
 * @returns the render result.
 */
function draw(value: ToastPosition, onChange = vi.fn(), disabled = false) {
  return render(<ToastPositionPicker value={value} label="Toast position" names={NAMES} disabled={disabled} onChange={onChange} />)
}

describe('the toast position setting', () => {
  it('defaults to the bottom left', () => {
    expect(DEFAULT_SETTINGS.toastPosition).toBe('bottom-left')
    expect(Config({}).toastPosition.get()).toBe('bottom-left')
  })

  it('accepts the six positions and rejects any other value', () => {
    for (const position of TOAST_POSITIONS) expect(Config({ toastPosition: position }).toastPosition.get()).toBe(position)
    expect(() => Config({ toastPosition: 'middle' })).toThrow()
  })
})

describe('the toast position control', () => {
  it('names the group and each of the six zones and marks the chosen one', () => {
    const view = draw('top-right')
    expect(view.getByRole('radiogroup', { name: 'Toast position' })).toBeTruthy()
    const radios = view.getAllByRole('radio')
    expect(radios.map(radio => radio.getAttribute('aria-label'))).toEqual(TOAST_POSITIONS.map(position => NAMES[position]))
    expect(radios.filter(radio => radio.getAttribute('aria-checked') === 'true').map(radio => radio.dataset.position)).toEqual(['top-right'])
  })

  it('assigns the position of the zone clicked, and nothing for the chosen zone', () => {
    const onChange = vi.fn()
    const view = draw('bottom-left', onChange)
    fireEvent.click(view.getByRole('radio', { name: 'Zone top-centre' }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('top-centre')
    fireEvent.click(view.getByRole('radio', { name: 'Zone bottom-left' }))
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('reaches only the chosen zone by Tab and moves focus with the arrow keys', () => {
    const view = draw('bottom-left')
    const radios = view.getAllByRole('radio')
    expect(radios.map(radio => radio.tabIndex)).toEqual([-1, -1, -1, 0, -1, -1])
    radios[3]!.focus()
    fireEvent.keyDown(radios[3]!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(radios[4])
    fireEvent.keyDown(radios[4]!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(radios[1])
    fireEvent.keyDown(radios[1]!, { key: 'Enter' })
    expect(document.activeElement).toBe(radios[1])
  })

  it('wraps the arrows in the grid and ignores other keys', () => {
    expect(arrowTarget(0, 'ArrowLeft')).toBe(2)
    expect(arrowTarget(5, 'ArrowRight')).toBe(3)
    expect(arrowTarget(0, 'ArrowUp')).toBe(3)
    expect(arrowTarget(4, 'ArrowDown')).toBe(1)
    expect(arrowTarget(2, 'a')).toBeUndefined()
  })

  it('does not assign while disabled', () => {
    const onChange = vi.fn()
    const view = draw('bottom-left', onChange, true)
    fireEvent.click(view.getByRole('radio', { name: 'Zone top-left' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})
