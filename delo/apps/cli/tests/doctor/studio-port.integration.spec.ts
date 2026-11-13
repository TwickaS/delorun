/**
 * `delorun doctor`'s port check in this process: the port the profile's studio uses, upstream's default when the
 * profile sets none, and a port held by this home's own home process, by another process or by nothing.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SETUP_DEFAULTS } from '@delo/contract-setup-answers'
import { newStartId, runDirectory } from '@delo/home'
import { queryHomeStatus } from '@delo/home-process'
import { doctorCommand, homeStudioPort } from '../../src/doctor/index.ts'
import { EXIT } from '../../src/exit.ts'
import { profileDirectory } from '../../src/profile.ts'
import { profileSection } from '../../src/setup/sections.ts'
import { startRunningHome, type RunningHome } from '../fixtures/running-home.ts'
import { closeServer, GOOD_KEY, listenOnEphemeralPort, usableBwrap } from './fixtures.ts'

vi.mock('@delo/home-process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delo/home-process')>()
  return { ...actual, queryHomeStatus: vi.fn(actual.queryHomeStatus) }
})

const PROFILE = 'default'

let osHome: string
let home: string
let emptyBin: string
let running: RunningHome | undefined
let cwd: string

beforeEach(() => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-doctor-port-')))
  home = join(osHome, '.delo')
  mkdirSync(home, { mode: 0o700 })
  emptyBin = join(osHome, 'empty-bin')
  mkdirSync(emptyBin)
  usableBwrap(emptyBin)
  running = undefined
  // The key check loads the invoking directory's `.env`; the OS home has none.
  cwd = process.cwd()
  process.chdir(osHome)
  // The key check sets the launch variables on this process.
  for (const name of ['DSH_HOME', 'DELO_HOME', 'DELO_PROFILE', 'DEEPSEEK_API_KEY']) vi.stubEnv(name, undefined)
})

afterEach(async () => {
  await running?.stop()
  process.chdir(cwd)
  vi.unstubAllEnvs()
  rmSync(osHome, { recursive: true, force: true })
})

/**
 * Write the profile's studio port the way setup's profile section writes it.
 * @param port - the port.
 */
async function setStudioPort(port: number): Promise<void> {
  const directory = profileDirectory(home, PROFILE)
  mkdirSync(directory, { recursive: true })
  await profileSection.apply({ home, env: {}, directory, secret: undefined }, { ...SETUP_DEFAULTS, profile: { name: null, port } })
}

/**
 * Run `delorun doctor` in this process with no Docker and no key.
 * @param args - the arguments after `doctor`.
 * @returns its exit code and its port line.
 */
async function doctor(args: readonly string[] = []): Promise<{ code: number | undefined, port: string }> {
  const { code, printed } = await doctorOutput(args)
  return { code, port: printed.split('\n').find(line => / port: /u.test(line)) ?? '' }
}

/**
 * Run `delorun doctor` in this process with no Docker.
 * @param args - the arguments after `doctor`.
 * @returns its exit code and everything it printed.
 */
async function doctorOutput(args: readonly string[]): Promise<{ code: number | undefined, printed: string }> {
  let printed = ''
  const code = await doctorCommand.run(args, {
    env: { HOME: osHome, USERPROFILE: osHome, DELO_HOME: home, PATH: emptyBin },
    stdout: (text) => { printed += text },
    stderr: (text) => { printed += text },
  })
  return { code: code ?? undefined, printed }
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

describe('the port delorun doctor checks', { timeout: 30_000 }, () => {
  it('reads the studio port the profile sets, without --port', async () => {
    const { server, port } = await listenOnEphemeralPort()
    await closeServer(server)
    await setStudioPort(port)
    expect(await doctor()).toEqual({ code: EXIT.ok, port: `pass port: port ${String(port)} on 127.0.0.1, the studio port of the profile default, is free.` })
  })

  it('passes a profile port of 0, which each start chooses, without binding anything', async () => {
    const directory = profileDirectory(home, PROFILE)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'cordis.patch.yml'), '- id: webserver\n  config:\n    port: 0\n')
    expect(await doctor()).toEqual({ code: EXIT.ok, port: 'pass port: the studio port of the profile default is 0, so each start takes a free port the system chooses; `delorun status` shows the address.' })
  })

  it('prints no YAML warning for a profile patch that holds a `!!js` expression', async () => {
    const directory = profileDirectory(home, PROFILE)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'cordis.patch.yml'), '- id: webserver\n  config:\n    host: !!js ctx.webStartup.host\n    port: 0\n')
    const warnings: string[] = []
    const onWarning = (warning: Error): void => { warnings.push(warning.message) }
    process.on('warning', onWarning)
    try {
      const { code, printed } = await doctorOutput([])
      // Node emits a process warning on the next tick.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(code).toBe(EXIT.ok)
      expect(printed).not.toContain('YAMLWarning')
      expect(warnings.filter(message => message.includes('Unresolved tag'))).toEqual([])
    } finally {
      process.off('warning', onWarning)
    }
  })

  it('checks upstream\'s default port when the profile sets none', async () => {
    const result = await doctor()
    expect(result.port).toMatch(/^(?:pass|fail) port: port 3080 on 127\.0\.0\.1, the studio's default port, which the profile default does not change, is /u)
  })

  it('checks --port instead of the profile\'s port', async () => {
    await setStudioPort(4100)
    const { server, port } = await listenOnEphemeralPort()
    await closeServer(server)
    expect(await doctor(['--port', String(port)])).toEqual({ code: EXIT.ok, port: `pass port: port ${String(port)} on 127.0.0.1 is free.` })
  })

  it('passes the port while this home\'s own studio holds it, and says Delo holds it', async () => {
    const { server, port } = await listenOnEphemeralPort()
    try {
      await setStudioPort(port)
      running = await startRunningHome(home, PROFILE, `http://127.0.0.1:${String(port)}/`)
      expect(await doctor()).toEqual({ code: EXIT.ok, port: `pass port: port ${String(port)} on 127.0.0.1, the studio port of the profile default, is in use by Delo's studio, which runs for the profile default.` })
    } finally {
      await closeServer(server)
    }
  })

  it('fails the port when another process holds it, even while this home\'s studio runs on another port', async () => {
    const { server, port } = await listenOnEphemeralPort()
    try {
      await setStudioPort(port)
      const other = `port ${String(port)} on 127.0.0.1, the studio port of the profile default, is in use by another process`
      const alone = await doctor()
      expect(alone.code).toBe(EXIT.failed)
      expect(alone.port).toContain(`fail port: ${other}`)
      running = await startRunningHome(home, PROFILE, `http://127.0.0.1:${String(port === 65535 ? port - 1 : port + 1)}/`)
      const beside = await doctor()
      expect(beside.code).toBe(EXIT.failed)
      expect(beside.port).toContain(`fail port: ${other}`)
    } finally {
      await closeServer(server)
    }
  })

  it('fails the check, naming the file, when the profile\'s patch cannot be read', async () => {
    const directory = profileDirectory(home, PROFILE)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'cordis.patch.yml'), 'id: webserver\n')
    const result = await doctor()
    expect(result.code).toBe(EXIT.failed)
    expect(result.port).toBe(`fail port: the check could not complete: delorun doctor: ${join(directory, 'cordis.patch.yml')} is not a patch list`)
  })
})

