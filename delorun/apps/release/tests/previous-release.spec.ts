import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { chosenPreviousRelease, compareReleases, previousRelease } from '../src/installed-smoke/previous-release.ts'

const made: string[] = []
afterEach(() => { for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true }) })

/**
 * A channel directory holding the given releases.
 * @param versions - the release versions.
 * @returns its path.
 */
function channelOf(versions: readonly string[]): string {
  const channel = mkdtempSync(join(tmpdir(), 'prev-release-'))
  made.push(channel)
  for (const version of versions) mkdirSync(join(channel, 'releases', 'download', `v${version}`), { recursive: true })
  return channel
}

describe('compareReleases', () => {
  it('orders preview numbers as numbers', () => {
    expect(compareReleases('0.1.0-preview.1.9', '0.1.0-preview.1.10')).toBeLessThan(0)
    expect(compareReleases('0.1.0-preview.1.11', '0.1.0-preview.1.11')).toBe(0)
    expect(compareReleases('0.1.0-preview.1', '0.1.0-preview.1.1')).toBeLessThan(0)
  })
})

describe('previousRelease', () => {
  it('names the newest release older than the candidate', async () => {
    const channel = channelOf(['0.1.0-preview.1.9', '0.1.0-preview.1.10', '0.1.0-preview.1.11'])
    expect(await previousRelease(channel, '0.1.0-preview.1.11')).toBe('0.1.0-preview.1.10')
  })

  it('names none when the channel holds no older release or no releases', async () => {
    expect(await previousRelease(channelOf(['0.1.0-preview.1.11']), '0.1.0-preview.1.11')).toBeUndefined()
    expect(await previousRelease(mkdtempSync(join(tmpdir(), 'prev-release-empty-')), '0.1.0-preview.1.11')).toBeUndefined()
  })
})

describe('chosenPreviousRelease', () => {
  const channel = (): string => channelOf(['0.1.0-preview.2.1', '0.1.0-preview.2.2', '0.1.0-preview.2.3'])

  it('names the release it was told to start from, even when a newer older one exists', async () => {
    const directory = channel()
    expect(await previousRelease(directory, '0.1.0-preview.2.3')).toBe('0.1.0-preview.2.2')
    expect(await chosenPreviousRelease(directory, '0.1.0-preview.2.3', '0.1.0-preview.2.1')).toBe('0.1.0-preview.2.1')
  })

  it('refuses a release the channel does not hold, or one that is not older than the candidate', async () => {
    await expect(chosenPreviousRelease(channel(), '0.1.0-preview.2.3', '0.1.0-preview.2')).rejects.toThrow(/--previous 0\.1\.0-preview\.2 is not in the channel/u)
    await expect(chosenPreviousRelease(channel(), '0.1.0-preview.2.3', '0.1.0-preview.2.3')).rejects.toThrow(/not older than/u)
    await expect(chosenPreviousRelease(channel(), '0.1.0-preview.2.2', '0.1.0-preview.2.3')).rejects.toThrow(/not older than/u)
    await expect(chosenPreviousRelease(mkdtempSync(join(tmpdir(), 'prev-release-empty-')), '0.1.0-preview.2.3', '0.1.0-preview.2.1')).rejects.toThrow(/not in the channel/u)
  })
})
