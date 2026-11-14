import { describe, expect, it } from 'vitest'
import { modelRate, ReadingController, type PaceSettings } from '../src/client/controller.ts'
import type { ReadingWord } from '../src/client/types.ts'

// Words of one part, each written `gap` ms after the previous from `start`; a gap of 0 marks them settled.
function words(texts: readonly string[], gap = 0, start = 1_000, part = '1:1:0'): ReadingWord[] {
  return texts.map((text, index) => ({
    key: `${part}#${String(index)}`, part, start: 0, end: text.length, text, pivot: 0,
    dwell: text.endsWith('.') ? 2 : 1, readyAt: gap === 0 ? 0 : start + index * gap,
  }))
}

const rate = (wpm: number, delayMs = 0): PaceSettings => ({ pace: 'rate', wpm, delayMs })

describe('the reading controller', () => {
  it('is empty without words, and plays from the first word it is given', () => {
    const reader = new ReadingController(rate(600), true)
    expect(reader.load([], true, 0)).toEqual({ cursor: -1, state: 'empty', wpm: 600 })
    expect(reader.load(words(['one', 'two']), true, 0)).toMatchObject({ cursor: 0, state: 'playing' })
  })

  it('moves on one word each interval at the set rate, and holds the end of a sentence for its dwell', () => {
    const reader = new ReadingController(rate(600), true)
    reader.load(words(['one', 'two.', 'three', 'four']), true, 0)
    expect(reader.advance(99).cursor).toBe(0)
    expect(reader.advance(100).cursor).toBe(1)
    // 'two.' dwells twice the 100 ms interval.
    expect(reader.advance(299).cursor).toBe(1)
    expect(reader.advance(300).cursor).toBe(2)
    expect(reader.advance(400)).toMatchObject({ cursor: 3, state: 'finished' })
  })

  it('shows at most one word a frame, so a slow frame delays words rather than skipping them', () => {
    const reader = new ReadingController(rate(600), true)
    reader.load(words(['a', 'b', 'c', 'd']), true, 0)
    expect(reader.advance(1_000).cursor).toBe(1)
    expect(reader.advance(1_000).cursor).toBe(1)
    expect(reader.advance(1_100).cursor).toBe(2)
  })

  it('waits for a word until it has been written for the delay', () => {
    const reader = new ReadingController(rate(600, 2_000), true)
    reader.load(words(['one', 'two'], 500, 1_000), false, 1_000)
    expect(reader.advance(2_000)).toMatchObject({ cursor: 0, state: 'waiting' })
    expect(reader.advance(3_500)).toMatchObject({ cursor: 1, state: 'waiting' })
  })

  it('waits at the newest word while the model is still writing, and finishes once it stops', () => {
    const reader = new ReadingController(rate(600), true)
    reader.load(words(['one']), false, 0)
    expect(reader.advance(1_000).state).toBe('waiting')
    expect(reader.load(words(['one']), true, 1_000).state).toBe('finished')
  })

  it('follows the newest word at the live pace', () => {
    const reader = new ReadingController({ pace: 'live', wpm: 300, delayMs: 5_000 }, true)
    reader.load(words(['one', 'two', 'three'], 10), false, 0)
    expect(reader.advance(0)).toMatchObject({ cursor: 2, state: 'waiting' })
  })

  it('measures the model’s rate over its newest written words, within the band’s limits', () => {
    expect(modelRate(words(['a', 'b', 'c', 'd'], 100))).toBeUndefined()
    expect(modelRate(words(['a', 'b', 'c', 'd', 'e'], 100))).toBe(600)
    expect(modelRate(words(['a', 'b', 'c', 'd', 'e'], 1))).toBe(1_500)
    expect(modelRate(words(['a', 'b', 'c', 'd', 'e'], 10_000))).toBe(60)
    expect(modelRate(words(['a', 'b', 'c', 'd', 'e']))).toBeUndefined()
    // Settled words before the written ones do not count.
    expect(modelRate([...words(['x', 'y']), ...words(['a', 'b', 'c', 'd', 'e'], 100, 1_000, '1:1:1')])).toBe(600)
  })

  it('plays at the model’s rate once it is known, and at the set rate before', () => {
    const reader = new ReadingController({ pace: 'model', wpm: 300, delayMs: 0 }, true)
    expect(reader.load(words(['a', 'b']), false, 0).wpm).toBe(300)
    expect(reader.load(words(['a', 'b', 'c', 'd', 'e'], 100), false, 0).wpm).toBe(600)
  })

  it('keeps the band on its word when the list changes around it, and starts a new list from its first word', () => {
    const reader = new ReadingController(rate(600), false)
    reader.load(words(['one', 'two', 'three']), false, 0)
    reader.step(2, 0)
    expect(reader.load(words(['one', 'two', 'three', 'four']), false, 0).cursor).toBe(2)
    expect(reader.load(words(['new', 'turn'], 0, 0, '2:1:0'), false, 0).cursor).toBe(0)
  })

  it('pauses, steps within the list, restarts at the first word and skips to the newest', () => {
    const reader = new ReadingController(rate(600), true)
    reader.load(words(['a', 'b', 'c']), true, 0)
    expect(reader.pause(0).state).toBe('paused')
    expect(reader.advance(10_000).cursor).toBe(0)
    expect(reader.step(5, 0)).toMatchObject({ cursor: 2, state: 'finished' })
    expect(reader.step(-1, 0)).toMatchObject({ cursor: 1, state: 'paused' })
    expect(reader.restart(0)).toMatchObject({ cursor: 0, state: 'paused' })
    expect(reader.play(0).state).toBe('playing')
    expect(reader.skipToLive(0)).toMatchObject({ cursor: 2, state: 'finished' })
    // Playing a finished list plays it again from the start.
    expect(reader.play(0)).toMatchObject({ cursor: 0, state: 'playing' })
  })

  it('starts paused when asked, and returns the same snapshot while nothing changes', () => {
    const reader = new ReadingController(rate(600), false)
    const loaded = reader.load(words(['a', 'b']), true, 0)
    expect(loaded.state).toBe('paused')
    expect(reader.advance(5_000)).toBe(loaded)
    expect(reader.snapshot).toBe(loaded)
  })

  it('applies new settings from the next word', () => {
    const reader = new ReadingController(rate(600), true)
    reader.load(words(['a', 'b', 'c']), true, 0)
    reader.setSettings(rate(60))
    expect(reader.advance(100).cursor).toBe(0)
    expect(reader.advance(1_000).cursor).toBe(1)
  })
})
