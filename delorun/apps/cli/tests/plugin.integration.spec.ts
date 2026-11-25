/**
 * `delorun plugin` (`delorun/apps/cli/src/upstream.ts`) registers as a shared user of the home's stores before it runs
 * upstream's `dsh plugin`, and releases the registration when upstream's command line ends or fails. While an exclusive
 * user runs it refuses and upstream's command line does not run. Before pnpm runs, the profile's packages are set to be
 * copied from pnpm's store; after a successful operation, the install check checks and records each plugin it
 * installed, prints every finding, and refuses a known critical advisory unless `--allow-advisory` names it, or a check
 * that cannot run, putting the profile back as it was. Upstream's command line is replaced by one that records its
 * arguments and writes the profile files a package operation would; a loopback stand-in answers for the advisory feed
 * and the registry.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DATA_USERS_DIRECTORY } from '@delorun/contract-home-layout'
import { reconcileProfile, recordPath } from '@delorun/plugin-install-check/check'
import { advisory, OLD, settingsFor, startStandIn, writeProfileFiles, type StandIn } from '@delorun/plugin-install-check/tests/fixture'
import { prepareHome, type CommandContext } from '../src/command.ts'
import { CliError, EXIT } from '../src/exit.ts'
import { registerDataUser } from '../src/home-exclusion.ts'
import { installsPackages, resolveOnly, takeAllowedAdvisories, type ProfileCheckSettings } from '../src/plugin-install-check.ts'
import { plugin, pluginCommand, type PluginDependencies, type UpstreamOperation } from '../src/upstream.ts'

// The check's own call can be made to throw; every other call passes through to the real check.
vi.mock('@delorun/plugin-install-check/check', async (importActual) => {
  const actual = await importActual<typeof import('@delorun/plugin-install-check/check')>()
  return { ...actual, reconcileProfile: vi.fn(actual.reconcileProfile) }
})

let osHome: string
let delorunHome: string
let profileDir: string
let context: CommandContext
let errors: string[]
let standIn: StandIn
const children: ChildProcess[] = []

beforeEach(async () => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-plugin-')))
  delorunHome = join(osHome, '.delorun')
  profileDir = join(delorunHome, 'profiles', 'default')
  vi.stubEnv('HOME', osHome)
  vi.stubEnv('USERPROFILE', osHome)
  vi.stubEnv('DELORUN_HOME', undefined)
  vi.stubEnv('DELORUN_PROFILE', undefined)
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
  const directory = join(delorunHome, 'run', DATA_USERS_DIRECTORY)
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

/** A second plugin, for a profile that keeps one plugin while it removes another. */
const OTHER = { name: 'other-plugin', version: '1.0.0', direct: true } as const

/** Write a set-up profile with nothing installed yet. */
function writeEmptyProfile(): void {
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), '{"name":"profile","private":true}\n')
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), '# the profile\'s pnpm settings\npackages:\n  - .\n\nnodeLinker: hoisted\n')
}

/** A content version, as the store names one. */
const VERSION = 'a'.repeat(64)

/**
 * @param name - a package name.
 * @returns the load copy Changes keeps for it under the default profile.
 */
function copyOf(name: string): string {
  return join(delorunHome, 'changes', 'profiles', 'default', 'active', name)
}

/**
 * Plant what a start leaves for the plugins a profile loads from copies: each one's active directory, the `active.json`
 * naming them and an empty change log beside them.
 * @param names - the plugins the profile has a copy of.
 */
function plantCopies(names: readonly string[]): void {
  const profileChanges = join(delorunHome, 'changes', 'profiles', 'default')
  mkdirSync(join(profileChanges, 'active'), { recursive: true, mode: 0o700 })
  const plugins: Record<string, { readonly version: string, readonly kind: string }> = {}
  for (const name of names) {
    mkdirSync(copyOf(name), { recursive: true, mode: 0o755 })
    writeFileSync(join(copyOf(name), 'index.js'), `export default ${JSON.stringify(name)}\n`)
    plugins[name] = { version: VERSION, kind: 'approved' }
  }
  writeFileSync(join(profileChanges, 'active.json'), `${JSON.stringify({ schema: 'delorun.changes-active/1', plugins }, null, 2)}\n`, { mode: 0o600 })
  writeFileSync(join(profileChanges, 'log.json'), `${JSON.stringify({ schema: 'delorun.changes-log/1', entries: [] }, null, 2)}\n`, { mode: 0o600 })
}

