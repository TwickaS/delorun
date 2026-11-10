/**
 * The withdrawal of an interrupted stock-home import before a profile starts:
 * nothing is registered when no import was interrupted, the withdrawal runs as
 * the one exclusive user of the home's stores, and it refuses, keeping the
 * journal, while another process uses them or an update is unfinished. The
 * import itself refuses while an update is unfinished too, so the two
 * recoveries are never both pending.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { STOCK_IMPORT_DIRECTORY, STOCK_IMPORT_JOURNAL } from '@delo/archive/dsh-import'
import { DATA_USERS_DIRECTORY, type RuntimeVersion } from '@delo/contract-home-layout'
import { runDirectory } from '@delo/home'
import { journalPath, writeJournal } from '@delo/home-process'
import { CliError } from '../../src/exit.ts'
import { registerDataUser } from '../../src/home-exclusion.ts'
import { recoverInterruptedImport } from '../../src/import-home/recover.ts'
import { fresh, put, removeScratch, runCommand, stockHome } from './support.ts'

const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  removeScratch()
})

/**
 * A live process that is not this one, killed after the spec.
 * @returns its process id.
 */
function liveProcess(): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  children.push(child)
  return child.pid ?? 0
}

/**
 * Leave an import a crash interrupted after it placed one file.
 * @param home - the Delo home.
 */
function interrupted(home: string): void {
  put(home, `${STOCK_IMPORT_DIRECTORY}/staging-x/files/AGENTS.md`, 'placed notes')
  linkSync(join(home, STOCK_IMPORT_DIRECTORY, 'staging-x/files/AGENTS.md'), join(home, 'AGENTS.md'))
  put(home, `${STOCK_IMPORT_DIRECTORY}/${STOCK_IMPORT_JOURNAL}`, JSON.stringify({ v: 1, staging: 'staging-x', directories: [], entries: [
    { path: 'AGENTS.md', replace: false, sha256: createHash('sha256').update('placed notes').digest('hex') },
  ] }))
}

/**
 * Write an update record of one profile that is between its snapshot and its end.
 * @param home - the Delo home.
 */
async function unfinishedUpdate(home: string): Promise<void> {
  mkdirSync(runDirectory(home, 'default'), { recursive: true, mode: 0o700 })
  await writeJournal(journalPath(home, 'default'), { from: brandString<RuntimeVersion>('1.0.0'), to: brandString<RuntimeVersion>('1.1.0'), previous: undefined, startedAt: '2026-11-10T12:00:00.000Z', dataDiffers: true, copy: true, targetStarted: false }, 'snapshot')
}

/**
 * The registrations under the home's `run/`.
 * @param home - the Delo home.
 * @returns their names, or none when the directory does not exist.
 */
function registrations(home: string): readonly string[] {
  const directory = join(home, 'run', DATA_USERS_DIRECTORY)
  return existsSync(directory) ? readdirSync(directory) : []
}

describe('the withdrawal before a profile starts', () => {
  it('registers nothing and returns nothing when no import was interrupted', async () => {
    const home = fresh('recover')
    expect(await recoverInterruptedImport(home, 'start')).toBeUndefined()
    expect(existsSync(join(home, 'run'))).toBe(false)
  })

  it('withdraws an interrupted import as the one exclusive user, and leaves no registration behind', async () => {
    const home = fresh('recover')
    interrupted(home)
    expect(await recoverInterruptedImport(home, 'start')).toEqual({ withdrawn: ['AGENTS.md'], kept: [], removed: 0 })
    expect(existsSync(join(home, 'AGENTS.md'))).toBe(false)
    expect(existsSync(join(home, STOCK_IMPORT_DIRECTORY, STOCK_IMPORT_JOURNAL))).toBe(false)
    expect(registrations(home)).toEqual([])
  })

  it('refuses while another process uses the stores, and keeps the journal for a later start', async () => {
    const home = fresh('recover')
    interrupted(home)
    const pid = liveProcess()
    registerDataUser(home, 'shared', 'headless', pid)
    const refused = await recoverInterruptedImport(home, 'start').catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(CliError)
    expect((refused as CliError).message).toBe(`delorun start: an interrupted import of a DeepSeek Harness home waits to be withdrawn, and process ${String(pid)} (delorun headless) uses the chat data; wait for it to end, then try again`)
    expect(existsSync(join(home, STOCK_IMPORT_DIRECTORY, STOCK_IMPORT_JOURNAL))).toBe(true)
    expect(existsSync(join(home, 'AGENTS.md'))).toBe(true)
    expect(registrations(home)).toEqual([String(pid)])
  })

  it('refuses while an update of a profile is unfinished, and passes a failure that is not a refusal through', async () => {
    const home = fresh('recover')
    interrupted(home)
    await unfinishedUpdate(home)
    const refused = await recoverInterruptedImport(home, 'headless').catch((error: unknown) => error)
    expect((refused as CliError).message).toContain('delorun headless: an interrupted import of a DeepSeek Harness home waits to be withdrawn, and an update of the profile default from Delo 1.0.0 to Delo 1.1.0 is snapshot')
    expect(existsSync(join(home, STOCK_IMPORT_DIRECTORY, STOCK_IMPORT_JOURNAL))).toBe(true)
    writeFileSync(journalPath(home, 'default'), 'not a record')
    const failed = await recoverInterruptedImport(home, 'start').catch((error: unknown) => error)
    expect(failed).toBeInstanceOf(Error)
    expect(failed).not.toBeInstanceOf(CliError)
    expect(registrations(home)).toEqual([])
  })

  it('leaves a journal it cannot reach to the recovery, which refuses it', async () => {
    const home = fresh('recover')
    put(home, 'archive', 'a file where the import keeps its journal')
    await expect(recoverInterruptedImport(home, 'start')).rejects.toMatchObject({ code: 'DSH_IMPORT_TARGET_REFUSED' })
    expect(registrations(home)).toEqual([])
  })
})

describe('delorun import-home beside an update', () => {
  it('refuses while an update of a profile is unfinished, and imports nothing', async () => {
    const person = fresh('person')
    stockHome(join(person, '.dsh'))
    const target = join(person, '.delo')
    await unfinishedUpdate(target)
    const run = await runCommand([], { home: target, env: { HOME: person }, answers: ['y'] })
    expect(run.error).toBeInstanceOf(CliError)
    expect((run.error as CliError).message).toContain('delorun import-home: an update of the profile default from Delo 1.0.0 to Delo 1.1.0 is snapshot')
    expect(run.asked).toEqual([])
    expect(existsSync(join(target, 'sessions'))).toBe(false)
  })
})
