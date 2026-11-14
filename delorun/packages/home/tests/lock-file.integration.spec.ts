import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isLockId, LockFile, parseHolder, randomLockId, type ProcessHolder } from '../src/index.ts'

/** The record of the lock under test. */
interface TestRecord extends ProcessHolder {
  readonly id: string
}

let directory: string
let file: LockFile<TestRecord>

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'delorun-lock-file-'))
  file = new LockFile(join(directory, 'test.lock'), {
    label: 'test lock',
    remedy: 'once no test runs',
    parse: (record) => {
      const holder = parseHolder(record)
      return holder === undefined || !isLockId(record.id) ? undefined : { ...holder, id: record.id }
    },
    id: record => record.id,
  })
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

/**
 * The process id of a process that has exited.
 * @returns the pid.
 */
function deadPid(): number {
  return Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', timeout: 30_000 }).stdout)
}

/**
 * Write a record file as another process would.
 * @param path - the file.
 * @param record - its JSON value.
 */
function plant(path: string, record: unknown): void {
  writeFileSync(path, JSON.stringify(record), { mode: 0o600 })
}

describe('a lock file', () => {
  it('names random ids of 32 lowercase hexadecimal digits', () => {
    expect(isLockId(randomLockId())).toBe(true)
    expect(isLockId('A'.repeat(32))).toBe(false)
    expect(isLockId(7)).toBe(false)
  })

  it('refuses JSON that is not an object, naming the lock and the remedy', () => {
    writeFileSync(file.path, '[1]')
    expect(() => file.read()).toThrow(`${file.path} is not a test lock record; remove it once no test runs`)
    writeFileSync(file.path, 'null')
    expect(() => file.read()).toThrow('is not a test lock record')
  })

  it('does not follow a symbolic link', () => {
    writeFileSync(join(directory, 'target'), JSON.stringify({ pid: process.pid, id: randomLockId() }))
    symlinkSync(join(directory, 'target'), file.path)
    expect(() => file.read()).toThrow(/ELOOP/u)
  })

  it('leaves a record it cannot replace and removes its temporary file', () => {
    mkdirSync(file.path)
    writeFileSync(join(file.path, 'inside'), '')
    expect(() => { file.replace({ pid: process.pid, id: randomLockId() }) }).toThrow()
    expect(readdirSync(directory)).toEqual(['test.lock'])
  })

  it('releases only the record with its id, and leaves a file that is not a record', () => {
    const record = { pid: process.pid, id: randomLockId() }
    expect(file.create(record)).toBe(true)
    file.release(randomLockId())
    expect(file.read()).toEqual(record)
    file.release(record.id)
    expect(existsSync(file.path)).toBe(false)
    file.release(record.id)
    writeFileSync(file.path, 'not json')
    file.release(record.id)
    expect(readFileSync(file.path, 'utf8')).toBe('not json')
  })

  it('removes a dead record under guards left by contenders that died, versioned or not', async () => {
    const lockId = randomLockId()
    const first = randomLockId()
    plant(file.path, { pid: deadPid(), id: lockId })
    plant(`${file.path}.takeover-${lockId}`, { pid: deadPid(), id: first })
    plant(`${file.path}.takeover-${first}`, { v: 1, pid: deadPid(), id: randomLockId() })
    expect(await file.removeDead(lockId)).toBe('done')
    expect(readdirSync(directory)).toEqual([])
  })

  it('refuses a guard of another version', async () => {
    const lockId = randomLockId()
    plant(file.path, { pid: deadPid(), id: lockId })
    plant(`${file.path}.takeover-${lockId}`, { v: 2, pid: deadPid(), id: randomLockId() })
    await expect(file.removeDead(lockId)).rejects.toThrow(`${file.path}.takeover-${lockId} is not a test lock takeover guard; remove it once no test runs`)
  })

  it('reports busy when a live contender holds the guard of a dead contender\'s guard', async () => {
    const lockId = randomLockId()
    const guardId = randomLockId()
    plant(file.path, { pid: deadPid(), id: lockId })
    plant(`${file.path}.takeover-${lockId}`, { pid: deadPid(), id: guardId })
    plant(`${file.path}.takeover-${guardId}`, { pid: process.pid, id: randomLockId() })
    expect(await file.removeDead(lockId)).toBe('busy')
    expect(file.read()?.id).toBe(lockId)
  })

  it('gives up after too many nested guards of contenders that died, naming the files to remove', async () => {
    let id = randomLockId()
    plant(file.path, { pid: deadPid(), id })
    const dead = deadPid()
    for (let level = 0; level < 10; level += 1) {
      const next = randomLockId()
      plant(`${file.path}.takeover-${id}`, { pid: dead, id: next })
      id = next
    }
    await expect(file.removeDead(JSON.parse(readFileSync(file.path, 'utf8')).id as string)).rejects.toThrow(`could not take ${file.path}: 9 nested takeovers were abandoned by processes that died; remove ${file.path}.takeover-* once no test runs`)
  })

  it('leaves a record whose holder lives or that another record replaced', async () => {
    const live = { pid: process.pid, id: randomLockId() }
    expect(await file.removeDead(live.id)).toBe('done')
    file.create(live)
    expect(await file.removeDead(live.id)).toBe('done')
    expect(await file.removeDead(randomLockId())).toBe('done')
    expect(file.read()).toEqual(live)
  })
})
