/**
 * The shared download measure: the speed over the recent window, the time left, a stall, a restarted count, and how
 * the time left reads.
 */
import { describe, expect, it } from 'vitest'
import { formatRemaining, STALL_SHOWN_MS, TransferRate } from '../src/transfer.ts'

describe('the speed of a download', () => {
  it('is unknown until two readings a second apart show bytes arriving', () => {
    const rate = new TransferRate()
    expect(rate.speed()).toBeUndefined()
    rate.add(0, 1_000_000)
    rate.add(500, 3_000_000)
    expect(rate.speed()).toBeUndefined()
    rate.add(1000, 5_000_000)
    expect(rate.speed()).toBe(4_000_000)
  })

  it('reads only the last five seconds, and is unknown once nothing arrived in them', () => {
    const rate = new TransferRate()
    rate.add(0, 0)
    rate.add(1000, 50_000_000)
    for (let at = 2000; at <= 7000; at += 1000) rate.add(at, 50_000_000)
    expect(rate.speed()).toBeUndefined()
    rate.add(8000, 52_000_000)
    expect(rate.speed()).toBe(400_000)
  })

  it('counts a stall from the last change of the count', () => {
    const rate = new TransferRate()
    expect(rate.stalledFor(5000)).toBe(0)
    rate.add(0, 0)
    rate.add(1000, 1_000_000)
    rate.add(2000, 1_000_000)
    rate.add(1000 + STALL_SHOWN_MS, 1_000_000)
    expect(rate.stalledFor(1000 + STALL_SHOWN_MS)).toBe(STALL_SHOWN_MS)
  })

  it('starts over when the count goes down, as a download that starts again does', () => {
    const rate = new TransferRate()
    rate.add(0, 0)
    rate.add(1000, 8_000_000)
    rate.add(1500, 0)
    expect(rate.speed()).toBeUndefined()
    rate.add(2500, 1_000_000)
    expect(rate.speed()).toBe(1_000_000)
  })
})

describe('the time left', () => {
  it('needs a size, a speed and something left', () => {
    const rate = new TransferRate()
    rate.add(0, 0)
    expect(rate.secondsLeft(10_000_000)).toBeUndefined()
    rate.add(2000, 4_000_000)
    expect(rate.secondsLeft(undefined)).toBeUndefined()
    expect(rate.secondsLeft(0)).toBeUndefined()
    expect(rate.secondsLeft(4_000_000)).toBeUndefined()
    expect(rate.secondsLeft(10_000_000)).toBe(3)
  })

  it('reads as at least a second, tenths below ten seconds, then minutes, then hours', () => {
    expect(formatRemaining(0.2)).toBe('1.0s')
    expect(formatRemaining(3.75)).toBe('3.8s')
    expect(formatRemaining(14)).toBe('14s')
    expect(formatRemaining(125)).toBe('2m 05s')
    expect(formatRemaining(3780)).toBe('1h 03m')
  })
})
