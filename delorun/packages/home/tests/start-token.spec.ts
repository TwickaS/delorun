/**
 * C1's start token and the token channel listener both of C1's channels use: the token's format, file and
 * constant-time check, its removal at a clean stop, the lock's handover to a successor, and the listener's binding,
 * replacement and authentication before the schema.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion, StartId, StartToken } from '@delorun/contract-home-layout'
import {
  acquireHomeLock,
  adoptHomeLock,
  listenTokenSocket,
  newStartId,
  newStartToken,
  parseStartToken,
  readHomeLock,
  readStartTokenFile,
  removeStartTokenFile,
  runDirectory,
  StartTokenCheck,
  startTokenFile,
  writeNewStartToken,
  type ChannelLogger,
  type ChannelRefusal,
  type TokenSocket,
} from '../src/index.ts'

const PROFILE = 'default'
const SILENT: ChannelLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }

let base: string
let home: string
let listener: TokenSocket | undefined

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dst-')))
  home = join(base, 'h')
  mkdirSync(runDirectory(home, PROFILE), { recursive: true, mode: 0o700 })
})

afterEach(async () => {
  await listener?.close()
  listener = undefined
  rmSync(base, { recursive: true, force: true })
})

describe('the start token', () => {
  it('accepts only the current token, compared whole', () => {
    const token = brandString<StartToken>('a'.repeat(43))
    const check = new StartTokenCheck(token)
    expect(check.accepts(token)).toBe(true)
    for (const candidate of [undefined, null, 42, '', token.slice(1), `${token}a`, 'b'.repeat(43)]) expect(check.accepts(candidate)).toBe(false)
  })

  it('writes a new token at mode 0600 at each start, and a previous start\'s token is not accepted', async () => {
    const first = await writeNewStartToken(home, PROFILE)
    const file = startTokenFile(home, PROFILE)
    expect(lstatSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8')).toBe(`${first}\n`)
    const second = await writeNewStartToken(home, PROFILE)
    expect(second).not.toBe(first)
    expect(await readStartTokenFile(file)).toBe(second)
    expect(new StartTokenCheck(second).accepts(first)).toBe(false)
    expect(parseStartToken(newStartToken())).toBeDefined()
  })

  it('reads the token file through C1\'s protected-file check and refuses a readable one', async () => {
    const token = await writeNewStartToken(home, PROFILE)
    const file = startTokenFile(home, PROFILE)
    expect(await readStartTokenFile(file)).toBe(token)
    chmodSync(file, 0o644)
    await expect(readStartTokenFile(file)).rejects.toMatchObject({ code: 'SECRET_FILE_MODE' })
  })

  it('refuses a token file that does not hold one token and one newline, without quoting it', async () => {
    const file = startTokenFile(home, PROFILE)
    writeFileSync(file, 'short-secret-value\n', { mode: 0o600 })
    await expect(readStartTokenFile(file)).rejects.toThrow(/does not hold one start token/)
    await expect(readStartTokenFile(file)).rejects.not.toThrow(/short-secret-value/)
    expect(parseStartToken('a'.repeat(43))).toBeDefined()
    expect(parseStartToken('a'.repeat(42))).toBeUndefined()
    expect(parseStartToken(`${'a'.repeat(42)}=`)).toBeUndefined()
  })

  it('removes the token file at a clean stop only while it holds this start\'s token', async () => {
    const first = await writeNewStartToken(home, PROFILE)
    const file = startTokenFile(home, PROFILE)
    const second = await writeNewStartToken(home, PROFILE)
    removeStartTokenFile(file, first)
    expect(await readStartTokenFile(file)).toBe(second)
    removeStartTokenFile(file, second)
    expect(existsSync(file)).toBe(false)
    removeStartTokenFile(file, second)
  })
})

describe('the home lock\'s handover', () => {
  const runtime = brandString<RuntimeVersion>('1.2.3')
  const probe = () => Promise.resolve('answered' as const)

  it('replaces the record with the successor\'s, after which the predecessor\'s release leaves it', async () => {
    const directory = runDirectory(home, PROFILE)
    const lock = await acquireHomeLock({ startId: newStartId(), runDirectory: directory, runtime, probe })
    const startId = brandString<StartId>('a'.repeat(32))
    const record = lock.handOver({ pid: process.pid, startId, runtime: brandString<RuntimeVersion>('1.2.4') })
    expect(readHomeLock(directory)).toEqual(record)
    lock.release()
    expect(readHomeLock(directory)?.startId).toBe(startId)
    expect(lstatSync(lock.path).mode & 0o777).toBe(0o600)
    const adopted = adoptHomeLock(directory, startId)
    adopted.release()
    expect(readHomeLock(directory)).toBeUndefined()
  })

  it('does not hand over a lock that no longer holds this holder\'s record, and adopts only a record handed to this process', async () => {
    const directory = runDirectory(home, PROFILE)
    const lock = await acquireHomeLock({ startId: newStartId(), runDirectory: directory, runtime, probe })
    lock.release()
    expect(() => lock.handOver({ pid: process.pid, startId: brandString<StartId>('b'.repeat(32)), runtime })).toThrow(/not handed over/)
    expect(() => adoptHomeLock(directory, brandString<StartId>('b'.repeat(32)))).toThrow(/was not handed/)
    const other = await acquireHomeLock({ startId: newStartId(), runDirectory: directory, runtime, probe })
    other.handOver({ pid: 1, startId: brandString<StartId>('c'.repeat(32)), runtime })
    expect(() => adoptHomeLock(directory, brandString<StartId>('c'.repeat(32)))).toThrow(/was not handed/)
  })
})

/** A refusal of the test channel. */
class Refused extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.code = code
  }
}

