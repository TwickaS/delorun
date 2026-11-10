import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXIT } from '../../src/exit.ts'
import { SetupCancelled } from '../../src/setup/prompts.ts'
import { resolveSurface } from '@delo/logs'
import type { StudioOpener } from '../../src/open/studio.ts'
import { fakeEnding, scriptedPrompter, type EndingLog, type Recording } from './support.ts'

vi.mock('../../src/start.ts', () => ({
  startDetached: vi.fn(() => Promise.resolve(0)),
  startForeground: vi.fn(() => Promise.resolve(undefined)),
}))

const { computerEnding, finishSetup, studioAddress } = await import('../../src/setup/ending.ts')
const { startDetached, startForeground } = await import('../../src/start.ts')

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'delorun-ending-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

/** An opener that records what it was asked and opens nothing. */
function recordingOpener(canOpen: boolean, opens = true): StudioOpener & { readonly opened: string[] } {
  const opened: string[] = []
  return {
    opened,
    canOpen: () => canOpen,
    link: () => Promise.resolve({ kind: 'link', link: { url: 'http://127.0.0.1:1/?token=one-time', oneTime: true } }),
    open: (url) => {
      opened.push(url)
      return Promise.resolve(opens)
    },
  }
}

describe('the computer', () => {
  const output = { stdout: () => undefined, stderr: () => undefined }

  it('starts through the existing start entries without opening the studio there', async () => {
    const opener = recordingOpener(true)
    const launched = { DELO_FIXTURE: 'launch' }
    const ending = computerEnding(directory, 'work', output, launched, undefined, opener)
    expect(await ending.start('background')).toBe(EXIT.ok)
    expect(startDetached).toHaveBeenCalledWith(directory, 'work', output, false, opener)
    expect(await ending.start('foreground')).toBeUndefined()
    expect(startForeground).toHaveBeenCalledWith({ home: directory, profile: 'work', open: false, output, env: launched })
  })

  it('opens a fresh link from the home process through the opener, and reports when no browser took it', async () => {
    const opener = recordingOpener(true)
    expect(await computerEnding(directory, 'default', output, {}, undefined, opener).open()).toBe(true)
    expect(opener.opened).toEqual(['http://127.0.0.1:1/?token=one-time'])
    expect(await computerEnding(directory, 'default', output, {}, undefined, recordingOpener(true, false)).open()).toBe(false)
    expect(await computerEnding(directory, 'default', output, {}, undefined, recordingOpener(false)).open()).toBe(false)
  })

  it('asks the opener whether a browser can open, installs through the runner and reports the account and computer', async () => {
    const run = vi.fn(() => Promise.resolve(0))
    expect(computerEnding(directory, 'default', output, { SSH_CONNECTION: '1 2 3 4' }, run).canOpen()).toBe(false)
    expect(computerEnding(directory, 'default', output, {}, run, recordingOpener(true)).canOpen()).toBe(true)
    expect(await computerEnding(directory, 'default', output, {}, run).spawn('npm', ['install', '-g', 'delorun'])).toBe(0)
    expect(run).toHaveBeenLastCalledWith('npm', ['install', '-g', 'delorun'])
    const identity = computerEnding(directory, 'default', output, {}).identity()
    expect(identity.user).not.toBe('')
    expect(identity.host).not.toBe('')
  })

  it('reads no address while no home process answers, and never from the log', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    const file = resolveSurface({ kind: 'home', home: directory, profile: 'default' }).file
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'booting\ndsh web: http://127.0.0.1:3090/?token=from-the-log\n')
    expect(await studioAddress(directory, 'default')).toBeUndefined()
    expect(await computerEnding(directory, 'default', output, {}).address()).toBeUndefined()
  })
})

describe('finishing a run', () => {
  const output = { stdout: () => undefined, stderr: () => undefined }

  it('passes on a failure of the install question that is not a cancellation', async () => {
    const recording: Recording = { screen: [], asked: [] }
    const log: EndingLog = { spawned: [], started: [], opened: 0 }
    const prompter = { ...scriptedPrompter([], recording), confirm: () => Promise.reject(new Error('terminal closed')) }
    await expect(finishSetup(prompter, fakeEnding(log), { profile: 'default', background: true, output })).rejects.toThrow('terminal closed')
    const cancelled = { ...prompter, confirm: () => Promise.reject(new SetupCancelled()) }
    expect(await finishSetup(cancelled, fakeEnding(log), { profile: 'default', background: true, output })).toBe(EXIT.ok)
  })

  it('names port 80 in the SSH line when the address has no port', async () => {
    const recording: Recording = { screen: [], asked: [] }
    const log: EndingLog = { spawned: [], started: [], opened: 0 }
    const lines: string[] = []
    const prompter = scriptedPrompter([false], recording)
    await finishSetup(prompter, fakeEnding(log, { canOpen: false, address: 'http://studio.example/' }), { profile: 'default', background: true, output: { stdout: text => void lines.push(text), stderr: () => undefined } })
    expect(lines.join('')).toContain('ssh -L 80:127.0.0.1:80 person@machine')
  })
})
