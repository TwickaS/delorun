/**
 * The lines a person reads while a release installs, from the launcher or from `delorun update`: one per step, with the
 * size of the download and the outcome of the release-log check, and the warning when that check did not run.
 */
import { describe, expect, it } from 'vitest'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import type { SemanticVersion } from '@delorun/contract-release-manifest'
import { formatSize, progressLines } from '../src/progress.ts'

const VERSION = '0.1.0' as SemanticVersion

describe('the install lines', () => {
  it('names the channel and release it resolved', () => {
    expect(progressLines({ step: 'resolved', channel: 'stable', version: VERSION })).toEqual(['Resolving the release: the stable channel names 0.1.0.\n'])
  })

  it('names the root the signature checked under', () => {
    expect(progressLines({ step: 'signature-checked', version: VERSION, rootVersion: 2 })).toEqual(['Checking the signature: 0.1.0 is signed under release root 2.\n'])
  })

  it('says the release log verified', () => {
    expect(progressLines({ step: 'log-checked', version: VERSION, state: 'verified' })).toEqual(['Checking the release log: verified.\n'])
  })

  it('says the release log was not checked, why, and warns in the contract’s words', () => {
    expect(progressLines({ step: 'log-checked', version: VERSION, state: 'unchecked', detail: 'the release log did not answer: connection refused' })).toEqual([
      'Checking the release log: not checked (the release log did not answer: connection refused).\n',
      'Warning: Release 0.1.0 has not been checked against the release log; Delorun checks it at the next connection.\n',
    ])
  })

  it('still says it was not checked when no reason came with the event', () => {
    expect(progressLines({ step: 'log-checked', version: VERSION, state: 'unchecked' })[0]).toBe('Checking the release log: not checked (the check did not run).\n')
  })

  it('names the archive and its size before the download', () => {
    expect(progressLines({ step: 'downloading', name: 'delorun-0.1.0-linux-x64.tar.gz', bytes: 61_523_000 })).toEqual(['Downloading delorun-0.1.0-linux-x64.tar.gz (61.5 MB).\n'])
  })

  it('names the release it installs', () => {
    expect(progressLines({ step: 'installing', version: '0.1.0' as RuntimeVersion })).toEqual(['Installing release 0.1.0.\n'])
  })
})

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
