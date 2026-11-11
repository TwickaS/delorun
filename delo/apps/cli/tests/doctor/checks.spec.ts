import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkDocker, checkHome, checkKey, checkPort, dockerProbeEnvironment, resolveStudioPort, runDockerVersion, STUDIO_DEFAULT_PORT, type DockerProbe } from '../../src/doctor/checks.ts'
import { parsePort } from '../../src/doctor/index.ts'
import { CliError, EXIT } from '../../src/exit.ts'
import { ANSWERING_DOCKER, closeServer, FAILING_DOCKER, GOOD_KEY, leaksPartOf, listenOnEphemeralPort, POSIX } from './fixtures.ts'

let base: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'doctor-checks-')))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(base, { recursive: true, force: true })
})

describe('dockerProbeEnvironment', () => {
  it('keeps the program search path and the Docker selectors, and drops every other variable', () => {
    const probe = dockerProbeEnvironment({ PATH: '/bin', DOCKER_HOST: 'unix:///run/docker.sock', DELO_SECRET_CANARY: 'canary', AWS_SECRET_ACCESS_KEY: 'x' })
    expect(probe).toEqual({ PATH: '/bin', DOCKER_HOST: 'unix:///run/docker.sock' })
  })
})

describe('checkKey', { timeout: 60_000 }, () => {
  it('warns when no key is set, whether the variable is absent or empty', () => {
    for (const key of [undefined, '']) {
      const result = checkKey(key)
      expect(result.status).toBe('warn')
      expect(result.message).toContain('no DeepSeek API key is set; the model cannot answer.')
    }
  })

  it('passes a key in the expected format, and says the key was not sent', () => {
    const result = checkKey(GOOD_KEY)
    expect(result).toEqual({
      name: 'key',
      status: 'pass',
      message: 'the DeepSeek API key is set and has the expected format (format only; the key was not sent to DeepSeek).',
    })
  })

  it.each([
    ['whitespace inside the key', 'sk-fixture0123456789 abcdefghij'],
    ['a trailing newline', 'sk-fixture0123456789abcdef\n'],
    ['a control character that is not whitespace', 'sk-fixture0123456789\u0007abcdef'],
    ['fewer than 20 characters', 'sk-short1234'],
    ['a prefix other than sk-', 'pk-fixture0123456789abcdef'],
  ])('fails a key with %s, and its message contains no part of the key', (_, key) => {
    const result = checkKey(key)
    expect(result).toEqual({
      name: 'key',
      status: 'fail',
      message: 'the DeepSeek API key is malformed; check it at the key page (format only; the key was not sent to DeepSeek).',
    })
    expect(leaksPartOf(result.message, key)).toBe(false)
  })

  it('checks the key of the provider setup chose, by that provider\'s name and variable, without DeepSeek\'s prefix rule', () => {
    const anthropic = { label: 'Anthropic', variable: 'ANTHROPIC_API_KEY', deepseek: false }
    expect(checkKey(undefined, anthropic)).toEqual({ name: 'key', status: 'warn', message: 'no Anthropic API key is set; the model cannot answer. Set ANTHROPIC_API_KEY, or run delorun setup key to store one (format only; the key was not sent to Anthropic).' })
    expect(checkKey('pk-fixture0123456789abcdef', anthropic).status).toBe('pass')
    const spaced = 'pk-fixture0123456789 abcdefghij'
    const failed = checkKey(spaced, anthropic)
    expect(failed).toEqual({ name: 'key', status: 'fail', message: 'the Anthropic API key is malformed; check it at the key page (format only; the key was not sent to Anthropic).' })
    expect(leaksPartOf(failed.message, spaced)).toBe(false)
  })
})

describe('checkDocker', () => {
  it('warns that Docker is not installed, and says native workspaces are unaffected', async () => {
    const probe: DockerProbe = { kind: 'missing' }
    expect(await checkDocker(() => Promise.resolve(probe))).toEqual({
      name: 'docker',
      status: 'warn',
      message: 'Docker is not installed; the Docker shapes stay unavailable, and native workspaces are unaffected.',
    })
  })

  it('warns, with the start-Docker message, when the engine does not answer', async () => {
    const result = await checkDocker(() => Promise.resolve({ kind: 'unanswered' }))
    expect(result.status).toBe('warn')
    expect(result.message).toBe('Docker is installed, but its engine does not answer; start Docker, then run delorun doctor again.')
  })

  it('passes an answering engine and names its server version', async () => {
    expect(await checkDocker(() => Promise.resolve({ kind: 'answered', serverVersion: '27.3.1' }))).toEqual({
      name: 'docker',
      status: 'pass',
      message: 'the Docker engine answers; its server version is 27.3.1.',
    })
  })
})

