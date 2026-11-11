/**
 * The home process (contract C19) against a fixture runtime store, profile history and Host: one home process per
 * profile holds the lock, each start writes a new token and only the current token is accepted, the channel's closed
 * schema and limits, the update handshake that never switches `current` under a running chat, a requester killed
 * mid-update, a failed health check, an interrupted update, the desktop app's independence and the Host's way to
 * the channel.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { REQUEST_MAX_BYTES, type HomeStatus } from '@delo/contract-home-process'
import { newStartId, processExists, readHomeLock, readStartTokenFile, runDirectory, startTokenFile, writeProtectedFile } from '@delo/home'
import { resolveSurface } from '@delo/logs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { exchangeLines, HostNotStoppedError, journalPath, openHomeLog, queryHomeStatus, readJournal, sendHomeRequest, stashPath, updateSocketPath, writeJournal, type JournalledUpdate, type ResponseLine } from '../src/index.ts'
import { FixtureStore, installFixture, killLockHolder, MemoryLogger, PROFILE, readPointer, startHome, tempHome, text, until, V0, V1, V2, type InProcessHome, type StartParts, type TempHome } from './support.ts'

let temp: TempHome | undefined
const homes: InProcessHome[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const home of homes.splice(0)) {
    await home.process.shutdown(0)
    home.exit()
  }
  if (temp !== undefined) await killLockHolder(temp.home)
  temp?.remove()
  temp = undefined
})

/** Set up a home with both fixture versions installed and `current` naming V1. */
async function setUp(behaviour: Parameters<typeof installFixture>[2] = {}): Promise<string> {
  temp = await tempHome()
  installFixture(temp.home, V1)
  installFixture(temp.home, V2, behaviour)
  await FixtureStore.seed(temp.home, V1)
  return temp.home
}

async function start(home: string, options: Parameters<typeof startHome>[1] = {}): Promise<InProcessHome> {
  const started = await startHome(home, options)
  homes.push(started)
  return started
}

async function status(home: string): Promise<HomeStatus> {
  const answer = await queryHomeStatus(home, PROFILE, 5_000)
  if (!('state' in answer)) throw new Error(`status refused: ${JSON.stringify(answer)}`)
  return answer as HomeStatus
}

/** The final line of an exchange. */
function final(lines: readonly ResponseLine[]): ResponseLine {
  const line = lines.at(-1)
  if (line === undefined) throw new Error('no response line')
  return line
}

async function prepare(home: string, target = V2): Promise<string> {
  const line = final(await sendHomeRequest(home, PROFILE, { op: 'update.prepare', args: { target } }))
  expect(line).toMatchObject({ ok: true, report: { to: target } })
  return line.reportId as string
}

/** A requester in its own process, as `delorun update` runs: it reads the token file and sends one request line. */
const REQUESTER = `
const fs = require('node:fs'), net = require('node:net')
const [socket, tokenFile, body] = process.argv.slice(1)
const token = fs.readFileSync(tokenFile, 'utf8').trim()
const connection = net.connect(socket)
connection.on('connect', () => { connection.write(JSON.stringify({ v: 1, token, ...JSON.parse(body) }) + '\\n') })
connection.on('data', chunk => { process.stdout.write(chunk) })
`

