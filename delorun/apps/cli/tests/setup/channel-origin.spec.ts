import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeChannelRecord } from '@delorun/install'
import { channelOriginOf } from '../../src/setup/channel-origin.ts'

let home: string

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'delorun-channel-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('the channel origin setup names', () => {
  it('is undefined for no record and for a record of the production channel, which is on npm', async () => {
    expect(await channelOriginOf(home)).toBeUndefined()
    await writeChannelRecord(home, { channelOrigin: 'https://releases.delorun.com' })
    expect(await channelOriginOf(home)).toBeUndefined()
  })

  it('is the origin of a launcher built for another channel', async () => {
    await writeChannelRecord(home, { channelOrigin: 'http://127.0.0.1:18080' })
    expect(await channelOriginOf(home)).toBe('http://127.0.0.1:18080')
  })
})
