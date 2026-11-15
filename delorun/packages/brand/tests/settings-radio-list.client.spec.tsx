// @vitest-environment jsdom
/** A radio list is one radio group of whole-line rows: named, one tab stop, arrow keys move the choice, and the chosen row shows its detail. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RadioList } from '../src/settings/RadioList.tsx'

afterEach(cleanup)

const ROWS = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }, { value: 'own', label: 'Own line', detail: <input aria-label="Own text" /> }] as const

function open(value: 'a' | 'b' | 'own', disabled = false) {
  const onChange = vi.fn()
  render(<RadioList<'a' | 'b' | 'own'> label="Lines" value={value} rows={ROWS} onChange={onChange} disabled={disabled} />)
  return onChange
}

describe('the radio list', () => {
  it('is a named radio group with the chosen row checked and the chosen row as its one tab stop', () => {
    open('b')
    expect(screen.getByRole('radiogroup', { name: 'Lines' })).toBeTruthy()
    expect(screen.getAllByRole('radio').map(radio => [radio.textContent, radio.getAttribute('aria-checked'), radio.tabIndex])).toEqual([['Alpha', 'false', -1], ['Beta', 'true', 0], ['Own line', 'false', -1]])
  })

  it('shows a row\'s detail only while that row is chosen', () => {
    open('a')
    expect(screen.queryByLabelText('Own text')).toBeNull()
    cleanup()
    open('own')
    expect(screen.getByLabelText('Own text')).toBeTruthy()
  })

  it('chooses a row by click or arrow key, never the chosen one, and refuses while disabled', () => {
    const onChange = open('a')
    fireEvent.click(screen.getByRole('radio', { name: 'Alpha' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Beta' }))
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Alpha' }), { key: 'ArrowUp' })
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Alpha' }), { key: 'x' })
    expect(onChange.mock.calls).toEqual([['b'], ['own']])
    cleanup()
    const refused = open('a', true)
    fireEvent.click(screen.getByRole('radio', { name: 'Beta' }))
    expect(refused).not.toHaveBeenCalled()
  })
})