describe.runIf(POSIX)('runDockerVersion', { timeout: 60_000 }, () => {
  let fakeBin: string
  let emptyBin: string

  beforeEach(() => {
    fakeBin = join(base, 'fake-bin')
    emptyBin = join(base, 'empty-bin')
    mkdirSync(fakeBin)
    mkdirSync(emptyBin)
  })

  /**
   * Write a fake `docker` program into the fake binary directory.
   * @param body - the script after its shebang.
   */
  function fakeDocker(body: string): void {
    writeFileSync(join(fakeBin, 'docker'), `#!/bin/sh\n${body}`, { mode: 0o755 })
  }

  it('reports a missing program when no docker is on the search path', async () => {
    vi.stubEnv('PATH', emptyBin)
    expect(await runDockerVersion(dockerProbeEnvironment(process.env))).toEqual({ kind: 'missing' })
  })

  it('reports an engine that exits non-zero as unanswered', async () => {
    fakeDocker(FAILING_DOCKER)
    vi.stubEnv('PATH', fakeBin)
    expect(await runDockerVersion(dockerProbeEnvironment(process.env))).toEqual({ kind: 'unanswered' })
  })

  it('reads the server version of an answering engine with the exact probe command', async () => {
    fakeDocker(ANSWERING_DOCKER)
    vi.stubEnv('PATH', fakeBin)
    expect(await runDockerVersion(dockerProbeEnvironment(process.env))).toEqual({ kind: 'answered', serverVersion: '27.3.1' })
  })

  it('gives the engine program the passed environment and nothing else', async () => {
    const dump = join(base, 'child-environment')
    fakeDocker(`env > '${dump}'\n${ANSWERING_DOCKER}`)
    vi.stubEnv('PATH', `${fakeBin}:/usr/bin:/bin`)
    vi.stubEnv('HOME', '/home/fixture')
    vi.stubEnv('DOCKER_HOST', 'unix:///run/fixture.sock')
    vi.stubEnv('XDG_RUNTIME_DIR', '/run/user/fixture')
    vi.stubEnv('DEEPSEEK_API_KEY', GOOD_KEY)
    vi.stubEnv('DELO_GIT_TOKEN', 'fixture-git-token-not-a-secret')
    vi.stubEnv('DELO_HOME', join(base, 'delo'))
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'fixture-aws-value-not-a-secret')
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    expect(await runDockerVersion(dockerProbeEnvironment(process.env))).toEqual({ kind: 'answered', serverVersion: '27.3.1' })
    const seen = Object.fromEntries(readFileSync(dump, 'utf8').split('\n').filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
    // The shell the fake program runs in adds its own bookkeeping names.
    for (const shellName of ['PWD', 'OLDPWD', 'SHLVL', '_']) delete seen[shellName]
    expect(seen).toEqual({ PATH: `${fakeBin}:/usr/bin:/bin`, HOME: '/home/fixture', DOCKER_HOST: 'unix:///run/fixture.sock', XDG_RUNTIME_DIR: '/run/user/fixture' })
  })

  it.each([
    ['a shell command after the version', `27.3.1; touch __MARKER__`],
    ['a command substitution', `27.3.1$(touch __MARKER__)`],
    ['an escape sequence', '27.3.1\\033[31m'],
    ['a second line', '27.3.1\\nCONTAINERS: 4'],
    ['a version that is 65 characters long', `1${'a'.repeat(64)}`],
    ['text that does not start with a digit', 'v27.3.1'],
  ])('reports an engine that prints %s as unanswered, and runs nothing it printed', async (_label, printed) => {
    const marker = join(base, 'marker')
    fakeDocker(`printf '${printed.replace('__MARKER__', marker)}\\n'\n`)
    vi.stubEnv('PATH', `${fakeBin}:/usr/bin:/bin`)
    expect(await runDockerVersion(dockerProbeEnvironment(process.env))).toEqual({ kind: 'unanswered' })
    expect(existsSync(marker)).toBe(false)
  })

  it('reports an engine whose output exceeds the read limit as unanswered', async () => {
    fakeDocker('printf 1\nhead -c 3000000 /dev/zero | tr "\\0" a\n')
    vi.stubEnv('PATH', `${fakeBin}:/usr/bin:/bin`)
    expect(await runDockerVersion(dockerProbeEnvironment(process.env))).toEqual({ kind: 'unanswered' })
  })

  it('stops a probe that hangs at its timeout and reports the engine as unanswered', async () => {
    // `exec` replaces the shell, so the timeout's signal reaches the process that holds the output pipe.
    fakeDocker('exec sleep 10\n')
    vi.stubEnv('PATH', fakeBin)
    const started = Date.now()
    expect(await runDockerVersion(dockerProbeEnvironment(process.env), 300)).toEqual({ kind: 'unanswered' })
    expect(Date.now() - started).toBeLessThan(4000)
  })
})

