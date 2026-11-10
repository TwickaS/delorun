/**
 * `delorun plugin` (`delo/apps/cli/src/upstream.ts`) registers as a shared user of the home's stores before it runs
 * upstream's `dsh plugin`, and releases the registration when upstream's command line ends or fails. While an exclusive
 * user runs it refuses and upstream's command line does not run. Upstream's command line is replaced by one that
 * records its arguments and the registrations it saw.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DATA_USERS_DIRECTORY } from '@delo/contract-home-layout'
import { prepareHome, type CommandContext } from '../src/command.ts'
import { CliError, EXIT } from '../src/exit.ts'
import { registerDataUser } from '../src/home-exclusion.ts'
import { plugin } from '../src/upstream.ts'

let osHome: string
let deloHome: string
let context: CommandContext
const children: ChildProcess[] = []

beforeEach(() => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-plugin-')))
  deloHome = join(osHome, '.delo')
  vi.stubEnv('HOME', osHome)
  vi.stubEnv('USERPROFILE', osHome)
  vi.stubEnv('DELO_HOME', undefined)
  vi.stubEnv('DELO_PROFILE', undefined)
  context = { env: { HOME: osHome }, stdout: () => undefined, stderr: () => undefined }
})

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  vi.unstubAllEnvs()
  rmSync(osHome, { recursive: true, force: true })
})

/**
 * The registrations under the home's `run/data-users/`.
 * @returns their file names, the process ids.
 */
function registrations(): string[] {
  const directory = join(deloHome, 'run', DATA_USERS_DIRECTORY)
  return existsSync(directory) ? readdirSync(directory) : []
}

describe('delorun plugin', () => {
  it('runs upstream\'s plugin command registered as a shared user, and releases the registration afterwards', async () => {
    const runs: { argv: readonly string[], registered: string[] }[] = []
    const exits: (() => void)[] = []
    const upstream = (argv: readonly string[]): Promise<void> => { runs.push({ argv, registered: registrations() }); return Promise.resolve() }
    expect(await plugin(['--profile', 'default', 'list'], context, upstream, (listener) => { exits.push(listener) })).toBe(EXIT.ok)
    expect(runs).toEqual([{ argv: ['plugin', '--profile', 'default', 'list'], registered: [String(process.pid)] }])
    expect(exits).toHaveLength(1)
    expect(registrations()).toEqual([])
  })

  it('releases the registration when upstream\'s command line fails', async () => {
    const failing = (): Promise<void> => Promise.reject(new Error('pnpm vanished'))
    await expect(plugin(['add', 'some-plugin'], context, failing, () => undefined)).rejects.toThrow('pnpm vanished')
    expect(registrations()).toEqual([])
  })

  it('refuses while an exclusive user runs, without running upstream\'s command line or staying registered', async () => {
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
    children.push(other)
    const pid = other.pid ?? 0
    const ran: (readonly string[])[] = []
    const upstream = (argv: readonly string[]): Promise<void> => { ran.push(argv); return Promise.resolve() }
    await prepareHome(context, undefined)
    registerDataUser(deloHome, 'exclusive', 'import', pid)
    await expect(plugin(['add', 'some-plugin'], context, upstream, () => undefined)).rejects.toThrow(new CliError(EXIT.failed, `delorun plugin: process ${String(pid)} (delorun import) is changing the stores this command uses; wait for it to finish, and try again`))
    expect(ran).toEqual([])
    expect(registrations()).toEqual([String(pid)])
  })
})
