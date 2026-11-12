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
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DATA_USERS_DIRECTORY } from '@delo/contract-home-layout'
import { recordPath } from '@delo/plugin-install-check/check'
import { advisory, OLD, settingsFor, startStandIn, writeProfileFiles, type StandIn } from '@delo/plugin-install-check/tests/fixture'
import { prepareHome, type CommandContext } from '../src/command.ts'
import { CliError, EXIT } from '../src/exit.ts'
import { registerDataUser } from '../src/home-exclusion.ts'
import { installsPackages, takeAllowedAdvisories, type ProfileCheckSettings } from '../src/plugin-install-check.ts'
import { plugin, type PluginDependencies, type UpstreamOperation } from '../src/upstream.ts'

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

/** One upstream run the stand-in command saw: its arguments, the registrations then, and the operation options it got. */
interface Run { argv: readonly string[], registered: string[], operation?: UpstreamOperation }

/**
 * Dependencies whose upstream command records its arguments and, for `add`, installs `good-plugin` into the profile.
 * @param runs - receives each run's arguments and the registrations it saw.
 * @param check - the install check's settings; the stand-in's by default.
 * @returns the dependencies and the exit listeners registered.
 */
function dependencies(runs: Run[], check: ProfileCheckSettings = { settings: settingsFor(standIn), knownNames: new Set() }): PluginDependencies {
  return {
    runUpstream: (argv, operation) => {
      runs.push({ argv, registered: registrations(), ...operation === undefined ? {} : { operation } })
      // pnpm's resolution writes the manifest and the lockfile; its installation writes the packages.
      if (argv.includes('--lockfile-only')) writeProfileFiles(profileDir, [GOOD], { installed: false })
      if (argv.includes('--frozen-lockfile')) writeProfileFiles(profileDir, [GOOD])
      return Promise.resolve(0)
    },
    checkSettings: () => Promise.resolve(check),
    profileRegistry: () => Promise.resolve(null),
    installAnchor: () => Promise.resolve(join(osHome, 'no-installation', 'package.json')),
    onExit: () => undefined,
  }
}

/** The plugin the stand-in upstream command installs. */
const GOOD = { name: 'good-plugin', version: '1.0.0', direct: true } as const

/** Write a set-up profile with nothing installed yet. */
function writeEmptyProfile(): void {
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), '{"name":"profile","private":true}\n')
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), '# the profile\'s pnpm settings\npackages:\n  - .\n\nnodeLinker: hoisted\n')
}

