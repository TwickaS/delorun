import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SETUP_DEFAULTS } from '@delo/contract-setup-answers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recorded, serializeCheckState } from '@delo/release-verify'
import { CHECK_NAMES, closeServer, GOOD_KEY, leaksPartOf, listenOnEphemeralPort, POSIX, ANSWERING_DOCKER, FAILING_DOCKER, usableBwrap } from './fixtures.ts'

const BIN = join(import.meta.dirname, '../../src/bin.ts')
const TSX_LOADER = import.meta.resolve('tsx/esm')
/** The release the source command runs as: the CLI package's version. */
const RUNNING = (JSON.parse(readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8')) as { version: string }).version

let osHome: string
let deloHome: string
let emptyBin: string
let fakeBin: string

beforeEach(() => {
  // The OS home is the working directory too, so no `.env` of the repository is loaded.
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-doctor-')))
  deloHome = join(osHome, '.delo')
  mkdirSync(deloHome, { mode: 0o700 })
  emptyBin = join(osHome, 'empty-bin')
  fakeBin = join(osHome, 'fake-bin')
  mkdirSync(emptyBin)
  mkdirSync(fakeBin)
  usableBwrap(emptyBin)
  usableBwrap(fakeBin)
})

afterEach(() => {
  rmSync(osHome, { recursive: true, force: true })
})

/**
 * Run `delorun doctor` in a child process against the fixture OS home. The environment is the caller's: the
 * inherited variables that do not name a Delo or upstream setting, a key or a path are kept, and `PATH` is an empty
 * directory unless the caller names one, so no real Docker is found.
 * @param args - the arguments after `doctor`.
 * @param env - variables set for the child.
 * @returns its exit status and output.
 */
function doctor(args: readonly string[], env: Record<string, string> = {}): { status: number | null, stdout: string, stderr: string } {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(DSH_|DELO_|NODE_PATH$|DEEPSEEK_API_KEY$|PATH$)/.test(name)))
  const result = spawnSync(process.execPath, ['--import', TSX_LOADER, BIN, 'doctor', ...args], {
    cwd: osHome,
    env: { ...inherited, HOME: osHome, USERPROFILE: osHome, PATH: emptyBin, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/**
 * Run `delorun doctor` in a child process whose whole environment is the given one.
 * @param args - the arguments after `doctor`.
 * @param env - the child's complete environment.
 * @returns its exit status and output.
 */
function doctorWithEnvironment(args: readonly string[], env: Record<string, string>): { status: number | null, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, ['--import', TSX_LOADER, BIN, 'doctor', ...args], { cwd: osHome, env, encoding: 'utf8', timeout: 60_000 })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/**
 * Write a fake `docker` program into the fake binary directory.
 * @param body - the script after its shebang.
 */
function fakeDocker(body: string): void {
  writeFileSync(join(fakeBin, 'docker'), `#!/bin/sh\n${body}`, { mode: 0o755 })
}

/**
 * A loopback port that nothing holds now.
 * @returns the port.
 */
async function freePort(): Promise<number> {
  const { server, port } = await listenOnEphemeralPort()
  await closeServer(server)
  return port
}

describe('delorun doctor', { timeout: 60_000 }, () => {
  it('warns that Docker is missing and that no release-log check is recorded, passes the other checks, and exits 0', async () => {
    const port = await freePort()
    const result = doctor(['--port', String(port)], { DEEPSEEK_API_KEY: GOOD_KEY })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe([
      'warn docker: Docker is not installed; the Docker shapes stay unavailable, and native workspaces are unaffected.',
      `warn release-log: no release-log check of release ${RUNNING} is recorded in ${join(deloHome, 'trust', 'release-log.json')}; run delorun verify to check it against the release log.`,
      '',
    ].join('\n'))
    expect(result.stdout).toContain('pass home: ')
    expect(result.stdout).toContain('pass key: the DeepSeek API key is set and has the expected format (format only; the key was not sent to DeepSeek).\n')
    expect(result.stdout).toContain(`pass port: port ${String(port)} on 127.0.0.1 is free.\n`)
  })

  it('warns for a running release that has stayed unchecked, with the time since and the recorded reason', async () => {
    const now = Math.floor(Date.now() / 1000)
    mkdirSync(join(deloHome, 'trust'), { mode: 0o700 })
    writeFileSync(join(deloHome, 'trust', 'release-log.json'), serializeCheckState(new Map([[RUNNING, recorded(RUNNING, 'unchecked', now - 2 * 86_400, { detail: 'no network' })]])), { mode: 0o600 })
    const port = await freePort()
    const result = doctor(['--port', String(port)], { DEEPSEEK_API_KEY: GOOD_KEY })
    expect(result.status).toBe(0)
    expect(result.stderr).toMatch(new RegExp(`^warn release-log: Release ${RUNNING.replaceAll('.', '\\.')} has not been checked against the release log; Delo checks it at the next connection\\. It has stayed unchecked since \\S+Z \\(2 days\\); the last attempt, at \\S+Z, recorded: no network\\.$`, 'm'))
  })

  it.runIf(POSIX)('passes an answering Docker engine and prints its version', async () => {
    fakeDocker(ANSWERING_DOCKER)
    const port = await freePort()
    const result = doctor(['--port', String(port)], { DEEPSEEK_API_KEY: GOOD_KEY, PATH: fakeBin })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('pass docker: the Docker engine answers; its server version is 27.3.1.\n')
    expect(result.stderr).not.toContain(' docker: ')
  })

  it.runIf(POSIX)('warns when Docker is installed but its engine does not answer, and exits 0', async () => {
    fakeDocker(FAILING_DOCKER)
    const port = await freePort()
    const result = doctor(['--port', String(port)], { DEEPSEEK_API_KEY: GOOD_KEY, PATH: fakeBin })
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('warn docker: Docker is installed, but its engine does not answer; start Docker, then run delorun doctor again.\n')
  })

  it('checks the key of the provider the profile\'s default-model row selects, from the variable its route names', async () => {
    const directory = join(deloHome, 'profiles', 'default')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(join(directory, 'cordis.patch.yml'), [
      '- id: llm-pi-ai', '  name: "@deepseek-ai/dsh-llm-pi-ai"', '  config:', '    providers:', '      anthropic:', '        apiKeyEnv: WORK_ANTHROPIC_KEY',
      '      cerebras: {}',
      '- id: agent-default-model', '  name: "@deepseek-ai/dsh-agent-default-model"', '  config:', '    provider: anthropic', '    model: claude-sonnet-5-5', '',
    ].join('\n'), { mode: 0o600 })
    // A setup answers record naming no provider does not hide the provider the profile selects.
    writeFileSync(join(directory, 'setup-answers.json'), JSON.stringify({ version: 1, ...SETUP_DEFAULTS, modelProvider: null }), { mode: 0o600 })
    const port = await freePort()
    expect(doctor(['--port', String(port)], { DEEPSEEK_API_KEY: GOOD_KEY }).stderr).toContain('warn key: no Anthropic API key is set; the model cannot answer. Set WORK_ANTHROPIC_KEY, or run delorun setup key to store one')
    expect(doctor(['--port', String(port)], { WORK_ANTHROPIC_KEY: 'anthropic-fixture-0123456789' }).stdout).toContain('pass key: the Anthropic API key is set and has the expected format (format only; the key was not sent to Anthropic).\n')
    writeFileSync(join(directory, 'cordis.patch.yml'), readFileSync(join(directory, 'cordis.patch.yml'), 'utf8').replace('provider: anthropic', 'provider: cerebras'))
    expect(doctor(['--port', String(port)], {}).stderr).toContain('warn key: new chats start on cerebras, whose row names no key variable')
  })

  it('warns when no DeepSeek key is set, and exits 0', async () => {
    const port = await freePort()
    const result = doctor(['--port', String(port)])
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('warn key: no DeepSeek API key is set; the model cannot answer.')
  })

  it.each([
    ['whitespace inside', 'sk-fixture0123456789 abcdefghij'],
    ['fewer than 20 characters', 'sk-short1234'],
  ])('fails a key with %s, names the check, and prints no part of the key', async (_, key) => {
    const port = await freePort()
    const result = doctor(['--port', String(port)], { DEEPSEEK_API_KEY: key })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('fail key: the DeepSeek API key is malformed; check it at the key page (format only; the key was not sent to DeepSeek).\n')
    expect(leaksPartOf(result.stdout + result.stderr, key)).toBe(false)
  })

  it.runIf(POSIX).each([
    ['a shell command after the version', "27.3.1; touch hostile-marker"],
    ['an escape sequence', '27.3.1\\033[31m\\033]0;title\\007'],
    ['a second line', '27.3.1\\nCONTAINERS: 4'],
    ['a version of 4000 characters', `1${'a'.repeat(3999)}`],
  ])('treats an engine that prints %s as not answering, and prints none of it', async (_label, printed) => {
    fakeDocker(`printf '${printed}\\n'\n`)
    const port = await freePort()
    const result = doctor(['--port', String(port)], { DEEPSEEK_API_KEY: GOOD_KEY, PATH: fakeBin })
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('warn docker: Docker is installed, but its engine does not answer; start Docker, then run delorun doctor again.\n')
    const output = result.stdout + result.stderr
    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f]/)
    for (const hostile of ['hostile-marker', 'CONTAINERS', 'title', '27.3.1', 'aaaa']) expect(output).not.toContain(hostile)
  })

  it.each([
    ['an unclosed quote', (key: string) => `refs:\n  DEEPSEEK_API_KEY: "${key}\n`],
    ['a repeated key', (key: string) => `refs:\n  DEEPSEEK_API_KEY: ${key}\n  DEEPSEEK_API_KEY: ${key}\n`],
    ['a line that is not YAML', (key: string) => `refs:\n  DEEPSEEK_API_KEY: ${key}\n: [broken\n`],
  ])('reports a credentials document with %s by its error code, and prints the key nowhere', async (_label, document) => {
    const key = 'sk-q7Zx41Vb93Lm05Wt82Rk'
    writeFileSync(join(deloHome, '.credentials.yaml'), document(key), { mode: 0o600 })
    const port = await freePort()
    // The same key is in the environment and in the home's .env file too, so every source of it is in play.
    writeFileSync(join(deloHome, '.env'), `DEEPSEEK_API_KEY=${key}\n`, { mode: 0o600 })
    const result = doctor(['--port', String(port)], { DEEPSEEK_API_KEY: key })
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/^fail key: the check could not complete: .*\.credentials\.yaml is not a readable credentials document \([A-Z_]+\)$/m)
    expect(leaksPartOf(result.stdout + result.stderr, key)).toBe(false)
  })

  it('runs against an empty environment: one line per check, no crash and no key', () => {
    // Without HOME the home resolves from the account database, so the verdicts of the home and key checks depend on the machine.
    const result = doctorWithEnvironment(['--port', '1'], {})
    const lines = (result.stdout + result.stderr).split('\n').filter(line => line !== '')
    expect(lines.map(line => /^(?:pass|warn|fail) ([\w-]+): /.exec(line)?.[1]).sort()).toEqual(CHECK_NAMES)
    expect(lines.find(line => line.includes(' docker: '))).toMatch(/^(?:pass|warn) docker: /)
    expect(lines.find(line => line.includes(' port: '))).toMatch(/^(?:pass|fail) port: /)
    expect(lines.find(line => / update: /.test(line))).toMatch(/^pass update: this Delo does not run from the runtime store/)
    expect(result.status).toBe(lines.some(line => line.startsWith('fail ')) ? 1 : 0)
    expect(result.stderr).not.toMatch(/\n\s+at /)
    expect(result.stdout + result.stderr).not.toContain('sk-')
  })

  it('fails a port in use, names the port, and exits 1', async () => {
    const { server, port } = await listenOnEphemeralPort()
    try {
      const result = doctor(['--port', String(port)], { DEEPSEEK_API_KEY: GOOD_KEY })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`fail port: port ${String(port)} is in use; stop the other process or pass --port\n`)
    } finally {
      await closeServer(server)
    }
  })

  it('checks the studio default port 3080 when no --port is given and the profile sets none', () => {
    const result = doctor([], { DEEPSEEK_API_KEY: GOOD_KEY })
    const line = /^(pass|fail) port: port 3080 /m.exec(result.stdout + result.stderr)
    expect(line).not.toBeNull()
    expect(result.status).toBe(line?.[1] === 'pass' ? 0 : 1)
  })

  it('refuses a bad --port with the usage code before any check runs', () => {
    for (const args of [['--port', '70000'], ['--port']]) {
      const result = doctor(args, { DEEPSEEK_API_KEY: GOOD_KEY })
      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('--port')
    }
  })

  it('prints help that says no model is contacted and no command runs, and exits 0', () => {
    const result = doctor(['--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('No model is contacted, no request is sent and no command runs')
    expect(result.stdout).toContain('default: the profile\'s studio port, or 3080 when the profile sets none')
  })

  it('reads the key stored in the home credentials document before the environment', async () => {
    const storedText = `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${GOOD_KEY}\n`
    writeFileSync(join(deloHome, '.credentials.yaml'), storedText, { mode: 0o600 })
    const port = await freePort()
    // The environment's key is malformed; the stored one, which the model uses, is well formed.
    const result = doctor(['--port', String(port)], { DEEPSEEK_API_KEY: 'sk-fixture0123456789 abcdefghij' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('pass key: ')
  })

  it('reads the key from the home .env file, the layer that delorun start reads', async () => {
    // Owner-only, as the home `.env` must be: a group- or world-readable one stops the start.
    writeFileSync(join(deloHome, '.env'), `DEEPSEEK_API_KEY=${GOOD_KEY}\n`, { mode: 0o600 })
    const port = await freePort()
    const result = doctor(['--port', String(port)])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('pass key: ')
  })

  it.runIf(POSIX)('refuses a credentials document another user can read, with the chmod 600 fix and no key', async () => {
    const path = join(deloHome, '.credentials.yaml')
    writeFileSync(path, `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${GOOD_KEY}\n`)
    chmodSync(path, 0o644)
    const port = await freePort()
    const result = doctor(['--port', String(port)])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('fail key: the check could not complete: SECRET_FILE_MODE: ')
    expect(result.stderr).toContain(`chmod 600 ${path}`)
    expect(leaksPartOf(result.stdout + result.stderr, GOOD_KEY)).toBe(false)
  })

  it.runIf(POSIX)('refuses a laxer home with the chmod 700 fix, and exits 1', async () => {
    chmodSync(deloHome, 0o755)
    const port = await freePort()
    const result = doctor(['--port', String(port)], { DEEPSEEK_API_KEY: GOOD_KEY })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`fail home: HOME_MODE: ${deloHome} has mode 0755`)
    expect(result.stderr).toContain(`chmod 700 ${deloHome}`)
  })
})
