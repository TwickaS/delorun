/**
 * The doctor checks' reports of failures the host cannot be made to produce on demand: a bind that fails for a reason
 * other than a port in use, a home that fails to resolve or examine for an unexpected reason, Windows, and a probe
 * result no branch knows. The listener and the home's examination are stubbed.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { checkPrivateDirectory, resolveDelorunHome } from '@delorun/home'
import { checkDocker, checkHome, checkPort } from '../../src/doctor/checks.ts'
import { doctorCommand } from '../../src/doctor/index.ts'

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>()
  return { ...actual, createServer: vi.fn(actual.createServer) }
})

vi.mock('@delorun/home', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delorun/home')>()
  return { ...actual, checkPrivateDirectory: vi.fn(actual.checkPrivateDirectory), resolveDelorunHome: vi.fn(actual.resolveDelorunHome) }
})

/** A home that resolves without examining the disk. */
const RESOLVED = { path: '/fixture/.delorun' }

/**
 * A listener whose bind fails with an error.
 * @param error - the error its `listen` reports.
 * @returns the listener.
 */
function failingServer(error: Error): Server {
  const emitter = new EventEmitter()
  const server = Object.assign(emitter, { listen: () => { queueMicrotask(() => { emitter.emit('error', error) }) } })
  return server as never
}

describe('checkPort when the bind fails', () => {
  it('names the error code and suggests another port, without asking the home process', async () => {
    vi.mocked(createServer).mockImplementationOnce(() => failingServer(Object.assign(new Error('permission denied'), { code: 'EACCES' })))
    const ownStudio = vi.fn(() => Promise.resolve(80))
    expect(await checkPort({ port: 80, source: 'option', profile: 'default' }, ownStudio)).toEqual({
      name: 'port',
      status: 'fail',
      message: 'port 80 on 127.0.0.1 cannot be bound (EACCES); pass --port with another port',
    })
    expect(ownStudio).not.toHaveBeenCalled()
  })

  it('says the error is unknown when it carries no code', async () => {
    vi.mocked(createServer).mockImplementationOnce(() => failingServer(new Error('no code')))
    expect((await checkPort({ port: 4100, source: 'profile', profile: 'work' }, () => Promise.resolve(undefined))).message)
      .toBe('port 4100 on 127.0.0.1, the studio port of the profile work, cannot be bound (unknown error); pass --port with another port')
  })
})

describe('checkHome when the home fails unexpectedly', () => {
  it('passes on an error resolving the home that is not a refusal', async () => {
    vi.mocked(resolveDelorunHome).mockRejectedValueOnce(new Error('the disk is gone'))
    await expect(checkHome({}, 'default')).rejects.toThrow('the disk is gone')
  })

  it('passes on an error examining a directory that is neither missing nor refused', async () => {
    vi.mocked(resolveDelorunHome).mockResolvedValueOnce(RESOLVED)
    vi.mocked(checkPrivateDirectory).mockRejectedValueOnce(Object.assign(new Error('input/output error'), { code: 'EIO' }))
    await expect(checkHome({}, 'default')).rejects.toThrow('input/output error')
  })

  it('warns on Windows that Delorun does not check file permissions', async () => {
    vi.mocked(resolveDelorunHome).mockResolvedValueOnce(RESOLVED)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      expect(await checkHome({}, 'default')).toEqual({ name: 'home', status: 'warn', message: 'the Delorun home at /fixture/.delorun resolves; Delorun does not check Windows file permissions, so who can read it is not verified.' })
    } finally {
      Object.defineProperty(process, 'platform', platform as PropertyDescriptor)
    }
  })
})

describe('checkDocker', () => {
  it('refuses a probe result it does not know', async () => {
    await expect(checkDocker(() => Promise.resolve({ kind: 'other' } as never))).rejects.toThrow('unhandled case: {"kind":"other"}')
  })
})

describe('delorun doctor when a check throws something other than an Error', () => {
  it('prints the thrown value as that check\'s failure line and runs the other checks', async () => {
    // The key check sets the launch variables on this process.
    for (const name of ['DSH_HOME', 'DELORUN_HOME', 'DELORUN_PROFILE']) vi.stubEnv(name, undefined)
    // Only the first home resolution is stubbed: the later checks resolve the home from HOME, so a scratch account home
    // keeps them off the real account's ~/.delorun.
    const osHome = mkdtempSync(join(tmpdir(), 'delorun-doctor-non-error-'))
    vi.stubEnv('HOME', osHome)
    vi.stubEnv('USERPROFILE', osHome)
    vi.mocked(resolveDelorunHome).mockRejectedValueOnce('the home is a text')
    let printed = ''
    try {
      await doctorCommand.run(['--port', '1'], { env: { PATH: '/nonexistent', HOME: osHome }, stdout: (text) => { printed += text }, stderr: (text) => { printed += text } })
    } finally {
      vi.unstubAllEnvs()
      rmSync(osHome, { recursive: true, force: true })
    }
    expect(printed).toContain('✗ home: the check could not complete: the home is a text\n')
    expect(printed).toMatch(/ port: /u)
  })
})
