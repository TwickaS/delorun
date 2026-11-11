/**
 * `delorun plugin` (`delo/apps/cli/src/upstream.ts`) registers as a shared user of the home's stores before it runs
 * upstream's `dsh plugin`, and releases the registration when upstream's command line ends or fails. While an exclusive
 * user runs it refuses and upstream's command line does not run. Before pnpm runs, the profile's packages are set to be
 * copied from pnpm's store; after a successful operation, the install check checks and records each plugin it
 * installed, prints every finding, and refuses a known critical advisory unless `--allow-advisory` names it, putting
 * the profile back as it was. Upstream's command line is replaced by one that records its arguments and writes the
 * profile files a package operation would; a loopback stand-in answers for the advisory feed and the registry.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DATA_USERS_DIRECTORY } from '@delo/contract-home-layout'
import { recordPath } from '@delo/plugin-install-check/check'
import { advisory, OLD, settingsFor, startStandIn, writeProfileFiles, type StandIn } from '@delo/plugin-install-check/tests/fixture'
import { prepareHome, type CommandContext } from '../src/command.ts'
import { CliError, EXIT } from '../src/exit.ts'
import { registerDataUser } from '../src/home-exclusion.ts'
import { takeAllowedAdvisories, type ProfileCheckSettings } from '../src/plugin-install-check.ts'
import { plugin, type PluginDependencies } from '../src/upstream.ts'

let osHome: string
let deloHome: string
let profileDir: string
let context: CommandContext
let errors: string[]
let standIn: StandIn
const children: ChildProcess[] = []

beforeEach(async () => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-plugin-')))
  deloHome = join(osHome, '.delo')
  profileDir = join(deloHome, 'profiles', 'default')
  vi.stubEnv('HOME', osHome)
  vi.stubEnv('USERPROFILE', osHome)
  vi.stubEnv('DELO_HOME', undefined)
  vi.stubEnv('DELO_PROFILE', undefined)
  errors = []
  context = { env: { HOME: osHome }, stdout: () => undefined, stderr: (text) => { errors.push(text) } }
  standIn = await startStandIn({ advisories: {}, times: { 'good-plugin': { '1.0.0': OLD } } })
})

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  vi.unstubAllEnvs()
  await standIn.close()
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

/**
 * Dependencies whose upstream command records its arguments and, for `add`, installs `good-plugin` into the profile.
 * @param runs - receives each run's arguments and the registrations it saw.
 * @param check - the install check's settings; the stand-in's by default.
 * @returns the dependencies and the exit listeners registered.
 */
function dependencies(runs: { argv: readonly string[], registered: string[] }[], check: ProfileCheckSettings = { settings: settingsFor(standIn), knownNames: new Set() }): PluginDependencies {
  return {
    runUpstream: (argv) => {
      runs.push({ argv, registered: registrations() })
      if (argv.includes('add')) writeProfileFiles(profileDir, [{ name: 'good-plugin', version: '1.0.0', direct: true }])
      return Promise.resolve(0)
    },
    checkSettings: () => Promise.resolve(check),
    onExit: () => undefined,
  }
}

/** Write a set-up profile with nothing installed yet. */
function writeEmptyProfile(): void {
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), '{"name":"profile","private":true}\n')
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), '# the profile\'s pnpm settings\npackages:\n  - .\n\nnodeLinker: hoisted\n')
}

