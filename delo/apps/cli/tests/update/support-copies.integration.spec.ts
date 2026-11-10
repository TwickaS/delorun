/**
 * The CLI's session-data copies as the home process sees them: each refusal of `@delo/update` reaches the home process
 * as contract C19's error code, and every other failure passes through unchanged.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'delo-support-'))
  // A home's CLI profile, whose writer lock a rollback holds.
  mkdirSync(join(home, 'profiles', 'default'), { recursive: true })
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

/**
 * The copies over a temporary home.
 * @param at - the home.
 * @returns the copies.
 */
function copies(at: string): ReturnType<typeof sessionDataCopies> {
  const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
  return sessionDataCopies({ home: at, profile: 'default', store: new RuntimeStore({ home: at, platform: runtimePlatformOf(process.platform, process.arch), logger }), root: () => Promise.reject(new Error('no root is read for a copy')), now: () => new Date('2026-11-10T12:00:00.000Z') })
}

describe('sessionDataCopies', () => {
  it('plans a copy that fits, and passes a failure that is not a refusal through', async () => {
    await expect(copies(home).plan(true)).resolves.toBeUndefined()
    await expect(copies(join(home, 'missing')).plan(true)).rejects.toThrow(/ENOENT/u)
  })

  it('refuses a copy and a rollback while delorun headless uses the chat data', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
    const release = registerDataUser(home, 'shared', 'headless', child.pid)
    try {
      await expect(copies(home).plan(true)).rejects.toMatchObject({ code: 'CHATS_RUNNING' })
      await expect(copies(home).save(v('1.0.0'), v('1.1.0'))).rejects.toMatchObject({ code: 'CHATS_RUNNING' })
      const record = { v: 1 as const, from: v('1.0.0'), to: v('1.1.0'), phase: 'committed' as const, startedAt: '2026-11-10T12:00:00.000Z', dataDiffers: false, copy: false, targetStarted: true }
      await expect(copies(home).rollback(record, { profileOnly: false, switchRuntime: async () => {}, markRollingBack: async () => {} })).rejects.toMatchObject({ code: 'CHATS_RUNNING' })
    } finally {
      release()
      child.kill('SIGKILL')
    }
  })

  it('confirms the sole user while only this process is registered, and refuses with CHATS_RUNNING once another live process registers', async () => {
    const own = registerDataUser(home, 'shared', 'start', process.pid, 'default')
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
    try {
      await expect(copies(home).confirmSoleUser()).resolves.toBeUndefined()
      const other = registerDataUser(home, 'shared', 'start', child.pid, 'work')
      await expect(copies(home).confirmSoleUser()).rejects.toMatchObject({ code: 'CHATS_RUNNING', message: expect.stringContaining(`the home process of the profile work (process ${String(child.pid)}) uses the chat data`) as string })
      other()
      await expect(copies(home).confirmSoleUser()).resolves.toBeUndefined()
    } finally {
      own()
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
  })
})
