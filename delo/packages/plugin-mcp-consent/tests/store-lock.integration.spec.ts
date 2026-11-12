/**
 * Specs of the acceptance store's lock across processes: the store is shared by every profile of the home, so a revoke
 * in one profile's process waits while another process holds the store's lock and then reads that process's change,
 * and neither change overwrites the other.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Context } from '@deepseek-ai/cordis'
import type { McpServerCommand } from '@deepseek-ai/dsh-mcp-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeloMcpConsent } from '../src/index.ts'
import { acceptanceStorePath, parseAcceptanceStore } from '../src/store.ts'

const REPOSITORY = join(import.meta.dirname, '../../../..')
const WRITER = join(import.meta.dirname, 'fixtures/store-writer.ts')

let root: string
let child: ChildProcess | undefined

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'delo-mcp-store-lock-')))
  mkdirSync(join(root, 'home'))
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin', 'tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  vi.stubEnv('DELO_HOME', join(root, 'home'))
})

afterEach(() => {
  child?.kill()
  child = undefined
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

/**
 * The next line a child prints.
 * @param lines - the child's output lines.
 * @returns the line.
 */
async function nextLine(lines: AsyncIterator<string>): Promise<string> {
  const { value, done } = await lines.next()
  if (done === true) throw new Error('the store writer exited without a line')
  return value
}

describe('the acceptance store lock', () => {
  it('keeps a revoke in one process from overwriting an acceptance another process writes, and the reverse', async () => {
    const consent = new DeloMcpConsent(new Context())
    const start: McpServerCommand = { serverName: 'srv', command: 'tool', args: [], env: {}, cwd: '', resolvedCommand: join(root, 'bin', 'tool'), resolvedCwd: root }
    await consent.accept(start)
    const [listed] = await consent.accepted()
    const path = acceptanceStorePath(join(root, 'home'))

    child = spawn(process.execPath, ['--import', 'tsx/esm', WRITER, path], { cwd: REPOSITORY, stdio: ['pipe', 'pipe', 'inherit'] })
    const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]()
    expect(await nextLine(lines)).toBe('held')

    let settled = false
    const revoking = consent.revokeAcceptance(listed?.acceptanceId ?? '', true).finally(() => { settled = true })
    // While the other process holds the lock, the revoke neither reads nor writes the store.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(settled).toBe(false)
    child.stdin!.write('go\n')
    expect(await nextLine(lines)).toBe('done')
    await expect(revoking).resolves.toEqual({ stopped: 0 })

    const store = parseAcceptanceStore(readFileSync(path, 'utf8'))
    expect([...store.acceptances.keys()]).toEqual(['other'])
    expect(store.setAside.get('srv')?.state).toBe('revoked')
  }, 60_000)
})