/**
 * @returns the plugins the planted `active.json` names.
 */
function activeRecord(): Record<string, unknown> {
  const record = JSON.parse(readFileSync(join(delorunHome, 'changes', 'profiles', 'default', 'active.json'), 'utf8')) as { plugins: Record<string, unknown> }
  return record.plugins
}

/**
 * Dependencies whose upstream command succeeds and leaves the profile depending on `kept` alone, with no install check.
 * @param kept - the packages the profile still depends on after the removal.
 * @returns the dependencies.
 */
function removing(kept: Parameters<typeof writeProfileFiles>[1]): PluginDependencies {
  return { ...dependencies([]), checkSettings: () => Promise.resolve(undefined), runUpstream: () => { writeProfileFiles(profileDir, kept); return Promise.resolve(0) } }
}

describe('delorun plugin', () => {
  it('says when the profile has no plugins to list, since pnpm prints nothing for it', async () => {
    await prepareHome(context, undefined, true)
    writeEmptyProfile()
    const printed: string[] = []
    const listing: CommandContext = { ...context, stdout: (text) => { printed.push(text) } }
    expect(await plugin(['--profile', 'default', 'list'], listing, dependencies([]))).toBe(0)
    expect(printed).toEqual(['No plugins added to the profile default.\n'])
  })

  it('prints nothing extra when a profile lists plugins', async () => {
    await prepareHome(context, undefined, true)
    writeEmptyProfile()
    writeFileSync(join(profileDir, 'package.json'), '{"name":"profile","private":true,"dependencies":{"good-plugin":"1.0.0"}}\n')
    const printed: string[] = []
    const listing: CommandContext = { ...context, stdout: (text) => { printed.push(text) } }
    expect(await plugin(['--profile', 'default', 'ls'], listing, dependencies([]))).toBe(0)
    expect(printed).toEqual([])
  })

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
    await prepareHome(context, undefined, true)
    registerDataUser(delorunHome, 'exclusive', 'import', pid)
    await expect(plugin(['add', 'some-plugin'], context, dependencies(runs))).rejects.toThrow(new CliError(EXIT.failed, `delorun plugin: process ${String(pid)} (delorun import) is changing the stores this command uses; wait for it to finish, and try again`))
    expect(runs).toEqual([])
    expect(registrations()).toEqual([String(pid)])
  })

  it('sets the profile\'s packages to be copied from pnpm\'s store before pnpm runs, keeping its other settings', async () => {
    await prepareHome(context, undefined, true)
    writeEmptyProfile()
    const seen: string[] = []
    const deps: PluginDependencies = { ...dependencies([]), runUpstream: () => { seen.push(readFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'utf8')); return Promise.resolve(0) } }
    await plugin(['list'], context, deps)
    expect(seen).toEqual(['# the profile\'s pnpm settings\npackages:\n  - .\n\nnodeLinker: hoisted\npackageImportMethod: copy\n'])
  })

  it('resolves an installation, checks the lockfile, installs it, then records it, printing every finding', async () => {
    await prepareHome(context, undefined, true)
    writeEmptyProfile()
    standIn.answers.advisories = { 'good-plugin': [advisory('GHSA-2222-3333-4444', 'high', '*')] }
    const runs: Run[] = []
    const before = readFileSync(join(profileDir, 'package.json'), 'utf8')
    expect(await plugin(['add', 'good-plugin'], context, dependencies(runs))).toBe(0)
    expect(runs.map(run => run.argv)).toEqual([['plugin', '--profile', 'default', 'add', 'good-plugin', '--lockfile-only', '--ignore-scripts'], ['plugin', '--profile', 'default', 'install', '--frozen-lockfile']])
    // The resolution activates no bundle; the installation compares and restores against the profile before it.
    expect(runs.map(run => run.operation)).toEqual([{ activateNewBundles: false }, { baseline: { manifest: before, lockfile: undefined }, capture: expect.stringContaining('plugin-output-') }])
    expect(errors.join('')).toBe([
      'delorun: checked good-plugin 1.0.0: 1 warning, which you should read before you use it:\n',
      '  warning: GHSA-2222-3333-4444 (high) affects good-plugin@1.0.0: A flaw in the package (GHSA-2222-3333-4444) (pnpm-lock.yaml:13)\n',
    ].join(''))
    expect(existsSync(recordPath(profileDir, 'good-plugin'))).toBe(true)
  })

  it('repeats the options that restrict pnpm in the installation step, which runs the install scripts', async () => {
    await prepareHome(context, undefined, true)
    writeEmptyProfile()
    const runs: Run[] = []
    const restricting = ['--ignore-scripts', '--offline', '--prefer-offline', '--loglevel', 'debug', '--reporter=silent', '--config.store-dir=/tmp/store', '--registry', 'http://registry.example.test/']
    expect(await plugin(['add', 'good-plugin', '--filter', '.', ...restricting], context, dependencies(runs))).toBe(0)
    expect(runs[0]!.argv).toEqual(['plugin', '--profile', 'default', 'add', 'good-plugin', '--filter', '.', ...restricting, '--lockfile-only'])
    expect(runs[1]!.argv).toEqual(['plugin', '--profile', 'default', 'install', '--frozen-lockfile', ...restricting])
    expect(runs[1]!.argv).toContain('--ignore-scripts')
  })

  it('refuses a known critical advisory after resolution: nothing is installed, the files go back, and the command fails', async () => {
    await prepareHome(context, undefined, true)
    writeEmptyProfile()
    const before = readFileSync(join(profileDir, 'package.json'), 'utf8')
    standIn.answers.advisories = { 'good-plugin': [advisory('GHSA-2222-3333-4444', 'critical', '*')] }
    const runs: Run[] = []
    expect(await plugin(['add', 'good-plugin'], context, dependencies(runs))).toBe(EXIT.failed)
    expect(runs.map(run => run.argv)).toEqual([['plugin', '--profile', 'default', 'add', 'good-plugin', '--lockfile-only', '--ignore-scripts']])
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
    await prepareHome(context, undefined, true)
    writeEmptyProfile()
    standIn.answers.advisories = { 'good-plugin': [advisory('GHSA-2222-3333-4444', 'critical', '*')] }
    const runs: Run[] = []
    expect(await plugin(['add', 'good-plugin', '--allow-advisory', 'GHSA-2222-3333-4444', '--registry=http://registry.example.test/'], context, dependencies(runs))).toBe(0)
    expect(runs.map(run => run.argv)).toEqual([
      ['plugin', '--profile', 'default', 'add', 'good-plugin', '--registry=http://registry.example.test/', '--lockfile-only', '--ignore-scripts'],
      ['plugin', '--profile', 'default', 'install', '--frozen-lockfile', '--registry=http://registry.example.test/'],
    ])
    expect(errors.join('')).toContain('  critical: GHSA-2222-3333-4444 (critical) affects good-plugin@1.0.0')
    expect(errors.join('')).toContain('  warning: The registry http://registry.example.test/ is plain http, so a package and its integrity hash could be altered in transit')
    expect(existsSync(recordPath(profileDir, 'good-plugin'))).toBe(true)
  })

  it('puts the profile files back byte for byte when the installation step fails, so the plugin is neither listed nor recorded', async () => {
    await prepareHome(context, undefined, true)
    writeEmptyProfile()
    writeProfileFiles(profileDir, [])
    const manifest = readFileSync(join(profileDir, 'package.json'), 'utf8')
    const lockfile = readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')
    const failing: PluginDependencies = { ...dependencies([]), runUpstream: (argv) => {
      if (argv.includes('--lockfile-only')) writeProfileFiles(profileDir, [GOOD], { installed: false })
      return Promise.resolve(argv.includes('--frozen-lockfile') ? 1 : 0)
    } }
    expect(await plugin(['add', 'good-plugin'], context, failing)).toBe(1)
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe(manifest)
    expect(readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')).toBe(lockfile)
    expect(existsSync(recordPath(profileDir, 'good-plugin'))).toBe(false)
    expect(errors.join('')).toContain('delorun plugin: the installation failed, so the profile default is back as it was before this command\n')
  })

  it('refuses the installation when the check throws, and puts the profile back', async () => {
    await prepareHome(context, undefined, true)
    writeEmptyProfile()
    writeProfileFiles(profileDir, [])
    const manifest = readFileSync(join(profileDir, 'package.json'), 'utf8')
    const lockfile = readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')
    vi.mocked(reconcileProfile).mockRejectedValueOnce(new Error('the advisory feed answered with garbage'))
    const runs: Run[] = []
    expect(await plugin(['add', 'good-plugin'], context, dependencies(runs))).toBe(EXIT.failed)
    expect(runs.map(run => run.argv)).toEqual([['plugin', '--profile', 'default', 'add', 'good-plugin', '--lockfile-only', '--ignore-scripts']])
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe(manifest)
    expect(readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')).toBe(lockfile)
    expect(errors.join('')).toContain('delorun: the plugins this command installs could not be checked, so they are refused: the advisory feed answered with garbage. Fix the cause, then run the command again.\n')
    expect(errors.join('')).toContain('delorun plugin: the profile default is back as it was before this command; nothing was installed into it and no install script ran\n')
  })

  it('refuses the installation when the lockfile does not read, rather than installing it unchecked', async () => {
    await prepareHome(context, undefined, true)
    writeEmptyProfile()
    const manifest = readFileSync(join(profileDir, 'package.json'), 'utf8')
    const runs: Run[] = []
    const unreadable: PluginDependencies = { ...dependencies(runs), runUpstream: (argv, operation) => {
      runs.push({ argv, registered: registrations(), ...operation === undefined ? {} : { operation } })
      writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'packages: [unclosed\n')
      return Promise.resolve(0)
    } }
    expect(await plugin(['add', 'good-plugin'], context, unreadable)).toBe(EXIT.failed)
    expect(runs.map(run => run.argv)).toEqual([['plugin', '--profile', 'default', 'add', 'good-plugin', '--lockfile-only', '--ignore-scripts']])
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe(manifest)
    expect(existsSync(join(profileDir, 'pnpm-lock.yaml'))).toBe(false)
    expect(errors.join('')).toContain('could not be checked, so they are refused: the lockfile is not YAML')
  })

  it('puts the profile files back when the installation step throws, and rethrows the error', async () => {
    await prepareHome(context, undefined, true)
    writeEmptyProfile()
    writeProfileFiles(profileDir, [])
    const manifest = readFileSync(join(profileDir, 'package.json'), 'utf8')
    const lockfile = readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')
    const throwing: PluginDependencies = { ...dependencies([]), runUpstream: (argv) => {
      if (argv.includes('--lockfile-only')) {
        writeProfileFiles(profileDir, [GOOD], { installed: false })
        return Promise.resolve(0)
      }
      return Promise.reject(new Error('pnpm vanished during the install'))
    } }
    await expect(plugin(['add', 'good-plugin'], context, throwing)).rejects.toThrow('pnpm vanished during the install')
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe(manifest)
    expect(readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')).toBe(lockfile)
  })

  it('resolves a removal, then installs and forgets the records of removed plugins', async () => {
    await prepareHome(context, undefined, true)
    writeEmptyProfile()
    await plugin(['add', 'good-plugin'], context, dependencies([]))
    expect(existsSync(recordPath(profileDir, 'good-plugin'))).toBe(true)
    const runs: Run[] = []
    const removing: PluginDependencies = { ...dependencies(runs), runUpstream: (argv) => { runs.push({ argv, registered: [] }); writeProfileFiles(profileDir, []); return Promise.resolve(0) } }
    expect(await plugin(['remove', 'good-plugin'], context, removing)).toBe(0)
    expect(runs.map(run => run.argv)).toEqual([
      ['plugin', '--profile', 'default', 'remove', 'good-plugin', '--lockfile-only', '--config.ignore-scripts=true'],
      ['plugin', '--profile', 'default', 'install', '--frozen-lockfile'],
    ])
    expect(existsSync(recordPath(profileDir, 'good-plugin'))).toBe(false)
  })

  it('forgets the load copy of a removed plugin, keeping the changes it was part of', async () => {
    await prepareHome(context, undefined, true)
    writeEmptyProfile()
    await plugin(['add', 'good-plugin'], context, dependencies([]))
    plantCopies(['good-plugin'])
    const changes = join(delorunHome, 'changes', 'profiles', 'default')
    const log = readFileSync(join(changes, 'log.json'), 'utf8')
    const removing: PluginDependencies = { ...dependencies([]), runUpstream: () => { writeProfileFiles(profileDir, []); return Promise.resolve(0) } }
    expect(await plugin(['remove', 'good-plugin'], context, removing)).toBe(0)
    expect(existsSync(copyOf('good-plugin'))).toBe(false)
    expect(activeRecord()).toEqual({})
    expect(readFileSync(join(changes, 'log.json'), 'utf8')).toBe(log)
  })

  it('leaves the load copy as it was when the removal fails', async () => {
    await prepareHome(context, undefined, true)
    writeEmptyProfile()
    writeProfileFiles(profileDir, [GOOD])
    plantCopies(['good-plugin'])
    const failing: PluginDependencies = { ...dependencies([]), checkSettings: () => Promise.resolve(undefined), runUpstream: () => Promise.resolve(7) }
    expect(await plugin(['remove', 'good-plugin'], context, failing)).toBe(7)
    expect(readFileSync(join(copyOf('good-plugin'), 'index.js'), 'utf8')).toBe('export default "good-plugin"\n')
    expect(activeRecord()).toHaveProperty('good-plugin')
  })

  it('keeps the copy of a plugin the profile still depends on', async () => {
    await prepareHome(context, undefined, true)
    writeEmptyProfile()
    writeProfileFiles(profileDir, [GOOD, OTHER])
    plantCopies(['good-plugin', 'other-plugin'])
    expect(await plugin(['remove', 'good-plugin'], context, removing([OTHER]))).toBe(0)
    expect(existsSync(copyOf('good-plugin'))).toBe(false)
    expect(readFileSync(join(copyOf('other-plugin'), 'index.js'), 'utf8')).toBe('export default "other-plugin"\n')
    expect(activeRecord()).toEqual({ 'other-plugin': { version: VERSION, kind: 'approved' } })
  })

  it('keeps the load copy when the person limited the removal to the lockfile', async () => {
    await prepareHome(context, undefined, true)
    writeEmptyProfile()
    writeProfileFiles(profileDir, [GOOD])
    plantCopies(['good-plugin'])
    expect(await plugin(['remove', 'good-plugin', '--lockfile-only'], context, removing([]))).toBe(0)
    expect(readFileSync(join(copyOf('good-plugin'), 'index.js'), 'utf8')).toBe('export default "good-plugin"\n')
    expect(activeRecord()).toHaveProperty('good-plugin')
  })

  it('checks an installation the person limited to the lockfile, and installs nothing', async () => {
    await prepareHome(context, undefined, true)
    writeEmptyProfile()
    const runs: Run[] = []
    expect(await plugin(['add', 'good-plugin', '--lockfile-only'], context, dependencies(runs))).toBe(0)
    expect(runs.map(run => run.argv)).toEqual([['plugin', '--profile', 'default', 'add', 'good-plugin', '--lockfile-only', '--ignore-scripts']])
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
      await prepareHome(context, undefined, true)
      writeEmptyProfile()
      const runs: Run[] = []
      expect(await plugin(argv, context, dependencies(runs))).toBe(0)
      expect(runs.map(run => run.argv.includes('--lockfile-only') ? 'resolve' : run.argv.includes('--frozen-lockfile') ? 'install' : 'direct')).toEqual(['resolve', 'install'])
    })
  }

  it('checks nothing after a failed operation, or with the check switched off', async () => {
    await prepareHome(context, undefined, true)
    writeEmptyProfile()
    const failed: PluginDependencies = { ...dependencies([]), runUpstream: () => Promise.resolve(7) }
    expect(await plugin(['add', 'good-plugin'], context, failed)).toBe(7)
    expect(await plugin(['add', 'good-plugin'], context, { ...dependencies([]), checkSettings: () => Promise.resolve(undefined) })).toBe(0)
    expect(errors).toEqual([])
    expect(existsSync(recordPath(profileDir, 'good-plugin'))).toBe(false)
  })
})

