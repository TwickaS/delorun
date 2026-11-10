import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXIT } from '../../src/exit.ts'
import { SetupCancelled } from '../../src/setup/prompts.ts'
import { fakeEnding, scriptedPrompter, type EndingLog, type Recording } from './support.ts'

vi.mock('../../src/start.ts', () => ({
  startDetached: vi.fn(() => Promise.resolve(0)),
  startForeground: vi.fn(() => Promise.resolve(undefined)),
}))

const { computerEnding, finishSetup, openerFor, pauseOneStep, spawnCommand, studioAddressFromLog, waitForAddress } = await import('../../src/setup/ending.ts')
const { startDetached, startForeground } = await import('../../src/start.ts')
const { surfaceFile } = await vi.importActual<typeof import('@delo/logs')>('@delo/logs').then(logs => ({ surfaceFile: (home: string, profile: string) => logs.resolveSurface({ kind: 'home', home, profile }).file }))

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'delorun-ending-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('the studio address', () => {
  it('is the last address the started process printed', () => {
    expect(studioAddressFromLog('')).toBeUndefined()
    expect(studioAddressFromLog('dsh web: http://127.0.0.1:3080/?a=1\nnoise\ndsh web: http://127.0.0.1:3081/?a=2\n')).toBe('http://127.0.0.1:3081/?a=2')
  })

  it('is waited for until the log holds it, and given up on after the attempts', async () => {
    let reads = 0
    const pauses = vi.fn(() => Promise.resolve())
    expect(await waitForAddress(() => (reads += 1) < 3 ? '' : 'dsh web: http://127.0.0.1:3080/', pauses)).toBe('http://127.0.0.1:3080/')
    expect(pauses).toHaveBeenCalledTimes(2)
    pauses.mockClear()
    expect(await waitForAddress(() => '', pauses)).toBeUndefined()
    expect(pauses).toHaveBeenCalledTimes(20)
  })
})

describe('the computer', () => {
  it('runs a command and reports its exit code, 127 when it cannot start', async () => {
    expect(await spawnCommand(process.execPath, ['-e', 'process.exit(3)'], 'ignore')).toBe(3)
    expect(await spawnCommand(process.execPath, ['-e', ''])).toBe(0)
    expect(await spawnCommand(join(directory, 'no-such-program'), [], 'ignore')).toBe(127)
    expect(await spawnCommand(process.execPath, ['-e', 'process.kill(process.pid, "SIGKILL")'], 'ignore')).toBe(127)
  })

  it('picks the opener of the platform, going through Windows from WSL', () => {
    expect(openerFor('darwin', {}, 'http://x/')).toEqual(['open', ['http://x/']])
    expect(openerFor('linux', {}, 'http://x/')).toEqual(['xdg-open', ['http://x/']])
    expect(openerFor('linux', { WSL_DISTRO_NAME: 'Ubuntu' }, 'http://x/')).toEqual(['cmd.exe', ['/c', 'start', '""', 'http://x/']])
    expect(openerFor('win32', {}, 'http://x/')).toEqual(['cmd.exe', ['/c', 'start', '""', 'http://x/']])
  })

  it('starts through the existing start entries: detached for the background, attached with the open choice otherwise', async () => {
    const output = { stdout: () => undefined, stderr: () => undefined }
    const ending = computerEnding(directory, 'work', output, {})
    expect(await ending.start('background', true)).toBe(EXIT.ok)
    expect(startDetached).toHaveBeenCalledWith(directory, 'work', output)
    expect(await ending.start('foreground', false)).toBeUndefined()
    expect(startForeground).toHaveBeenCalledWith({ home: directory, profile: 'work', open: false, output })
  })

  it('cannot open a browser from an SSH session, and reports the account and computer', () => {
    const output = { stdout: () => undefined, stderr: () => undefined }
    expect(computerEnding(directory, 'default', output, { SSH_CONNECTION: '1 2 3 4' }).canOpen()).toBe(false)
    expect(computerEnding(directory, 'default', output, { SSH_TTY: '/dev/pts/1' }).canOpen()).toBe(false)
    expect(typeof computerEnding(directory, 'default', output, { SSH_TTY: '' }).canOpen()).toBe('boolean')
    const identity = computerEnding(directory, 'default', output, {}).identity()
    expect(identity.user).not.toBe('')
    expect(identity.host).not.toBe('')
  })

  it('opens the address through the platform opener and installs through the same runner', async () => {
    const output = { stdout: () => undefined, stderr: () => undefined }
    const run = vi.fn(() => Promise.resolve(0))
    const ending = computerEnding(directory, 'default', output, { WSL_DISTRO_NAME: 'Ubuntu' }, run)
    expect(await ending.open('http://127.0.0.1:1/')).toBe(true)
    expect(run).toHaveBeenLastCalledWith(...(process.platform === 'darwin' ? ['open', ['http://127.0.0.1:1/'], 'ignore'] : ['cmd.exe', ['/c', 'start', '""', 'http://127.0.0.1:1/'], 'ignore']))
    run.mockResolvedValueOnce(1)
    expect(await ending.open('http://127.0.0.1:1/')).toBe(false)
    expect(await ending.spawn('npm', ['install', '-g', 'delorun'])).toBe(0)
    expect(run).toHaveBeenLastCalledWith('npm', ['install', '-g', 'delorun'])
  })

  it('reads the address from the home log of the profile', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    const output = { stdout: () => undefined, stderr: () => undefined }
    const ending = computerEnding(directory, 'default', output, {})
    const file = surfaceFile(directory, 'default')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'booting\ndsh web: http://127.0.0.1:3090/?t=1\n')
    expect(await ending.address()).toBe('http://127.0.0.1:3090/?t=1')
  })
})

describe('finishing a run', () => {
  const output = { stdout: () => undefined, stderr: () => undefined }

  it('waits one step with a timer', async () => {
    const started = Date.now()
    await pauseOneStep()
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
  })

  it('reads the log of a profile that has none yet as no address, waiting through every attempt', async () => {
    const pause = vi.fn(() => Promise.resolve())
    expect(await computerEnding(directory, 'fresh', output, {}, undefined, pause).address()).toBeUndefined()
    expect(pause).toHaveBeenCalledTimes(20)
  })

  it('asks whether a browser can open from an empty environment', () => {
    expect(typeof computerEnding(directory, 'default', output, {}).canOpen()).toBe('boolean')
  })

  it('passes on a failure of the install question that is not a cancellation', async () => {
    const recording: Recording = { screen: [], asked: [] }
    const log: EndingLog = { spawned: [], started: [], opened: [] }
    const prompter = { ...scriptedPrompter([], recording), confirm: () => Promise.reject(new Error('terminal closed')) }
    await expect(finishSetup(prompter, fakeEnding(log), { profile: 'default', background: true, output })).rejects.toThrow('terminal closed')
    const cancelled = { ...prompter, confirm: () => Promise.reject(new SetupCancelled()) }
    expect(await finishSetup(cancelled, fakeEnding(log), { profile: 'default', background: true, output })).toBe(EXIT.ok)
  })

  it('names port 80 in the SSH line when the address has no port', async () => {
    const recording: Recording = { screen: [], asked: [] }
    const log: EndingLog = { spawned: [], started: [], opened: [] }
    const lines: string[] = []
    const prompter = scriptedPrompter([false], recording)
    await finishSetup(prompter, fakeEnding(log, { canOpen: false, address: 'http://studio.example/' }), { profile: 'default', background: true, output: { stdout: text => void lines.push(text), stderr: () => undefined } })
    expect(lines.join('')).toContain('ssh -L 80:127.0.0.1:80 person@machine')
  })
})
