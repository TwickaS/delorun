/**
 * Stopping an update's successor that handed off to a composed tree (contract C19, "The update handshake"): the
 * successor runs in its own process group and the composed child stays in it, so stopping a successor that hangs at
 * boot ends the child too, not only the signed process the update started.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion, StartId } from '@delo/contract-home-layout'
import { startSuccessor, type HandoverLine, type Successor } from '@delo/home-process'

const REPOSITORY = join(import.meta.dirname, '../../../../..')
const SUCCESSOR = join(import.meta.dirname, '../fixtures/handed-off-successor.ts')
const HANDOVER: HandoverLine = {
  type: 'handover', v: 1, home: '/nonexistent', profile: 'default', from: brandString<RuntimeVersion>('1.0.0'), to: brandString<RuntimeVersion>('1.1.0'),
  startId: brandString<StartId>('0'.repeat(32)), health: { disabledPlugins: [], namedRows: [], previousFailures: [], previousRows: [] }, startedAt: '2026-11-11T00:00:00.000Z',
}

let directory: string
let server: Server
const pids: number[] = []
const successors: Successor[] = []

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'delo-successor-stop-'))
})

afterEach(async () => {
  for (const successor of successors.splice(0)) await successor.stop()
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (_gone) {
      // ESRCH: the process has already exited.
    }
  }
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  rmSync(directory, { recursive: true, force: true })
})

/**
 * Listen on a socket and hand over each connection with the first line it sends.
 * @param path - the socket's path.
 * @returns the connections, by the name they gave.
 */
function listen(path: string): Promise<Map<string, Socket>> {
  const connections = new Map<string, Socket>()
  return new Promise((resolve) => {
    server = createServer((socket) => {
      createInterface({ input: socket }).once('line', (line) => {
        const [name, pid] = line.split(' ')
        pids.push(Number(pid))
        connections.set(name!, socket)
        if (connections.size === 2) resolve(connections)
      })
    })
    server.listen(path)
  })
}

/**
 * @param socket - a connection.
 * @returns when the process at its other end has gone and the connection closed.
 */
function closed(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.closed) resolve()
    else socket.once('close', () => { resolve() })
    socket.on('error', () => {
      // ECONNRESET: the process at the other end was killed.
    })
  })
}

describe('stopping a successor that handed off', { timeout: 60_000 }, () => {
  it('a handed-off successor that hangs at boot is gone, parent and child, after stop()', async () => {
    const path = process.platform === 'win32' ? `\\\\.\\pipe\\delo-successor-stop-${String(process.pid)}` : join(directory, 'successor.sock')
    const connected = listen(path)
    const successor = startSuccessor({ command: process.execPath, args: ['--import', 'tsx/esm', SUCCESSOR, path], cwd: REPOSITORY }, HANDOVER, 60_000)
    successors.push(successor)
    const connections = await connected
    await successor.stop()
    const gone = Promise.all([closed(connections.get('parent')!), closed(connections.get('child')!)]).then(() => 'gone')
    expect(await Promise.race([gone, new Promise(resolve => { setTimeout(resolve, 10_000, 'still running') })])).toBe('gone')
  })

  it('a successor that could not be started fails and stops at once', async () => {
    server = createServer()
    const successor = startSuccessor({ command: join(directory, 'no-node'), args: [], cwd: directory }, HANDOVER, 60_000)
    expect(successor.pid).toBe(-1)
    expect(await successor.result).toEqual({ type: 'failed', reason: 'HEALTH_CHECK_FAILED' })
    await successor.stop()
  })
})
