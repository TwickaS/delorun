/**
 * `delorun doctor` run in this process through {@link createDoctorCommand}, with a fixed clock, release and import
 * reader: the record lines it adds after the four checks, the import line only when a reader is wired, and the key's
 * sources. The command sets the launch variables and loads `.env` layers into `process.env`, so every case runs from
 * a temporary working directory and puts the environment and the directory back afterwards.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recorded, serializeCheckState } from '@delo/release-verify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDoctorCommand, doctorCommand, type DoctorEnvironment } from '../../src/doctor/index.ts'
import type { DshImportRecordEntry } from '../../src/doctor/records.ts'
import { CHECK_NAMES, closeServer, GOOD_KEY, listenOnEphemeralPort, usableBwrap } from './fixtures.ts'

const RELEASE = '0.4.0'
/** 2026-11-10T12:00:00Z. */
const NOW = 1_794_312_000

let base: string
let home: string
let savedEnv: NodeJS.ProcessEnv
let savedCwd: string

beforeEach(() => {
  savedEnv = { ...process.env }
  savedCwd = process.cwd()
  base = realpathSync(mkdtempSync(join(tmpdir(), 'doctor-command-')))
  home = join(base, '.delo')
  mkdirSync(home, { mode: 0o700 })
  mkdirSync(join(base, 'no-bin'))
  usableBwrap(join(base, 'no-bin'))
  process.chdir(base)
  for (const name of Object.keys(process.env)) if (/^(DSH_|DELO_|DEEPSEEK_API_KEY$)/.test(name)) delete process.env[name]
})

afterEach(() => {
  process.chdir(savedCwd)
  for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name]
  Object.assign(process.env, savedEnv)
  rmSync(base, { recursive: true, force: true })
})