function requester(home: string, body: object): ChildProcess {
  const child = spawn(process.execPath, ['-e', REQUESTER, updateSocketPath(home, PROFILE), startTokenFile(home, PROFILE), JSON.stringify(body)], { stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(child)
  return child
}

const TIMEOUT = { timeout: 90_000 }

describe('one home process per profile', TIMEOUT, () => {
  it('holds the lock, listens under the home at mode 0600 and refuses a second start with HOME_RUNNING', async () => {
    const home = await setUp()
    const first = await start(home)
    const lock = readHomeLock(runDirectory(home, PROFILE))
    expect(lock).toMatchObject({ pid: process.pid, runtime: V1 })
    const socket = updateSocketPath(home, PROFILE)
    expect(socket.startsWith(`${home}/run/${PROFILE}/`)).toBe(true)
    expect(lstatSync(socket).mode & 0o777).toBe(0o600)
    expect(lstatSync(startTokenFile(home, PROFILE)).mode & 0o777).toBe(0o600)
    expect(await status(home)).toMatchObject({ state: 'running', pid: process.pid, startId: lock?.startId, runtime: { current: V1, running: V1 }, chats: 0 })
    await expect(startHome(home)).rejects.toMatchObject({ code: 'HOME_RUNNING' })
    expect(readHomeLock(runDirectory(home, PROFILE))?.startId).toBe(lock?.startId)
    expect(first.process.socketPath).toBe(socket)
  })

  it('a clean stop closes the Host and removes the token, the socket and the lock', async () => {
    const home = await setUp()
    const running = await start(home)
    const lines = await sendHomeRequest(home, PROFILE, { op: 'stop', args: { mode: 'drain' } })
    expect(final(lines)).toMatchObject({ ok: true, status: { state: 'stopping' } })
    await until(() => running.exits.length > 0, 5_000, 'the stop')
    expect(running.exits).toEqual([0])
    expect(running.hosts.latest.closed).toBe(true)
    for (const path of [startTokenFile(home, PROFILE), updateSocketPath(home, PROFILE), join(runDirectory(home, PROFILE), 'home.lock')]) expect(existsSync(path), path).toBe(false)
  })

  it('a stop with drain waits for a running chat, refusing new turns meanwhile', async () => {
    const home = await setUp()
    const running = await start(home)
    const end = running.hosts.latest.chats.begin(() => {})
    const stopping = sendHomeRequest(home, PROFILE, { op: 'stop', args: { mode: 'drain' } })
    await until(async () => (await status(home)).state === 'stopping', 5_000, 'stopping')
    expect(() => running.hosts.latest.chats.begin(() => {})).toThrow(/UPDATE_PENDING/)
    expect(running.exits).toEqual([])
    end()
    expect(final(await stopping)).toMatchObject({ ok: true })
    await until(() => running.exits.length > 0, 5_000, 'the stop')
  })
})

describe('the home process\'s operational log', TIMEOUT, () => {
  it('logs to the home-<profile> surface with its start id, and the start token never reaches it', async () => {
    const home = await setUp()
    const startId = newStartId()
    const opened = openHomeLog({ home, profile: PROFILE, startId, level: 'debug', onFailure: () => {} })
    try {
      const running = await start(home, { logger: opened.logger, log: { redactor: opened.redactor, startId } })
      const token = await readStartTokenFile(startTokenFile(home, PROFILE))
      await status(home)
      opened.logger.info(`a record that quotes the token ${token}`)
      await running.process.shutdown(0)
      const text = readFileSync(resolveSurface({ kind: 'home', home, profile: PROFILE }).file, 'utf8')
      const records = text.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as { readonly msg: string, readonly startId?: string })
      expect(records.map(record => record.msg)).toEqual(expect.arrayContaining(['update channel listening', 'request {"op":"status","outcome":"ok"}']))
      expect(records.every(record => record.startId === startId)).toBe(true)
      expect(text.includes(token)).toBe(false)
    } finally {
      opened.log.close()
    }
  })
})

describe('update-channel-token-required', TIMEOUT, () => {
  it('each start writes a new token; no token, a wrong token and the previous start\'s token get UNAUTHENTICATED and nothing else', async () => {
    const home = await setUp()
    const first = await start(home)
    const previous = await readStartTokenFile(startTokenFile(home, PROFILE))
    await first.process.shutdown(0)
    first.exit()
    await start(home)
    const current = await readStartTokenFile(startTokenFile(home, PROFILE))
    expect(current).not.toBe(previous)
    const socket = updateSocketPath(home, PROFILE)
    for (const token of [undefined, 'x'.repeat(43), previous, 42]) {
      expect(await exchangeLines(socket, JSON.stringify({ v: 1, token, op: 'status' }))).toEqual([{ ok: false, error: 'UNAUTHENTICATED' }])
    }
    expect(await exchangeLines(socket, 'not json')).toEqual([{ ok: false, error: 'UNAUTHENTICATED' }])
    expect(final(await exchangeLines(socket, JSON.stringify({ v: 1, token: current, op: 'status' })))).toMatchObject({ ok: true, status: { state: 'running' } })
  })
})

describe('update-request-fields', TIMEOUT, () => {
  it('refuses a path, URL or command field, an unknown op and an unknown version with SCHEMA_VIOLATION and changes nothing', async () => {
    const home = await setUp()
    const running = await start(home)
    const token = await readStartTokenFile(startTokenFile(home, PROFILE))
    const socket = updateSocketPath(home, PROFILE)
    const refused = [
      { v: 1, token, op: 'update.prepare', args: { target: V2, path: '/tmp/archive.tar' } },
      { v: 1, token, op: 'update.prepare', args: { url: 'https://example.invalid/release' } },
      { v: 1, token, op: 'update.prepare', args: { target: '../../bin/sh' } },
      { v: 1, token, op: 'update.prepare', args: {}, command: 'sh' },
      { v: 1, token, op: 'exec', args: { command: 'sh' } },
      { v: 2, token, op: 'status' },
      { v: 1, token, op: 'update.apply', args: { reportId: 'a'.repeat(32), wait: 'drain', drainTimeoutS: 1, dataCopy: false } },
    ]
    for (const request of refused) expect(final(await exchangeLines(socket, JSON.stringify(request)))).toMatchObject({ ok: false, error: 'SCHEMA_VIOLATION' })
    expect(running.store?.switches).toEqual([])
    expect(readPointer(home, 'current')).toBe(V1)
  })
})

describe('update-request-limits', TIMEOUT, () => {
  it('closes a request line above 16,384 bytes, a connection silent for 5 seconds and a ninth connection with their codes', async () => {
    const home = await setUp()
    await start(home)
    const socket = updateSocketPath(home, PROFILE)
    expect(await exchangeLines(socket, 'x'.repeat(REQUEST_MAX_BYTES + 1))).toEqual([{ ok: false, error: 'REQUEST_TOO_LARGE', detail: `the request line exceeds ${String(REQUEST_MAX_BYTES)} bytes` }])
    const silent = Array.from({ length: 8 }, () => connect(socket))
    await Promise.all(silent.map(async client => new Promise(resolve => client.once('connect', resolve))))
    const ninth = await new Promise<string>((resolve) => {
      const client = connect(socket)
      let received = ''
      client.setEncoding('utf8')
      client.on('data', (chunk: string) => { received += chunk })
      client.on('close', () => { resolve(received) })
    })
    expect(JSON.parse(ninth)).toEqual({ ok: false, error: 'BUSY' })
    const timedOut = await new Promise<string>((resolve) => {
      let received = ''
      const client = silent[0]
      client?.setEncoding('utf8')
      client?.on('data', (chunk: string) => { received += chunk })
      client?.on('close', () => { resolve(received) })
    })
    expect(JSON.parse(timedOut)).toEqual({ ok: false, error: 'REQUEST_TIMEOUT' })
    for (const client of silent) client.destroy()
  })
})

describe('update-waits-for-chat', TIMEOUT, () => {
  it('stays in waiting with current unchanged while a turn runs, refuses new turns with UPDATE_PENDING, and switches once the turn ends', async () => {
    const home = await setUp()
    const running = await start(home)
    const host = running.hosts.latest
    const end = host.chats.begin(() => {})
    const idle = vi.spyOn(host.chats, 'idle')
    const reportId = await prepare(home)
    const applying = sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId, wait: 'drain', dataCopy: false } })
    await until(async () => (await status(home)).update?.phase === 'waiting', 10_000, 'waiting')
    // Only the running chat's end or the drain limit wakes an update that waits on the gate.
    await until(() => idle.mock.calls.length > 0, 10_000, 'the update to wait on the chat gate')
    expect(await status(home)).toMatchObject({ state: 'waiting', chats: 1, runtime: { current: V1, running: V1 }, update: { phase: 'waiting', target: V2 } })
    expect(readPointer(home, 'current')).toBe(V1)
    expect(running.store?.switches).toEqual([])
    expect(() => host.chats.begin(() => {})).toThrow(/UPDATE_PENDING/)
    end()
    const lines = await applying
    expect(lines.filter(line => 'phase' in line).map(line => line.phase)).toEqual(['snapshot', 'waiting', 'switching', 'health-check'])
    expect(final(lines)).toEqual({ ok: true, outcome: 'committed' })
    expect(running.store?.switches).toEqual([`${V1}>${V2}`])
    expect(readPointer(home, 'current')).toBe(V2)
    expect(readPointer(home, 'previous')).toBe(V1)
    await until(() => running.exits.length > 0, 5_000, 'the predecessor to end')
    expect(running.exits).toEqual([0])
    expect(host.closed).toBe(true)
    await until(async () => (await status(home).catch(() => undefined))?.state === 'running', 30_000, 'the successor')
    const after = await status(home)
    expect(after).toMatchObject({ state: 'running', runtime: { current: V2, previous: V1, running: V2 } })
    expect(after.pid).not.toBe(process.pid)
    expect(readHomeLock(runDirectory(home, PROFILE))).toMatchObject({ pid: after.pid, startId: after.startId, runtime: V2 })
    // The update record stays, marked committed by the successor, for a later rollback.
    await until(async () => JSON.parse(await text(journalPath(home, PROFILE))).phase === 'committed', 30_000, 'the committed record')
  })

  it('with abort-if-busy ends aborted with CHATS_RUNNING and with update.cancel ends aborted, both leaving current unchanged', async () => {
    const home = await setUp()
    const running = await start(home)
    const host = running.hosts.latest
    const end = host.chats.begin(() => {})
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'abort-if-busy', dataCopy: false } }))).toEqual({ ok: true, outcome: 'aborted', reason: 'CHATS_RUNNING' })
    const applying = sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'drain', dataCopy: false } })
    await until(async () => (await status(home)).update?.phase === 'waiting', 10_000, 'waiting')
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'update.cancel' }))).toMatchObject({ ok: true, status: { state: 'running' } })
    expect(final(await applying)).toEqual({ ok: true, outcome: 'aborted' })
    expect(readPointer(home, 'current')).toBe(V1)
    expect(running.store?.switches).toEqual([])
    expect(existsSync(journalPath(home, PROFILE))).toBe(false)
    // The gate is released: new turns are accepted again.
    host.chats.begin(() => {})()
    end()
  })

  it('with cancel cancels the running turn through the Host and then switches', async () => {
    const home = await setUp()
    const running = await start(home)
    let end: (() => void) | undefined
    end = running.hosts.latest.chats.begin(() => { setTimeout(() => { end?.() }, 50) })
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'cancel', dataCopy: false } }))).toEqual({ ok: true, outcome: 'committed' })
    expect(readPointer(home, 'current')).toBe(V2)
  })

  it('refuses a second update with UPDATE_IN_PROGRESS and an unknown report with REPORT_EXPIRED', async () => {
    const home = await setUp()
    const running = await start(home)
    const end = running.hosts.latest.chats.begin(() => {})
    const applying = sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'drain', dataCopy: false } })
    await until(async () => (await status(home)).update?.phase === 'waiting', 10_000, 'waiting')
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'update.prepare', args: { target: V2 } }))).toMatchObject({ ok: false, error: 'UPDATE_IN_PROGRESS' })
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'stop', args: { mode: 'drain' } }))).toMatchObject({ ok: false, error: 'UPDATE_IN_PROGRESS' })
    await sendHomeRequest(home, PROFILE, { op: 'update.cancel' })
    await applying
    end()
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId: 'f'.repeat(32), wait: 'drain', dataCopy: false } }))).toMatchObject({ ok: false, error: 'REPORT_EXPIRED' })
  })
})

