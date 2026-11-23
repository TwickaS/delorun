import { describe, expect, it } from 'vitest'
import { relativeTime } from '../src/client/trust-time.ts'

const AT = '2026-11-23T10:00:00Z'
const base = Date.parse(AT)

describe('relativeTime', () => {
  it('reads as just now under a minute, and for a moment a little in the future', () => {
    expect(relativeTime('en', AT, base)).toEqual({ kind: 'just-now' })
    expect(relativeTime('en', AT, base + 59_999)).toEqual({ kind: 'just-now' })
    expect(relativeTime('en', AT, base - 5_000)).toEqual({ kind: 'just-now' })
  })

  it('counts whole minutes, then hours, then days', () => {
    expect(relativeTime('en', AT, base + 3 * 60_000 + 30_000)).toEqual({ kind: 'ago', text: '3 minutes ago' })
    expect(relativeTime('en', AT, base + 60_000)).toEqual({ kind: 'ago', text: '1 minute ago' })
    expect(relativeTime('en', AT, base + 2 * 3_600_000 + 59 * 60_000)).toEqual({ kind: 'ago', text: '2 hours ago' })
    expect(relativeTime('en', AT, base + 3 * 86_400_000)).toEqual({ kind: 'ago', text: '3 days ago' })
  })

  it('words the time in the panel\'s locale', () => {
    expect(relativeTime('zh-CN', AT, base + 3 * 60_000)).toEqual({ kind: 'ago', text: '3分钟前' })
  })

  it('answers nothing for a time that does not parse', () => {
    expect(relativeTime('en', 'not a time', base)).toBeUndefined()
  })
})
