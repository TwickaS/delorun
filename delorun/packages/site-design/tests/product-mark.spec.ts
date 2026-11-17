import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProductMark } from '../src/product-mark.tsx'

describe('the product mark', () => {
  it('pins the plug to the brand peach whatever accent a look sets', () => {
    const html = renderToStaticMarkup(createElement(ProductMark, { size: 20 }))
    expect(html).toContain('--dl-accent:var(--dl-peach)')
    expect(html).toContain('data-delorun-mark')
  })
})