describe('requester-killed', TIMEOUT, () => {
  it('killing the requester in waiting leaves the home process running and current unchanged, and the update goes on', async () => {
    const home = await setUp()
    const running = await start(home)
    const end = running.hosts.latest.chats.begin(() => {})
    const child = requester(home, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'drain', dataCopy: false } })
    await until(async () => (await status(home)).update?.phase === 'waiting', 10_000, 'waiting')
    child.kill('SIGKILL')
    await new Promise(resolve => child.once('exit', resolve))
    expect(await status(home)).toMatchObject({ state: 'waiting', runtime: { current: V1 } })
    expect(readPointer(home, 'current')).toBe(V1)
    end()
    await until(async () => (await status(home).catch(() => undefined))?.runtime.running === V2, 30_000, 'the successor')
    expect(readPointer(home, 'current')).toBe(V2)
  })

  it('killing the requester in health-check leaves the update to finish and one whole version current', async () => {
    const home = await setUp()
    const bootGate = join(home, 'boot.release')
    installFixture(home, V2, { bootGate })
    await start(home)
    const child = requester(home, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'drain', dataCopy: false } })
    await until(async () => (await status(home).catch(() => undefined))?.update?.phase === 'health-check', 20_000, 'health-check')
    child.kill('SIGKILL')
    await new Promise(resolve => child.once('exit', resolve))
    expect([V1, V2]).toContain(readPointer(home, 'current'))
    writeFileSync(bootGate, '')
    await until(async () => (await status(home).catch(() => undefined))?.runtime.running === V2, 30_000, 'the successor')
    expect(readPointer(home, 'current')).toBe(V2)
  })
})

describe('health-check-rollback', TIMEOUT, () => {
  it('a successor that disables a plugin the report did not name is rolled back, and the Host runs again on the previous version', async () => {
    const home = await setUp({ disabled: ['@scope/plugin'] })
    const running = await start(home)
    const lines = await sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'drain', dataCopy: false } })
    expect(final(lines)).toEqual({ ok: true, outcome: 'rolled-back', reason: 'HEALTH_CHECK_FAILED', criterion: 'H3-only-named-disabled' })
    expect(readPointer(home, 'current')).toBe(V1)
    expect(running.store?.switches).toEqual([`${V1}>${V2}`, `restore:${V1}`])
    expect(running.snapshots.calls).toEqual([`save:${V1}>${V2}`, `restore:${V1}>${V2}`])
    expect(running.copies.calls).toEqual(['recover', `rollback:${V1}>${V2}`])
    expect(running.hosts.booted).toHaveLength(2)
    expect(running.hosts.latest.closed).toBe(false)
    expect(await status(home)).toMatchObject({ state: 'running', pid: process.pid, runtime: { current: V1, running: V1 } })
    expect(existsSync(journalPath(home, PROFILE))).toBe(false)
  })

  it('hands the running Host\'s sandbox protection to the successor: one that denies fewer sockets is rolled back, one that denies more commits', async () => {
    const protection = { protectedHome: '/h', protectedHomeReadable: ['runtimes'], deniedSockets: ['/h/run/default/update.sock', '/h/run/default/supervisor.sock'], escapeSocketDirectories: ['/run/WSL'] }
    const home = await setUp({ protection: { ...protection, deniedSockets: ['/h/run/default/update.sock'] } })
    installFixture(home, V1, { protection })
    await start(home)
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'drain', dataCopy: false } }))).toEqual({ ok: true, outcome: 'rolled-back', reason: 'HEALTH_CHECK_FAILED', criterion: 'H3-only-named-disabled' })
    installFixture(home, V2, { protection: { ...protection, deniedSockets: [...protection.deniedSockets, '/h/run/default/other.sock'] } })
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'drain', dataCopy: false } }))).toEqual({ ok: true, outcome: 'committed' })
  })

  it('a successor whose studio listener does not answer is rolled back, and the outcome names the criterion it failed', async () => {
    const home = await setUp({ healthy: false })
    await start(home)
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'drain', dataCopy: false } }))).toEqual({ ok: true, outcome: 'rolled-back', reason: 'HEALTH_CHECK_FAILED', criterion: 'H2-host-ready' })
    expect(readPointer(home, 'current')).toBe(V1)
  })
})

