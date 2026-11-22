import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawned = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawned.spawn }))

const {
  WSL_TIMEOUTS_MS, WslHomeError, acceptLink, delorunArgs, findLoginShell, listDistros, parseDistroList, parseHomeStatus, parseLoginShell,
  readHomeStatus, readSignInLink, requireListedDistro, runWsl, selectLauncher,
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
    expect(run).toHaveBeenCalledWith(['-d', 'Ubuntu', '--exec', 'delorun', 'status', '--json', '--profile', 'work'], WSL_TIMEOUTS_MS.status)
  })

  it('starts delorun with --exec, so no Linux shell parses the arguments', async () => {
    const run = vi.fn().mockResolvedValue(answer(status('0.1.0')))
    await readHomeStatus('Ubuntu', 'work', run)
    const args = run.mock.calls[0]![0] as string[]
    expect(args.slice(0, 4)).toEqual(['-d', 'Ubuntu', '--exec', 'delorun'])
    expect(args).not.toContain('--')
  })

  it('requires the distribution to be listed by its exact name', async () => {
    const listed = vi.fn().mockResolvedValue({ code: 0, stdout: utf16('Ubuntu\r\nDebian\r\n') })
    await expect(requireListedDistro('Ubuntu', listed)).resolves.toBeUndefined()
    for (const name of ['ubuntu', 'Ubuntu ', 'Ubun', 'Ubuntu\r\nDebian', 'Ubuntu"', 'Fedora']) {
      await expect(requireListedDistro(name, listed), name).rejects.toMatchObject({ code: 'distro-missing', detail: { distro: name } })
    }
    expect(listed).toHaveBeenCalledWith(['-l', '-q'], WSL_TIMEOUTS_MS.list)
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
    expect(run).toHaveBeenCalledWith(['-d', 'Ubuntu', '--exec', 'delorun', 'open', '--print', '--profile', 'default'], WSL_TIMEOUTS_MS.link)
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
    const result = runWsl(['-d', 'Ubuntu', '--exec', 'delorun', 'status'], 1000)
    process.stdout.emit('data', Buffer.from('a'))
    process.stdout.emit('data', Buffer.from('b'))
    process.emit('close', 0)
    expect(await result).toEqual({ code: 0, stdout: Buffer.from('ab') })
    expect(spawned.spawn).toHaveBeenCalledWith('wsl.exe', ['-d', 'Ubuntu', '--exec', 'delorun', 'status'], expect.objectContaining({ windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }))
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

  it('rejects on its own timer when a child keeps its output pipe open after the kill, so the window never waits on a close that does not come', async () => {
    const process = child()
    const failure = runWsl(['-d', 'Ubuntu', '--exec', 'delorun', 'status'], 1000).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1000)
    expect(process.kill).toHaveBeenCalledWith('SIGKILL')
    // No 'close' event is emitted: the call must already have settled.
    expect(await failure).toMatchObject({ code: 'wsl-timeout' })
    process.stdout.emit('data', Buffer.from('late'))
    process.emit('close', null)
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

describe('the login shell fallback', () => {
  const BASH = { kind: 'login-shell', shell: { path: '/bin/bash', flavour: 'posix' } } as const
  const FISH = { kind: 'login-shell', shell: { path: '/usr/bin/fish', flavour: 'fish' } } as const

  it.each([
    ['alice:x:1000:1000:Alice,,,:/home/alice:/bin/bash', { path: '/bin/bash', flavour: 'posix' }],
    ['alice:x:1000:1000::/home/alice:/usr/bin/zsh', { path: '/usr/bin/zsh', flavour: 'posix' }],
    ['alice:x:1000:1000::/home/alice:/bin/sh\n', { path: '/bin/sh', flavour: 'posix' }],
    ['alice:x:1000:1000::/home/alice:/usr/local/bin/fish', { path: '/usr/local/bin/fish', flavour: 'fish' }],
  ])('accepts the login shell in %j', (entry, shell) => {
    expect(parseLoginShell(entry, 'alice')).toEqual(shell)
  })

  it.each([
    ['a shell outside the list', 'alice:x:1000:1000::/home/alice:/usr/sbin/nologin'],
    ['a shell that exits', 'alice:x:1000:1000::/home/alice:/bin/false'],
    ['a program the person owns', 'alice:x:1000:1000::/home/alice:/home/alice/bin/bash'],
    ['a temporary program', 'alice:x:1000:1000::/home/alice:/tmp/bash'],
    ['a path that climbs out of a listed one', 'alice:x:1000:1000::/home/alice:/bin/../tmp/bash'],
    ['a shell with arguments', 'alice:x:1000:1000::/home/alice:/bin/bash -x'],
    ['a shell followed by a command', 'alice:x:1000:1000::/home/alice:/bin/bash;rm'],
    ['a relative shell', 'alice:x:1000:1000::/home/alice:bash'],
    ['a name that only ends like a listed shell', 'alice:x:1000:1000::/home/alice:/bin/notbash'],
    ['an entry with too few fields', 'alice:x:1000'],
    ['an entry for another account', 'mallory:x:1001:1001::/home/mallory:/bin/bash'],
    ['an empty entry', ''],
  ])('refuses %s', (_name, entry) => {
    expect(parseLoginShell(entry, 'alice')).toBeUndefined()
  })

  it('finds the shell with `id` and `getent` started by --exec, never through a shell', async () => {
    const run = vi.fn(async (args: readonly string[]) => args.includes('id')
      ? answer('alice\n') : answer('alice:x:1000:1000::/home/alice:/bin/bash\n'))
    expect(await findLoginShell('Ubuntu', run)).toEqual({ path: '/bin/bash', flavour: 'posix' })
    expect(run.mock.calls.map(call => call[0])).toEqual([
      ['-d', 'Ubuntu', '--exec', 'id', '-un'], ['-d', 'Ubuntu', '--exec', 'getent', 'passwd', 'alice'],
    ])
    expect(run.mock.calls.every(call => call[1] === WSL_TIMEOUTS_MS.shell)).toBe(true)
  })

  it.each(['al ice', '$(id)', 'alice;x', '-n', 'Alice', '', 'a'.repeat(40), 'alice\nmallory'])('never asks about the account name %j', async (name) => {
    const run = vi.fn(async () => answer(`${name}\n`))
    expect(await findLoginShell('Ubuntu', run)).toBeUndefined()
    expect(run).toHaveBeenCalledOnce()
  })

  it('runs a hostile login shell never: an entry outside the list gives no shell to run', async () => {
    const run = vi.fn(async (args: readonly string[]) => args.includes('id') ? answer('alice\n') : answer('alice:x:1:1::/home/alice:/tmp/evil\n'))
    expect(await findLoginShell('Ubuntu', run)).toBeUndefined()
  })

  it('starts the shell with a fixed script and the arguments as positional parameters, so nothing is parsed', () => {
    expect(delorunArgs('Ubuntu', 'work', ['open', '--print'], BASH)).toEqual([
      '-d', 'Ubuntu', '--exec', '/bin/bash', '-l', '-i', '-c', 'exec delorun $@', 'delorun', 'open', '--print', '--profile', 'work',
    ])
    expect(delorunArgs('Ubuntu', 'work', ['status', '--json'], FISH)).toEqual([
      '-d', 'Ubuntu', '--exec', '/usr/bin/fish', '-l', '-i', '-c', 'exec delorun $argv', 'status', '--json', '--profile', 'work',
    ])
  })

  it.each(['work', 'default', 'a-b_c9'])('puts nothing but plain words after the script, for the profile %s', (profile) => {
    for (const launcher of [BASH, FISH]) {
      const args = delorunArgs('Ubuntu', profile, ['status', '--json'], launcher)
      const script = args.indexOf('-c') + 1
      expect(args[script]).toMatch(/^exec delorun \$(@|argv)$/u)
      expect(args[script]).not.toMatch(/["'`;&|<>\\(){}]/u)
      for (const word of args.slice(script + 1)) expect(word).toMatch(/^[A-Za-z0-9._-]+$/u)
      expect(args).not.toContain('--')
    }
  })

  it('selects the direct start when it works, and asks no shell anything', async () => {
    const run = vi.fn().mockResolvedValue(answer(status('0.1.0')))
    expect(await selectLauncher('Ubuntu', 'default', run)).toMatchObject({ launcher: { kind: 'direct' }, status: { state: 'running' } })
    expect(run).toHaveBeenCalledOnce()
  })

  it('falls back to the login shell when the direct start finds no delorun, and ignores the noise the shell start-up prints', async () => {
    const noisy = `Welcome to the distribution\nnvm is ready\n${status('0.1.0')}\n`
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes('id')) return answer('alice\n')
      if (args.includes('getent')) return answer('alice:x:1000:1000::/home/alice:/bin/bash\n')
      return args[2] === '--exec' && args[3] === 'delorun' ? answer('', 127) : answer(noisy)
    })
    const chosen = await selectLauncher('Ubuntu', 'default', run)
    expect(chosen.launcher).toEqual({ kind: 'login-shell', shell: { path: '/bin/bash', flavour: 'posix' } })
    expect(chosen.status).toMatchObject({ state: 'running', version: '0.1.0' })
  })

  it('reports delorun-missing when neither start finds delorun, and the direct error when the account has no accepted shell', async () => {
    const missing = vi.fn(async (args: readonly string[]) => {
      if (args.includes('id')) return answer('alice\n')
      if (args.includes('getent')) return answer('alice:x:1000:1000::/home/alice:/bin/bash\n')
      return answer('', 127)
    })
    await expect(selectLauncher('Ubuntu', 'default', missing)).rejects.toMatchObject({ code: 'delorun-missing' })
    const noShell = vi.fn(async (args: readonly string[]) => {
      if (args.includes('id')) return answer('alice\n')
      if (args.includes('getent')) return answer('alice:x:1000:1000::/home/alice:/usr/sbin/nologin\n')
      return answer('', 127)
    })
    await expect(selectLauncher('Ubuntu', 'default', noShell)).rejects.toMatchObject({ code: 'delorun-missing' })
    expect(noShell.mock.calls.some(call => (call[0] as string[]).includes('-c'))).toBe(false)
  })

  it('does not fall back for a timeout or a missing distribution', async () => {
    const stuck = vi.fn().mockRejectedValue(new WslHomeError('wsl-timeout'))
    await expect(selectLauncher('Ubuntu', 'default', stuck)).rejects.toMatchObject({ code: 'wsl-timeout' })
    expect(stuck).toHaveBeenCalledOnce()
  })

  it('reads the link as the last line that is a link for the studio, ignoring what a start-up file prints', async () => {
    const decoy = 'http://127.0.0.1:18999/?token=SECRET-DECOY'
    const text = `Last login: today\n${decoy}\n${LINK}\nThis link signs in to the studio once.\nexport PATH ready\n`
    const run = vi.fn().mockResolvedValue(answer(text))
    expect(await readSignInLink('Ubuntu', 'default', STUDIO, run, BASH)).toBe(LINK)
    expect(run.mock.calls[0]![0]).toEqual([
      '-d', 'Ubuntu', '--exec', '/bin/bash', '-l', '-i', '-c', 'exec delorun $@', 'delorun', 'open', '--print', '--profile', 'default',
    ])
    const onlyNoise = vi.fn().mockResolvedValue(answer(`motd\n${decoy}\n`))
    await expect(readSignInLink('Ubuntu', 'default', STUDIO, onlyNoise, BASH)).rejects.toMatchObject({ code: 'link-unusable' })
  })
})
