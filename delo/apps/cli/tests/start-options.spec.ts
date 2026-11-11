/**
 * `delorun start`'s author options (`delo/apps/cli/src/start.ts`, `delo/apps/cli/src/inspector.ts`): `--patch` files are
 * made absolute and a missing one is a usage error before anything starts. `--inspect` is refused without the person's
 * confirmation, at a terminal or by `--yes`, and in safe mode, before anything opens or starts; once confirmed it opens
 * Node's inspector on the loopback address and port 9229, warns what that exposes, and records it for `delorun status`
 * until the process exits; a port it cannot open is a failure that names the port.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enterSafeMode } from '@delo/profile-safety'
import { CliError, EXIT } from '../src/exit.ts'
import { INSPECTOR_PORT, INSPECTOR_QUESTION, inspectorConsent, inspectorRecordPath, openDebugger, readInspectorRecord } from '../src/inspector.ts'
import { patchFilesOf, startCommand } from '../src/start.ts'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'delorun-start-options-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('--patch', () => {
  it('makes each file absolute, in order', () => {
    const file = join(directory, 'mine.patch.yml')
    writeFileSync(file, '[]\n')
    expect(patchFilesOf([file, file])).toEqual([file, file])
  })

  it('refuses a file that does not exist as a usage error', () => {
    const missing = join(directory, 'missing.patch.yml')
    expect(() => patchFilesOf([missing])).toThrow(new CliError(EXIT.usage, `delorun start: --patch ${missing} does not exist`))
  })

  it('is an option of delorun start, which lists it in its summary', () => {
    expect(startCommand.summary).toContain('--patch')
  })
})

describe('--inspect', () => {
  /**
   * The refusal a promise ends with.
   * @param promise - the promise.
   * @returns the CliError it rejected with.
   */
  async function refusal(promise: Promise<unknown>): Promise<CliError> {
    const error: unknown = await promise.then(() => undefined, (failure: unknown) => failure)
    expect(error).toBeInstanceOf(CliError)
    return error as CliError
  }

  it('is refused without a terminal unless --yes confirms it, saying what it exposes', async () => {
    const error = await refusal(inspectorConsent({ home: directory, profile: 'default', yes: false, confirm: undefined }))
    expect(error.exit).toBe(EXIT.failed)
    expect(error.message).toContain('--inspect --yes')
    expect(error.message).toContain('including commands the agent runs inside the sandbox, can run code as Delo outside the sandbox')
    await expect(inspectorConsent({ home: directory, profile: 'default', yes: true, confirm: undefined })).resolves.toBeUndefined()
  })

  it('asks at a terminal, and is refused when the person declines', async () => {
    const questions: string[] = []
    const error = await refusal(inspectorConsent({ home: directory, profile: 'default', yes: false, confirm: (question) => { questions.push(question); return Promise.resolve(false) } }))
    expect(error.message).toContain('declined')
    expect(questions).toEqual([INSPECTOR_QUESTION])
    await expect(inspectorConsent({ home: directory, profile: 'default', yes: false, confirm: () => Promise.resolve(true) })).resolves.toBeUndefined()
  })

  it('is refused in safe mode, even with --yes', async () => {
    mkdirSync(join(directory, 'run', 'default'), { recursive: true })
    await enterSafeMode({ homeDir: directory, profile: 'default', reason: 'a spec', skipped: [] })
    const error = await refusal(inspectorConsent({ home: directory, profile: 'default', yes: true, confirm: () => Promise.resolve(true) }))
    expect(error.message).toContain('safe mode')
    expect(error.message).toContain('delorun recover exit-safe-mode')
  })

  it('is refused by delorun start before anything starts, and --yes alone is a usage error', async () => {
    const home = join(directory, 'home')
    vi.stubEnv('DELO_HOME', home)
    try {
      const context = { env: { DELO_HOME: home }, stdout: () => undefined, stderr: () => undefined }
      const error = await refusal(startCommand.run(['--foreground', '--inspect'], context))
      expect(error.message).toContain('--inspect --yes')
      expect(existsSync(inspectorRecordPath(home, 'default'))).toBe(false)
      expect((await refusal(startCommand.run(['--foreground', '--yes'], context))).exit).toBe(EXIT.usage)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('opens the inspector on the loopback address and Node\'s default port, says what that exposes, and records it until exit', () => {
    mkdirSync(join(directory, 'run', 'default'), { recursive: true })
    const opened: [number, string][] = []
    const warnings: string[] = []
    const exits: (() => void)[] = []
    openDebugger(directory, 'default', { stdout: () => undefined, stderr: (text) => { warnings.push(text) } }, (listener) => { exits.push(listener) }, (port, host) => { opened.push([port, host]) })
    expect(opened).toEqual([[INSPECTOR_PORT, '127.0.0.1']])
    expect(INSPECTOR_PORT).toBe(9229)
    expect(warnings.join('')).toContain('can run code as Delo outside the sandbox')
    expect(readInspectorRecord(directory, 'default', process.pid)).toMatchObject({ pid: process.pid })
    expect(readInspectorRecord(directory, 'default', process.pid + 1)).toBeUndefined()
    exits.forEach((exit) => { exit() })
    expect(readInspectorRecord(directory, 'default', process.pid)).toBeUndefined()
  })

  it('reads no record that does not parse', () => {
    mkdirSync(join(directory, 'run', 'default'), { recursive: true })
    writeFileSync(inspectorRecordPath(directory, 'default'), '{')
    expect(readInspectorRecord(directory, 'default', process.pid)).toBeUndefined()
    expect(readFileSync(inspectorRecordPath(directory, 'default'), 'utf8')).toBe('{')
  })

  it('fails naming the port when the inspector cannot open', () => {
    expect(() => openDebugger(directory, 'default', { stdout: () => undefined, stderr: () => undefined }, () => undefined, () => { throw new Error('address already in use') })).toThrow('could not listen on 127.0.0.1:9229: address already in use')
  })
})