/** What one run printed and returned. */
interface Run {
  readonly code: number | undefined
  readonly stdout: string
  readonly stderr: string
  /** Every line, standard output's first. */
  readonly lines: readonly string[]
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

/**
 * Run the command against the fixture home with no Docker on the search path.
 * @param environment - the reader and overrides of the fixed clock and release.
 * @param env - variables the command's context adds.
 * @param args - the arguments after `doctor`; a free port by default.
 * @returns the run.
 */
async function run(environment: Partial<DoctorEnvironment> = {}, env: Record<string, string> = {}, args?: readonly string[]): Promise<Run> {
  let stdout = ''
  let stderr = ''
  const command = createDoctorCommand({ now: () => NOW, running: () => RELEASE, ...environment })
  const code = await command.run(args ?? ['--port', String(await freePort())], {
    env: { DELO_HOME: home, PATH: join(base, 'no-bin'), ...env },
    stdout: (text) => { stdout += text },
    stderr: (text) => { stderr += text },
  })
  return { code: code ?? undefined, stdout, stderr, lines: (stdout + stderr).split('\n').filter(line => line !== '') }
}

/**
 * Record a release-log check state for the fixture release.
 * @param state - the state.
 */
function writeState(state: 'verified' | 'unchecked' | 'failed'): void {
  mkdirSync(join(home, 'trust'), { mode: 0o700 })
  const findings = state === 'failed' ? { refusal: 'inclusion-proof-invalid' as const, detail: 'the proof does not reach the root' } : state === 'unchecked' ? { detail: 'no network' } : {}
  writeFileSync(join(home, 'trust', 'release-log.json'), serializeCheckState(new Map([[RELEASE, recorded(RELEASE, state, NOW - 7200, findings)]])), { mode: 0o600 })
}

/** One import entry. */
const IMPORT: DshImportRecordEntry = { at: '2026-11-09T08:00:00.000Z', source: '/home/person/.dsh', chats: 2, workspaces: 1, profiles: ['web'], credentials: [], skipped: 0 }

describe('delorun doctor in process', { timeout: 60_000 }, () => {
  it('prints the release-log line and the update line after the four checks, and no import line without a reader', async () => {
    writeState('verified')
    const result = await run({}, { DEEPSEEK_API_KEY: GOOD_KEY })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('pass release-log: release 0.4.0 verified against the release log at 2026-11-10T10:00:00Z.\n')
    expect(result.lines.map(line => /^(?:pass|warn|fail) ([\w-]+): /.exec(line)?.[1]).sort()).toEqual(CHECK_NAMES)
    expect(result.lines.some(line => / import: /.test(line))).toBe(false)
  })

  it('warns on standard error for an unchecked release, with the time since and the reason, and exits 0', async () => {
    writeState('unchecked')
    const result = await run({}, { DEEPSEEK_API_KEY: GOOD_KEY })
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('warn release-log: Release 0.4.0 has not been checked against the release log; Delo checks it at the next connection. It has stayed unchecked since 2026-11-10T10:00:00Z (2 hours); the last attempt, at 2026-11-10T10:00:00Z, recorded: no network.\n')
  })

  it('fails a refused release and exits 1', async () => {
    writeState('failed')
    const result = await run({}, { DEEPSEEK_API_KEY: GOOD_KEY })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('fail release-log: the release log refused release 0.4.0 (inclusion-proof-invalid) at 2026-11-10T10:00:00Z: the proof does not reach the root\n')
  })

  it('warns when no state is recorded for the running release', async () => {
    const result = await run({}, { DEEPSEEK_API_KEY: GOOD_KEY })
    expect(result.code).toBe(0)
    expect(result.stderr).toContain(`warn release-log: no release-log check of release 0.4.0 is recorded in ${join(home, 'trust', 'release-log.json')}; run delorun verify to check it against the release log.\n`)
  })

  it('fails the release-log line when the running version cannot be read', async () => {
    const result = await run({ running: () => { throw new Error('the version cannot be read') } }, { DEEPSEEK_API_KEY: GOOD_KEY })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('fail release-log: the check could not complete: the version cannot be read\n')
  })

  it('prints the import line last when a reader is wired: pass, warn for entries left behind, and fail for a reader that throws', async () => {
    writeState('verified')
    const homes: string[] = []
    const passed = await run({ importRecord: (from) => { homes.push(from); return Promise.resolve([IMPORT]) } }, { DEEPSEEK_API_KEY: GOOD_KEY })
    expect(homes).toEqual([home])
    expect(passed.code).toBe(0)
    expect(passed.stdout.trimEnd().split('\n').at(-1)).toBe('pass import: the newest of 1 stock-home import, from /home/person/.dsh at 2026-11-09T08:00:00.000Z, carried 2 chats, 1 workspace, 1 profile and 0 credentials.')
    const warned = await run({ importRecord: () => Promise.resolve([{ ...IMPORT, skipped: 3 }]) }, { DEEPSEEK_API_KEY: GOOD_KEY })
    expect(warned.code).toBe(0)
    expect(warned.stderr).toContain('warn import: the newest of 1 stock-home import, from /home/person/.dsh at 2026-11-09T08:00:00.000Z, carried 2 chats, 1 workspace, 1 profile and 0 credentials; it left 3 entries of the stock home behind, which it did not copy.\n')
    const failed = await run({ importRecord: () => Promise.reject(new Error('the record is a directory')) }, { DEEPSEEK_API_KEY: GOOD_KEY })
    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain('fail import: the check could not complete: the record is a directory\n')
  })

  it('reports a thrown value that is not an Error by its text', async () => {
    // A reader from another package may reject with any value; the line still names it.
    const result = await run({ importRecord: () => Promise.reject(new TypeError('x').name) }, { DEEPSEEK_API_KEY: GOOD_KEY })
    expect(result.stderr).toContain('fail import: the check could not complete: TypeError\n')
  })

  it('reads the key from the home credentials document first, then from the environment layers, and warns when none sets it', async () => {
    writeFileSync(join(home, '.credentials.yaml'), `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${GOOD_KEY}\n`, { mode: 0o600 })
    expect((await run({}, {})).stdout).toContain('pass key: ')
    writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs: []\n', { mode: 0o600 })
    expect((await run({}, {})).stderr).toContain('warn key: no DeepSeek API key is set')
    writeFileSync(join(home, '.credentials.yaml'), 'refs: [broken\n', { mode: 0o600 })
    expect((await run({}, {})).stderr).toMatch(/^fail key: the check could not complete: .*\.credentials\.yaml is not a readable credentials document \([A-Z_]+\)$/m)
    writeFileSync(join(home, '.credentials.yaml'), 'just text\n', { mode: 0o600 })
    writeFileSync(join(base, '.env'), `DEEPSEEK_API_KEY=${GOOD_KEY}\n`, { mode: 0o600 })
    expect((await run({}, {})).stdout).toContain('pass key: ')
  })

  it('passes a .env loader warning to standard error and goes on', async () => {
    mkdirSync(join(base, '.env'))
    process.env['DEEPSEEK_API_KEY'] = GOOD_KEY
    const result = await run()
    expect(result.stderr).toContain('delorun: failed to load .env: ')
    expect(result.stdout).toContain('pass key: ')
  })

  it('reads this process\'s version in the shipped command', async () => {
    let stderr = ''
    await doctorCommand.run(['--port', String(await freePort())], { env: { DELO_HOME: home, PATH: join(base, 'no-bin') }, stdout: () => undefined, stderr: (text) => { stderr += text } })
    expect(stderr).toMatch(/^warn release-log: no release-log check of release \d+\.\d+\.\d+\S* is recorded in /m)
    expect(stderr).not.toContain(' import: ')
  })
})