function refusal(code: string): ChannelRefusal {
  return { code, line: { ok: false, error: code } }
}

/**
 * Send raw bytes and collect every response line until the channel closes.
 * @param path - the socket.
 * @param bytes - what to send.
 * @returns the parsed lines.
 */
function exchange(path: string, bytes: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    let text = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => { text += chunk })
    socket.on('error', reject)
    socket.on('close', () => { resolve(text.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)) })
    socket.write(bytes)
  })
}

async function listen(token: StartToken, handle: (op: string, progress: (fields: Readonly<Record<string, unknown>>) => void) => Promise<Readonly<Record<string, unknown>>>): Promise<TokenSocket> {
  listener = await listenTokenSocket<{ readonly op: string }>({
    socketPath: join(runDirectory(home, PROFILE), 'test.sock'),
    check: new StartTokenCheck(token),
    logger: SILENT,
    limits: { requestMaxBytes: 256, maxConnections: 2, requestDeadlineMs: 1_000, firstByteMs: 500, refusalLogIntervalMs: 1_000 },
    decode: (value) => {
      const op = (value as { readonly op?: unknown }).op
      if (typeof op !== 'string') throw new Refused('SCHEMA_VIOLATION')
      return { op }
    },
    handle: async (request, progress) => handle(request.op, progress),
    refusalOf: error => (error instanceof Refused ? refusal(error.code) : undefined),
    refuse: kind => refusal(kind),
    describe: request => ({ op: request.op }),
  })
  return listener
}

