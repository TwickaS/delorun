import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { environmentOverlay, GateProcess, programSpawnRequest, spawnThroughGate, watchedArgv, watcherPath } from '../src/process.ts'
import { assertTestedSdk, TESTED_SDK_VERSION } from '../src/sdk.ts'
import type { ProgramSpawnRequest } from '../src/pending-contract.ts'

function fakeHandle() {
  const outcome = Promise.withResolvers<SubprocessOutcome>()
  let terminations = 0
  const handle = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: undefined,
    done: outcome.promise,
    terminate: () => { terminations += 1 },
    waitForExit: () => Promise.resolve(true),
  } as Partial<SubprocessHandle> as SubprocessHandle
  return { handle, outcome, terminations: () => terminations }
}

describe('the program process', () => {
  it('starts the program under the watcher on POSIX and directly on Windows', () => {
    expect(watchedArgv(['/pack/claude', '--x'], 'linux', '/pkg/watcher.mjs')).toEqual([process.execPath, '/pkg/watcher.mjs', '/pack/claude', '--x'])
    expect(watchedArgv(['/pack/claude', '--x'], 'darwin', '/pkg/watcher.mjs')).toEqual([process.execPath, '/pkg/watcher.mjs', '/pack/claude', '--x'])
    expect(watchedArgv(['C:\\pack\\claude.exe'], 'win32', '')).toEqual(['C:\\pack\\claude.exe'])
  })

  it('ships the watcher as plain JavaScript inside the package', () => {
    const path = watcherPath()
    expect(path).toMatch(/agent-claude-code[\\/]src[\\/]watcher\.mjs$/)
    expect(readFileSync(path, 'utf8')).toContain("process.stdin.on('end'")
  })

  it('passes the SDK\'s environment and removes the base names the SDK removed, adding no credential', () => {
    expect(environmentOverlay({ PATH: '/bin', MCP_TOOL_TIMEOUT: '900000' }, { PATH: '/usr/bin', HOME: '/home/p', LANG: 'C' }))
      .toEqual({ PATH: '/bin', MCP_TOOL_TIMEOUT: '900000', HOME: undefined, LANG: undefined })
    const request = programSpawnRequest({ command: '/pack/claude', args: ['-p'], cwd: '/tmp/task', env: { PATH: '/bin' }, signal: new AbortController().signal }, 'linux', '/w.mjs')
    expect(Object.keys(request.env).filter(name => /KEY|TOKEN|SECRET|PASSWORD/.test(name) && request.env[name] !== undefined)).toEqual([])
    expect(request.stdio).toEqual({ stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    expect(request).not.toHaveProperty('cwd')
  })

  it('shows the gate\'s handle to the SDK: streams pass through, kill asks the gate once, exit is reported', async () => {
    const { handle, outcome, terminations } = fakeHandle()
    const requests: ProgramSpawnRequest[] = []
    const process = spawnThroughGate((request) => { requests.push(request); return handle }, 'win32')({ command: 'claude.exe', args: [], cwd: 'C:\\task', env: {}, signal: new AbortController().signal })
    expect(requests).toHaveLength(1)
    expect(process.stdin).toBe(handle.stdin)
    const exited = new Promise<[number | null, string | null]>((resolve) => { process.once('exit', (code: number | null, signal: NodeJS.Signals | null) => { resolve([code, signal]) }) })
    expect(process.kill('SIGTERM')).toBe(true)
    expect(process.kill('SIGTERM')).toBe(false)
    expect(process.killed).toBe(true)
    expect(terminations()).toBe(1)
    outcome.resolve({ exitCode: null, signal: 'SIGTERM' } as SubprocessOutcome)
    expect(await exited).toEqual([null, 'SIGTERM'])
    expect(process.exitCode).toBeNull()
    expect(process.signalCode).toBe('SIGTERM')
  })

  it('drains the program\'s standard error without keeping it', () => {
    const { handle } = fakeHandle()
    const stderr = new PassThrough()
    new GateProcess({ ...handle, stderr })
    expect(stderr.readableFlowing).toBe(true)
  })

  it('refuses a handle without piped standard input and output', () => {
    const { handle } = fakeHandle()
    expect(() => new GateProcess({ ...handle, stdin: undefined })).toThrow('piped')
  })
})

describe('the pinned SDK', () => {
  it('is the version upstream\'s Claude Code package pins, for both the types and the tested version', () => {
    const upstream = JSON.parse(readFileSync(new URL('../../../../packages/subagent/subagent-claude-code/package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> }
    const own = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { devDependencies: Record<string, string> }
    expect(own.devDependencies['@anthropic-ai/claude-agent-sdk']).toBe(upstream.dependencies['@anthropic-ai/claude-agent-sdk'])
    expect(TESTED_SDK_VERSION).toBe(upstream.dependencies['@anthropic-ai/claude-agent-sdk'])
  })

  it('refuses an SDK whose version was not tested', () => {
    expect(() => { assertTestedSdk({ entry: '/x/sdk.mjs', version: TESTED_SDK_VERSION }) }).not.toThrow()
    expect(() => { assertTestedSdk({ entry: '/x/sdk.mjs', version: '0.3.264' }) }).toThrow(expect.objectContaining({ code: 'sdk-version' }))
  })
})
