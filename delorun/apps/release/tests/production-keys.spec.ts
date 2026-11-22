import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PRODUCTION_KEYS_PATH, readProductionKeys } from '../src/local/production-keys.ts'

const REPO = join(import.meta.dirname, '..', '..', '..', '..')

describe('the committed production-keys registry', () => {
  it('reads with the release tool as an empty registry under the renamed schema', () => {
    const keys = readProductionKeys(readFileSync(join(REPO, PRODUCTION_KEYS_PATH)))
    expect(keys.rootDigests.size).toBe(0)
    expect(keys.keyids.size).toBe(0)
  })
})
