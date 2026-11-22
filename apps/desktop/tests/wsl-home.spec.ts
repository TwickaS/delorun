import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawned = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawned.spawn }))

const {
  WSL_TIMEOUTS_MS, WslHomeError, acceptLink, listDistros, parseDistroList, parseHomeStatus, readHomeStatus, readSignInLink, runWsl,
} = await import('../src/wsl-home.ts')

const LINK = 'http://127.0.0.1:18601/?token=SECRET-ONE-TIME'
const STUDIO = 'http://127.0.0.1:18601/'

/** `wsl.exe -l -q` prints UTF-16LE with a byte-order mark. */
function utf16(text: string, bom = true): Buffer {
  return Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(text, 'utf16le')])
}
const answer = (stdout: string, code = 0) => ({ code, stdout: Buffer.from(stdout, 'utf8') })
const status = (running: string, studio = STUDIO) => JSON.stringify({ ok: true, status: { state: 'ready', pid: 1, runtime: { current: running, running }, chats: 0, studio } })

describe('distribution discovery', () => {
  it('reads UTF-16 output, with or without a byte-order mark, and drops Docker Desktop distributions and blanks', () => {
    expect(parseDistroList(utf16('Ubuntu-24.04\r\ndocker-desktop\r\nDebian\r\n\r\ndocker-desktop-data\r\n'))).toEqual(['Ubuntu-24.04', 'Debian'])
    expect(parseDistroList(utf16('Ubuntu\r\n', false))).toEqual(['Ubuntu'])
    expect(parseDistroList(Buffer.alloc(0))).toEqual([])
  })

  it('skips names that could be read as options', () => {
    expect(parseDistroList(utf16('--shutdown\r\nUbuntu\r\n'))).toEqual(['Ubuntu'])
  })

  it('asks wsl.exe for the quiet list with the list deadline, and returns nothing when it fails', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: utf16('Ubuntu\r\n') })
    expect(await listDistros(run)).toEqual(['Ubuntu'])
    expect(run).toHaveBeenCalledWith(['-l', '-q'], WSL_TIMEOUTS_MS.list)
    expect(await listDistros(vi.fn().mockResolvedValue({ code: 1, stdout: Buffer.alloc(0) }))).toEqual([])
  })
})

describe('home status', () => {
  it('reads a running home and a stopped one', () => {
    expect(parseHomeStatus(status('0.1.0-preview.4'))).toEqual({ state: 'running', version: '0.1.0-preview.4', studio: STUDIO })
    expect(parseHomeStatus('{"ok":false,"state":"not-running"}\n')).toEqual({ state: 'not-running' })
  })

  it.each(['', 'bash: delorun: command not found', '{"ok":true}', '{"ok":true,"status":{"runtime":{}}}', '{"ok":false,"state":"other"}', '[]'])('does not read %j', (text) => {
    expect(parseHomeStatus(text)).toBeUndefined()
  })

  it('runs `delorun status --json` in the named distribution and profile, with the status deadline', async () => {
    const run = vi.fn().mockResolvedValue(answer(status('0.1.0')))
    expect(await readHomeStatus('Ubuntu', 'work', run)).toMatchObject({ state: 'running' })
    expect(run).toHaveBeenCalledWith(['-d', 'Ubuntu', '--', 'delorun', 'status', '--json', '--profile', 'work'], WSL_TIMEOUTS_MS.status)
  })

  it('names the step that failed', async () => {
    await expect(readHomeStatus('Ubuntu', 'default', vi.fn().mockResolvedValue(answer('', 127)))).rejects.toMatchObject({ code: 'delorun-missing' })
    const listed = vi.fn().mockResolvedValueOnce(answer('garbage', 1)).mockResolvedValueOnce({ code: 0, stdout: utf16('Ubuntu\r\n') })
    await expect(readHomeStatus('Ubuntu', 'default', listed)).rejects.toMatchObject({ code: 'status-unreadable' })
    const absent = vi.fn().mockResolvedValueOnce(answer('', 1)).mockResolvedValueOnce({ code: 0, stdout: utf16('Debian\r\n') })
    await expect(readHomeStatus('Ubuntu', 'default', absent)).rejects.toMatchObject({ code: 'distro-missing', detail: { distro: 'Ubuntu' } })
  })
})