describe('resolveStudioPort', () => {
  it('takes --port first, then the profile\'s studio port, then upstream\'s default when the profile sets none', () => {
    expect(resolveStudioPort(4100, 4200, 'default')).toEqual({ port: 4100, source: 'option', profile: 'default' })
    expect(resolveStudioPort(undefined, 4200, 'work')).toEqual({ port: 4200, source: 'profile', profile: 'work' })
    expect(resolveStudioPort(undefined, undefined, 'default')).toEqual({ port: STUDIO_DEFAULT_PORT, source: 'default', profile: 'default' })
    expect(STUDIO_DEFAULT_PORT).toBe(3080)
  })
})

describe('checkPort', () => {
  const notRunning = (): Promise<undefined> => Promise.resolve(undefined)

  it('fails a --port another process holds, and the message names it', async () => {
    const { server, port } = await listenOnEphemeralPort()
    try {
      expect(await checkPort(resolveStudioPort(port, undefined, 'default'), notRunning)).toEqual({
        name: 'port',
        status: 'fail',
        message: `port ${String(port)} is in use; stop the other process or pass --port`,
      })
    } finally {
      await closeServer(server)
    }
  })

  it('fails the profile\'s studio port when another process holds it, and names the setup section that changes it', async () => {
    const { server, port } = await listenOnEphemeralPort()
    try {
      const ownStudio = vi.fn(() => Promise.resolve(port + 1))
      expect(await checkPort(resolveStudioPort(undefined, port, 'work'), ownStudio)).toEqual({
        name: 'port',
        status: 'fail',
        message: `port ${String(port)} on 127.0.0.1, the studio port of the profile work, is in use by another process, so the studio cannot listen on it; stop that process, or choose another port with delorun setup profile --profile work`,
      })
      expect(ownStudio).toHaveBeenCalledTimes(1)
      expect((await checkPort(resolveStudioPort(undefined, port, 'default'), notRunning)).message).toMatch(/choose another port with delorun setup profile$/u)
    } finally {
      await closeServer(server)
    }
  })

  it('passes a port this home\'s own studio holds, and says Delo holds it', async () => {
    const { server, port } = await listenOnEphemeralPort()
    try {
      expect(await checkPort(resolveStudioPort(undefined, port, 'default'), () => Promise.resolve(port))).toEqual({
        name: 'port',
        status: 'pass',
        message: `port ${String(port)} on 127.0.0.1, the studio port of the profile default, is in use by Delo's studio, which runs for the profile default.`,
      })
    } finally {
      await closeServer(server)
    }
  })

  it('refuses a port source it does not know', () => {
    expect(() => checkPort({ port: 1, source: 'other' as never, profile: 'default' }, notRunning)).toThrow('unhandled case: "other"')
  })

  it('passes a free port without asking the home process, and the port can be bound again afterwards', async () => {
    const { server, port } = await listenOnEphemeralPort()
    await closeServer(server)
    const ownStudio = vi.fn(notRunning)
    expect(await checkPort(resolveStudioPort(port, undefined, 'default'), ownStudio)).toEqual({ name: 'port', status: 'pass', message: `port ${String(port)} on 127.0.0.1 is free.` })
    expect(await checkPort({ port, source: 'default', profile: 'default' }, ownStudio)).toEqual({ name: 'port', status: 'pass', message: `port ${String(port)} on 127.0.0.1, the studio's default port, which the profile default does not change, is free.` })
    expect(ownStudio).not.toHaveBeenCalled()
    const again = await listenOnEphemeralPort()
    await closeServer(again.server)
  })
})

