/**
 * Specs of the check before a reload when another process takes the free profile write lock first: the check waits a
 * bounded time, then only verifies; a failure other than that wait, or one after the check started, is the check's.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareReload } from '../src/enforce.ts'
import { folder, linkAs, migrated, PROFILE } from './profile-fixture.ts'
import { rejection } from './support.ts'

const lock = vi.hoisted(() => ({ mode: 'pass' as 'pass' | 'busy' | 'fail' }))

vi.mock('@deepseek-ai/dsh-atomic-write', async (original) => {
  const actual = await original<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return {
    ...actual,
    withFileLock: async <T>(filename: string, operation: () => Promise<T>, options?: { signal?: AbortSignal, waitMs?: number }): Promise<T> => {
      // Only the reload check's wait has a signal; every other lock behaves as upstream's.
      if (options?.signal === undefined || lock.mode === 'pass') return actual.withFileLock(filename, operation, options)
      if (lock.mode === 'fail') throw Object.assign(new Error('EACCES: the lock cannot be created'), { code: 'EACCES' })
      const signal = options.signal
      await new Promise((resolve) => { signal.addEventListener('abort', resolve) })
      throw signal.reason
    },
  }
})

// Each case writes real git histories and scans folders; under a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 60_000 })

afterEach(() => {
  lock.mode = 'pass'
})

describe('the check before a reload when the lock is taken meanwhile', () => {
  it('only verifies after its bounded wait, and refuses a folder link it could not move', async () => {
    const { fx } = await migrated()
    const added = folder(fx, 'added')
    linkAs(fx, 'added', added)
    const manifest = readFileSync(join(fx.profileDir, 'package.json'), 'utf8')
    lock.mode = 'busy'
    const error = await rejection(prepareReload({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir, lockWaitMs: 10 }), 'LOAD_REFUSED')
    expect(error.detail).toContain(`added is linked from ${added}`)
    expect(readFileSync(join(fx.profileDir, 'package.json'), 'utf8')).toBe(manifest)
  })

  it('fails with the lock\'s own failure', async () => {
    const { fx } = await migrated()
    lock.mode = 'fail'
    await expect(prepareReload({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir })).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('fails with the check\'s failure once it holds the lock, and reads the clock itself', async () => {
    const { fx } = await migrated()
    const tampered = join(fx.home, 'changes', 'profiles', PROFILE, 'log.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(tampered, 'not json')
    await rejection(prepareReload({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir }), 'RECORD_UNREADABLE')
  })
})
