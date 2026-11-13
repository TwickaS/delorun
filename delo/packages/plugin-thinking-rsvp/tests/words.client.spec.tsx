import { describe, expect, it } from 'vitest'
import { dwellOf, pivotOf, scanWords } from '../src/client/words.ts'

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
})
