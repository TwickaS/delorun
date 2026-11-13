// @vitest-environment jsdom
/** The sidebar's brand occupants: the hex jack mark at the size the sidebar asks for, and the product name. */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BRAND_NAME, DeloBrandMark, DeloBrandName } from '../src/client/brand.tsx'

afterEach(cleanup)

describe('the sidebar brand', () => {
  it('draws the mark at the requested edge, its nut in the row\'s text colour, hidden from assistive technology', () => {
    for (const size of [24, 32]) {
      const { container } = render(<DeloBrandMark size={size} />)
      const mark = container.querySelector('svg')
      expect(mark?.getAttribute('width')).toBe(String(size))
      expect(mark?.getAttribute('height')).toBe(String(size))
      expect(mark?.getAttribute('aria-hidden')).toBe('true')
      expect(mark?.querySelector('path')?.getAttribute('fill')).toBe('currentColor')
      expect(mark?.querySelectorAll('circle')).toHaveLength(1)
      cleanup()
    }
  })

  it('names the brand beside it', () => {
    const { container } = render(<DeloBrandName />)
    expect(container.textContent).toBe(BRAND_NAME)
  })
})