describe('delorun plugin', () => {
  it('runs upstream\'s plugin command registered as a shared user, and releases the registration afterwards', async () => {
    const runs: { argv: readonly string[], registered: string[] }[] = []
    expect(await plugin(['--profile', 'default', 'list'], context, dependencies(runs))).toBe(0)
    expect(runs).toEqual([{ argv: ['plugin', '--profile', 'default', 'list'], registered: [String(process.pid)] }])
    expect(registrations()).toEqual([])
  })

  it('releases the registration when upstream\'s command line fails', async () => {
    const failing: PluginDependencies = { ...dependencies([]), runUpstream: () => Promise.reject(new Error('pnpm vanished')) }
    await expect(plugin(['add', 'some-plugin'], context, failing)).rejects.toThrow('pnpm vanished')
    expect(registrations()).toEqual([])
  })

  it('refuses while an exclusive user runs, without running upstream\'s command line or staying registered', async () => {
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
    children.push(other)
    const pid = other.pid ?? 0
    const runs: { argv: readonly string[], registered: string[] }[] = []
    await prepareHome(context, undefined)
    registerDataUser(deloHome, 'exclusive', 'import', pid)
    await expect(plugin(['add', 'some-plugin'], context, dependencies(runs))).rejects.toThrow(new CliError(EXIT.failed, `delorun plugin: process ${String(pid)} (delorun import) is changing the stores this command uses; wait for it to finish, and try again`))
    expect(runs).toEqual([])
    expect(registrations()).toEqual([String(pid)])
  })

  it('sets the profile\'s packages to be copied from pnpm\'s store before pnpm runs, keeping its other settings', async () => {
    await prepareHome(context, undefined)
    writeEmptyProfile()
    const seen: string[] = []
    const deps: PluginDependencies = { ...dependencies([]), runUpstream: () => { seen.push(readFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'utf8')); return Promise.resolve(0) } }
    await plugin(['list'], context, deps)
    expect(seen).toEqual(['# the profile\'s pnpm settings\npackages:\n  - .\n\nnodeLinker: hoisted\npackageImportMethod: copy\n'])
  })

  it('checks and records what an installation brought, and prints every finding', async () => {
    await prepareHome(context, undefined)
    writeEmptyProfile()
    standIn.answers.advisories = { 'good-plugin': [advisory('GHSA-2222-3333-4444', 'high', '*')] }
    expect(await plugin(['add', 'good-plugin'], context, dependencies([]))).toBe(0)
    expect(errors.join('')).toBe([
      'delorun: checked good-plugin 1.0.0: 1 warning, which you should read before you use it:\n',
      '  warning: GHSA-2222-3333-4444 (high) affects good-plugin@1.0.0: A flaw in the package (GHSA-2222-3333-4444) (pnpm-lock.yaml:13)\n',
    ].join(''))
    expect(existsSync(recordPath(profileDir, 'good-plugin'))).toBe(true)
  })

  it('refuses a known critical advisory: the profile goes back as it was, is installed again, and the command fails', async () => {
    await prepareHome(context, undefined)
    writeEmptyProfile()
    const before = readFileSync(join(profileDir, 'package.json'), 'utf8')
    standIn.answers.advisories = { 'good-plugin': [advisory('GHSA-2222-3333-4444', 'critical', '*')] }
    const runs: { argv: readonly string[], registered: string[] }[] = []
    expect(await plugin(['add', 'good-plugin'], context, dependencies(runs))).toBe(EXIT.failed)
    expect(runs.map(run => run.argv)).toEqual([['plugin', 'add', 'good-plugin'], ['plugin', '--profile', 'default', 'install']])
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe(before)
    expect(existsSync(join(profileDir, 'pnpm-lock.yaml'))).toBe(false)
    expect(existsSync(recordPath(profileDir, 'good-plugin'))).toBe(false)
    const printed = errors.join('')
    expect(printed).toContain('delorun: refused good-plugin 1.0.0: a known critical advisory affects it, so it was not installed:\n')
    expect(printed).toContain('  To install it anyway, run the same command with --allow-advisory GHSA-2222-3333-4444\n')
    expect(printed).toContain('delorun plugin: the profile default is back as it was before this command\n')
  })

  it('installs a known critical advisory that --allow-advisory names, without passing the option to pnpm', async () => {
    await prepareHome(context, undefined)
    writeEmptyProfile()
    standIn.answers.advisories = { 'good-plugin': [advisory('GHSA-2222-3333-4444', 'critical', '*')] }
    const runs: { argv: readonly string[], registered: string[] }[] = []
    expect(await plugin(['add', 'good-plugin', '--allow-advisory', 'GHSA-2222-3333-4444'], context, dependencies(runs))).toBe(0)
    expect(runs.map(run => run.argv)).toEqual([['plugin', 'add', 'good-plugin']])
    expect(errors.join('')).toContain('  critical: GHSA-2222-3333-4444 (critical) affects good-plugin@1.0.0')
    expect(existsSync(recordPath(profileDir, 'good-plugin'))).toBe(true)
  })

  it('checks nothing after a failed operation, or with the check switched off', async () => {
    await prepareHome(context, undefined)
    writeEmptyProfile()
    const failed: PluginDependencies = { ...dependencies([]), runUpstream: () => Promise.resolve(7) }
    expect(await plugin(['add', 'good-plugin'], context, failed)).toBe(7)
    expect(await plugin(['add', 'good-plugin'], context, { ...dependencies([]), checkSettings: () => Promise.resolve(undefined) })).toBe(0)
    expect(errors).toEqual([])
    expect(existsSync(recordPath(profileDir, 'good-plugin'))).toBe(false)
  })
})

describe('--allow-advisory', () => {
  it('takes each id in either form and leaves every other argument, and those after --, to pnpm', () => {
    expect(takeAllowedAdvisories(['add', 'x', '--allow-advisory', 'GHSA-2222-3333-4444', '--allow-advisory=GHSA-5555-6666-7777', '--', '--allow-advisory'])).toEqual({ allowed: ['GHSA-2222-3333-4444', 'GHSA-5555-6666-7777'], rest: ['add', 'x', '--', '--allow-advisory'] })
  })

  it('refuses a missing value or one that is not a GitHub advisory id', () => {
    expect(() => takeAllowedAdvisories(['add', 'x', '--allow-advisory'])).toThrow(new CliError(EXIT.usage, 'delorun plugin: --allow-advisory takes a GitHub advisory id such as GHSA-xxxx-xxxx-xxxx'))
    expect(() => takeAllowedAdvisories(['--allow-advisory=CVE-2026-1'])).toThrow(new CliError(EXIT.usage, 'delorun plugin: --allow-advisory takes a GitHub advisory id such as GHSA-xxxx-xxxx-xxxx, not "CVE-2026-1"'))
  })
})
