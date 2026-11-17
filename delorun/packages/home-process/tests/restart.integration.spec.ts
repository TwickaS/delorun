/**
 * The restart (contract C19, "The restart") against the fixture runtime store and Host, with a real successor process:
 * it writes no runtime pointer, update record, stash or retention; it never runs while an update does, nor an update
 * while it does; a successor that fails its health check, H3's "no plugin disabled beyond those already disabled"
 * included, leaves this process's Host running and the newest harness change out; and a wait for running chats ends
 * by its bound or by a cancellation with nothing stopped.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HomeStatus } from '@delorun/contract-home-process'
import { readHomeLock, runDirectory, writeProtectedFile } from '@delorun/home'
import { afterEach, describe, expect, it } from 'vitest'
import { journalPath, queryHomeStatus, sendHomeRequest, stashPath, writeJournal, type RestartSupport } from '../src/index.ts'
import { FixtureStore, installFixture, killLockHolder, PROFILE, readPointer, startHome, tempHome, until, V0, V1, V2, type InProcessHome, type TempHome } from './support.ts'

let temp: TempHome | undefined
const homes: InProcessHome[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) {
    await home.process.shutdown(0)
    home.exit()
  }
  if (temp !== undefined) await killLockHolder(temp.home)
  temp?.remove()
  temp = undefined
})

const TIMEOUT = { timeout: 90_000 }

/** The change the fixture leave-out names. */
const LEFT_OUT = { id: 'c0ffee12345', file: 'app/node_modules/@delorun/cli/src/bin.js' }

/** A restart support that records each leave-out and leaves {@link LEFT_OUT} out. */
function leaveOutSupport(calls: string[]): RestartSupport {
  return {
    leaveOut: async (failure) => {
      calls.push(failure)
      return Promise.resolve(LEFT_OUT)
    },
  }
}

/**
 * A home whose `current` names V1 and `previous` V0, both installed.
 * @param behaviour - how V1's Host behaves.
 * @returns the home.
 */
async function setUp(behaviour: Parameters<typeof installFixture>[2] = {}): Promise<string> {
  temp = await tempHome()
  installFixture(temp.home, V0)
  installFixture(temp.home, V1, behaviour)
  installFixture(temp.home, V2)
  await FixtureStore.seed(temp.home, V1, V0)
  return temp.home
}

async function start(home: string, calls: string[] = []): Promise<InProcessHome> {
  const started = await startHome(home, { restart: leaveOutSupport(calls) })
  homes.push(started)
  return started
}

async function status(home: string): Promise<HomeStatus> {
  const answer = await queryHomeStatus(home, PROFILE, 5_000)
  if (!('state' in answer)) throw new Error(`status refused: ${JSON.stringify(answer)}`)
  return answer as HomeStatus
}

describe('restart keeps previous and its runtime', TIMEOUT, () => {
  it('hands the lock to a successor on the same runtime and writes no pointer, record, stash or retention', async () => {
    const home = await setUp()
    const journal = journalPath(home, PROFILE)
    const running = await start(home)
    // A committed update to V1 and a stash beside it, as an earlier update and an interrupted later one leave them.
    await writeJournal(journal, { from: V0, to: V1, previous: undefined, startedAt: new Date().toISOString(), dataDiffers: false, copy: false, targetStarted: true }, 'committed')
    await writeProtectedFile(stashPath(journal), readFileSync(journal, 'utf8'))
    const before = { journal: readFileSync(journal, 'utf8'), stash: readFileSync(stashPath(journal), 'utf8') }
    let cancelled = 0
    const end = running.hosts.latest.chats.begin(() => { cancelled += 1 })

    const begun = await running.process.restart.begin({ stopChats: true, drainTimeoutS: 60 })
    expect(begun.runningChats).toBe(1)
    end()
    expect(await begun.done).toEqual({ outcome: 'restarted' })

    expect(cancelled).toBe(1)
    expect(running.exits).toEqual([0])
    // The token file is gone between the predecessor's handover and the successor's first write.
    await until(async () => (await status(home).catch(() => undefined))?.pid !== undefined && (await status(home)).pid !== process.pid, 30_000, 'the successor to answer status')
    expect(await status(home)).toMatchObject({ state: 'running', runtime: { current: V1, previous: V0, running: V1 } })
    expect(readHomeLock(runDirectory(home, PROFILE))?.pid).not.toBe(process.pid)
    expect(readPointer(home, 'current')).toBe(V1)
    expect(readPointer(home, 'previous')).toBe(V0)
    expect(existsSync(join(home, 'runtimes', V0, 'fixture.json'))).toBe(true)
    expect(readFileSync(journal, 'utf8')).toBe(before.journal)
    expect(readFileSync(stashPath(journal), 'utf8')).toBe(before.stash)
    expect(existsSync(join(home, 'runtimes', 'retained.log'))).toBe(false)
    expect(running.store?.switches).toEqual([])
    expect(running.store?.commands).toEqual([`successor:${V1}`])
    expect(running.snapshots.calls).toEqual([])
  })
})