describe('rollback', TIMEOUT, () => {
  it('without an update record is refused with NO_UPDATE_RECORD; after an update it moves current back and installs nothing', async () => {
    const home = await setUp()
    await start(home)
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'rollback', args: { wait: 'drain', profileOnly: false } }))).toMatchObject({ ok: false, error: 'NO_UPDATE_RECORD' })
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'drain', dataCopy: false } }))).toEqual({ ok: true, outcome: 'committed' })
    await until(async () => (await status(home).catch(() => undefined))?.runtime.running === V2, 30_000, 'the successor')
    await until(async () => JSON.parse(await text(journalPath(home, PROFILE))).phase === 'committed', 30_000, 'the committed record')
    expect(JSON.parse(readFileSync(journalPath(home, PROFILE), 'utf8'))).toMatchObject({ from: V1, to: V2, phase: 'committed', targetStarted: true })
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'rollback', args: { wait: 'drain', profileOnly: false } }))).toEqual({ ok: true, outcome: 'rolled-back', lines: [`Went back to ${V1}.`] })
    await until(async () => (await status(home).catch(() => undefined))?.runtime.running === V1, 30_000, 'the rolled-back successor')
    // The record goes once the version rolled back to has passed its health check.
    await until(() => !existsSync(journalPath(home, PROFILE)), 30_000, 'the record to go')
    expect(readPointer(home, 'current')).toBe(V1)
    expect(readPointer(home, 'previous')).toBe(V2)
  })

  it('when the version rolled back to fails its health check, the predecessor stops and the record stays until a start on that version passes', async () => {
    const home = await setUp()
    await FixtureStore.seed(home, V2, V1)
    await writeJournal(journalPath(home, PROFILE), { from: V1, to: V2, previous: V0, startedAt: new Date().toISOString(), dataDiffers: false, copy: false, targetStarted: true }, 'committed')
    const running = await start(home, { running: V2 })
    installFixture(home, V1, { healthy: false })
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'rollback', args: { wait: 'drain', profileOnly: false } }))).toEqual({ ok: true, outcome: 'failed', reason: 'HEALTH_CHECK_FAILED' })
    await until(() => running.exits.length > 0, 10_000, 'the predecessor to stop')
    expect(running.exits).toEqual([1])
    expect(running.hosts.booted).toHaveLength(1)
    expect(readPointer(home, 'current')).toBe(V1)
    expect(await readJournal(journalPath(home, PROFILE))).toMatchObject({ phase: 'rolling-back', from: V1, to: V2 })
    running.exit()
    await expect(startHome(home, { running: V1 })).rejects.toMatchObject({ code: 'HEALTH_CHECK_FAILED' })
    expect(await readJournal(journalPath(home, PROFILE))).toMatchObject({ phase: 'rolling-back' })
    installFixture(home, V1)
    await start(home, { running: V1 })
    expect(existsSync(journalPath(home, PROFILE))).toBe(false)
    expect(readPointer(home, 'current')).toBe(V1)
  })
})

/** The record of an update from V1 to V2 whose target started and whose data differs, with no copy. */
function interrupted(): JournalledUpdate {
  return { from: V1, to: V2, previous: undefined, startedAt: new Date().toISOString(), dataDiffers: true, copy: false, targetStarted: true }
}