/** The key pnpm prints for the git-hosted package the stand-in refuses to build. */
const GIT_KEY = 'git-plug@git+file:///tmp/repo#8edca4e355d5677de0397415bf6ea4a7307bb076'

/**
 * Dependencies whose installation step prints pnpm's refusal of the git package's build into the kept output until the
 * profile's `pnpm-workspace.yaml` allows the exact key.
 * @param runs - receives each run's arguments and options.
 * @param options - `check` to switch the install check off with `undefined`; `afterStep` runs after each installation step.
 * @returns the dependencies.
 */
function refusingBuild(runs: Run[], options: { readonly check?: false, readonly afterStep?: (step: number) => void, readonly confirm?: (question: string) => Promise<boolean> } = {}): PluginDependencies {
  const base = dependencies(runs)
  let steps = 0
  return {
    ...base,
    ...options.check === false ? { checkSettings: () => Promise.resolve(undefined) } : {},
    ...options.confirm === undefined ? {} : { confirmBuild: options.confirm },
    runUpstream: (argv, operation) => {
      if (!argv.includes('--frozen-lockfile') && !(options.check === false && operation?.capture !== undefined)) return base.runUpstream(argv, operation)
      runs.push({ argv, registered: [], ...operation === undefined ? {} : { operation } })
      writeProfileFiles(profileDir, [GOOD], { installed: false })
      const workspace = join(profileDir, 'pnpm-workspace.yaml')
      const allowed = existsSync(workspace) && readFileSync(workspace, 'utf8').includes(`${GIT_KEY}: true`)
      if (operation?.capture !== undefined) writeFileSync(operation.capture, allowed ? 'Done\n' : `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED Failed to prepare git-hosted package\nallowBuilds:\n  ${GIT_KEY}: true\n`)
      options.afterStep?.(steps++)
      return Promise.resolve(allowed ? 0 : 1)
    },
  }
}

