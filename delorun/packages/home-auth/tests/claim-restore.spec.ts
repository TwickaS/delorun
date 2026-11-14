/**
 * A claim whose owner record cannot be written puts the device list back and fails, so the home never reads as owned
 * by a device it did not record. The file writer is wrapped to fail on `owner.json` only.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { claimOf, homeFixture } from './fixtures/home.ts'

const failing = { owner: false }

vi.mock('../src/files.ts', async (load) => {
  const actual = await load<typeof import('../src/files.ts')>()
  return {
    ...actual,
    writeStoreFile: async (path: string, value: unknown): Promise<void> => {
      if (failing.owner && path.endsWith('owner.json')) throw new Error('the disk is full')
      await actual.writeStoreFile(path, value)
    },
  }
})

describe('a claim whose owner record cannot be written', () => {
  it('puts the device list back and fails', async () => {
    const home = await homeFixture()
    try {
      const issued = await home.auth.issueOwnerCode()
      failing.owner = true
      await expect(home.auth.claim(claimOf(issued.code))).rejects.toThrow('the disk is full')
      expect(JSON.parse(await readFile(join(home.directory, 'devices.json'), 'utf8'))).toEqual({ v: 1, devices: [] })
      await expect(home.auth.owner()).resolves.toBeUndefined()
    } finally {
      failing.owner = false
      await home.dispose()
    }
  })
})
