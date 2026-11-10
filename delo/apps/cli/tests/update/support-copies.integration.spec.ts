/**
 * The CLI's session-data copies as the home process sees them: each refusal of `@delo/update` reaches the home process
 * as contract C19's error code, and every other failure passes through unchanged.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import { HomeProcessError } from '@delo/home-process'
import { RuntimeStore } from '@delo/runtime-store'
import { runtimePlatformOf } from '../../src/update/channel.ts'
import { registerDataUser } from '../../src/home-exclusion.ts'
import { sessionDataCopies } from '../../src/update/support.ts'

const v = (text: string): RuntimeVersion => brandString<RuntimeVersion>(text)
let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'delo-support-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

/**
 * The copies over a temporary home.
 * @param at - the home.
 * @returns the copies.
 */
function copies(at: string): ReturnType<typeof sessionDataCopies> {
  const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
  return sessionDataCopies({ home: at, profile: 'default', store: new RuntimeStore({ home: at, platform: runtimePlatformOf(process.platform, process.arch), logger }), now: () => new Date('2026-11-10T12:00:00.000Z') })
}

describe('sessionDataCopies', () => {
  it('plans a copy that fits, and passes a failure that is not a refusal through', async () => {
    await expect(copies(home).plan()).resolves.toBeUndefined()
    await expect(copies(join(home, 'missing')).plan()).rejects.toThrow(/ENOENT/u)
  })

  it('refuses a copy and a rollback while delorun headless uses the chat data', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
    const release = registerDataUser(home, 'shared', 'headless', child.pid)
    try {
      await expect(copies(home).plan()).rejects.toMatchObject({ code: 'CHATS_RUNNING' })
      await expect(copies(home).save(v('1.0.0'), v('1.1.0'))).rejects.toMatchObject({ code: 'CHATS_RUNNING' })
      const record = { v: 1 as const, from: v('1.0.0'), to: v('1.1.0'), phase: 'committed' as const, startedAt: '2026-11-10T12:00:00.000Z', dataDiffers: false, copy: false, targetStarted: true }
      await expect(copies(home).rollback(record, { profileOnly: false, switchRuntime: async () => {}, markRollingBack: async () => {} })).rejects.toMatchObject({ code: 'CHATS_RUNNING' })
    } finally {
      release()
      child.kill('SIGKILL')
    }
  })

  it('saves a copy, and passes a failure of the copy through', async () => {
    await copies(home).save(v('1.0.0'), v('1.1.0'))
    await expect(copies(home).save(v('1.0.0'), v('../1.1.0'))).rejects.toThrow(/not a version/u)
  })

  it('turns the table\'s refusal into ROLLBACK_NEEDS_DATA_COPY, with nothing switched', async () => {
    let switched = false
    const record = { v: 1 as const, from: v('1.0.0'), to: v('1.1.0'), phase: 'committed' as const, startedAt: '2026-11-10T12:00:00.000Z', dataDiffers: true, copy: false, targetStarted: true }
    const refused = await copies(home).rollback(record, { profileOnly: false, switchRuntime: async () => { switched = true }, markRollingBack: async () => { switched = true } }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(HomeProcessError)
    expect(refused).toMatchObject({ code: 'ROLLBACK_NEEDS_DATA_COPY' })
    expect(switched).toBe(false)
    await expect(copies(home).recover()).resolves.toBeUndefined()
  })
})