describe('a build pnpm refuses, with the install check on', () => {
  const add = ['add', 'good-plugin']

  beforeEach(async () => {
    await prepareHome(context, undefined, true)
    writeEmptyProfile()
  })

  it('is allowed after the person confirms, and only the installation step runs again, on the checked lockfile', async () => {
    const runs: Run[] = []
    const questions: string[] = []
    expect(await plugin(add, context, refusingBuild(runs, { confirm: (question) => { questions.push(question); return Promise.resolve(true) } }))).toBe(0)
    expect(runs.map(run => run.argv.includes('--lockfile-only'))).toEqual([true, false, false])
    expect(runs[1]!.argv).toEqual(runs[2]!.argv)
    expect(runs[2]!.argv).toContain('--frozen-lockfile')
    expect(questions).toHaveLength(1)
    expect(questions[0]).toContain(GIT_KEY)
    expect(readFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'utf8')).toContain(`${GIT_KEY}: true`)
    expect(existsSync(recordPath(profileDir, 'good-plugin'))).toBe(true)
  })

  it('is not run when the person declines: the profile files go back and nothing is recorded or allowed', async () => {
    const runs: Run[] = []
    const before = readFileSync(join(profileDir, 'package.json'), 'utf8')
    expect(await plugin(add, context, refusingBuild(runs, { confirm: () => Promise.resolve(false) }))).toBe(1)
    expect(runs).toHaveLength(2)
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe(before)
    expect(existsSync(join(profileDir, 'pnpm-lock.yaml'))).toBe(false)
    expect(readFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'utf8')).not.toContain(`${GIT_KEY}: true`)
    expect(existsSync(recordPath(profileDir, 'good-plugin'))).toBe(false)
    expect(errors.join('')).toContain('--allow-build git-plug')
  })

  it('is not run without a terminal or --allow-build', async () => {
    const runs: Run[] = []
    expect(await plugin(add, context, refusingBuild(runs))).toBe(1)
    expect(runs).toHaveLength(2)
    expect(readFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'utf8')).not.toContain(`${GIT_KEY}: true`)
  })

  it('is allowed without a prompt by --allow-build naming the package, which pnpm never receives', async () => {
    const runs: Run[] = []
    expect(await plugin([...add, '--allow-build', 'git-plug'], context, refusingBuild(runs))).toBe(0)
    expect(runs).toHaveLength(3)
    expect(runs.flatMap(run => run.argv)).not.toContain('--allow-build')
    expect(existsSync(recordPath(profileDir, 'good-plugin'))).toBe(true)
  })

  it('is not allowed by --allow-build naming a package pnpm did not print', async () => {
    const runs: Run[] = []
    expect(await plugin([...add, '--allow-build', 'other'], context, refusingBuild(runs))).toBe(1)
    expect(runs).toHaveLength(2)
    expect(readFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'utf8')).not.toContain(': true')
  })

  it.each(['*', 'git-*', 'git-plug?', '!git-plug', ''])('refuses --allow-build %j before any step runs', async (name) => {
    const runs: Run[] = []
    await expect(plugin([...add, '--allow-build', name], context, refusingBuild(runs))).rejects.toThrow(CliError)
    expect(runs).toEqual([])
  })

  it('refuses when the lockfile changed between the check and the rerun, and puts the profile back', async () => {
    const runs: Run[] = []
    const before = readFileSync(join(profileDir, 'package.json'), 'utf8')
    const deps = refusingBuild(runs, { afterStep: () => { writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: changed\n') } })
    expect(await plugin([...add, '--allow-build', 'git-plug'], context, deps)).toBe(EXIT.failed)
    expect(runs).toHaveLength(2)
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe(before)
    expect(existsSync(join(profileDir, 'pnpm-lock.yaml'))).toBe(false)
    expect(existsSync(recordPath(profileDir, 'good-plugin'))).toBe(false)
  })

  it('refuses when the rerun itself changes the lockfile, and puts the profile back', async () => {
    const runs: Run[] = []
    const before = readFileSync(join(profileDir, 'package.json'), 'utf8')
    const deps = refusingBuild(runs, { afterStep: (step) => { if (step === 1) writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: changed\n') } })
    expect(await plugin([...add, '--allow-build', 'git-plug'], context, deps)).toBe(EXIT.failed)
    expect(runs).toHaveLength(3)
    expect(errors.join('')).toContain('differs from the one the install check read')
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe(before)
    expect(existsSync(join(profileDir, 'pnpm-lock.yaml'))).toBe(false)
    expect(existsSync(recordPath(profileDir, 'good-plugin'))).toBe(false)
  })

  it('stops at an advisory refusal in the resolution, before any build prompt', async () => {
    standIn.answers.advisories = { 'good-plugin': [advisory('GHSA-2222-3333-4444', 'critical', '*')] }
    const runs: Run[] = []
    const asked = vi.fn(() => Promise.resolve(true))
    expect(await plugin([...add, '--allow-build', 'git-plug'], context, refusingBuild(runs, { confirm: asked }))).toBe(EXIT.failed)
    expect(runs).toHaveLength(1)
    expect(asked).not.toHaveBeenCalled()
  })
})

describe('a build pnpm refuses, with the install check off', () => {
  beforeEach(async () => {
    await prepareHome(context, undefined, true)
    writeEmptyProfile()
  })

  it('runs the whole operation again once the person allows the build', async () => {
    const runs: Run[] = []
    expect(await plugin(['add', 'git+file:///tmp/repo'], context, refusingBuild(runs, { check: false, confirm: () => Promise.resolve(true) }))).toBe(0)
    expect(runs.map(run => run.argv)).toEqual([['plugin', '--profile', 'default', 'add', 'git+file:///tmp/repo'], ['plugin', '--profile', 'default', 'add', 'git+file:///tmp/repo']])
  })

  it('does not run it again when the person declines', async () => {
    const runs: Run[] = []
    expect(await plugin(['add', 'git+file:///tmp/repo'], context, refusingBuild(runs, { check: false, confirm: () => Promise.resolve(false) }))).toBe(EXIT.failed)
    expect(runs).toHaveLength(1)
  })
})

describe('the plugin command', () => {
  it('sends check and dev to Delorun\'s own commands, which refuse a wrong command line before any profile changes', async () => {
    await expect(pluginCommand.run(['check'], context)).rejects.toThrow('usage: delorun plugin check <directory>')
    await expect(pluginCommand.run(['dev'], context)).rejects.toThrow('usage: delorun plugin dev <folder>')
    expect(existsSync(join(delorunHome, 'profiles'))).toBe(false)
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
    vi.stubEnv('DSH_HOME', delorunHome)
    vi.stubEnv('MARKER', join(osHome, 'postinstall-ran'))
    await prepareHome(context, undefined, true)
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

  it('runs no approved git prepare script while it resolves: a lockfile-only run leaves no marker', async () => {
    const repository = join(osHome, 'repository')
    const marker = join(osHome, 'prepare-ran')
    mkdirSync(repository)
    const env = { ...process.env, GIT_CONFIG_GLOBAL: join(osHome, 'git.config'), GIT_CONFIG_NOSYSTEM: '1' }
    writeFileSync(env.GIT_CONFIG_GLOBAL, '')
    const git = (args: string[]): string => execFileSync('git', args, { cwd: repository, env, encoding: 'utf8', timeout: 30_000 })
    git(['init', '--initial-branch=main'])
    writeFileSync(join(repository, 'package.json'), JSON.stringify({ name: 'git-prepared', version: '1.0.0', scripts: { prepare: 'node build.cjs' } }))
    writeFileSync(join(repository, 'build.cjs'), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")\n`)
    git(['add', '.'])
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'])
    const spec = `git+${pathToFileURL(repository).href}`
    // The prepare script is approved under its commit-exact key, so only the resolution's own flags keep it from running.
    writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), `packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nstoreDir: ${join(osHome, 'pnpm-store')}\nallowBuilds:\n  '${`git-prepared@${spec}#${git(['rev-parse', 'HEAD']).trim()}`}': true\n`)
    vi.stubEnv('GIT_CONFIG_GLOBAL', env.GIT_CONFIG_GLOBAL)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    expect(await plugin(['add', spec, '--lockfile-only'], context, realPnpm())).toBe(0)
    expect(readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')).toContain('git-prepared')
    expect(existsSync(marker)).toBe(false)
  })

  it('resolves a removal with arguments the real pnpm accepts, and the lockfile loses the package', () => {
    const dependency = join(osHome, 'removable')
    const project = join(osHome, 'removal-project')
    mkdirSync(dependency)
    mkdirSync(project)
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'removable', version: '1.0.0' }))
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'removal-project', version: '1.0.0', private: true }))
    const run = (args: string[]): string => execFileSync('pnpm', ['--dir', project, ...args], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: osHome } })
    run(['add', `file:${dependency}`, '--ignore-scripts'])
    expect(readFileSync(join(project, 'pnpm-lock.yaml'), 'utf8')).toContain('removable')
    run(resolveOnly(['remove', 'removable']))
    expect(readFileSync(join(project, 'pnpm-lock.yaml'), 'utf8')).not.toContain('removable')
  })

  it('runs the approved postinstall only after the check passed, and records the installed files after it', async () => {
    standIn.answers.advisories = { 'evil-plugin': [advisory('GHSA-2222-3333-4444', 'critical', '*')] }
    expect(await plugin(['add', 'evil-plugin', `--registry=${standIn.registry}`, '--allow-advisory', 'GHSA-2222-3333-4444'], context, realPnpm())).toBe(0)
    expect(readFileSync(join(osHome, 'postinstall-ran'), 'utf8')).toBe('ran')
    expect(existsSync(recordPath(profileDir, 'evil-plugin'))).toBe(true)
  })
})