describe('home-killed-mid-switch', TIMEOUT, () => {
  it('a start after a home process killed in health-check with a failing new version restores both pointers from the journal', async () => {
    const home = await setUp({ healthy: false })
    installFixture(home, V0)
    await FixtureStore.seed(home, V1, V0)
    // What a home process killed in health-check leaves: the switch written and the journal, with the old `previous`.
    await new FixtureStore(home, PROFILE).switchTo(V1, V2)
    expect(readPointer(home, 'previous')).toBe(V1)
    await writeJournal(journalPath(home, PROFILE), { from: V1, to: V2, previous: V0, startedAt: new Date().toISOString(), dataDiffers: false, copy: false, targetStarted: true }, 'health-check')
    expect(JSON.parse(readFileSync(journalPath(home, PROFILE), 'utf8'))).toMatchObject({ from: V1, to: V2, previous: V0 })
    await expect(startHome(home, { running: V2 })).rejects.toMatchObject({ code: 'HEALTH_CHECK_FAILED' })
    expect(readPointer(home, 'current')).toBe(V1)
    expect(readPointer(home, 'previous')).toBe(V0)
    // The record stays rolling-back until the restart on the previous version has passed its check.
    expect(await readJournal(journalPath(home, PROFILE))).toMatchObject({ phase: 'rolling-back' })
    await until(async () => (await status(home).catch(() => undefined))?.runtime.running === V1, 30_000, 'the restart on the previous version')
    await until(() => !existsSync(journalPath(home, PROFILE)), 30_000, 'the record to go')
  })

  it('without a previous runtime before the update, the recovery removes previous', async () => {
    const home = await setUp({ healthy: false })
    await new FixtureStore(home, PROFILE).switchTo(V1, V2)
    await writeJournal(journalPath(home, PROFILE), { from: V1, to: V2, previous: undefined, startedAt: new Date().toISOString(), dataDiffers: false, copy: false, targetStarted: false }, 'switching')
    expect(JSON.parse(readFileSync(journalPath(home, PROFILE), 'utf8'))).not.toHaveProperty('previous')
    await expect(startHome(home, { running: V2 })).rejects.toMatchObject({ code: 'HEALTH_CHECK_FAILED' })
    expect(readPointer(home, 'current')).toBe(V1)
    expect(readPointer(home, 'previous')).toBeUndefined()
    await until(async () => (await status(home).catch(() => undefined))?.runtime.running === V1, 30_000, 'the restart on the previous version')
  })

  it('a start after a kill between the store\'s two pointer writes restores the previous the journal recorded', async () => {
    const home = await setUp()
    installFixture(home, V0)
    // What a kill between the two pointer writes leaves: the switch wrote `previous` with `from` and was killed
    // before the `current` write, so both pointers name the running version while the journal in `switching`
    // records the true previous V0.
    await new FixtureStore(home, PROFILE).switchTo(V1, V2)
    await writeProtectedFile(join(home, 'runtimes', 'current'), `${V1}\n`)
    await writeJournal(journalPath(home, PROFILE), { from: V1, to: V2, previous: V0, startedAt: new Date().toISOString(), dataDiffers: false, copy: false, targetStarted: false }, 'switching')
    expect(readPointer(home, 'current')).toBe(V1)
    expect(readPointer(home, 'previous')).toBe(V1)
    await start(home)
    expect(readPointer(home, 'current')).toBe(V1)
    expect(readPointer(home, 'previous')).toBe(V0) // restored from the journal, not left clobbered with `from`
    expect(existsSync(journalPath(home, PROFILE))).toBe(false)
    expect(await status(home)).toMatchObject({ state: 'running', runtime: { current: V1, running: V1 } })
  })

  it('a start after a kill between the store\'s two pointer writes with no previous before the update removes the clobbered pointer', async () => {
    const home = await setUp()
    // The same kill point when the update had no previous: the switch still wrote `previous` with `from`, and the
    // journal records no previous, so the recovery removes the pointer the switch left behind.
    await new FixtureStore(home, PROFILE).switchTo(V1, V2)
    await writeProtectedFile(join(home, 'runtimes', 'current'), `${V1}\n`)
    await writeJournal(journalPath(home, PROFILE), { from: V1, to: V2, previous: undefined, startedAt: new Date().toISOString(), dataDiffers: false, copy: false, targetStarted: false }, 'switching')
    expect(readPointer(home, 'current')).toBe(V1)
    expect(readPointer(home, 'previous')).toBe(V1)
    await start(home)
    expect(readPointer(home, 'current')).toBe(V1)
    expect(readPointer(home, 'previous')).toBeUndefined()
    expect(existsSync(journalPath(home, PROFILE))).toBe(false)
    expect(await status(home)).toMatchObject({ state: 'running', runtime: { current: V1, running: V1 } })
  })

  it('an update journals the previous pointer it found before the switch', async () => {
    const home = await setUp()
    const bootGate = join(home, 'boot.release')
    installFixture(home, V2, { bootGate })
    installFixture(home, V0)
    await FixtureStore.seed(home, V1, V0)
    await start(home)
    const applying = sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'drain', dataCopy: false } })
    void applying.catch(() => {}) // an aborted assertion must not leave this rejection unhandled
    try {
      await until(async () => (await status(home).catch(() => undefined))?.update?.phase === 'health-check', 20_000, 'health-check')
      // The phase is announced before the journal's write lands, so the on-disk journal may still name `switching`
      // while `status` reports `health-check`; either order recovers the same way.
      const journalled = JSON.parse(readFileSync(journalPath(home, PROFILE), 'utf8')) as Record<string, unknown>
      expect(journalled).toMatchObject({ v: 1, from: V1, to: V2, previous: V0 })
      expect(['switching', 'health-check']).toContain(journalled.phase)
      writeFileSync(bootGate, '')
      expect(final(await applying)).toEqual({ ok: true, outcome: 'committed' })
    } finally {
      writeFileSync(bootGate, '')
      await applying.catch(() => {})
    }
  })

  it('a start keeps a committed record while current names its target, and removes it once a rollback moved current back', async () => {
    const home = await setUp()
    await writeJournal(journalPath(home, PROFILE), { from: V0, to: V1, previous: undefined, startedAt: new Date().toISOString(), dataDiffers: true, copy: true, targetStarted: true }, 'committed')
    const running = await start(home)
    expect(existsSync(journalPath(home, PROFILE))).toBe(true)
    await running.process.shutdown(0)
    running.exit()
    await writeJournal(journalPath(home, PROFILE), { from: V1, to: V2, previous: undefined, startedAt: new Date().toISOString(), dataDiffers: true, copy: true, targetStarted: true }, 'committed')
    await start(home)
    expect(existsSync(journalPath(home, PROFILE))).toBe(false)
  })

  it('a start that finishes an interrupted update records targetStarted before its Host boots, and marks the update committed', async () => {
    const home = await setUp()
    await new FixtureStore(home, PROFILE).switchTo(V1, V2)
    await writeJournal(journalPath(home, PROFILE), { from: V1, to: V2, previous: undefined, startedAt: new Date().toISOString(), dataDiffers: true, copy: true, targetStarted: false }, 'switching')
    await startHome(home, { running: V2 })
    expect(JSON.parse(readFileSync(journalPath(home, PROFILE), 'utf8'))).toMatchObject({ phase: 'committed', targetStarted: true })
  })

  it('a start that cannot roll an interrupted update back leaves the record for delorun recover', async () => {
    const home = await setUp({ healthy: false })
    await new FixtureStore(home, PROFILE).switchTo(V1, V2)
    await writeJournal(journalPath(home, PROFILE), { from: V1, to: V2, previous: undefined, startedAt: new Date().toISOString(), dataDiffers: true, copy: false, targetStarted: true }, 'health-check')
    await expect(startHome(home, { running: V2 })).rejects.toMatchObject({ code: 'HEALTH_CHECK_FAILED' })
    expect(readPointer(home, 'current')).toBe(V2)
    expect(JSON.parse(readFileSync(journalPath(home, PROFILE), 'utf8'))).toMatchObject({ phase: 'health-check', targetStarted: true, refused: true })
  })

  it('a start refuses a record whose automatic rollback C3\'s table refused, naming the ways out, and boots no Host', async () => {
    const home = await setUp()
    await new FixtureStore(home, PROFILE).switchTo(V1, V2)
    await writeJournal(journalPath(home, PROFILE), { ...interrupted(), refused: true }, 'health-check')
    let hosts: { readonly booted: readonly unknown[] } | undefined
    const failure = await startHome(home, { running: V2, configure: (parts) => { hosts = parts.hosts } }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'ROLLBACK_NEEDS_DATA_COPY' })
    expect(String((failure as { readonly detail?: unknown }).detail)).toMatch(/delorun recover rollback --profile-only.*delorun recover safe-mode/)
    expect(hosts?.booted).toEqual([])
    expect(await readJournal(journalPath(home, PROFILE))).toMatchObject({ phase: 'health-check', refused: true })
    expect(readPointer(home, 'current')).toBe(V2)
  })

  it('a start rolls an interrupted update back while it still holds the home lock, after stopping its Host through its own teardown', async () => {
    const home = await setUp({ healthy: false })
    await new FixtureStore(home, PROFILE).switchTo(V1, V2)
    await writeJournal(journalPath(home, PROFILE), { ...interrupted(), dataDiffers: false }, 'health-check')
    let holder: string | undefined = 'not called'
    let startId: string | undefined
    let hosts: StartParts['hosts'] | undefined
    await expect(startHome(home, {
      running: V2,
      configure: (parts) => {
        startId = parts.startId
        hosts = parts.hosts
        parts.copies.beforeRollback = () => { holder = readHomeLock(runDirectory(home, PROFILE))?.startId }
      },
    })).rejects.toMatchObject({ code: 'HEALTH_CHECK_FAILED' })
    expect(holder).toBe(startId)
    // `close` is the process-stop path, whose upstream bound may end the process before the rollback runs.
    expect(hosts?.latest.stops).toEqual(['suspend'])
    await until(async () => (await status(home).catch(() => undefined))?.runtime.running === V1, 30_000, 'the restart on the previous version')
  })

  it('a start that rolled an interrupted update back starts no home process on a version that fails its check before a start', async () => {
    const home = await setUp({ healthy: false })
    installFixture(home, V1, { launchRefused: true })
    await new FixtureStore(home, PROFILE).switchTo(V1, V2)
    await writeJournal(journalPath(home, PROFILE), { ...interrupted(), dataDiffers: false }, 'health-check')
    const logger = new MemoryLogger()
    let store: FixtureStore | undefined
    await expect(startHome(home, { running: V2, logger, configure: (parts) => { store = parts.store } })).rejects.toMatchObject({ code: 'HEALTH_CHECK_FAILED' })
    expect(readPointer(home, 'current')).toBe(V1)
    // A failed start settles after its start again has run, so the refusal and the absent command are both final here.
    expect(logger.records.some(record => record.includes('failed its check before a start'))).toBe(true)
    expect(store?.commands).toEqual([])
  })

  it('a start after a home process killed in switching before current was written runs the previous version and removes the journal', async () => {
    const home = await setUp()
    await writeJournal(journalPath(home, PROFILE), { from: V1, to: V2, previous: undefined, startedAt: new Date().toISOString(), dataDiffers: false, copy: false, targetStarted: false }, 'switching')
    await start(home)
    expect(existsSync(journalPath(home, PROFILE))).toBe(false)
    expect(await status(home)).toMatchObject({ state: 'running', runtime: { current: V1, running: V1 } })
  })
})

