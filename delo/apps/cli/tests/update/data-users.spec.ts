/**
 * The users of the home's chat data beside the home process: a registered live process makes a copy, restore or
 * rollback refuse, a dead one's registration goes, and `delorun headless` refuses while an update, a rollback or a
 * restore is in progress (`headless` concurrent with an update).
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import { ensureHomeTree } from '@delo/home'
import { journalPath, writeJournal } from '@delo/home-process'
import { EXIT } from '../../src/exit.ts'
import { main } from '../../src/main.ts'
import { assertNoUpdateInProgress, assertSoleDataUser, DATA_USERS_DIRECTORY, DataInUseError, otherDataUsers, registerDataUser } from '../../src/update/data-users.ts'

const v = (text: string): RuntimeVersion => brandString<RuntimeVersion>(text)
let base: string
let home: string
beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'delo-users-'))
  home = join(base, '.delo')
  await ensureHomeTree(home, 'default')
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

/**
 * Write an update record of the default profile in a phase.
 * @param phase - the phase.
 */
async function record(phase: 'snapshot' | 'committed' | 'rolling-back'): Promise<void> {
  await writeJournal(journalPath(home, 'default'), { from: v('1.0.0'), to: v('1.1.0'), previous: undefined, startedAt: '2026-11-10T12:00:00.000Z', dataDiffers: true, copy: true, targetStarted: false }, phase)
}

describe('data users', () => {
  it('lists another live user, refuses beside it, and drops a dead one\'s registration', async () => {
    expect(otherDataUsers(home)).toEqual([])
    const release = registerDataUser(home)
    expect(otherDataUsers(home)).toEqual([])
    expect(() => { assertSoleDataUser(home) }).not.toThrow()
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
    const other = registerDataUser(home, child.pid)
    expect(otherDataUsers(home)).toEqual([child.pid])
    expect(() => { assertSoleDataUser(home) }).toThrow(DataInUseError)
    child.kill('SIGKILL')
    await new Promise(resolve => child.once('exit', resolve))
    expect(otherDataUsers(home)).toEqual([])
    expect(readdirSync(join(home, 'run', DATA_USERS_DIRECTORY))).toEqual([String(process.pid)])
    writeFileSync(join(home, 'run', DATA_USERS_DIRECTORY, 'not-a-pid'), '')
    expect(otherDataUsers(home)).toEqual([])
    other()
    release()
    release()
    expect(readdirSync(join(home, 'run', DATA_USERS_DIRECTORY))).toEqual(['not-a-pid'])
  })

  it('refuses while an update or rollback is in progress or a restore is unfinished, and not after a commit', async () => {
    await assertNoUpdateInProgress(home)
    await record('committed')
    await assertNoUpdateInProgress(home)
    await record('snapshot')
    await expect(assertNoUpdateInProgress(home)).rejects.toThrow(/is snapshot/u)
    await record('rolling-back')
    await expect(assertNoUpdateInProgress(home)).rejects.toThrow(/is rolling-back/u)
    await record('committed')
    mkdirSync(join(home, 'data-copies'), { recursive: true })
    writeFileSync(join(home, 'data-copies', 'restore.json'), '{}')
    await expect(assertNoUpdateInProgress(home)).rejects.toThrow(/restore of the chat data is unfinished/u)
  })

  it('reads no record from a home without a run directory', async () => {
    rmSync(join(home, 'run'), { recursive: true, force: true })
    await assertNoUpdateInProgress(home)
  })

  it('delorun headless refuses while an update is in progress and leaves no registration behind', async () => {
    await record('snapshot')
    let stderr = ''
    const code = await main(['headless', 'say hello'], { env: { ...process.env, HOME: base, DELO_HOME: home }, stdout: () => {}, stderr: (text) => { stderr += text } })
    expect(code).toBe(EXIT.failed)
    expect(stderr).toContain('delorun headless: an update of the profile default from Delo 1.0.0 to Delo 1.1.0 is snapshot')
    expect(readdirSync(join(home, 'run', DATA_USERS_DIRECTORY))).toEqual([])
  })
})