describe('restart never runs during an update', TIMEOUT, () => {
  it('refuses while the update record is in a phase other than committed, starting no successor', async () => {
    const home = await setUp()
    const running = await start(home)
    await writeJournal(journalPath(home, PROFILE), { from: V1, to: V2, previous: V0, startedAt: new Date().toISOString(), dataDiffers: false, copy: false, targetStarted: false }, 'waiting')
    await expect(running.process.restart.begin({ stopChats: false, drainTimeoutS: 60 })).rejects.toMatchObject({ code: 'UPDATE_IN_PROGRESS' })
    expect(running.store?.commands).toEqual([])
    expect(running.process.restart.view()).toEqual({ kind: 'idle' })
  })

  it('refuses while an update waits for a chat, and an update refuses while a restart waits', async () => {
    const home = await setUp()
    const running = await start(home)
    const end = running.hosts.latest.chats.begin(() => {})
    const prepared = await sendHomeRequest(home, PROFILE, { op: 'update.prepare', args: { target: V2 } })
    const reportId = prepared.at(-1)?.reportId as string
    const applying = sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId, wait: 'drain', dataCopy: false } })
    await until(async () => (await status(home)).state === 'waiting', 10_000, 'the update to wait')
    await expect(running.process.restart.begin({ stopChats: false, drainTimeoutS: 60 })).rejects.toMatchObject({ code: 'UPDATE_IN_PROGRESS' })
    await sendHomeRequest(home, PROFILE, { op: 'update.cancel' })
    expect((await applying).at(-1)).toMatchObject({ ok: true, outcome: 'aborted' })

    const begun = await running.process.restart.begin({ stopChats: false, drainTimeoutS: 60 })
    expect(running.process.restart.view()).toMatchObject({ kind: 'restarting', phase: 'waiting', runningChats: 1 })
    expect((await sendHomeRequest(home, PROFILE, { op: 'update.prepare', args: { target: V2 } })).at(-1)).toMatchObject({ ok: false, error: 'RESTART_IN_PROGRESS' })
    await expect(running.process.restart.begin({ stopChats: false, drainTimeoutS: 60 })).rejects.toMatchObject({ code: 'RESTART_IN_PROGRESS' })
    expect(await running.process.restart.cancel()).toBe(true)
    expect(await begun.done).toEqual({ outcome: 'cancelled' })
    expect(running.process.restart.view()).toEqual({ kind: 'idle' })
    expect(running.hosts.latest.chats.held).toBe(false)
    end()
    expect(running.store?.commands).toEqual([])
    expect(readPointer(home, 'current')).toBe(V1)
  })
})

