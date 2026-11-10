/**
 * The exclusive use of a home by `delorun trash`, `export` and `import`: the
 * home lock of every profile is held for the whole operation and released
 * afterwards, whatever the operation did; a profile whose home process runs,
 * or whose lock another process holds, refuses the command before it runs and
 * leaves no lock this process took. Each refusal spec fails when its check is
 * removed: the operation would run beside a live home process.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import { acquireHomeLock, newStartId, readHomeLock, runDirectory, type HolderAnswer } from '@delo/home'
import { updateChannelProbe } from '@delo/home-process'
import { CliError } from '../src/exit.ts'
import { homeExclusion, withHomeExclusive, type HomeExclusion } from '../src/home-exclusion.ts'

const RUNTIME = brandString<RuntimeVersion>('0.0.0')

let home: string | undefined

afterEach(() => {
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
  home = undefined
})

/**
 * A fresh home with run directories for some profiles.
 * @param profiles - the profiles whose run directories exist.
 * @returns its path.
 */
function newHome(profiles: readonly string[] = []): string {
  home = mkdtempSync(join(tmpdir(), 'delorun-exclusive-'))
  for (const profile of profiles) mkdirSync(runDirectory(home, profile), { recursive: true, mode: 0o700 })
  return home
}

/**
 * An exclusion whose probe gives one answer.
 * @param answer - what every holder answers.
 * @returns the exclusion.
 */
function answering(answer: HolderAnswer): HomeExclusion {
  return { probe: () => async () => answer, runtime: RUNTIME }
}

/**
 * Hold one profile's lock as a home process would.
 * @param root - the home.
 * @param profile - the profile.
 * @returns the held lock.
 */
async function holdAsHomeProcess(root: string, profile: string): ReturnType<typeof acquireHomeLock> {
  return acquireHomeLock({ runDirectory: runDirectory(root, profile), runtime: RUNTIME, probe: async () => 'answered', startId: newStartId() })
}

describe('withHomeExclusive', () => {
  it('holds the lock of every profile, the given one created, for the whole operation, and releases them after', async () => {
    const root = newHome(['work', 'play'])
    const seen = await withHomeExclusive({ home: root, profile: 'default', command: 'trash', instead: '' }, async () =>
      ['default', 'play', 'work'].map(profile => readHomeLock(runDirectory(root, profile))?.pid), answering('answered'))

    expect(seen).toEqual([process.pid, process.pid, process.pid])
    expect(['default', 'play', 'work'].map(profile => readHomeLock(runDirectory(root, profile)))).toEqual([undefined, undefined, undefined])
  })

  it('releases every lock when the operation fails', async () => {
    const root = newHome()

    await expect(withHomeExclusive({ home: root, profile: 'default', command: 'trash', instead: '' }, async () => { throw new Error('the operation failed') }, answering('answered'))).rejects.toThrow('the operation failed')

    expect(readHomeLock(runDirectory(root, 'default'))).toBeUndefined()
  })

  it('refuses while a profile\'s home process runs, runs nothing, and leaves no lock it took', async () => {
    const root = newHome(['a', 'work'])
    const running = await holdAsHomeProcess(root, 'work')
    let ran = false
    try {
      const refused = await withHomeExclusive({ home: root, profile: 'a', command: 'trash', instead: 'use the studio' }, async () => { ran = true }, answering('answered')).then(() => undefined, (error: unknown) => error)

      expect(refused).toBeInstanceOf(CliError)
      expect((refused as CliError).message).toBe(`delorun trash: Delo is running for the profile work (process ${String(process.pid)}) and uses the stores this command changes; run delorun stop --profile work first, or use the studio`)
      expect(ran).toBe(false)
      expect(readHomeLock(runDirectory(root, 'a'))).toBeUndefined()
      expect(readHomeLock(runDirectory(root, 'work'))?.startId).toBe(running.record.startId)
    } finally {
      running.release()
    }
  })

  it('refuses while another command holds a profile\'s lock without answering', async () => {
    const root = newHome(['default'])
    const other = await holdAsHomeProcess(root, 'default')
    try {
      const refused = await withHomeExclusive({ home: root, profile: 'default', command: 'import', instead: '' }, async () => undefined, answering('silent')).then(() => undefined, (error: unknown) => error)

      expect((refused as CliError).message).toBe(`delorun import: another process (process ${String(process.pid)}) holds the home lock of the profile default, such as another delorun trash, export or import; wait for it to finish, or stop it, and try again`)
    } finally {
      other.release()
    }
  })

  it('reports a lock file it cannot read, and leaves no lock it took', async () => {
    const root = newHome(['a', 'b'])
    writeFileSync(join(runDirectory(root, 'b'), 'home.lock'), 'not a lock record')

    await expect(withHomeExclusive({ home: root, profile: 'a', command: 'export', instead: '' }, async () => undefined, answering('answered'))).rejects.toThrow('is not a home lock record')

    expect(readHomeLock(runDirectory(root, 'a'))).toBeUndefined()
  })

  it('names no process when the holder left before it could be read', async () => {
    const root = newHome(['default'])
    const other = await holdAsHomeProcess(root, 'default')
    const leaving: HomeExclusion = { probe: () => async () => { other.release(); return 'answered' }, runtime: RUNTIME }

    const refused = await withHomeExclusive({ home: root, profile: 'default', command: 'trash', instead: '' }, async () => undefined, leaving).then(() => undefined, (error: unknown) => error)

    expect((refused as CliError).message).toBe('delorun trash: Delo is running for the profile default and uses the stores this command changes; run delorun stop --profile default first')
  })
})

describe('homeExclusion', () => {
  it('asks a holder over the update channel and records the CLI\'s version', () => {
    const exclusion = homeExclusion()

    expect(exclusion.probe).toBe(updateChannelProbe)
    expect(exclusion.runtime).toMatch(/^\d+\.\d+\.\d+/)
  })
})