/** The committed record of an update from V0 to V1, which a process on V1 keeps for a later rollback. */
const EARLIER: JournalledUpdate = { from: V0, to: V1, previous: undefined, startedAt: '2026-11-01T00:00:00.000Z', dataDiffers: false, copy: false, targetStarted: true }

/** Leave the earlier update's committed record in the stash, as an update in progress does. */
async function stashEarlier(home: string): Promise<void> {
  await writeJournal(stashPath(journalPath(home, PROFILE)), EARLIER, 'committed')
}

describe('a kill at each step of an update or rollback', TIMEOUT, () => {
  it('after the copy is written and before the switch: the next start discards the copy, and the previous update\'s record returns', async () => {
    const home = await setUp()
    await stashEarlier(home)
    await writeJournal(journalPath(home, PROFILE), { from: V1, to: V2, previous: undefined, startedAt: new Date().toISOString(), dataDiffers: true, copy: true, targetStarted: false }, 'switching')
    const running = await start(home)
    expect(running.copies.calls).toEqual(['recover', `discard:${V2}`])
    expect(await readJournal(journalPath(home, PROFILE))).toMatchObject({ from: V0, to: V1, phase: 'committed' })
    expect(existsSync(stashPath(journalPath(home, PROFILE)))).toBe(false)
    expect(readPointer(home, 'current')).toBe(V1)
  })

  it('after the stash and before the update\'s own record: the next start puts the previous update\'s record back', async () => {
    const home = await setUp()
    await stashEarlier(home)
    await start(home)
    expect(await readJournal(journalPath(home, PROFILE))).toMatchObject({ from: V0, to: V1, phase: 'committed' })
    expect(existsSync(stashPath(journalPath(home, PROFILE)))).toBe(false)
  })

  it('after the successor committed and before the stash went: the next start keeps only the committed update\'s record and copy', async () => {
    const home = await setUp()
    await FixtureStore.seed(home, V2, V1)
    await stashEarlier(home)
    await writeJournal(journalPath(home, PROFILE), interrupted(), 'committed')
    const running = await start(home, { running: V2 })
    expect(running.copies.calls).toEqual(['recover', `commit:${V2}`])
    expect(running.snapshots.calls).toEqual([`committed:${V1}>${V2}`])
    expect(await readJournal(journalPath(home, PROFILE))).toMatchObject({ from: V1, to: V2, phase: 'committed' })
    expect(existsSync(stashPath(journalPath(home, PROFILE)))).toBe(false)
  })

  it('a commit whose profile record cannot be marked still commits, and the start logs a warning', async () => {
    const home = await setUp()
    await FixtureStore.seed(home, V2, V1)
    await stashEarlier(home)
    await writeJournal(journalPath(home, PROFILE), interrupted(), 'committed')
    const running = await start(home, { running: V2, configure: ({ snapshots }) => { snapshots.committedFails = true } })
    expect(running.copies.calls).toEqual(['recover', `commit:${V2}`])
    expect(running.logger.records.some(record => record.startsWith('warn the profile\'s record of the update could not be marked committed'))).toBe(true)
    expect(await readJournal(journalPath(home, PROFILE))).toMatchObject({ from: V1, to: V2, phase: 'committed' })
    expect(existsSync(stashPath(journalPath(home, PROFILE)))).toBe(false)
  })

  it('after targetStarted and before the successor answered: the next start holds the target to the record\'s expectations and commits', async () => {
    const home = await setUp({ disabled: ['@scope/plugin'] })
    await new FixtureStore(home, PROFILE).switchTo(V1, V2)
    await stashEarlier(home)
    await writeJournal(journalPath(home, PROFILE), { ...interrupted(), health: { disabledPlugins: ['@scope/plugin'], namedRows: [] } }, 'health-check')
    const running = await start(home, { running: V2 })
    expect(running.copies.calls).toEqual(['recover', `commit:${V2}`])
    expect(running.snapshots.calls).toEqual([`committed:${V1}>${V2}`])
    expect(await readJournal(journalPath(home, PROFILE))).toMatchObject({ from: V1, to: V2, phase: 'committed' })
    expect(existsSync(stashPath(journalPath(home, PROFILE)))).toBe(false)
  })

  it('after targetStarted and before the successor answered: the next start runs H1 to H5 and rolls back through the table when H3 fails', async () => {
    const home = await setUp({ disabled: ['@scope/plugin'] })
    await new FixtureStore(home, PROFILE).switchTo(V1, V2)
    await stashEarlier(home)
    await writeJournal(journalPath(home, PROFILE), { ...interrupted(), dataDiffers: false, health: { disabledPlugins: [], namedRows: [] } }, 'health-check')
    let calls: readonly string[] = []
    await expect(startHome(home, { running: V2, configure: (parts) => { calls = parts.copies.calls } })).rejects.toMatchObject({ code: 'HEALTH_CHECK_FAILED' })
    expect(calls).toEqual(['recover', `rollback:${V1}>${V2}`])
    expect(readPointer(home, 'current')).toBe(V1)
    await until(async () => (await status(home).catch(() => undefined))?.runtime.running === V1, 30_000, 'the restart on the previous version')
    // Once the previous version passed its check, the rollback's record goes and the earlier update's returns.
    await until(async () => (await readJournal(journalPath(home, PROFILE)))?.to === V1, 30_000, 'the earlier record to return')
    expect(existsSync(stashPath(journalPath(home, PROFILE)))).toBe(false)
  })

  it('between the data restore and the switch: the next start completes the switch before any Host boots and starts again on the previous version', async () => {
    const home = await setUp()
    await FixtureStore.seed(home, V2, V1)
    await writeJournal(journalPath(home, PROFILE), { ...interrupted(), dataDiffers: false }, 'rolling-back')
    let booted = -1
    await expect(startHome(home, {
      running: V2,
      configure: (parts) => { parts.copies.beforeRollback = () => { booted = parts.hosts.booted.length } },
    })).rejects.toMatchObject({ code: 'HEALTH_CHECK_FAILED' })
    expect(booted).toBe(0)
    expect(readPointer(home, 'current')).toBe(V1)
    expect(readPointer(home, 'previous')).toBe(V2)
    await until(async () => (await status(home).catch(() => undefined))?.runtime.running === V1, 30_000, 'the restart on the previous version')
    await until(() => !existsSync(journalPath(home, PROFILE)), 30_000, 'the record to go')
  })

  it('after the switch of a rollback and before its check: the next start on the previous version checks it and removes the record', async () => {
    const home = await setUp()
    await writeJournal(journalPath(home, PROFILE), { ...interrupted(), dataDiffers: false }, 'rolling-back')
    const running = await start(home)
    expect(running.copies.calls).toEqual(['recover'])
    expect(existsSync(journalPath(home, PROFILE))).toBe(false)
  })
})

