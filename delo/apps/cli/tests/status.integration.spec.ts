/** `delorun status` against a real update channel: the home process's answer, the studio's address and the open hint. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newStartId, runDirectory } from '@delo/home'
import { queryHomeStatus } from '@delo/home-process'
import { EXIT } from '../src/exit.ts'
import { OPEN_HINT, statusCommand, studioAddress } from '../src/status.ts'
import { startRunningHome, type RunningHome } from './fixtures/running-home.ts'

vi.mock('@delo/home-process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delo/home-process')>()
  return { ...actual, queryHomeStatus: vi.fn(actual.queryHomeStatus) }
})

const PROFILE = 'default'

let osHome: string
let home: string
let running: RunningHome | undefined

beforeEach(() => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-status-')))
  home = join(osHome, '.delo')
  running = undefined
})

afterEach(async () => {
  await running?.stop()
  rmSync(osHome, { recursive: true, force: true })
})

/**
 * Run `delorun status` in this process.
 * @param args - the arguments after `status`.
 * @returns its exit code and output.
 */
async function status(args: readonly string[] = []): Promise<{ code: number | undefined, stdout: string, stderr: string }> {
  let stdout = ''
  let stderr = ''
  const code = await statusCommand.run(args, {
    env: { HOME: osHome, USERPROFILE: osHome, DELO_HOME: home },
    stdout: (text) => { stdout += text },
    stderr: (text) => { stderr += text },
  })
  return { code: code ?? undefined, stdout, stderr }
}

/**
 * Write a home lock record that names a process.
 * @param pid - the process id the record names.
 */
function writeLock(pid: number): void {
  const directory = runDirectory(home, PROFILE)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(join(directory, 'home.lock'), JSON.stringify({ v: 1, pid, startId: newStartId(), runtime: '0.0.0-fixture', startedAt: new Date().toISOString() }))
}

describe('the studio address', () => {
  it('keeps the scheme, host, port and path, and drops any query, fragment and credentials', () => {
    expect(studioAddress('http://127.0.0.1:4123/')?.href).toBe('http://127.0.0.1:4123/')
    const credentials = ['user', 'secret'].join(':')
    expect(studioAddress(`https://${credentials}@127.0.0.1:4123/studio/?token=abc#t=1`)?.href).toBe('https://127.0.0.1:4123/studio/')
  })

  it('reads no address from an answer without one, a text that is not a URL, or a URL that is not http or https', () => {
    expect(studioAddress(undefined)).toBeUndefined()
    expect(studioAddress('not a url')).toBeUndefined()
    expect(studioAddress('file:///tmp/studio')).toBeUndefined()
  })
})

describe('delorun status', { timeout: 30_000 }, () => {
  it('prints the studio\'s address and the open hint, and no token', async () => {
    running = await startRunningHome(home, PROFILE, 'http://127.0.0.1:4123/?token=fixture-token-value')
    const result = await status()
    expect(result.code).toBe(EXIT.ok)
    expect(result.stdout).toContain('state: running\n')
    expect(result.stdout).toContain(`studio: http://127.0.0.1:4123/\n${OPEN_HINT}\n`)
    expect(OPEN_HINT).toBe('Run delorun open to open the studio in your browser.')
    expect(result.stdout).not.toContain('fixture-token-value')
    expect(result.stdout).not.toContain('token')
  })

  it('prints no studio line or hint while the Host serves no studio', async () => {
    running = await startRunningHome(home, PROFILE, undefined)
    const result = await status()
    expect(result.code).toBe(EXIT.ok)
    expect(result.stdout).toContain('chats: 0\n')
    expect(result.stdout).not.toContain('studio:')
    expect(result.stdout).not.toContain(OPEN_HINT)
  })

  it('prints the status answer alone with --json, as before', async () => {
    running = await startRunningHome(home, PROFILE, 'http://127.0.0.1:4123/')
    const result = await status(['--json'])
    expect(result.code).toBe(EXIT.ok)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, status: { state: 'running', studio: 'http://127.0.0.1:4123/' } })
    expect(result.stdout).not.toContain(OPEN_HINT)
  })

  it('reports no home process, with and without --json, and a lock its exited holder left', async () => {
    expect(await status()).toMatchObject({ code: EXIT.notRunning, stdout: expect.stringContaining('state: not running\n') as string })
    expect(await status(['--json'])).toMatchObject({ code: EXIT.notRunning, stdout: '{"ok":false,"state":"not-running"}\n' })
    const exited = spawnSync(process.execPath, ['-e', ''], { timeout: 30_000 })
    writeLock(exited.pid as number)
    expect((await status()).stdout).toContain(`a lock left by process ${String(exited.pid)}, which has exited`)
  })

  it('fails when the lock holder lives but its update channel does not answer', async () => {
    writeLock(process.pid)
    const result = await status()
    expect(result.code).toBe(EXIT.failed)
    expect(result.stderr).toContain(`process ${String(process.pid)} holds the profile's lock but its update channel did not answer`)
  })

  it('names a failure that is not an Error by its text', async () => {
    writeLock(process.pid)
    vi.mocked(queryHomeStatus).mockRejectedValueOnce('the channel closed')
    expect((await status()).stderr).toContain('its update channel did not answer: the channel closed')
  })

  it('fails when the home process refuses the request', async () => {
    writeLock(process.pid)
    vi.mocked(queryHomeStatus).mockResolvedValueOnce({ ok: false, error: 'UNAUTHENTICATED' })
    const result = await status()
    expect(result.code).toBe(EXIT.failed)
    expect(result.stderr).toContain('the home process refused the request: UNAUTHENTICATED')
  })

  it('prints the previous runtime and the update in progress beside the studio', async () => {
    writeLock(process.pid)
    vi.mocked(queryHomeStatus).mockResolvedValueOnce({
      state: 'running', pid: process.pid, startId: newStartId(),
      runtime: { current: '1.1.0', previous: '1.0.0', running: '1.0.0' }, chats: 2,
      studio: 'http://127.0.0.1:4123/', update: { phase: 'waiting', target: '1.1.0' },
    } as Awaited<ReturnType<typeof queryHomeStatus>>)
    const result = await status()
    expect(result.code).toBe(EXIT.ok)
    expect(result.stdout).toContain('runtime: 1.0.0 (current 1.1.0, previous 1.0.0)\nchats: 2\nupdate: waiting to 1.1.0\nstudio: http://127.0.0.1:4123/\n')
  })

  it('names an inherited DSH_HOME that it ignores', async () => {
    let stdout = ''
    await statusCommand.run([], { env: { HOME: osHome, DELO_HOME: home, DSH_HOME: join(osHome, 'elsewhere') }, stdout: (text) => { stdout += text }, stderr: () => {} })
    expect(stdout).toContain(`DSH_HOME is set to ${join(osHome, 'elsewhere')}; delorun ignores it`)
  })
})
