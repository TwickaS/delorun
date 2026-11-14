import { describe, expect, it } from 'vitest'
import { dwellOf, pivotOf, plainText, plainWord, scanWords } from '../src/client/words.ts'

describe('reading words', () => {
  it('fixes the eye a little left of the middle, counted from the first letter', () => {
    expect(['a', 'word', 'reading', 'considerable', 'unquestionably'].map(pivotOf)).toEqual([0, 1, 2, 3, 4])
    expect(pivotOf('“quoted')).toBe(3)
    expect(pivotOf('(—)')).toBe(2)
  })

  it('holds the end of a sentence twice as long, a clause half as long again, and a long word a little longer', () => {
    expect(dwellOf('done.')).toBe(2)
    expect(dwellOf('really?”')).toBe(2)
    expect(dwellOf('完成。')).toBe(2)
    expect(dwellOf('first,')).toBe(1.5)
    expect(dwellOf('(aside;)')).toBe(1.5)
    expect(dwellOf('characteristically')).toBe(1.3)
    expect(dwellOf('plain')).toBe(1)
  })

  it('reads only complete words of a streaming text, and the last one once the text is final', () => {
    const text = 'Read  this\nslowly'
    const streaming = scanWords(text, 0, false)
    expect(streaming.words.map(word => text.slice(word.start, word.end))).toEqual(['Read', 'this'])
    expect(streaming.next).toBe(10)
    const final = scanWords(text, streaming.next, true)
    expect(final.words.map(word => text.slice(word.start, word.end))).toEqual(['slowly'])
    expect(final.next).toBe(text.length)
    expect(scanWords(text, text.length, true)).toEqual({ words: [], next: text.length })
  })

  it('reads Chinese, written without spaces, word by word, keeping punctuation on the word before it', () => {
    const text = '“我们先读文件，然后运行测试'
    const streaming = scanWords(text, 0, false)
    const read = streaming.words.map(word => text.slice(word.start, word.end))
    expect(read.length).toBeGreaterThan(2)
    expect(read[0]?.startsWith('“')).toBe(true)
    expect(read.some(word => word.endsWith('，'))).toBe(true)
    // The run's last word waits for more text; everything read so far is the text up to it.
    expect(read.join('')).toBe(text.slice(0, streaming.next))
    expect(streaming.next).toBeLessThan(text.length)
    const rest = scanWords(text, streaming.next, true)
    expect([...read, ...rest.words.map(word => text.slice(word.start, word.end))].join('')).toBe(text)
  })
  const shown = (text: string): string[] => scanWords(text, 0, true).words.map(word => word.text)

  it('shows the words without inline Markdown markup', () => {
    expect(shown('It costs **5 pence** and *x* is `code.run()` here')).toEqual(['It', 'costs', '5', 'pence', 'and', 'x', 'is', 'code.run()', 'here'])
    expect(shown('__strong__ ~~gone~~ (**bold**), snake_case 2*3')).toEqual(['strong', 'gone', '(bold),', 'snake_case', '2*3'])
    expect(shown('`npm install` now')).toEqual(['npm', 'install', 'now'])
  })

  it('keeps the text of a link or image and drops its address', () => {
    expect(shown('See [the docs](https://example.com/a_b) or [one](u).')).toEqual(['See', 'the', 'docs', 'or', 'one.'])
    expect(shown('![a chart](c.png) [1], done')).toEqual(['a', 'chart', '1,', 'done'])
  })

  it('drops heading hashes, bullets, quote marks and rules at a line start only', () => {
    const text = '## Plan\n- first\n  * second\n> quoted\n>> deeper\n---\nA - dash and #tag'
    expect(shown(text)).toEqual(['Plan', 'first', 'second', 'quoted', 'deeper', 'A', '-', 'dash', 'and', '#tag'])
    expect(shown('1. one\n2. two')).toEqual(['1.', 'one', '2.', 'two'])
  })

  it('keeps the code lines of a fenced block and drops the fences', () => {
    expect(shown('Run:\n```ts\nconst a = 1\n```\nDone')).toEqual(['Run:', 'const', 'a', '=', '1', 'Done'])
  })

  it('does not reshuffle earlier words when a marker is split across chunks', () => {
    const whole = '**bold** next'
    const first = scanWords('**bo', 0, false)
    expect(first.words).toEqual([])
    const second = scanWords('**bold**', first.next, false)
    expect(second.words).toEqual([])
    const third = scanWords(whole, second.next, false)
    expect(third.words.map(word => word.text)).toEqual(['bold'])
    expect(third.words[0]).toMatchObject({ start: 0, end: 8 })
    const split = scanWords('**two ', 0, false)
    expect(split.words.map(word => word.text)).toEqual(['two'])
    expect(scanWords('**two words** x', split.next, true).words.map(word => word.text)).toEqual(['words', 'x'])
  })

  it('cleans the Markdown of a whole text, keeping its whitespace', () => {
    expect(plainText('# Title\n**a** [b](c)\n- d', true)).toBe(' Title\na b\n d')
    expect(plainText('- d', false)).toBe('- d')
    expect(plainWord('**', false)).toBeUndefined()
  })
})
