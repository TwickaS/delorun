/**
 * The install events and the words a person reads for sizes, speeds and durations.
 */
import { describe, expect, it } from 'vitest'
import { formatDuration, formatSize, formatSpeed, isInstallerProgress } from '../src/progress.ts'

describe('a download size', () => {
  it('reads in kB below a megabyte, MB below a gigabyte and GB above', () => {
    expect(formatSize(0)).toBe('1 kB')
    expect(formatSize(1_499)).toBe('1 kB')
    expect(formatSize(999_999)).toBe('1000 kB')
    expect(formatSize(1_000_000)).toBe('1.0 MB')
    expect(formatSize(61_523_000)).toBe('61.5 MB')
    expect(formatSize(1_073_741_824)).toBe('1.1 GB')
  })
})

describe('a speed', () => {
  it('is a size per second', () => {
    expect(formatSpeed(6_700_000)).toBe('6.7 MB/s')
    expect(formatSpeed(20_000)).toBe('20 kB/s')
  })
})

describe('a duration', () => {
  it('reads in tenths below ten seconds, seconds below a minute, then minutes', () => {
    expect(formatDuration(0)).toBe('0.0s')
    expect(formatDuration(-5)).toBe('0.0s')
    expect(formatDuration(430)).toBe('0.4s')
    expect(formatDuration(9_940)).toBe('9.9s')
    expect(formatDuration(14_400)).toBe('14s')
    expect(formatDuration(65_000)).toBe('1m 05s')
    expect(formatDuration(600_000)).toBe('10m 00s')
  })
})

describe('an event read from a process boundary', () => {
  it('is accepted when it names an install step', () => {
    expect(isInstallerProgress({ step: 'download-bytes', name: 'a', received: 1, total: 2 })).toBe(true)
    expect(isInstallerProgress({ step: 'starting' })).toBe(true)
  })

  it('is refused when it is not an object with a known step', () => {
    expect(isInstallerProgress(undefined)).toBe(false)
    expect(isInstallerProgress(null)).toBe(false)
    expect(isInstallerProgress('resolved')).toBe(false)
    expect(isInstallerProgress({ step: 7 })).toBe(false)
    expect(isInstallerProgress({ step: 'rm -rf' })).toBe(false)
    expect(isInstallerProgress({ line: 'Downloading' })).toBe(false)
  })
})
