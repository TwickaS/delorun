/**
 * The home process (contract C19) against a fixture runtime store, profile history and Host: one home process per
 * profile holds the lock, each start writes a new token and only the current token is accepted, the channel's closed
 * schema and limits, the update handshake that never switches `current` under a running chat, a requester killed
 * mid-update, a failed health check, an interrupted update, the desktop app's independence and the Host's way to
 * the channel.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { REQUEST_MAX_BYTES, type HomeStatus } from '@delo/contract-home-process'
import { newStartId, processExists, readHomeLock, readStartTokenFile, runDirectory, startTokenFile } from '@delo/home'
import { resolveSurface } from '@delo/logs'
import { afterEach, describe, expect, it } from 'vitest'
import { exchangeLines, journalPath, openHomeLog, queryHomeStatus, sendHomeRequest, updateSocketPath, writeJournal, type ResponseLine } from '../src/index.ts'
import { FixtureStore, installFixture, killLockHolder, PROFILE, readPointer, startHome, tempHome, until, V0, V1, V2, type InProcessHome, type TempHome } from './support.ts'

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
      { v: 1, token, op: 'update.apply', args: { reportId: 'a'.repeat(32), wait: 'drain', drainTimeoutS: 1 } },
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
    const reportId = await prepare(home)
    const applying = sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId, wait: 'drain' } })
    await until(async () => (await status(home)).update?.phase === 'waiting', 10_000, 'waiting')
    await new Promise(resolve => setTimeout(resolve, 300))
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
    expect(existsSync(journalPath(home, PROFILE))).toBe(false)
  })

  it('with abort-if-busy ends aborted with CHATS_RUNNING and with update.cancel ends aborted, both leaving current unchanged', async () => {
    const home = await setUp()
    const running = await start(home)
    const host = running.hosts.latest
    const end = host.chats.begin(() => {})
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'abort-if-busy' } }))).toEqual({ ok: true, outcome: 'aborted', reason: 'CHATS_RUNNING' })
    const applying = sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'drain' } })
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
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'cancel' } }))).toEqual({ ok: true, outcome: 'committed' })
    expect(readPointer(home, 'current')).toBe(V2)
  })

  it('refuses a second update with UPDATE_IN_PROGRESS and an unknown report with REPORT_EXPIRED', async () => {
    const home = await setUp()
    const running = await start(home)
    const end = running.hosts.latest.chats.begin(() => {})
    const applying = sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'drain' } })
    await until(async () => (await status(home)).update?.phase === 'waiting', 10_000, 'waiting')
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'update.prepare', args: { target: V2 } }))).toMatchObject({ ok: false, error: 'UPDATE_IN_PROGRESS' })
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'stop', args: { mode: 'drain' } }))).toMatchObject({ ok: false, error: 'UPDATE_IN_PROGRESS' })
    await sendHomeRequest(home, PROFILE, { op: 'update.cancel' })
    await applying
    end()
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId: 'f'.repeat(32), wait: 'drain' } }))).toMatchObject({ ok: false, error: 'REPORT_EXPIRED' })
  })
})

describe('requester-killed', TIMEOUT, () => {
  it('killing the requester in waiting leaves the home process running and current unchanged, and the update goes on', async () => {
    const home = await setUp()
    const running = await start(home)
    const end = running.hosts.latest.chats.begin(() => {})
    const child = requester(home, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'drain' } })
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
    const home = await setUp({ bootMs: 1_500 })
    await start(home)
    const child = requester(home, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'drain' } })
    await until(async () => (await status(home).catch(() => undefined))?.update?.phase === 'health-check', 20_000, 'health-check')
    child.kill('SIGKILL')
    expect([V1, V2]).toContain(readPointer(home, 'current'))
    await until(async () => (await status(home).catch(() => undefined))?.runtime.running === V2, 30_000, 'the successor')
    expect(readPointer(home, 'current')).toBe(V2)
  })
})

describe('health-check-rollback', TIMEOUT, () => {
  it('a successor that disables a plugin the report did not name is rolled back, and the Host runs again on the previous version', async () => {
    const home = await setUp({ disabled: ['@scope/plugin'] })
    const running = await start(home)
    const lines = await sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'drain' } })
    expect(final(lines)).toEqual({ ok: true, outcome: 'rolled-back', reason: 'HEALTH_CHECK_FAILED' })
    expect(readPointer(home, 'current')).toBe(V1)
    expect(running.store?.switches).toEqual([`${V1}>${V2}`, `restore:${V1}`])
    expect(running.snapshots.calls).toEqual([`save:${V1}>${V2}`, `restore:${V1}>${V2}`])
    expect(running.hosts.booted).toHaveLength(2)
    expect(running.hosts.latest.closed).toBe(false)
    expect(await status(home)).toMatchObject({ state: 'running', pid: process.pid, runtime: { current: V1, running: V1 } })
    expect(existsSync(journalPath(home, PROFILE))).toBe(false)
  })

  it('a successor whose studio listener does not answer is rolled back', async () => {
    const home = await setUp({ healthy: false })
    await start(home)
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'drain' } }))).toEqual({ ok: true, outcome: 'rolled-back', reason: 'HEALTH_CHECK_FAILED' })
    expect(readPointer(home, 'current')).toBe(V1)
  })
})

describe('rollback', TIMEOUT, () => {
  it('without a previous runtime is refused with NO_PREVIOUS; after an update it moves current back and installs nothing', async () => {
    const home = await setUp()
    await start(home)
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'rollback', args: { wait: 'drain' } }))).toMatchObject({ ok: false, error: 'NO_PREVIOUS' })
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'drain' } }))).toEqual({ ok: true, outcome: 'committed' })
    await until(async () => (await status(home).catch(() => undefined))?.runtime.running === V2, 30_000, 'the successor')
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'rollback', args: { wait: 'drain' } }))).toEqual({ ok: true, outcome: 'committed' })
    await until(async () => (await status(home).catch(() => undefined))?.runtime.running === V1, 30_000, 'the rolled-back successor')
    expect(readPointer(home, 'current')).toBe(V1)
    expect(readPointer(home, 'previous')).toBe(V2)
  })
})

describe('home-killed-mid-switch', TIMEOUT, () => {
  it('a start after a home process killed in health-check with a failing new version restores both pointers from the journal', async () => {
    const home = await setUp({ healthy: false })
    installFixture(home, V0)
    await FixtureStore.seed(home, V1, V0)
    // What a home process killed in health-check leaves: the switch written and the journal, with the old `previous`.
    await new FixtureStore(home, PROFILE).switchTo(V1, V2)
    expect(readPointer(home, 'previous')).toBe(V1)
    await writeJournal(journalPath(home, PROFILE), { from: V1, to: V2, previous: V0, startedAt: new Date().toISOString() }, 'health-check')
    expect(JSON.parse(readFileSync(journalPath(home, PROFILE), 'utf8'))).toMatchObject({ from: V1, to: V2, previous: V0 })
    await expect(startHome(home, { running: V2 })).rejects.toMatchObject({ code: 'HEALTH_CHECK_FAILED' })
    expect(readPointer(home, 'current')).toBe(V1)
    expect(readPointer(home, 'previous')).toBe(V0)
    expect(existsSync(journalPath(home, PROFILE))).toBe(false)
    await until(async () => (await status(home).catch(() => undefined))?.runtime.running === V1, 30_000, 'the restart on the previous version')
  })

  it('without a previous runtime before the update, the recovery removes previous', async () => {
    const home = await setUp({ healthy: false })
    await new FixtureStore(home, PROFILE).switchTo(V1, V2)
    await writeJournal(journalPath(home, PROFILE), { from: V1, to: V2, previous: undefined, startedAt: new Date().toISOString() }, 'switching')
    expect(JSON.parse(readFileSync(journalPath(home, PROFILE), 'utf8'))).not.toHaveProperty('previous')
    await expect(startHome(home, { running: V2 })).rejects.toMatchObject({ code: 'HEALTH_CHECK_FAILED' })
    expect(readPointer(home, 'current')).toBe(V1)
    expect(readPointer(home, 'previous')).toBeUndefined()
    await until(async () => (await status(home).catch(() => undefined))?.runtime.running === V1, 30_000, 'the restart on the previous version')
  })

  it('an update journals the previous pointer it found before the switch', async () => {
    const home = await setUp({ bootMs: 1_500 })
    installFixture(home, V0)
    await FixtureStore.seed(home, V1, V0)
    await start(home)
    const applying = sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'drain' } })
    await until(async () => (await status(home).catch(() => undefined))?.update?.phase === 'health-check', 20_000, 'health-check')
    expect(JSON.parse(readFileSync(journalPath(home, PROFILE), 'utf8'))).toMatchObject({ v: 1, from: V1, to: V2, previous: V0, phase: 'health-check' })
    expect(final(await applying)).toEqual({ ok: true, outcome: 'committed' })
  })

  it('a start after a home process killed in switching before current was written runs the previous version and removes the journal', async () => {
    const home = await setUp()
    await writeJournal(journalPath(home, PROFILE), { from: V1, to: V2, previous: undefined, startedAt: new Date().toISOString() }, 'switching')
    await start(home)
    expect(existsSync(journalPath(home, PROFILE))).toBe(false)
    expect(await status(home)).toMatchObject({ state: 'running', runtime: { current: V1, running: V1 } })
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
    expect(final(await sendHomeRequest(home, PROFILE, { op: 'update.apply', args: { reportId: await prepare(home), wait: 'drain' } }))).toEqual({ ok: true, outcome: 'committed' })
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
    expect(final(await sendHomeRequest(temp.home, PROFILE, { op: 'rollback', args: { wait: 'drain' } }))).toMatchObject({ ok: false, error: 'NO_PREVIOUS' })
    expect(await status(temp.home)).toMatchObject({ state: 'running', runtime: { current: V1, running: V1 } })
  })
})