describe('the previous update\'s committed record across an update', TIMEOUT, () => {
  it('waits in the stash while the update runs and goes once the successor has committed', async () => {
    const home = await setUp()
    await writeJournal(journalPath(home, PROFILE), EARLIER, 'committed')
    await start(home)
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'drain', dataCopy: false } }))).toEqual({ ok: true, outcome: 'committed' })
    // The successor rewrites the record while this polls; a read that meets the rename is retried.
    await until(async () => (await readJournal(journalPath(home, PROFILE)).catch(() => undefined))?.phase === 'committed', 30_000, 'the committed record')
    await until(() => !existsSync(stashPath(journalPath(home, PROFILE))), 30_000, 'the stash to go')
    expect(await readJournal(journalPath(home, PROFILE))).toMatchObject({ from: V1, to: V2, phase: 'committed' })
  })
})

/** A digest of every file under a directory, by relative path. */
function treeDigest(directory: string): Record<string, string> {
  const digests: Record<string, string> = {}
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`)
      else digests[`${prefix}${name}`] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  walk(directory, '')
  return digests
}

describe('desktop-independent', TIMEOUT, () => {
  it('with a desktop Host running, the CLI start succeeds and an update leaves the desktop process running and its profile byte-identical', async () => {
    const home = await setUp()
    const desktop = join(home, 'profiles', 'desktop')
    mkdirSync(desktop, { recursive: true })
    writeFileSync(join(desktop, 'cordis.patch.yml'), 'plugins: []\n')
    writeFileSync(join(desktop, 'package.json'), '{"name":"desktop-profile"}\n')
    // The fixture desktop Host holds upstream's own desktop lock and runs on its own.
    const host = spawn(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(join(desktop, 'lock'))}, String(process.pid)); setInterval(() => {}, 1000)`], { stdio: 'ignore' })
    children.push(host)
    await until(() => existsSync(join(desktop, 'lock')), 10_000, 'the desktop lock')
    const before = treeDigest(desktop)
    await start(home)
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'drain', dataCopy: false } }))).toEqual({ ok: true, outcome: 'committed' })
    await until(async () => (await status(home).catch(() => undefined))?.runtime.running === V2, 30_000, 'the successor')
    expect(host.pid !== undefined && processExists(host.pid)).toBe(true)
    expect(treeDigest(desktop)).toEqual(before)
    expect(readHomeLock(runDirectory(home, PROFILE))?.pid).not.toBe(host.pid)
  })
})

describe('the studio\'s way to the home process', TIMEOUT, () => {
  it('the Host reaches the home process only through the update channel, with the current token held in memory', async () => {
    const home = await setUp()
    const running = await start(home)
    const access = running.hosts.latest.access
    expect(final(await access.send({ op: 'status' }))).toMatchObject({ ok: true, status: { state: 'running' } })
    expect(final(await access.send({ op: 'update.prepare', args: { target: V2 } }))).toMatchObject({ ok: true, report: { to: V2 } })
    expect(running.logger.records).toContain('info request {"op":"update.prepare","outcome":"ok"}')
    await running.process.shutdown(0)
    await expect(access.send({ op: 'status' })).rejects.toThrow(/not open/)
  })
})

describe('a build without the runtime store', TIMEOUT, () => {
  it('refuses update requests and still serves status and stop', async () => {
    temp = await tempHome()
    installFixture(temp.home, V1)
    await start(temp.home, { updates: false })
    expect(final(await sendHomeRequest(temp.home, PROFILE, { op: 'update.prepare', args: {} }))).toMatchObject({ ok: false, error: 'VERIFY_FAILED' })
    expect(final(await sendHomeRequest(temp.home, PROFILE, { op: 'rollback', args: { wait: 'drain', profileOnly: false } }))).toMatchObject({ ok: false, error: 'NO_UPDATE_RECORD' })
    expect(await status(temp.home)).toMatchObject({ state: 'running', runtime: { current: V1, running: V1 } })
  })
})

describe('host-teardown-bounded', TIMEOUT, () => {
  it('an update whose Host is slow to stop waits for its teardown, keeps this process and commits', async () => {
    const home = await setUp()
    let finish: (() => void) | undefined
    const running = await start(home, { hostSuspend: async () => new Promise<void>((resolve) => { finish = resolve }) })
    const reportId = await prepare(home)
    const applying = sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId, wait: 'drain', dataCopy: false } })
    await until(() => finish !== undefined, 30_000, 'the Host\'s teardown to begin')
    // While the teardown runs, nothing is switched and the process is not told to end.
    expect(running.store?.switches).toEqual([])
    expect(running.exits).toEqual([])
    finish?.()
    expect(final(await applying)).toEqual({ ok: true, outcome: 'committed' })
    expect(running.store?.switches).toEqual([`${V1}>${V2}`])
    await until(() => running.exits.length > 0, 5_000, 'the predecessor to end')
    // The process ends once, after the handover, never in the middle of the switch.
    expect(running.exits).toEqual([0])
    // The committed successor keeps the runtimes the pointers name and removes the rest.
    await until(() => existsSync(join(home, 'runtimes', 'retained.log')), 30_000, 'the retention at commit')
  })

  it('a switch waits for an 8-second teardown, refuses one that outlasts the bound or fails with HOST_STOP_FAILED, and keeps the process running', async () => {
    const home = await setUp()
    let teardown: 'slow' | 'never' | 'fail' = 'slow'
    const running = await start(home, {
      hostSuspend: async () => {
        if (teardown === 'fail') throw new Error('a row did not dispose')
        await new Promise<void>((resolve) => { if (teardown === 'slow') setTimeout(resolve, 8_000) })
      },
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let slow: unknown = 'waiting'
      void running.process.suspend(60).then(() => { slow = 'stopped' }, (error: unknown) => { slow = error })
      await vi.advanceTimersByTimeAsync(7_999)
      expect(slow).toBe('waiting')
      await vi.advanceTimersByTimeAsync(1)
      expect(slow).toBe('stopped')
      await running.process.resume()
      teardown = 'never'
      let stuck: unknown = 'waiting'
      void running.process.suspend(60).then(() => { stuck = 'stopped' }, (error: unknown) => { stuck = error })
      await vi.advanceTimersByTimeAsync(59_999)
      expect(stuck).toBe('waiting')
      await vi.advanceTimersByTimeAsync(1)
      expect(stuck).toMatchObject({ code: 'HOST_STOP_FAILED', detail: 'the Host did not stop within 60 seconds; nothing was switched' })
    } finally {
      vi.useRealTimers()
    }
    await running.process.resume()
    teardown = 'fail'
    await expect(running.process.suspend(60)).rejects.toMatchObject({ code: 'HOST_STOP_FAILED', detail: 'the Host\'s teardown failed (a row did not dispose); nothing was switched' })
    await running.process.resume()
    expect(running.exits).toEqual([])
    expect((await status(home)).state).toBe('running')
  })

  it('a failed start whose Host does not stop rolls nothing back, starts nothing again and keeps the lock until the process ends', async () => {
    const home = await setUp({ healthy: false })
    await new FixtureStore(home, PROFILE).switchTo(V1, V2)
    await writeJournal(journalPath(home, PROFILE), { ...interrupted(), dataDiffers: false }, 'health-check')
    let parts: StartParts | undefined
    const failure = await startHome(home, { running: V2, hostSuspend: async () => Promise.reject(new Error('a row did not dispose')), configure: (given) => { parts = given } }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HostNotStoppedError)
    expect(failure).toMatchObject({ cause: { code: 'HEALTH_CHECK_FAILED' }, outcome: { stopped: false, kind: 'failed' } })
    expect(parts?.hosts.latest.stops).toEqual(['suspend'])
    expect(parts?.copies.calls.filter(call => call.startsWith('rollback'))).toEqual([])
    expect(readPointer(home, 'current')).toBe(V2)
    expect(await readJournal(journalPath(home, PROFILE))).toMatchObject({ phase: 'health-check', targetStarted: true })
    expect(parts?.store?.commands).toEqual([])
    expect(readHomeLock(runDirectory(home, PROFILE))?.startId).toBe(parts?.startId)
    // No signal listener is left that would swallow a signal while the Host may still run.
    expect(parts?.signals.count).toBe(0)
    expect(parts?.exits).toEqual([])
  })
})

