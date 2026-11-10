/**
 * Text a command prints that it did not write itself: every character a
 * terminal acts on, every bidirectional control and every character that shows
 * nothing at all is written as an escape, and nothing else changes.
 */
import { describe, expect, it } from 'vitest'
import { printable, quoted } from '../src/terminal-text.ts'

describe('terminal text', () => {
  it('escapes controls, separators, bidirectional controls and zero-width characters', () => {
    expect(printable('a\u001b[2Jb\u0007 ‮⁦')).toBe('a\\u001b[2Jb\\u0007\\u2028\\u202e\\u2066')
    for (const invisible of ['​', '‌', '‍', '⁠', '﻿', '­', '᠎']) {
      const code = invisible.charCodeAt(0).toString(16).padStart(4, '0')
      expect(printable(`pay${invisible}pal`)).toBe(`pay\\u${code}pal`)
    }
  })

  it('leaves visible text as it is, and quotes a string as JSON before it escapes it', () => {
    expect(printable('résumé — 日本語 ✓')).toBe('résumé — 日本語 ✓')
    expect(quoted('a​b')).toBe('"a\\u200bb"')
  })
})