describe('the port of this home\'s own studio', { timeout: 30_000 }, () => {
  it('is the port of the address the running home process reports, or the scheme\'s port when the address names none', async () => {
    running = await startRunningHome(home, PROFILE, 'http://127.0.0.1:4123/?token=x')
    expect(await homeStudioPort(home, PROFILE)).toBe(4123)
    await running.stop()
    running = await startRunningHome(home, PROFILE, 'http://127.0.0.1/')
    expect(await homeStudioPort(home, PROFILE)).toBe(80)
    await running.stop()
    running = await startRunningHome(home, PROFILE, 'https://127.0.0.1/')
    expect(await homeStudioPort(home, PROFILE)).toBe(443)
  })

  it('is none while no home process runs, its lock\'s holder has exited, or the Host serves no studio', async () => {
    expect(await homeStudioPort(home, PROFILE)).toBeUndefined()
    writeLock(spawnSync(process.execPath, ['-e', ''], { timeout: 30_000 }).pid as number)
    expect(await homeStudioPort(home, PROFILE)).toBeUndefined()
    rmSync(join(runDirectory(home, PROFILE), 'home.lock'))
    running = await startRunningHome(home, PROFILE, undefined)
    expect(await homeStudioPort(home, PROFILE)).toBeUndefined()
  })

  it('is none when the lock\'s live holder does not answer or refuses', async () => {
    writeLock(process.pid)
    expect(await homeStudioPort(home, PROFILE)).toBeUndefined()
    vi.mocked(queryHomeStatus).mockResolvedValueOnce({ ok: false, error: 'UNAUTHENTICATED' })
    expect(await homeStudioPort(home, PROFILE)).toBeUndefined()
  })
})

describe('delorun doctor in this process', { timeout: 30_000 }, () => {
  it('prints its help for --help and -h', async () => {
    for (const flag of ['--help', '-h']) {
      const result = await doctorOutput([flag])
      expect(result.code).toBe(EXIT.ok)
      expect(result.printed).toContain('Usage: delorun doctor [--port <n>]')
    }
  })

  /**
   * Write the home's credentials document at mode 0600.
   * @param text - its text.
   */
  function credentials(text: string): void {
    writeFileSync(join(home, '.credentials.yaml'), text, { mode: 0o600 })
  }

  it('passes on the warning of an invoking directory\'s .env that cannot be read', async () => {
    mkdirSync(join(osHome, '.env'))
    expect((await doctorOutput(['--port', '1'])).printed).toContain('delorun: failed to load .env: ')
  })

  it('checks the stored key first, and reports a document that is not YAML by its error code', async () => {
    credentials(`version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${GOOD_KEY}\n`)
    expect((await doctorOutput(['--port', '1'])).printed).toContain('pass key: ')
    credentials(`refs: [${GOOD_KEY}\n`)
    const broken = await doctorOutput(['--port', '1'])
    expect(broken.printed).toMatch(/fail key: the check could not complete: .*is not a readable credentials document \([A-Z_]+\)/u)
    expect(broken.printed).not.toContain(GOOD_KEY)
  })

  it.each([['a list', '- a\n'], ['references that are not a mapping', 'refs: x\n'], ['an empty reference', 'refs:\n  DEEPSEEK_API_KEY: ""\n']])('reads the environment\'s key when the stored document holds %s', async (_label, text) => {
    credentials(text)
    expect((await doctorOutput(['--port', '1'])).printed).toContain('warn key: no DeepSeek API key is set')
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    expect((await doctorOutput(['--port', '1'])).printed).toContain('warn key: no DeepSeek API key is set')
    vi.stubEnv('DEEPSEEK_API_KEY', GOOD_KEY)
    expect((await doctorOutput(['--port', '1'])).printed).toContain('pass key: ')
  })
})