describe('delorun plugin', () => {
  it('runs upstream\'s plugin command registered as a shared user, and releases the registration afterwards', async () => {
    const runs: Run[] = []
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
    const runs: Run[] = []
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

  it('resolves an installation, checks the lockfile, installs it, then records it, printing every finding', async () => {
    await prepareHome(context, undefined)
    writeEmptyProfile()
    standIn.answers.advisories = { 'good-plugin': [advisory('GHSA-2222-3333-4444', 'high', '*')] }
    const runs: Run[] = []
    const before = readFileSync(join(profileDir, 'package.json'), 'utf8')
    expect(await plugin(['add', 'good-plugin'], context, dependencies(runs))).toBe(0)
    expect(runs.map(run => run.argv)).toEqual([['plugin', '--profile', 'default', 'add', 'good-plugin', '--lockfile-only'], ['plugin', '--profile', 'default', 'install', '--frozen-lockfile']])
    // The resolution activates no bundle; the installation compares and restores against the profile before it.
    expect(runs.map(run => run.operation)).toEqual([{ activateNewBundles: false }, { baseline: { manifest: before, lockfile: undefined } }])
    expect(errors.join('')).toBe([
      'delorun: checked good-plugin 1.0.0: 1 warning, which you should read before you use it:\n',
      '  warning: GHSA-2222-3333-4444 (high) affects good-plugin@1.0.0: A flaw in the package (GHSA-2222-3333-4444) (pnpm-lock.yaml:13)\n',
    ].join(''))
    expect(existsSync(recordPath(profileDir, 'good-plugin'))).toBe(true)
  })

  it('repeats the options that restrict pnpm in the installation step, which runs the install scripts', async () => {
    await prepareHome(context, undefined)
    writeEmptyProfile()
    const runs: Run[] = []
    const restricting = ['--ignore-scripts', '--offline', '--prefer-offline', '--loglevel', 'debug', '--reporter=silent', '--config.store-dir=/tmp/store', '--registry', 'http://registry.example.test/']
    expect(await plugin(['add', 'good-plugin', '--filter', '.', ...restricting], context, dependencies(runs))).toBe(0)
    expect(runs[0]!.argv).toEqual(['plugin', '--profile', 'default', 'add', 'good-plugin', '--filter', '.', ...restricting, '--lockfile-only'])
    expect(runs[1]!.argv).toEqual(['plugin', '--profile', 'default', 'install', '--frozen-lockfile', ...restricting])
    expect(runs[1]!.argv).toContain('--ignore-scripts')
  })

  it('refuses a known critical advisory after resolution: nothing is installed, the files go back, and the command fails', async () => {
    await prepareHome(context, undefined)
    writeEmptyProfile()
    const before = readFileSync(join(profileDir, 'package.json'), 'utf8')
    standIn.answers.advisories = { 'good-plugin': [advisory('GHSA-2222-3333-4444', 'critical', '*')] }
    const runs: Run[] = []
    expect(await plugin(['add', 'good-plugin'], context, dependencies(runs))).toBe(EXIT.failed)
    expect(runs.map(run => run.argv)).toEqual([['plugin', '--profile', 'default', 'add', 'good-plugin', '--lockfile-only']])
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe(before)
    expect(existsSync(join(profileDir, 'pnpm-lock.yaml'))).toBe(false)
    expect(existsSync(join(profileDir, 'node_modules'))).toBe(false)
    expect(existsSync(recordPath(profileDir, 'good-plugin'))).toBe(false)
    const printed = errors.join('')
    expect(printed).toContain('delorun: refused good-plugin 1.0.0: a known critical advisory affects it, so it was not installed:\n')
    expect(printed).toContain('  To install it anyway, run the same command with --allow-advisory GHSA-2222-3333-4444\n')
    expect(printed).toContain('delorun plugin: the profile default is back as it was before this command; nothing was installed into it and no install script ran\n')
  })

  it('installs a known critical advisory that --allow-advisory names, without passing the option to pnpm', async () => {
    await prepareHome(context, undefined)
    writeEmptyProfile()
    standIn.answers.advisories = { 'good-plugin': [advisory('GHSA-2222-3333-4444', 'critical', '*')] }
    const runs: Run[] = []
    expect(await plugin(['add', 'good-plugin', '--allow-advisory', 'GHSA-2222-3333-4444', '--registry=http://registry.example.test/'], context, dependencies(runs))).toBe(0)
    expect(runs.map(run => run.argv)).toEqual([
      ['plugin', '--profile', 'default', 'add', 'good-plugin', '--registry=http://registry.example.test/', '--lockfile-only'],
      ['plugin', '--profile', 'default', 'install', '--frozen-lockfile', '--registry=http://registry.example.test/'],
    ])
    expect(errors.join('')).toContain('  critical: GHSA-2222-3333-4444 (critical) affects good-plugin@1.0.0')
    expect(errors.join('')).toContain('  warning: The registry http://registry.example.test/ is plain http, so a package could be altered in transit')
    expect(existsSync(recordPath(profileDir, 'good-plugin'))).toBe(true)
  })

  it('resolves a removal, then installs and forgets the records of removed plugins', async () => {
    await prepareHome(context, undefined)
    writeEmptyProfile()
    await plugin(['add', 'good-plugin'], context, dependencies([]))
    expect(existsSync(recordPath(profileDir, 'good-plugin'))).toBe(true)
    const runs: Run[] = []
    const removing: PluginDependencies = { ...dependencies(runs), runUpstream: (argv) => { runs.push({ argv, registered: [] }); writeProfileFiles(profileDir, []); return Promise.resolve(0) } }
    expect(await plugin(['remove', 'good-plugin'], context, removing)).toBe(0)
    expect(runs.map(run => run.argv)).toEqual([
      ['plugin', '--profile', 'default', 'remove', 'good-plugin', '--lockfile-only'],
      ['plugin', '--profile', 'default', 'install', '--frozen-lockfile'],
    ])
    expect(existsSync(recordPath(profileDir, 'good-plugin'))).toBe(false)
  })

  it('checks an installation the person limited to the lockfile, and installs nothing', async () => {
    await prepareHome(context, undefined)
    writeEmptyProfile()
    const runs: Run[] = []
    expect(await plugin(['add', 'good-plugin', '--lockfile-only'], context, dependencies(runs))).toBe(0)
    expect(runs.map(run => run.argv)).toEqual([['plugin', '--profile', 'default', 'add', 'good-plugin', '--lockfile-only']])
    expect(errors.join('')).toBe('delorun: checked good-plugin 1.0.0: no warnings\n')
    expect(existsSync(recordPath(profileDir, 'good-plugin'))).toBe(false)
  })

  for (const argv of [
    ['--registry', 'http://registry.example.test/', 'add', 'good-plugin'],
    ['--loglevel', 'debug', 'add', 'good-plugin'],
    ['-C', '.', 'add', 'good-plugin'],
    ['--filter', '.', 'add', 'good-plugin'],
    ['--prefix', 'bin', 'add', 'good-plugin'],
    ['dedupe'],
    ['it'],
    ['patch-commit', 'good-plugin'],
  ]) {
    it(`resolves, checks and then installs for ${argv.join(' ')}`, async () => {
      await prepareHome(context, undefined)
      writeEmptyProfile()
      const runs: Run[] = []
      expect(await plugin(argv, context, dependencies(runs))).toBe(0)
      expect(runs.map(run => run.argv.includes('--lockfile-only') ? 'resolve' : run.argv.includes('--frozen-lockfile') ? 'install' : 'direct')).toEqual(['resolve', 'install'])
    })
  }

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

describe('installsPackages', () => {
  for (const argv of [
    ['add', 'x'], ['install'], ['i'], ['update', 'x'], ['up'], ['upgrade'], ['remove', 'x'], ['dedupe'], ['it'], ['patch-commit', 'x'],
    ['--profile', 'default', 'add', 'x'], ['add', 'x', '--lockfile-only'], ['audit', '--fix'], ['audit', '--fix=true'],
    ['config', 'set', 'registry', 'https://r.example/'], ['config'], ['exec', 'ls'], ['unknown-command'], ['--', 'ls'],
    ['--registry', 'https://r.example/', 'add', 'x'], ['--loglevel', 'debug', 'add', 'x'], ['-C', '.', 'add', 'x'], ['--filter', '.', 'add', 'x'],
    ['--prefix', 'bin', 'add', 'x'], ['--silent', 'ls'],
  ]) {
    it(`installs for ${argv.join(' ')}`, () => { expect(installsPackages(argv)).toBe(true) })
  }

  for (const argv of [
    ['ls'], ['list'], ['ll'], ['la'], ['why', 'x'], ['outdated'], ['view', 'x'], ['info', 'x'], ['show', 'x'], ['help'], ['root'], ['bin'], ['licenses'],
    ['--loglevel', 'debug', 'why', 'x'], ['--registry=https://r.example/', 'ls'], ['--profile', 'default', 'list'],
    ['audit'], ['config', 'get', 'registry'], ['config', 'list'],
    ['--version'], ['-v'], ['--help'], ['-h'], [],
  ]) {
    it(`does not install for ${argv.length === 0 ? 'no arguments' : argv.join(' ')}`, () => { expect(installsPackages(argv)).toBe(false) })
  }
})

describe('delorun plugin with the real pnpm', { timeout: 120_000 }, () => {
  /** The repository's pinned pnpm, which upstream's plugin command runs here instead of the one on PATH. */
  const PNPM = fileURLToPath(new URL('../../../../node_modules/.bin/pnpm', import.meta.url))

  /**
   * Dependencies that run upstream's real plugin command with the repository's pnpm, and the install check against the
   * stand-in.
   * @returns the dependencies.
   */
  function realPnpm(): PluginDependencies {
    return {
      ...dependencies([]),
      runUpstream: async (argv, operation) => {
        const { parseDshArgs } = await import('@deepseek-ai/dsh/lib/args.js')
        const { runPlugin } = await import('@deepseek-ai/dsh/lib/plugin.js')
        const invocation = parseDshArgs(argv, '0.0.0')
        if (invocation.mode !== 'plugin') throw new Error('not a plugin command')
        return runPlugin(invocation.profile, invocation.args, { command: PNPM, args: [], env: {} }, operation)
      },
    }
  }

  beforeEach(async () => {
    vi.stubEnv('DSH_HOME', deloHome)
    vi.stubEnv('MARKER', join(osHome, 'postinstall-ran'))
    await prepareHome(context, undefined)
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), '{"name":"profile","private":true,"dependencies":{}}\n')
    writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), `packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nstoreDir: ${join(osHome, 'pnpm-store')}\nallowBuilds:\n  evil-plugin: true\n`)
    standIn.answers.packages = {
      'evil-plugin': {
        version: '1.0.0',
        files: { 'index.js': 'export default 1\n' },
        scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(process.env.MARKER, \'ran\')"' },
      },
    }
    standIn.answers.times['evil-plugin'] = { '1.0.0': OLD }
  })

  it('refuses a package with a known critical advisory and an approved postinstall before the script runs: its marker never appears', async () => {
    standIn.answers.advisories = { 'evil-plugin': [advisory('GHSA-2222-3333-4444', 'critical', '*')] }
    const before = readFileSync(join(profileDir, 'package.json'), 'utf8')
    expect(await plugin(['add', 'evil-plugin', `--registry=${standIn.registry}`], context, realPnpm())).toBe(EXIT.failed)
    expect(existsSync(join(osHome, 'postinstall-ran'))).toBe(false)
    expect(existsSync(join(profileDir, 'node_modules', 'evil-plugin'))).toBe(false)
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe(before)
    expect(errors.join('')).toContain('delorun: refused evil-plugin 1.0.0: a known critical advisory affects it, so it was not installed:\n')
  })

  it('runs the approved postinstall only after the check passed, and records the installed files after it', async () => {
    standIn.answers.advisories = { 'evil-plugin': [advisory('GHSA-2222-3333-4444', 'critical', '*')] }
    expect(await plugin(['add', 'evil-plugin', `--registry=${standIn.registry}`, '--allow-advisory', 'GHSA-2222-3333-4444'], context, realPnpm())).toBe(0)
    expect(readFileSync(join(osHome, 'postinstall-ran'), 'utf8')).toBe('ran')
    expect(existsSync(recordPath(profileDir, 'evil-plugin'))).toBe(true)
  })
})
