import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeServer, GOOD_KEY, leaksPartOf, listenOnEphemeralPort, POSIX, ANSWERING_DOCKER, FAILING_DOCKER } from './fixtures.ts'

const BIN = join(import.meta.dirname, '../../src/bin.ts')
const TSX_LOADER = import.meta.resolve('tsx/esm')

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
  it('warns that Docker is missing, passes the other checks, and exits 0', async () => {
    const port = await freePort()
    const result = doctor(['--port', String(port)], { DEEPSEEK_API_KEY: GOOD_KEY })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('warn docker: Docker is not installed; the Docker shapes stay unavailable, and native workspaces are unaffected.\n')
    expect(result.stdout).toContain('pass home: ')
    expect(result.stdout).toContain('pass key: the DeepSeek API key is set and has the expected format (format only; the key was not sent to DeepSeek).\n')
    expect(result.stdout).toContain(`pass port: port ${String(port)} on 127.0.0.1 is free.\n`)
  })

  it.runIf(POSIX)('passes an answering Docker engine and prints its version', async () => {
    fakeDocker(ANSWERING_DOCKER)
    const port = await freePort()
    const result = doctor(['--port', String(port)], { DEEPSEEK_API_KEY: GOOD_KEY, PATH: fakeBin })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('pass docker: the Docker engine answers; its server version is 27.3.1.\n')
    expect(result.stderr).toBe('')
  })

  it.runIf(POSIX)('warns when Docker is installed but its engine does not answer, and exits 0', async () => {
    fakeDocker(FAILING_DOCKER)
    const port = await freePort()
    const result = doctor(['--port', String(port)], { DEEPSEEK_API_KEY: GOOD_KEY, PATH: fakeBin })
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('warn docker: Docker is installed, but its engine does not answer; start Docker, then run delorun doctor again.\n')
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

  it('checks the studio default port 3080 when no --port is given', () => {
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
    expect(result.stdout).toContain('No model is contacted and no command runs')
    expect(result.stdout).toContain('default 3080')
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
