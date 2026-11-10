// @vitest-environment jsdom
/** A choice group is one radio group: named, one tab stop, arrow keys move the choice, no tabs and no dangling panel references. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChoiceGroup } from '../src/client/ChoiceGroup.tsx'

afterEach(cleanup)

const OPTIONS = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }, { value: 'c', label: 'Gamma' }] as const

function open(value: 'a' | 'b' | 'c', disabled = false) {
  const onChange = vi.fn()
  render(<ChoiceGroup label="Letters" value={value} options={OPTIONS} onChange={onChange} disabled={disabled} />)
  return onChange
}

describe('the choice group', () => {
  it('is a named radio group of radios with the chosen one checked, and has no tabs or panel references', () => {
    open('b')
    const group = screen.getByRole('radiogroup', { name: 'Letters' })
    expect(screen.getAllByRole('radio').map(radio => [radio.textContent, radio.getAttribute('aria-checked')])).toEqual([['Alpha', 'false'], ['Beta', 'true'], ['Gamma', 'false']])
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(group.querySelector('[aria-controls]')).toBeNull()
  })

  it('has the chosen radio as its one tab stop', () => {
    open('b')
    expect(screen.getAllByRole('radio').map(radio => radio.tabIndex)).toEqual([-1, 0, -1])
  })

  it('chooses on a click of another radio, and on nothing for the chosen one', () => {
    const onChange = open('a')
    fireEvent.click(screen.getByRole('radio', { name: 'Alpha' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Gamma' }))
    expect(onChange.mock.calls).toEqual([['c']])
  })

  it('moves the focus and the choice with the arrow keys, wrapping at the ends, and ignores other keys', () => {
    const onChange = open('a')
    const alpha = screen.getByRole('radio', { name: 'Alpha' })
    fireEvent.keyDown(alpha, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Beta' }))
    fireEvent.keyDown(alpha, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Gamma' }))
    fireEvent.keyDown(alpha, { key: 'ArrowDown' })
    fireEvent.keyDown(alpha, { key: 'ArrowUp' })
    fireEvent.keyDown(alpha, { key: 'x' })
    expect(onChange.mock.calls).toEqual([['b'], ['c'], ['b'], ['c']])
  })

  it('does not choose the value it already has when a key lands on it', () => {
    const onChange = open('b')
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Alpha' }), { key: 'ArrowRight' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('locks every radio when disabled', () => {
    open('a', true)
    for (const radio of screen.getAllByRole('radio')) expect((radio as HTMLButtonElement).disabled).toBe(true)
  })
})
