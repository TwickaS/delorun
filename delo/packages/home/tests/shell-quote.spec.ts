/**
 * Specs of `shellQuote`: a suggested command's value pastes back into a POSIX shell as the one word it names.
 */
import { describe, expect, it } from 'vitest'
import { shellQuote } from '../src/index.ts'

describe('shellQuote', () => {
  it('writes one single-quoted word, escaping each single quote', () => {
    expect(shellQuote('/home/person/my site')).toBe('\'/home/person/my site\'')
    expect(shellQuote('it\'s')).toBe('\'it\'\\\'\'s\'')
    expect(shellQuote('$(rm -rf ~) `id`; x')).toBe('\'$(rm -rf ~) `id`; x\'')
  })
})