describe('a failed restart keeps the old Host and leaves the newest harness change out', TIMEOUT, () => {
  it('kills a successor that fails its health check, boots its own Host again and leaves the change out', async () => {
    const home = await setUp({ unhealthySuccessor: true })
    const calls: string[] = []
    const running = await start(home, calls)
    const begun = await running.process.restart.begin({ stopChats: false, drainTimeoutS: 60 })
    expect(await begun.done).toEqual({ outcome: 'kept', reason: 'health' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('H2-host-ready')
    expect(running.process.restart.view()).toMatchObject({ kind: 'failed', reason: 'health', leftOut: LEFT_OUT })
    expect(running.hosts.booted).toHaveLength(2)
    expect(running.hosts.latest.closed).toBe(false)
    expect(running.exits).toEqual([])
    expect(await status(home)).toMatchObject({ state: 'running', pid: process.pid, runtime: { current: V1, previous: V0, running: V1 } })
    expect(readHomeLock(runDirectory(home, PROFILE))?.pid).toBe(process.pid)
    expect(running.store?.switches).toEqual([])
    running.process.restart.clearFailure()
    expect(running.process.restart.view()).toEqual({ kind: 'idle' })
  })

  it('fails a successor that disables a plugin beyond those the running Host disabled', async () => {
    const home = await setUp({ disabled: ['@scope/old'], successorDisabled: ['@scope/old', '@scope/new'] })
    const running = await start(home)
    const begun = await running.process.restart.begin({ stopChats: false, drainTimeoutS: 60 })
    expect(await begun.done).toEqual({ outcome: 'kept', reason: 'health' })
    expect(running.process.restart.view()).toMatchObject({ kind: 'failed', failure: expect.stringContaining('H3-only-named-disabled') as string })
    expect(await status(home)).toMatchObject({ state: 'running', pid: process.pid })
  })
})

describe('a restart\'s wait for running chats', TIMEOUT, () => {
  it('ends at its bound with nothing stopped, the Host running and new turns accepted', async () => {
    const home = await setUp()
    const running = await start(home)
    const end = running.hosts.latest.chats.begin(() => {})
    const begun = await running.process.restart.begin({ stopChats: false, drainTimeoutS: 1 })
    expect(await begun.done).toEqual({ outcome: 'kept', reason: 'chats' })
    expect(running.process.restart.view()).toMatchObject({ kind: 'failed', reason: 'chats' })
    expect(running.process.restart.view()).not.toHaveProperty('leftOut')
    expect(running.hosts.booted).toHaveLength(1)
    expect(running.hosts.latest.chats.held).toBe(false)
    expect(running.store?.commands).toEqual([])
    expect(await status(home)).toMatchObject({ state: 'running' })
    end()
  })

  it('ends at an update cancel or a stop, so the person is never kept from stopping Delorun by a restart that waits', async () => {
    const home = await setUp()
    const running = await start(home)
    let end: () => void = () => {}
    end = running.hosts.latest.chats.begin(() => { end() })
    const waiting = await running.process.restart.begin({ stopChats: false, drainTimeoutS: 600 })
    expect((await sendHomeRequest(home, PROFILE, { op: 'update.cancel' })).at(-1)).toMatchObject({ ok: true, restartCancelled: true })
    expect(await waiting.done).toEqual({ outcome: 'cancelled' })
    expect(running.process.restart.view()).toEqual({ kind: 'idle' })
    expect(running.hosts.latest.chats.held).toBe(false)

    const again = await running.process.restart.begin({ stopChats: false, drainTimeoutS: 600 })
    expect((await sendHomeRequest(home, PROFILE, { op: 'stop', args: { mode: 'cancel' } })).at(-1)).toMatchObject({ ok: true })
    expect(await again.done).toEqual({ outcome: 'cancelled' })
    expect(running.store?.commands).toEqual([])
  })

  it('refuses without what a restart needs beyond the home process', async () => {
    const home = await setUp()
    const running = await startHome(home)
    homes.push(running)
    await expect(running.process.restart.begin({ stopChats: false, drainTimeoutS: 60 })).rejects.toMatchObject({ code: 'NO_RUNTIME_STORE' })
  })
})
