import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { writeNewStartToken } from '@delorun/home'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { HomeLockRecord, RuntimeVersion, StartId } from '@delorun/contract-home-layout'
import { afterEach, describe, expect, it } from 'vitest'
import { updateChannelProbe, updateSocketPath } from '../src/index.ts'
import { PROFILE, tempHome, type TempHome } from './support.ts'

const RECORD = { v: 1, pid: 1, startId: brandString<StartId>('a'.repeat(32)), runtime: brandString<RuntimeVersion>('1.0.0'), startedAt: '2026-01-01T00:00:00.000Z' } satisfies HomeLockRecord

let temp: TempHome | undefined

afterEach(() => {
  temp?.remove()
  temp = undefined
})

/**
 * Leave a socket file at a path with no process listening on it, as a killed home process does.
 * @param path - the socket path.
 */
async function leaveDeadSocket(path: string): Promise<void> {
  const child = spawn(process.execPath, ['-e', 'const s = require("node:net").createServer().listen(process.argv[1], () => { console.log("up") }); setInterval(() => {}, 1000)', path], { stdio: ['ignore', 'pipe', 'inherit'] })
  await once(child.stdout, 'data')
  child.kill('SIGKILL')
  await once(child, 'exit')
}

describe('the update channel probe', () => {
  it('reads a socket file that refuses the connection as refused, and a missing one as silent', async () => {
    temp = await tempHome()
    await writeNewStartToken(temp.home, PROFILE)
    const probe = updateChannelProbe(temp.home, PROFILE)
    expect(await probe(RECORD)).toBe('silent')
    await leaveDeadSocket(updateSocketPath(temp.home, PROFILE))
    expect(existsSync(updateSocketPath(temp.home, PROFILE))).toBe(true)
    expect(await probe(RECORD)).toBe('refused')
  })
})