describe('one-time sign-in link', () => {
  it('accepts only a tokened http link for the studio origin on 127.0.0.1', () => {
    expect(acceptLink(`${LINK}\n`, STUDIO)).toBe(LINK)
    for (const bad of ['http://127.0.0.1:18602/?token=x', 'http://localhost:18601/?token=x', 'https://127.0.0.1:18601/?token=x',
      'http://127.0.0.1:18601/', 'http://u:p@127.0.0.1:18601/?token=x', 'http://evil.example/?token=x', 'not a url', '']) {
      expect(acceptLink(bad, STUDIO), bad).toBeUndefined()
    }
  })

  it('reads the link from stdout; the command line carries no token', async () => {
    const run = vi.fn().mockResolvedValue(answer(`${LINK}\nThis link signs in to the studio once.\n`))
    expect(await readSignInLink('Ubuntu', 'default', STUDIO, run)).toBe(LINK)
    expect(run).toHaveBeenCalledWith(['-d', 'Ubuntu', '--', 'delorun', 'open', '--print', '--profile', 'default'], WSL_TIMEOUTS_MS.link)
    expect(JSON.stringify(run.mock.calls)).not.toContain('SECRET')
  })

  it('refuses without echoing what the command printed', async () => {
    const attempts = [
      { run: answer(LINK, 3), code: 'home-not-running' },
      { run: answer(LINK, 1), code: 'link-refused' },
      { run: answer('http://127.0.0.1:18999/?token=SECRET-OTHER-PORT\n', 0), code: 'link-unusable' },
    ] as const
    for (const attempt of attempts) {
      const failure = await readSignInLink('Ubuntu', 'default', STUDIO, vi.fn().mockResolvedValue(attempt.run)).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(WslHomeError)
      expect((failure as InstanceType<typeof WslHomeError>).code).toBe(attempt.code)
      expect(JSON.stringify([(failure as Error).message, (failure as InstanceType<typeof WslHomeError>).detail])).not.toContain('SECRET')
    }
  })
})

describe('running wsl.exe', () => {
  /** A child process that the spec drives. */
  function child() {
    const stdout = new EventEmitter()
    const process = Object.assign(new EventEmitter(), { stdout, kill: vi.fn() })
    spawned.spawn.mockReturnValue(process)
    return process
  }
  beforeEach(() => { vi.useFakeTimers(); spawned.spawn.mockReset() })
  afterEach(() => { vi.useRealTimers() })

  it('starts wsl.exe without a shell, passes every argument separately and returns the output', async () => {
    const process = child()
    const result = runWsl(['-d', 'Ubuntu', '--', 'delorun', 'status'], 1000)
    process.stdout.emit('data', Buffer.from('a'))
    process.stdout.emit('data', Buffer.from('b'))
    process.emit('close', 0)
    expect(await result).toEqual({ code: 0, stdout: Buffer.from('ab') })
    expect(spawned.spawn).toHaveBeenCalledWith('wsl.exe', ['-d', 'Ubuntu', '--', 'delorun', 'status'], expect.objectContaining({ windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }))
    expect(spawned.spawn.mock.calls[0]?.[2]).not.toHaveProperty('shell')
  })

  it('kills a call that does not finish in time and reports it, so a hung WSL never freezes the window', async () => {
    const process = child()
    const result = runWsl(['-l', '-q'], 1000)
    const failure = result.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1000)
    expect(process.kill).toHaveBeenCalledWith('SIGKILL')
    process.emit('close', null)
    expect(await failure).toMatchObject({ code: 'wsl-timeout' })
  })

  it('kills a call whose output is too long, and reports wsl.exe that cannot start', async () => {
    const process = child()
    const long = runWsl(['-l', '-q'], 1000).catch((error: unknown) => error)
    process.stdout.emit('data', Buffer.alloc(1024 * 1024 + 1))
    process.emit('close', null)
    expect(await long).toMatchObject({ code: 'wsl-timeout' })
    const missing = child()
    const start = runWsl(['-l'], 1000).catch((error: unknown) => error)
    missing.emit('error', new Error('spawn wsl.exe ENOENT'))
    expect(await start).toMatchObject({ code: 'wsl-unavailable' })
  })
})