describe('parsePort', () => {
  it('accepts integers from 1 to 65535', () => {
    expect(parsePort('1')).toBe(1)
    expect(parsePort('65535')).toBe(65535)
    expect(parsePort('03080')).toBe(3080)
  })

  it.each(['0', '65536', '-1', '3080.5', 'abc', '', ' 3080', '99999999999999999999'])('refuses %j with the usage code', (text) => {
    let thrown: unknown
    try {
      parsePort(text)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).exit).toBe(EXIT.usage)
  })
})

describe('checkHome', { timeout: 60_000 }, () => {
  it('passes a private home and creates nothing in it', async () => {
    const home = join(base, 'delo')
    mkdirSync(home, { mode: 0o700 })
    const result = await checkHome({ DELO_HOME: home }, 'default')
    expect(result).toMatchObject({ name: 'home', status: 'pass' })
    expect(readdirSync(home)).toEqual([])
  })

  it('warns for a home that does not exist yet, and creates nothing', async () => {
    const home = join(base, 'absent')
    const result = await checkHome({ DELO_HOME: home }, 'default')
    expect(result.status).toBe('warn')
    expect(result.message).toContain(`the Delo home at ${home} does not exist yet; delorun setup creates it at mode 0700.`)
    expect(existsSync(home)).toBe(false)
  })

  it.runIf(POSIX)('fails a laxer home, with the chmod 700 fix', async () => {
    const home = join(base, 'delo')
    mkdirSync(home, { mode: 0o700 })
    chmodSync(home, 0o755)
    const result = await checkHome({ DELO_HOME: home }, 'default')
    expect(result.status).toBe('fail')
    expect(result.message).toContain(`${home} has mode 0755`)
    expect(result.message).toContain(`chmod 700 ${home}`)
  })

  it.runIf(POSIX)('fails a home that is a symbolic link', async () => {
    const real = join(base, 'real')
    const link = join(base, 'link')
    mkdirSync(real, { mode: 0o700 })
    symlinkSync(real, link)
    const result = await checkHome({ DELO_HOME: link }, 'default')
    expect(result.status).toBe('fail')
    expect(result.message).toContain('is a symbolic link')
  })

  it('fails a home that is a file', async () => {
    const file = join(base, 'delo')
    writeFileSync(file, '')
    const result = await checkHome({ DELO_HOME: file }, 'default')
    expect(result.status).toBe('fail')
    expect(result.message).toContain('is not a directory')
  })

  it.runIf(POSIX)('fails a laxer secrets directory and a laxer run directory of the profile', async () => {
    const home = join(base, 'delo')
    mkdirSync(join(home, 'secrets'), { recursive: true, mode: 0o700 })
    mkdirSync(join(home, 'run', 'default'), { recursive: true, mode: 0o700 })
    chmodSync(join(home, 'secrets'), 0o755)
    const secrets = await checkHome({ DELO_HOME: home }, 'default')
    expect(secrets.status).toBe('fail')
    expect(secrets.message).toContain(`chmod 700 ${join(home, 'secrets')}`)
    chmodSync(join(home, 'secrets'), 0o700)
    chmodSync(join(home, 'run', 'default'), 0o755)
    const run = await checkHome({ DELO_HOME: home }, 'default')
    expect(run.status).toBe('fail')
    expect(run.message).toContain(`chmod 700 ${join(home, 'run', 'default')}`)
  })

  it('fails a relative home without examining the disk', async () => {
    const result = await checkHome({ DELO_HOME: 'relative/delo' }, 'default')
    expect(result.status).toBe('fail')
    expect(result.message).toContain('HOME_INVALID')
  })

  it('fails a home inside upstream\'s ~/.dsh, which Delo never touches', async () => {
    const result = await checkHome({ DELO_HOME: join(homedir(), '.dsh', 'delo') }, 'default')
    expect(result.status).toBe('fail')
    expect(result.message).toContain('HOME_IS_DSH_HOME')
  })
})
