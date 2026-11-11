/**
 * `delorun plugin` (`delo/apps/cli/src/upstream.ts`) registers as a shared user of the home's stores before it runs
 * upstream's `dsh plugin`, and releases the registration when upstream's command line ends or fails. While an exclusive
 * user runs it refuses and upstream's command line does not run. Without `--profile` it manages the CLI profile. When
 * pnpm refuses a build, the build the person allows is allowed and the operation runs again; one they decline is not.
 * Upstream's command line is replaced by one that records its arguments and the registrations it saw, and that ends by
 * exiting the process as upstream's does.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DATA_USERS_DIRECTORY } from '@delo/contract-home-layout'
import { prepareHome, type CommandContext } from '../src/command.ts'
import { CliError, EXIT } from '../src/exit.ts'
import { registerDataUser } from '../src/home-exclusion.ts'
import { capturingPackageManager } from '../src/plugin-builds.ts'
import { plugin, pluginCommand } from '../src/upstream.ts'

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

  it('manages the CLI profile when no --profile is given, DELO_PROFILE\'s when it is set', async () => {
    const runs: (readonly string[])[] = []
    const upstream = (argv: readonly string[]): Promise<void> => { runs.push(argv); return Promise.resolve() }
    expect(await plugin(['add', 'some-plugin'], context, upstream, () => undefined)).toBe(EXIT.ok)
    expect(await plugin(['add', 'some-plugin'], { ...context, env: { ...context.env, DELO_PROFILE: 'work' } }, upstream, () => undefined)).toBe(EXIT.ok)
    expect(runs).toEqual([['plugin', '--profile', 'default', 'add', 'some-plugin'], ['plugin', '--profile', 'work', 'add', 'some-plugin']])
  })

  it('exits 1 when upstream\'s command line exits with another code, and keeps the process', async () => {
    const upstream = (): Promise<void> => { process.exit(127) }
    expect(await plugin(['add', 'some-plugin'], context, upstream, () => undefined)).toBe(EXIT.failed)
  })
})

/** The key pnpm prints for the git-hosted package the fake refuses. */
const GIT_KEY = 'git-plug@git+file:///tmp/repo#8edca4e355d5677de0397415bf6ea4a7307bb076'

/**
 * A stand-in for upstream's command line over the default profile: it prints pnpm's refusal of the git package's
 * prepare script into the file that keeps pnpm's output, until the profile allows the exact key, and exits.
 * @param runs - receives each run's arguments.
 * @returns the stand-in.
 */
function pnpmRefusingBuild(runs: (readonly string[])[]): (argv: readonly string[], capture?: string) => Promise<void> {
  return (argv, capture) => {
    runs.push(argv)
    const profileDir = join(deloHome, 'profiles', 'default')
    mkdirSync(profileDir, { recursive: true })
    if (!existsSync(join(profileDir, 'package.json'))) writeFileSync(join(profileDir, 'package.json'), '{"name":"dsh-profile-default","private":true,"dependencies":{}}\n')
    const workspace = join(profileDir, 'pnpm-workspace.yaml')
    const allowed = existsSync(workspace) && readFileSync(workspace, 'utf8').includes(`${GIT_KEY}: true`)
    if (capture !== undefined) writeFileSync(capture, allowed ? 'Done\n' : `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED Failed to prepare git-hosted package\nallowBuilds:\n  ${GIT_KEY}: true\n`)
    process.exit(allowed ? 0 : 1)
  }
}

describe('a build pnpm refuses', () => {
  it('is allowed after the person confirms, and the operation runs again', async () => {
    const runs: (readonly string[])[] = []
    const questions: string[] = []
    expect(await plugin(['add', 'git+file:///tmp/repo'], context, pnpmRefusingBuild(runs), () => undefined, (question) => { questions.push(question); return Promise.resolve(true) })).toBe(EXIT.ok)
    expect(runs).toHaveLength(2)
    expect(questions).toHaveLength(1)
    expect(questions[0]).toContain(GIT_KEY)
  })

  it('stays refused when the person declines, and the operation does not run again', async () => {
    const runs: (readonly string[])[] = []
    const lines: string[] = []
    expect(await plugin(['add', 'git+file:///tmp/repo'], { ...context, stderr: (text) => { lines.push(text) } }, pnpmRefusingBuild(runs), () => undefined, () => Promise.resolve(false))).toBe(EXIT.failed)
    expect(runs).toHaveLength(1)
    expect(lines.join('')).toContain('--allow-build git-plug')
    expect(readFileSync(join(deloHome, 'profiles', 'default', 'pnpm-workspace.yaml'), 'utf8')).toContain('set this to true or false')
  })

  it('is allowed without a prompt by --allow-build naming the package, which pnpm never receives', async () => {
    const runs: (readonly string[])[] = []
    expect(await plugin(['add', 'git+file:///tmp/repo', '--allow-build', 'git-plug'], context, pnpmRefusingBuild(runs), () => undefined, undefined)).toBe(EXIT.ok)
    expect(runs).toEqual([['plugin', '--profile', 'default', 'add', 'git+file:///tmp/repo'], ['plugin', '--profile', 'default', 'add', 'git+file:///tmp/repo']])
  })

  it('is not allowed by --allow-build naming another package', async () => {
    const runs: (readonly string[])[] = []
    expect(await plugin(['add', 'git+file:///tmp/repo', '--allow-build', 'other'], context, pnpmRefusingBuild(runs), () => undefined, undefined)).toBe(EXIT.failed)
    expect(runs).toHaveLength(1)
  })
})

describe('the plugin command', () => {
  it('sends check, new and dev to Delo\'s own commands, which refuse a wrong command line before any profile changes', async () => {
    await expect(pluginCommand.run(['check'], context)).rejects.toThrow('usage: delorun plugin check <directory>')
    await expect(pluginCommand.run(['dev'], context)).rejects.toThrow('usage: delorun plugin dev <folder>')
    expect(existsSync(join(deloHome, 'profiles'))).toBe(false)
  })
})

describe('the wrapper that keeps pnpm\'s output', () => {
  it('passes the package manager\'s output through, keeps a copy and ends with its exit code', () => {
    const file = join(osHome, 'out.log')
    const fakePnpm = join(osHome, 'pnpm.cjs')
    writeFileSync(fakePnpm, "process.stdout.write('to stdout\\n'); process.stderr.write('to stderr\\n'); process.exitCode = 3\n")
    const wrapper = capturingPackageManager({ command: process.execPath, args: [fakePnpm], env: {} }, file)
    const result = spawnSync(wrapper.command, [...wrapper.args, 'add', 'x'], { encoding: 'utf8', timeout: 30_000 })
    expect(result.status).toBe(3)
    expect(result.stdout).toBe('to stdout\n')
    expect(result.stderr).toBe('to stderr\n')
    expect(readFileSync(file, 'utf8')).toContain('to stdout\n')
    expect(readFileSync(file, 'utf8')).toContain('to stderr\n')
  })

  it('ends with 127 when the package manager cannot be found', () => {
    const wrapper = capturingPackageManager({ command: join(osHome, 'no-such-pnpm'), args: [], env: {} }, join(osHome, 'out.log'))
    expect(spawnSync(wrapper.command, wrapper.args, { encoding: 'utf8', timeout: 30_000 }).status).toBe(127)
  })
})
