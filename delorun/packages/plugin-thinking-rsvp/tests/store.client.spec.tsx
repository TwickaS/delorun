import { expect, it } from 'vitest'
import { MAX_DELAY_SECONDS, MAX_WPM, MIN_WPM, readerSettings } from '../src/client/store.ts'

it('keeps valid preferences as they are', () => {
  const settings = { source: 'reply', pace: 'rate', wpm: 450, delaySeconds: 3 } as const
  expect(readerSettings(settings)).toEqual(settings)
})

it('falls back to the defaults for fields another build kept or a hand edited', () => {
  expect(readerSettings({ source: 'thoughts', pace: 7, wpm: 'fast', delaySeconds: null })).toEqual({ source: 'both', pace: 'model', wpm: 300, delaySeconds: 0 })
  expect(readerSettings({})).toEqual({ source: 'both', pace: 'model', wpm: 300, delaySeconds: 0 })
})

it('brings numbers inside their ranges as whole numbers', () => {
  expect(readerSettings({ wpm: 5, delaySeconds: -2 })).toMatchObject({ wpm: MIN_WPM, delaySeconds: 0 })
  expect(readerSettings({ wpm: Number.POSITIVE_INFINITY, delaySeconds: 99.6 })).toMatchObject({ wpm: 300, delaySeconds: MAX_DELAY_SECONDS })
  expect(readerSettings({ wpm: 5000.4 })).toMatchObject({ wpm: MAX_WPM })
})
