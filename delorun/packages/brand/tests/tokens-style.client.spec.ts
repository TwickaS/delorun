// @vitest-environment jsdom
/** Importing the brand adds its tokens to the document once, because a studio bundle drops a bare stylesheet import. */
import { describe, expect, it } from 'vitest'

describe('tokens style', () => {
  it('adds one style element for the tokens, however often the module is imported', async () => {
    await import('../src/index.ts')
    await import('../src/tokens-style.ts')
    const tags = document.head.querySelectorAll('style[data-delorun-brand-tokens]')
    expect(tags).toHaveLength(1)
  })
})