describe('signals and stop', TIMEOUT, () => {
  /** The paths a stop removes. */
  function stopRemoved(home: string): string[] {
    return [startTokenFile(home, PROFILE), updateSocketPath(home, PROFILE), join(runDirectory(home, PROFILE), 'home.lock')]
  }

  it('a signal before the Host booted stops the process and removes the token, the socket and the lock', async () => {
    temp = await tempHome()
    const home = temp.home
    const bootGate = join(home, 'boot.release')
    installFixture(home, V1, { bootGate })
    await FixtureStore.seed(home, V1)
    let parts: StartParts | undefined
    const starting = startHome(home, { configure: (configured) => { parts = configured } }).catch((error: unknown) => error)
    await until(async () => (await status(home).catch(() => undefined))?.state === 'starting', 5_000, 'the channel')
    expect(parts?.hosts.booted).toEqual([])
    parts?.signals.send('SIGTERM')
    await until(() => (parts?.exits.length ?? 0) > 0, 5_000, 'the stop')
    expect(parts?.exits).toEqual([0])
    for (const path of stopRemoved(home)) expect(existsSync(path), path).toBe(false)
    expect(parts?.signals.count).toBe(0)
    // The Host's boot finishes only now, after the stop: the start ends without serving it.
    writeFileSync(bootGate, '')
    expect(await starting).toMatchObject({ message: 'the home process stopped while its Host booted' })
    expect(parts?.hosts.booted[0]?.closed).toBe(true)
  })

  it('after a failed switch and the Host\'s boot again, one SIGTERM stops the process once through its own stop', async () => {
    const home = await setUp({ disabled: ['@scope/plugin'] })
    const running = await start(home)
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'drain', dataCopy: false } }))).toEqual({ ok: true, outcome: 'rolled-back', reason: 'HEALTH_CHECK_FAILED', criterion: 'H3-only-named-disabled' })
    expect(running.hosts.booted).toHaveLength(2)
    expect(running.signals.count).toBe(1)
    running.signals.send('SIGTERM')
    await until(() => running.exits.length > 0, 5_000, 'the stop')
    expect(running.exits).toEqual([0])
    expect(running.hosts.latest.closed).toBe(true)
    for (const path of stopRemoved(home)) expect(existsSync(path), path).toBe(false)
    expect(running.logger.records).toContain('info stopped {"code":0}')
  })

  it('SIGINT stops with code 130, and a second signal while that stop runs ends the process at once', async () => {
    const home = await setUp()
    const running = await start(home)
    running.signals.send('SIGINT')
    running.signals.send('SIGTERM')
    expect(running.exits[0]).toBe(0)
    await until(() => running.exits.length > 1, 5_000, 'the stop')
    expect(running.exits).toEqual([0, 130])
  })

  it('stop --now during a draining stop cancels the running chat, and both requests end with the process', async () => {
    const home = await setUp()
    const running = await start(home)
    let cancelled = 0
    let end: (() => void) | undefined
    end = running.hosts.latest.chats.begin(() => {
      cancelled += 1
      end?.()
    })
    const draining = sendHomeRequest(home, PROFILE, { op: 'stop', args: { mode: 'drain' } })
    await until(async () => (await status(home)).state === 'stopping', 5_000, 'stopping')
    const now = sendHomeRequest(home, PROFILE, { op: 'stop', args: { mode: 'cancel' } })
    expect(final(await now)).toMatchObject({ ok: true, status: { state: 'stopping', chats: 0 } })
    expect(final(await draining)).toMatchObject({ ok: true, status: { state: 'stopping', chats: 0 } })
    expect(cancelled).toBe(1)
    await until(() => running.exits.length > 0, 5_000, 'the stop')
    expect(running.exits).toEqual([0])
  })

  it('a stop whose cancellation fails, or whose status cannot be read, still answers and ends the process', async () => {
    const home = await setUp()
    const running = await start(home)
    let end: (() => void) | undefined
    end = running.hosts.latest.chats.track(() => {
      end?.()
      throw new Error('the cancellation failed after the turn ended')
    })
    // The status reads `current`, which is gone.
    rmSync(join(home, 'runtimes', 'current'))
    const lines = await sendHomeRequest(home, PROFILE, { op: 'stop', args: { mode: 'cancel' } })
    expect(final(lines)).toEqual({ ok: true })
    await until(() => running.exits.length > 0, 5_000, 'the stop')
    expect(running.exits).toEqual([0])
    expect(running.logger.records.some(record => record.startsWith('error the stop could not cancel the running chats'))).toBe(true)
  })
})

describe('an update record without the runtime store', TIMEOUT, () => {
  it('refuses to start with NO_RUNTIME_STORE, naming delorun recover, boots no Host and leaves the record', async () => {
    temp = await tempHome()
    const home = temp.home
    installFixture(home, V1)
    await writeJournal(journalPath(home, PROFILE), interrupted(), 'switching')
    let hosts: { readonly booted: readonly unknown[] } | undefined
    const failure = await startHome(home, { updates: false, configure: (parts) => { hosts = parts.hosts } }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'NO_RUNTIME_STORE' })
    expect(String((failure as { readonly detail?: unknown }).detail)).toMatch(/delorun recover/)
    expect(hosts?.booted).toEqual([])
    expect(await readJournal(journalPath(home, PROFILE))).toMatchObject({ phase: 'switching', from: V1, to: V2 })
    expect(readHomeLock(runDirectory(home, PROFILE))).toBeUndefined()
  })

  it('starts with a committed record, which it leaves for a later rollback', async () => {
    temp = await tempHome()
    const home = temp.home
    installFixture(home, V1)
    await writeJournal(journalPath(home, PROFILE), interrupted(), 'committed')
    const running = await start(home, { updates: false })
    expect(await readJournal(journalPath(home, PROFILE))).toMatchObject({ phase: 'committed' })
    expect(running.logger.records.some(record => record.startsWith('warn an update record exists'))).toBe(true)
  })
})
