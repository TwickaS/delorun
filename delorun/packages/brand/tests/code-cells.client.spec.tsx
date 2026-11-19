// @vitest-environment jsdom
/** The code cells: one real input under the cells, so paste, deletion, completion and labels behave as in any field. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeCells, type CodeCellsProps } from '../src/index.ts'

afterEach(cleanup)

function Harness(props: Partial<CodeCellsProps> & { readonly done?: (value: string) => void }) {
  const [value, setValue] = useState(props.value ?? '')
  return <CodeCells label="Pairing code" length={8} {...props} value={value} onChange={setValue} onComplete={props.done} />
}

const field = (): HTMLInputElement => screen.getByLabelText('Pairing code') as HTMLInputElement

describe('the code cells', () => {
  it('is one input named by its localized label, with a cell per character and no value in the cells when masked', () => {
    const { container } = render(<Harness mask length={6} open value="8420" />)
    expect(screen.getAllByLabelText('Pairing code')).toHaveLength(1)
    expect(field().type).toBe('password')
    expect(field().getAttribute('inputmode')).toBe('numeric')
    const cells = container.querySelector('[data-cells]') as HTMLElement
    expect(cells.children).toHaveLength(6)
    expect(cells.getAttribute('data-cells')).toBe('4')
    expect(cells.getAttribute('aria-hidden')).toBe('true')
    expect(cells.outerHTML).not.toContain('8420')
  })

  it('shows plain digits for a one-time code and offers the phone its received code', () => {
    const { container } = render(<Harness autoComplete="one-time-code" value="1234" />)
    expect(field().getAttribute('autocomplete')).toBe('one-time-code')
    expect(container.querySelector('[data-cells]')?.textContent).toBe('1234')
  })

  it('takes a pasted code with separators as its digits, cut to the length, and completes once', () => {
    const done = vi.fn()
    render(<Harness done={done} />)
    fireEvent.change(field(), { target: { value: '1234-5678 99' } })
    expect(field().value).toBe('12345678')
    expect(done).toHaveBeenCalledTimes(1)
    expect(done).toHaveBeenCalledWith('12345678')
  })

  it('does not complete before the last digit, and deleting is the field\'s own', () => {
    const done = vi.fn()
    render(<Harness done={done} />)
    fireEvent.change(field(), { target: { value: '1234567' } })
    expect(done).not.toHaveBeenCalled()
    fireEvent.change(field(), { target: { value: '123456' } })
    expect(field().value).toBe('123456')
  })

  it('grows past its length for an open-ended PIN and never completes by itself', () => {
    const done = vi.fn()
    const { container } = render(<Harness open length={6} done={done} />)
    fireEvent.change(field(), { target: { value: '12345678' } })
    expect(container.querySelector('[data-cells]')?.children).toHaveLength(8)
    expect(done).not.toHaveBeenCalled()
  })

  it('marks the active cell while focused, and reports an error with the colour state and the aria flag', () => {
    const { container } = render(<Harness value="12" error />)
    expect(container.querySelector('[data-active]')).toBeNull()
    fireEvent.focus(field())
    field().setSelectionRange(2, 2)
    fireEvent.select(field())
    expect(container.querySelector('[data-active]')).not.toBeNull()
    expect(field().getAttribute('aria-invalid')).toBe('true')
    expect(container.querySelector('[data-error]')).not.toBeNull()
    expect(container.querySelector('[data-cells]')?.hasAttribute('data-shake')).toBe(true)
  })

  it('draws the label above the cells when asked, tied to the input', () => {
    render(<Harness showLabel />)
    expect(screen.getByText('Pairing code').tagName).toBe('LABEL')
    expect(field().id).not.toBe('')
  })
})
