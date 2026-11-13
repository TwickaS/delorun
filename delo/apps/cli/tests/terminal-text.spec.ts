/**
 * Text a command prints that it did not write itself: every character a
 * terminal acts on, every bidirectional control and every character that shows
 * nothing at all is written as an escape, and nothing else changes; a long line
 * wraps, and a long value is cut with what was left out named.
 */
import { describe, expect, it } from 'vitest'
import { clipped, CONTINUED, LINE_LIMIT, printable, printableJson, printableLines, printableText, quoted } from '../src/terminal-text.ts'

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

  it('writes every control, separator and bidirectional character as an escape', () => {
    expect(printable('a\u001b[2J\r\n\u0085\u2028\u202e\u2066b')).toBe('a\\u001b[2J\\u000d\\u000a\\u0085\\u2028\\u202e\\u2066b')
    expect(quoted('x\u202ey')).toBe('"x\\u202ey"')
  })

  it('keeps one line on one line, and wraps a long one without splitting an escape or a surrogate pair', () => {
    expect(printableLines('short\nline')).toEqual(['short\\u000aline'])
    expect(printableLines('')).toEqual([''])
    expect(printableLines('abcdefghij', 6)).toEqual(['abcdef', `${CONTINUED}gh`, `${CONTINUED}ij`])
    expect(printableLines('abcde\u001bf', 8)).toEqual(['abcde', `${CONTINUED}\\u001b`, `${CONTINUED}f`])
    expect(printableLines('abcde😀', 6)).toEqual(['abcde', `${CONTINUED}😀`])
    const long = printableLines('x'.repeat(LINE_LIMIT * 2))
    expect(long.every(line => line.length <= LINE_LIMIT)).toBe(true)
    expect(long.join('').replaceAll(CONTINUED, '')).toBe('x'.repeat(LINE_LIMIT * 2))
  })

  it('splits text on its line breaks and escapes the rest', () => {
    expect(printableText('+one\r\n-two\u001b')).toEqual(['+one\\u000d', '-two\\u001b'])
  })

  it('writes JSON that parses to the same value with no raw character a terminal acts on', () => {
    const value = { name: 'a\u202eb\u0085c\u2028d\u007f', nested: ['\u001b'] }
    const text = printableJson(value)
    expect(text).not.toMatch(/[\u001b\u007f\u0085\u2028\u202e]/u)
    expect(JSON.parse(text)).toEqual(value)
  })

  it('cuts a long value, saying how much was left out', () => {
    expect(clipped('short\u001b')).toBe('short\\u001b')
    expect(clipped('abcdefgh', 5)).toBe('abcde… (3 more characters)')
  })
})