describe('the token channel listener', () => {
  it('binds at mode 0600, checks the token before the schema, and sends progress lines before the final line', async () => {
    const token = newStartToken()
    const socket = await listen(token, async (op, progress) => {
      progress({ phase: 'one' })
      return Promise.resolve({ op })
    })
    expect(lstatSync(socket.socketPath).mode & 0o777).toBe(0o600)
    expect(await exchange(socket.socketPath, `${JSON.stringify({ token, op: 'x' })}\n`)).toEqual([{ ok: true, phase: 'one' }, { ok: true, op: 'x' }])
    expect(await exchange(socket.socketPath, `${JSON.stringify({ token: newStartToken(), op: 'x' })}\n`)).toEqual([{ ok: false, error: 'UNAUTHENTICATED' }])
    expect(await exchange(socket.socketPath, `${JSON.stringify({ op: 'x' })}\n`)).toEqual([{ ok: false, error: 'UNAUTHENTICATED' }])
    expect(await exchange(socket.socketPath, 'not json\n')).toEqual([{ ok: false, error: 'UNAUTHENTICATED' }])
    expect(await exchange(socket.socketPath, `${JSON.stringify({ token })}\n`)).toEqual([{ ok: false, error: 'SCHEMA_VIOLATION' }])
    expect(await exchange(socket.socketPath, `${JSON.stringify({ token, op: 'x'.repeat(256) })}\n`)).toEqual([{ ok: false, error: 'REQUEST_TOO_LARGE' }])
  })

  it('keeps running a request whose caller has gone, and frees that caller\'s connection at once', async () => {
    const token = newStartToken()
    const finishes: Array<() => void> = []
    const finished: Array<Promise<void>> = []
    let entered = Promise.withResolvers<void>()
    const socket = await listen(token, async (op) => {
      if (op === 'slow') {
        const release = Promise.withResolvers<void>()
        const done = Promise.withResolvers<void>()
        finishes.push(release.resolve)
        finished.push(done.promise)
        entered.resolve()
        await release.promise
        done.resolve()
      }
      return { op }
    })
    for (let index = 0; index < 2; index += 1) {
      entered = Promise.withResolvers<void>()
      const caller = connect(socket.socketPath)
      const closed = new Promise((resolve) => { caller.once('close', resolve) })
      caller.write(`${JSON.stringify({ token, op: 'slow' })}\n`)
      await entered.promise
      caller.destroy()
      await closed
    }
    // The listener sees each caller's close on its own side asynchronously; until then a new connection is BUSY.
    await expect.poll(async () => exchange(socket.socketPath, `${JSON.stringify({ token, op: 'fast' })}\n`)).toEqual([{ ok: true, op: 'fast' }])
    for (const finish of finishes) finish()
    await Promise.all(finished)
    expect(finished).toHaveLength(2)
  })

  it('replaces an earlier start\'s socket and removes only its own socket when it closes', async () => {
    const first = await listen(newStartToken(), async op => Promise.resolve({ op }))
    listener = undefined
    const token = newStartToken()
    const second = await listen(token, async op => Promise.resolve({ op }))
    await first.close()
    expect(existsSync(second.socketPath)).toBe(true)
    first.removeSocketSync()
    expect(await exchange(second.socketPath, `${JSON.stringify({ token, op: 'x' })}\n`)).toEqual([{ ok: true, op: 'x' }])
    second.removeSocketSync()
    expect(existsSync(second.socketPath)).toBe(false)
  })

  it('refuses a file other than a socket at its path and a path longer than C1\'s limit', async () => {
    writeFileSync(join(runDirectory(home, PROFILE), 'test.sock'), '')
    await expect(listen(newStartToken(), async op => Promise.resolve({ op }))).rejects.toThrow(/is not a socket/)
    listener = undefined
    await expect(listenTokenSocket({
      socketPath: join(base, 'x'.repeat(120)),
      check: new StartTokenCheck(newStartToken()),
      logger: SILENT,
      limits: { requestMaxBytes: 256, maxConnections: 2, requestDeadlineMs: 1_000, firstByteMs: 500, refusalLogIntervalMs: 1_000 },
      decode: () => ({}),
      handle: async () => Promise.resolve({}),
      refusalOf: () => undefined,
      refuse: kind => refusal(kind),
      describe: () => ({}),
    })).rejects.toMatchObject({ code: 'SOCKET_PATH_TOO_LONG' })
  })
})
