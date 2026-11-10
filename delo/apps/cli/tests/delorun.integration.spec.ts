import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunProfileOptions } from '@deepseek-ai/dsh/profile-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { DELO_PROFILE_BUNDLES, LOCAL_BUNDLE, STUDIO_BUNDLE } from '@delo/bundle-local/profile'
import { READ_EXEMPTIONS, RESERVED_PROFILE_NAMES, type RuntimeVersion } from '@delo/contract-home-layout'
import { attestTerminal, readApproved, readChangeLog, readWorkSession, startWork } from '@delo/changes'
import { brandString } from '@deepseek-ai/dsh-brand'
import { HostNotStoppedError, sendHomeRequest, type LocalDeviceApproval } from '@delo/home-process'
import { resolveSurface } from '@delo/logs'
import { reloadThroughChannel } from '../src/changes/command.ts'
import { parse, stringify } from 'yaml'
import { prepareHome, type CommandContext } from '../src/command.ts'
import { CliError, EXIT } from '../src/exit.ts'
import { main } from '../src/main.ts'
import { cliRefusal } from '../src/refusals.ts'
import { NO_APPROVED_CONTENT } from '../src/compose.ts'
import type { BootedRow } from '../src/delo-bundles.ts'
import { requestStudioLink } from '../src/open/studio.ts'
import { realPreStartSteps, startForeground, upstreamAddStudioBundle, upstreamDependencies, type StartDependencies } from '../src/start.ts'
import type { UpdateWatchOptions } from '../src/update/notice-host.ts'
import { runtimeOfFile } from '../src/update/runtime.ts'
import { composedBootRows, composedProviders } from './fixtures/composed-rows.ts'
import { LINKING_PROGRESS } from '../src/delo-bundles.ts'
import { DEFAULT_WORKSPACE_ENV } from '../src/default-workspace.ts'

const BIN = join(import.meta.dirname, '../src/bin.ts')
const BUNDLE_LOCAL_DIR = new URL('.', import.meta.resolve('@delo/bundle-local/package.json')).pathname
const TSX_LOADER = import.meta.resolve('tsx/esm')
const POSIX = process.platform !== 'win32'

let osHome: string
let deloHome: string
let dshHome: string
let desktopProfile: string

/**
 * Every file and directory under a root with its content hash, mode and link target, for byte-identity checks.
 * @param root - the tree's root.
 * @returns one line per entry, sorted.
 */
function snapshot(root: string): string[] {
  const lines: string[] = []
  const walk = (path: string): void => {
    const stats = lstatSync(path)
    const name = relative(root, path) || '.'
    if (stats.isDirectory()) {
      lines.push(`${name}/ ${(stats.mode & 0o777).toString(8)} ${String(stats.mtimeMs)}`)
      for (const entry of readdirSync(path)) walk(join(path, entry))
    } else {
      lines.push(`${name} ${(stats.mode & 0o777).toString(8)} ${String(stats.mtimeMs)} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`)
    }
  }
  walk(root)
  return lines.sort()
}

/**
 * Run `delorun` in a child process against the fixture OS home, from a directory without a `.env`.
 * @param args - the arguments.
 * @param env - variables added to the child's environment.
 * @returns its exit status and output.
 */
function delorun(args: readonly string[], env: Record<string, string> = {}): { status: number | null, stdout: string, stderr: string } {
  // NODE_PATH, which pnpm's script shims set, would let upstream resolve workspace packages no installation carries.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(DSH_|DELO_|NODE_PATH$|DEEPSEEK_API_KEY$)/.test(name)))
  const result = spawnSync(process.execPath, ['--import', TSX_LOADER, BIN, ...args], {
    cwd: osHome,
    env: { ...inherited, HOME: osHome, USERPROFILE: osHome, DSH_HOME: dshHome, DEEPSEEK_API_KEY: 'fixture-key', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  })
  // A child ended by its timeout or a signal reports that, with its output, instead of a status mismatch.
  if (result.error !== undefined || result.signal !== null) throw new Error(`delorun ${args.join(' ')} did not exit (${result.error?.message ?? String(result.signal)}):\n${result.stderr}`)
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

beforeEach(() => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-cli-')))
  deloHome = join(osHome, '.delo')
  dshHome = join(osHome, '.dsh')
  // Upstream's home with a profile, a credential file and a session, as a person who used dsh has it.
  mkdirSync(join(dshHome, 'profiles', 'web'), { recursive: true })
  writeFileSync(join(dshHome, 'profiles', 'web', 'package.json'), '{"name":"dsh-profile-web"}\n')
  writeFileSync(join(dshHome, '.credentials.yaml'), 'version: 1\n', { mode: 0o600 })
  mkdirSync(join(dshHome, 'sessions'))
  writeFileSync(join(dshHome, 'sessions', 's1.jsonl'), '{"type":"session/created"}\n')
  desktopProfile = join(deloHome, 'profiles', 'desktop')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(osHome, { recursive: true, force: true })
})

describe('delorun', { timeout: 60_000 }, () => {
  it('runs setup on the first run against an empty home, and creates the home at mode 0700', () => {
    const first = delorun(['setup', '--yes'])
    expect(first.stderr).toBe('')
    expect(first.status).toBe(EXIT.ok)
    expect(first.stdout).toContain(`Set up the CLI profile default at ${join(deloHome, 'profiles', 'default')}`)
    const manifest = JSON.parse(readFileSync(join(deloHome, 'profiles', 'default', 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles).toEqual(DELO_PROFILE_BUNDLES)
    if (POSIX) {
      expect(lstatSync(deloHome).mode & 0o777).toBe(0o700)
      expect(lstatSync(join(deloHome, 'secrets')).mode & 0o777).toBe(0o700)
    }
    const again = delorun(['setup', '--yes'])
    expect(again.status).toBe(EXIT.ok)
    expect(again.stdout).toContain('already set up')
  })

  it('gives upstream the Delo home as DSH_HOME and leaves a fixture ~/.dsh byte-identical', () => {
    const before = snapshot(dshHome)
    expect(delorun(['setup', '--yes']).status).toBe(EXIT.ok)
    const plugin = delorun(['plugin', '--profile', 'probe', 'version-exemptions'])
    expect(plugin.stderr).toBe('')
    expect(plugin.status).toBe(0)
    // Upstream initialised the profile it was asked about under the Delo home, not under the inherited DSH_HOME.
    expect(lstatSync(join(deloHome, 'profiles', 'probe', 'package.json')).isFile()).toBe(true)
    const status = delorun(['status'])
    expect(status.status).toBe(EXIT.notRunning)
    expect(status.stdout).toContain(`home: ${deloHome}\n`)
    expect(status.stdout).toContain(`DSH_HOME is set to ${dshHome}; delorun ignores it and runs with DSH_HOME=${deloHome}`)
    expect(status.stdout).toContain('state: not running')
    expect(snapshot(dshHome)).toEqual(before)
  })

  it('refuses the desktop app\'s profile and leaves it byte-identical', () => {
    // The desktop app created the home and its profile.
    mkdirSync(deloHome, { mode: 0o700 })
    mkdirSync(desktopProfile, { recursive: true })
    writeFileSync(join(desktopProfile, 'package.json'), '{"name":"dsh-profile-desktop"}\n')
    writeFileSync(join(desktopProfile, 'cordis.patch.yml'), '[]\n')
    writeFileSync(join(desktopProfile, 'lock'), '4242\n')
    const before = snapshot(desktopProfile)
    expect(delorun(['setup', '--yes']).status).toBe(EXIT.ok)
    for (const refused of [delorun(['--profile', 'desktop']), delorun(['start', '--foreground', '--profile', 'Desktop']), delorun(['setup'], { DELO_PROFILE: 'desktop' })]) {
      expect(refused.status).toBe(EXIT.usage)
      expect(refused.stderr).toContain('the desktop app\'s own profile')
    }
    // Delo's own profile-name rule refuses the name before upstream's plugin manager, which refuses it too, runs.
    const plugin = delorun(['plugin', '--profile', 'desktop', 'add', 'some-plugin'])
    expect(plugin.status).toBe(EXIT.usage)
    expect(plugin.stderr).toContain('the desktop app\'s own profile')
    expect(delorun(['status']).status).toBe(EXIT.notRunning)
    expect(snapshot(desktopProfile)).toEqual(before)
    // No run directory for the desktop profile, and no registration as a user of the stores: `delorun plugin` refuses
    // the profile before it registers.
    expect(readdirSync(join(deloHome, 'run'))).toEqual(['default'])
  })

  it('reserved-profile-refused: refuses a CLI profile under a reserved name at start, and changes nothing', () => {
    expect(delorun(['setup', '--yes']).status).toBe(EXIT.ok)
    // A CLI profile under a name the rule reserves, as an earlier release accepted it.
    const reserved = join(deloHome, 'profiles', 'data-users')
    mkdirSync(reserved, { recursive: true })
    writeFileSync(join(reserved, 'package.json'), '{"name":"dsh-profile-data-users"}\n')
    const before = snapshot(reserved)
    const runs: ReadonlyArray<readonly [readonly string[], Record<string, string>, string]> = [
      [['start', '--foreground', '--profile', 'data-users'], {}, 'data-users'],
      [['start', '--foreground'], { DELO_PROFILE: 'headless' }, 'headless'],
      [['--profile', 'node_modules'], {}, 'node_modules'],
    ]
    for (const [args, env, name] of runs) {
      const refused = delorun(args, env)
      expect(refused.status).toBe(EXIT.usage)
      expect(refused.stderr).toContain(`"${name}" is reserved: ${RESERVED_PROFILE_NAMES.get(name)!}; choose another profile name`)
    }
    expect(snapshot(reserved)).toEqual(before)
    expect(readdirSync(join(deloHome, 'run'))).toEqual(['default'])
  })

  it('refuses to start a profile whose composition skipped @delo/bundle-local, and starts nothing', () => {
    expect(delorun(['setup', '--yes']).status).toBe(EXIT.ok)
    // Setup linked the bundle; removing the link is what an incomplete install leaves.
    rmSync(join(deloHome, 'profiles', 'default', 'node_modules', LOCAL_BUNDLE))
    const refused = delorun(['start', '--foreground'])
    expect(refused.status).toBe(EXIT.failed)
    expect(refused.stderr).toContain('delorun: the profile default could not load Delo\'s bundle, so Delo did not start:')
    expect(refused.stderr).toContain(`  ${LOCAL_BUNDLE}: Error: dsh: cannot resolve profile bundle "${LOCAL_BUNDLE}"`)
    expect(refused.stderr).toContain(`  To fix it, run: delorun plugin --profile default add link:${BUNDLE_LOCAL_DIR}`)
    expect(refused.stderr).toContain('no Delo guard, and session logs uploaded to DeepSeek')
    expect(refused.stdout).not.toContain('http://')
    expect(readdirSync(join(deloHome, 'run', 'default'))).toEqual([])
  })

  it('refuses a home inside ~/.dsh before creating anything', () => {
    const refused = delorun([], { DELO_HOME: join(dshHome, 'delo') })
    expect(refused.status).toBe(EXIT.failed)
    expect(refused.stderr).toContain('HOME_IS_DSH_HOME')
    expect(readdirSync(dshHome).sort()).toEqual(['.credentials.yaml', 'profiles', 'sessions'])
  })

  it.runIf(POSIX)('refuses a laxer existing home with the chmod 700 fix and starts nothing', () => {
    mkdirSync(deloHome, { mode: 0o700 })
    chmodSync(deloHome, 0o755)
    const refused = delorun([])
    expect(refused.status).toBe(EXIT.failed)
    expect(refused.stderr).toContain(`HOME_MODE: ${deloHome} has mode 0755`)
    expect(refused.stderr).toContain(`chmod 700 ${deloHome}`)
    expect(readdirSync(deloHome)).toEqual([])
  })

  it('refuses a background start of a home without the CLI profile, and stop finds nothing to stop', () => {
    const start = delorun(['start'])
    expect(start.status).toBe(EXIT.failed)
    expect(start.stderr).toContain('run: delorun setup')
    const stop = delorun(['stop'])
    expect(stop.status).toBe(EXIT.ok)
    expect(stop.stdout).toContain('Delo is not running for the profile default.')
  })

  it('reports wrong command lines with the usage code', () => {
    expect(delorun(['start', '--bogus']).status).toBe(EXIT.usage)
    expect(delorun(['stop', '--bogus']).status).toBe(EXIT.usage)
    expect(delorun(['frobnicate']).status).toBe(EXIT.usage)
    expect(delorun(['status', '--bogus']).status).toBe(EXIT.usage)
    expect(delorun(['--profile', '..']).status).toBe(EXIT.usage)
    const help = delorun(['--help'])
    expect(help.status).toBe(EXIT.ok)
    expect(help.stdout).toContain('Usage: delorun')
  })
})

describe('starting the home process', { timeout: 60_000 }, () => {
  let context: CommandContext

  beforeEach(() => {
    vi.stubEnv('HOME', osHome)
    vi.stubEnv('USERPROFILE', osHome)
    // prepareHome sets these on the process; stubbing them first restores them afterwards.
    vi.stubEnv('DSH_HOME', dshHome)
    vi.stubEnv('DELO_HOME', undefined)
    vi.stubEnv('DELO_PROFILE', undefined)
    context = { env: { HOME: osHome, DSH_HOME: dshHome, DEEPSEEK_API_KEY: 'fixture-key' }, stdout: () => undefined, stderr: () => undefined }
  })

  /**
   * Start dependencies that record what the profile runner saw.
   * @param seen - collects each run's options and DSH_HOME.
   * @returns the dependencies.
   */
  function recording(seen: { options: RunProfileOptions, dshHome: string | undefined }[], rows: readonly BootedRow[] = [], shutdowns: number[] = [], events: string[] = []): StartDependencies {
    return {
      approvedPluginContent: NO_APPROVED_CONTENT,
      preStartSteps: realPreStartSteps(() => Promise.resolve(false), () => Promise.resolve(false)),
      prepareProfile: upstreamDependencies().prepareProfile,
      runProfile: (options) => {
        seen.push({ options, dshHome: process.env.DSH_HOME })
        const booted = (): BootedRow[] => composedBootRows(deloHome, options, rows)
        return Promise.resolve({ rows: () => { events.push('rows'); return booted() }, providerOf: composedProviders(booted), releaseTurns: () => { events.push('release') }, shutdown: (code) => { events.push('shutdown'); shutdowns.push(code); return Promise.resolve() }, dispose: () => { events.push('dispose'); return Promise.resolve() }, watchChats: () => {}, watchUpdates: () => Promise.resolve(), studio: () => undefined, studioLink: () => ({ kind: 'unavailable', reason: 'the Host serves no studio' }), reload: async () => Promise.resolve({ ok: true }) })
      },
      loadEnvironment: () => createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]),
      probe: () => () => Promise.resolve('answered'),
      onSignal: () => () => undefined,
      fatalRelease: () => {
        events.push('fatal-release')
        return () => { events.push('fatal-release removed') }
      },
      onExit: () => undefined,
      exit: () => undefined,
      captureOutput: () => () => undefined,
      runtime: home => runtimeOfFile(home, join(home, 'not-a-runtime')),
      updates: () => { throw new Error('a start outside the store has no update support') },
      checkRuntime: () => Promise.reject(new Error('a start outside the store checks no stored runtime')),
      handover: async () => Promise.resolve(undefined),
      opener: { canOpen: () => true, link: requestStudioLink, open: () => Promise.reject(new Error('no link reaches the browser here')) },
    }
  }

  /**
   * Link a package into the CLI profile's node_modules, as `delorun plugin add link:` leaves it.
   * @param name - the package name.
   * @param directory - the package directory.
   */
  function linkIntoProfile(name: string, directory: string): void {
    const link = join(deloHome, 'profiles', 'default', 'node_modules', name)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(directory, link, 'junction')
  }

  /**
   * Add bundles to the CLI profile's bundle list.
   * @param names - the package names to append.
   */
  function appendBundles(...names: string[]): void {
    const path = join(deloHome, 'profiles', 'default', 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    manifest.dsh.profile.bundles.push(...names)
    writeFileSync(path, JSON.stringify(manifest))
  }

  it('adds the studio bundle with upstream\'s plugin operation to a profile whose list lacks it, once', async () => {
    expect(await main(['setup', '--yes'], context)).toBe(EXIT.ok)
    const path = join(deloHome, 'profiles', 'default', 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dsh: { profile: { bundles: string[] } }, dependencies?: Record<string, string> }
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== STUDIO_BUNDLE)
    delete manifest.dependencies?.[STUDIO_BUNDLE]
    writeFileSync(path, JSON.stringify(manifest))
    const progress: string[] = []
    const output = { ...context, stdout: (text: string) => void progress.push(text), stderr: () => undefined }
    expect(await upstreamAddStudioBundle(deloHome, 'default', output)).toBe(true)
    expect((JSON.parse(readFileSync(path, 'utf8')) as { dsh: { profile: { bundles: string[] } } }).dsh.profile.bundles).toContain(STUDIO_BUNDLE)
    expect(progress).toEqual([LINKING_PROGRESS, 'done\n'])
    expect(await upstreamAddStudioBundle(deloHome, 'default', output)).toBe(false)
    expect(progress).toHaveLength(2)
  })

  it('adds the studio look once, at a fresh start, starts in the stock look while that fails, and never tries again once it is done', async () => {
    expect(await main(['setup', '--yes'], context)).toBe(EXIT.ok)
    const printed: string[] = []
    const output = { ...context, stderr: (text: string) => void printed.push(text) }
    const lock = join(deloHome, 'run', 'default', 'home.lock')
    const refusing: StartDependencies = { ...recording([]), preStartSteps: realPreStartSteps(() => Promise.reject(new CliError(EXIT.failed, 'pnpm exited 1')), () => Promise.resolve(false)) }
    expect(await startForeground({ home: deloHome, profile: 'default', open: false, output, env: context.env }, refusing)).toBeUndefined()
    expect(printed.join('')).toContain('delorun: the profile default starts in the stock look, because Delo\'s studio look could not be added: pnpm exited 1')
    rmSync(lock, { force: true })
    printed.length = 0
    const added: string[] = []
    const upgrading: StartDependencies = { ...recording([]), preStartSteps: realPreStartSteps((_home, profile) => { added.push(profile); return Promise.resolve(true) }, () => Promise.resolve(false)) }
    expect(await startForeground({ home: deloHome, profile: 'default', open: false, output, env: context.env }, upgrading)).toBeUndefined()
    expect(added).toEqual(['default'])
    expect(printed.join('')).toContain('delorun: added Delo\'s studio look to the profile default')
    rmSync(lock, { force: true })
    expect(await startForeground({ home: deloHome, profile: 'default', open: false, output, env: context.env }, upgrading)).toBeUndefined()
    expect(added).toEqual(['default'])
    rmSync(lock, { force: true })
    rmSync(join(deloHome, 'profiles', 'default', 'delo-migrations.json'))
    const failing: StartDependencies = { ...recording([]), preStartSteps: realPreStartSteps(() => Promise.reject(new Error('disk gone')), () => Promise.resolve(false)) }
    await expect(startForeground({ home: deloHome, profile: 'default', open: false, output, env: context.env }, failing)).rejects.toThrow('disk gone')
  })

  it('attaches the update check to a Host that runs from the store, and prints its line', async () => {
    expect(await main(['setup', '--yes'], context)).toBe(EXIT.ok)
    const watched: UpdateWatchOptions[] = []
    const printed: string[] = []
    const output = { ...context, stdout: (text: string) => void printed.push(text) }
    const fromStore: StartDependencies = {
      ...recording([]),
      runProfile: async (options) => ({
        ...await recording([]).runProfile(options),
        watchUpdates: (watch) => { watched.push(watch); watch.line('Delorun 0.1.1 is available'); watch.log?.('delo-update-check: the update check failed: logged'); return Promise.resolve() },
      }),
      runtime: () => ({ version: brandString<RuntimeVersion>('0.1.0'), store: true }),
      updates: () => ({ copies: { recover: () => Promise.resolve() }, store: { pointers: () => Promise.resolve({ current: brandString<RuntimeVersion>('0.1.0') }) } }) as never,
    }
    expect(await startForeground({ home: deloHome, profile: 'default', open: false, output, env: context.env }, fromStore)).toBeUndefined()
    expect(watched).toEqual([expect.objectContaining({ home: deloHome, profile: 'default', running: '0.1.0' })])
    expect(printed).toContain('Delorun 0.1.1 is available\n')
    expect(printed.join('')).not.toContain('logged')
    expect(readFileSync(resolveSurface({ kind: 'home', home: deloHome, profile: 'default' }).file, 'utf8')).toContain('the update check failed: logged')
    rmSync(join(deloHome, 'run', 'default', 'home.lock'), { force: true })
  })

  it('boots the CLI profile with DSH_HOME set to the Delo home, and a second start leaves one holder', async () => {
    expect(await main(['setup', '--yes'], context)).toBe(EXIT.ok)
    const prepared = await prepareHome(context, undefined)
    expect(prepared.home).toEqual({ path: deloHome, ignoredDshHome: dshHome })
    const seen: { options: RunProfileOptions, dshHome: string | undefined }[] = []
    expect(await startForeground({ home: deloHome, profile: 'default', open: true, output: context, env: context.env }, recording(seen))).toBeUndefined()
    expect(seen).toHaveLength(1)
    const overlay = join(deloHome, 'run', 'default', 'sandbox.patch.yml')
    expect(seen[0]).toMatchObject({ dshHome: deloHome, options: { profile: 'default', patchFiles: [overlay], args: ['--no-open'] } })
    // C1's confinement on the profile's sandbox row: the home, its read exemptions and both channels' sockets.
    expect(parse(readFileSync(overlay, 'utf8'))).toEqual([{ id: 'sandbox', config: expect.objectContaining({
      protectedHome: deloHome,
      protectedHomeReadable: [...READ_EXEMPTIONS],
      deniedSockets: expect.arrayContaining([join(deloHome, 'run', 'default', 'update.sock'), join(deloHome, 'run', 'default', 'supervisor.sock')]),
    }) }])
    expect(lstatSync(overlay).mode & 0o777).toBe(0o600)
    expect(seen[0]!.options.resolvedProfile?.profile.layers.map(layer => layer.packageName)).toEqual(DELO_PROFILE_BUNDLES)
    expect(process.env.DELO_HOME).toBe(deloHome)
    expect(process.env.DELO_PROFILE).toBe('default')
    const lock = JSON.parse(readFileSync(join(deloHome, 'run', 'default', 'home.lock'), 'utf8')) as { pid: number }
    expect(lock.pid).toBe(process.pid)
    // C19's `changes.reload` reaches the booted profile's reload.
    expect(await sendHomeRequest(deloHome, 'default', { op: 'changes.reload' })).toEqual([{ ok: true, reload: { ok: true } }])
    const printed: string[] = []
    expect(await startForeground({ home: deloHome, profile: 'default', open: false, output: { ...context, stdout: text => void printed.push(text) }, env: context.env }, recording(seen))).toBe(EXIT.ok)
    expect(printed.join('')).toContain(`Delo is already running for the profile default (process ${String(process.pid)}`)
    expect(printed.join('')).toContain('Run delorun open to open the studio in your browser.\n')
    const opening: string[] = []
    expect(await startForeground({ home: deloHome, profile: 'default', open: true, output: { stdout: () => {}, stderr: text => void opening.push(text) }, env: context.env }, recording(seen))).toBe(EXIT.ok)
    expect(opening.join('')).toBe('The home process for the profile default did not give a studio link (STUDIO_UNAVAILABLE: the Host serves no studio); see delorun status.\n')
    expect(seen).toHaveLength(1)
    const silent: StartDependencies = { ...recording(seen), probe: () => () => Promise.resolve('silent') }
    await expect(startForeground({ home: deloHome, profile: 'default', open: false, output: context, env: context.env }, silent)).rejects.toMatchObject({ code: 'HOME_UNRESPONSIVE' })
    expect(seen).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(deloHome, 'run', 'default', 'home.lock'), 'utf8'))).toEqual(lock)
  })

  it('sets the default workspace folder before the profile boots, creates nothing, and leaves a row the profile configures alone', async () => {
    vi.stubEnv(DEFAULT_WORKSPACE_ENV, undefined)
    expect(await main(['setup', '--yes'], context)).toBe(EXIT.ok)
    const atBoot: (string | undefined)[] = []
    const watching: StartDependencies = { ...recording([]), runProfile: (options) => {
      atBoot.push(process.env[DEFAULT_WORKSPACE_ENV])
      return recording([]).runProfile(options)
    } }
    expect(await startForeground({ home: deloHome, profile: 'default', open: false, output: context, env: context.env }, watching)).toBeUndefined()
    expect(atBoot).toHaveLength(1)
    // The documents lookup runs on this host, so the base is its documents folder or the fixture home.
    expect(atBoot[0]?.endsWith(join('Delo', 'default-workspace'))).toBe(true)
    expect(existsSync(atBoot[0] ?? '')).toBe(false)
    rmSync(join(deloHome, 'run', 'default', 'home.lock'), { force: true })
    vi.stubEnv(DEFAULT_WORKSPACE_ENV, undefined)
    const patchPath = join(deloHome, 'profiles', 'default', 'cordis.patch.yml')
    const parsed: unknown = parse(readFileSync(patchPath, 'utf8'))
    const rows = Array.isArray(parsed) ? parsed : []
    writeFileSync(patchPath, stringify([...rows, { id: 'workspace-controller', config: { defaultWorkspaceDirectory: join(osHome, 'mine') } }]))
    expect(await startForeground({ home: deloHome, profile: 'default', open: false, output: context, env: context.env }, watching)).toBeUndefined()
    expect(atBoot).toEqual([atBoot[0], undefined])
  })

  it('Delo stopping ends the work session: the Host closes it and approves nothing', { timeout: 300_000 }, async () => {
    expect(await main(['setup', '--yes'], context)).toBe(EXIT.ok)
    const profileDir = join(deloHome, 'profiles', 'default')
    const folder = join(osHome, 'plug')
    mkdirSync(folder)
    writeFileSync(join(folder, 'package.json'), '{"name":"plug","version":"1.0.0"}\n')
    writeFileSync(join(folder, 'index.js'), 'export default 1\n')
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, plug: `link:${folder}` } }))
    linkIntoProfile('plug', folder)
    const shutdowns: number[] = []
    expect(await startForeground({ home: deloHome, profile: 'default', open: false, output: context, env: context.env }, recording([], [], shutdowns))).toBeUndefined()
    const ctx = { home: deloHome, profile: 'default', profileDir }
    const from = (await readApproved(profileDir)).plugins.plug?.version
    await startWork(ctx, 'plug', attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } }), { reload: () => reloadThroughChannel(deloHome, 'default'), minutes: 60 })
    writeFileSync(join(folder, 'index.js'), 'export default 2\n')
    await sendHomeRequest(deloHome, 'default', { op: 'stop', args: { mode: 'drain' } })
    await vi.waitFor(async () => { expect(await readWorkSession(deloHome, 'default')).toBeUndefined() }, { timeout: 60_000, interval: 100 })
    await vi.waitFor(() => { expect(shutdowns).toEqual([EXIT.ok]) }, { timeout: 60_000, interval: 100 })
    expect(from).toBeDefined()
    expect((await readApproved(profileDir)).plugins.plug?.version).toBe(from)
    expect((await readChangeLog(deloHome, 'default')).entries.filter(entry => entry.kind === 'plugin-edit')).toEqual([])
  })

  it('releases the lock when the profile fails to boot, and refuses a home without the CLI profile', async () => {
    await prepareHome(context, undefined)
    await expect(startForeground({ home: deloHome, profile: 'default', open: false, output: context, env: context.env }, recording([]))).rejects.toThrow('run: delorun setup')
    expect(await main(['setup', '--yes'], context)).toBe(EXIT.ok)
    const failing: StartDependencies = { ...recording([]), runProfile: () => Promise.reject(new Error('boot failed')) }
    await expect(startForeground({ home: deloHome, profile: 'default', open: false, output: context, env: context.env }, failing)).rejects.toThrow('failed to start: boot failed')
    expect(startArtifacts(join(deloHome, 'run', 'default'))).toEqual(['changes-boot.json'])
  })

  it('refuses a Delo bundle that resolves but fails to load, and still starts over a skipped upstream bundle', async () => {
    expect(await main(['setup', '--yes'], context)).toBe(EXIT.ok)
    const broken = join(osHome, 'bundle-broken')
    mkdirSync(broken)
    writeFileSync(join(broken, 'package.json'), '{"name":"@delo/bundle-broken","version":"0.0.0"}\n')
    linkIntoProfile('@delo/bundle-broken', broken)
    appendBundles('@delo/bundle-broken')
    const seen: { options: RunProfileOptions, dshHome: string | undefined }[] = []
    await expect(startForeground({ home: deloHome, profile: 'default', open: false, output: context, env: context.env }, recording(seen)))
      .rejects.toThrow(/@delo\/bundle-broken: Error: dsh: profile bundle "@delo\/bundle-broken" declares no dsh.bundle[^\n]*\n {2}To fix it, reinstall Delo, or run: delorun plugin --profile default install/)
    expect(seen).toHaveLength(0)
    const manifest = JSON.parse(readFileSync(join(deloHome, 'profiles', 'default', 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    manifest.dsh.profile.bundles = [...DELO_PROFILE_BUNDLES, '@deepseek-ai/dsh-not-installed']
    writeFileSync(join(deloHome, 'profiles', 'default', 'package.json'), JSON.stringify(manifest))
    expect(await startForeground({ home: deloHome, profile: 'default', open: false, output: context, env: context.env }, recording(seen))).toBeUndefined()
    expect(seen[0]!.options.resolvedProfile?.profile.skippedBundles.map(bundle => bundle.packageName)).toEqual(['@deepseek-ai/dsh-not-installed'])
  })

  it('tears down and refuses a profile in which a row of a Delo bundle did not import, without upstream\'s process shutdown, and starts over inactive upstream rows', async () => {
    expect(await main(['setup', '--yes'], context)).toBe(EXIT.ok)
    const shutdowns: number[] = []
    const events: string[] = []
    const rows: BootedRow[] = [
      { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop', disabled: false, state: 'active' },
      { id: 'delo-privacy', name: LOCAL_BUNDLE, disabled: false, state: 'not-imported' },
    ]
    const refusal = startForeground({ home: deloHome, profile: 'default', open: false, output: context, env: context.env }, recording([], rows, shutdowns, events))
    await expect(refusal).rejects.toThrow(/delo-privacy \(@delo\/bundle-local\) failed to import\n {2}To fix it, build it in this source checkout with: pnpm --filter @delo\/bundle-local run build/)
    // Upstream's shutdown may end the process before the failed start finishes; the refused Host's own teardown does not.
    expect(shutdowns).toEqual([])
    expect(events.filter(event => event === 'dispose')).toEqual(['dispose'])
    expect(startArtifacts(join(deloHome, 'run', 'default'))).toEqual(['changes-boot.json'])
    const upstreamOnly: BootedRow[] = [{ id: 'mcp', name: '@deepseek-ai/dsh-mcp-client', disabled: false, state: 'failed' }]
    expect(await startForeground({ home: deloHome, profile: 'default', open: false, output: context, env: context.env }, recording([], upstreamOnly, shutdowns))).toBeUndefined()
    expect(shutdowns).toEqual([])
  })

  it('reports a refused Host whose teardown fails with the refusal, keeps the lock, and ends the process only after the report', async () => {
    expect(await main(['setup', '--yes'], context)).toBe(EXIT.ok)
    const exits: number[] = []
    const rows: BootedRow[] = [{ id: 'delo-privacy', name: LOCAL_BUNDLE, disabled: false, state: 'not-imported' }]
    const base = recording([], rows)
    const stuck: StartDependencies = {
      ...base,
      exit: (code) => { exits.push(code) },
      runProfile: async options => ({ ...await base.runProfile(options), dispose: async () => Promise.reject(new Error('a row did not dispose')) }),
    }
    const failure = await startForeground({ home: deloHome, profile: 'default', open: false, output: context, env: context.env }, stuck).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HostNotStoppedError)
    expect((failure as HostNotStoppedError).cause).toBeInstanceOf(CliError)
    const reported = cliRefusal(failure, ['start'])
    expect(reported.text).toMatch(/delo-privacy \(@delo\/bundle-local\) failed to import/)
    expect(reported.text).toContain('the refused Host failed to stop (a row did not dispose) and may still run')
    expect(reported.exit).toBe(EXIT.failed)
    // The lock stays with this start while its Host may still run, and the process ends once `main` has reported.
    expect(readdirSync(join(deloHome, 'run', 'default'))).toContain('home.lock')
    expect(exits).toEqual([])
    await new Promise(resolve => setImmediate(resolve))
    expect(exits).toEqual([EXIT.failed])
  })

  it('registers one teardown for the last-resort handler, whose fatal exit disposes the current Host', async () => {
    expect(await main(['setup', '--yes'], context)).toBe(EXIT.ok)
    const events: string[] = []
    let release: (() => Promise<void>) | undefined
    const base = recording([], [], [], events)
    const dependencies: StartDependencies = { ...base, fatalRelease: (given) => { release = given; return base.fatalRelease(given) } }
    expect(await startForeground({ home: deloHome, profile: 'default', open: false, output: context, env: context.env }, dependencies)).toBeUndefined()
    expect(events.filter(event => event.startsWith('fatal-release'))).toEqual(['fatal-release'])
    expect(events).not.toContain('dispose')
    await release?.()
    expect(events.at(-1)).toBe('dispose')
  })

  it('releases the turn gate\'s start hold only after the booted Host passed its check, and never for a Host it refuses', async () => {
    expect(await main(['setup', '--yes'], context)).toBe(EXIT.ok)
    const refusedEvents: string[] = []
    const disabled: BootedRow[] = [{ id: 'delo-fetch-guard', name: '@delo/plugin-fetch-guard', disabled: true, state: 'active', config: { enabled: true } }]
    await expect(startForeground({ home: deloHome, profile: 'default', open: false, output: context, env: context.env }, recording([], disabled, [], refusedEvents))).rejects.toThrow('delo-fetch-guard is disabled')
    expect(refusedEvents).not.toContain('release')
    expect(refusedEvents.filter(event => event === 'dispose' || event === 'shutdown')).toEqual(['dispose'])
    const events: string[] = []
    expect(await startForeground({ home: deloHome, profile: 'default', open: false, output: context, env: context.env }, recording([], [], [], events))).toBeUndefined()
    expect(events.filter(event => event === 'release')).toEqual(['release'])
    expect(events.indexOf('release')).toBeGreaterThan(events.lastIndexOf('rows', events.indexOf('release')))
    expect(events).not.toContain('shutdown')
    expect(events).not.toContain('dispose')
  })

  it('answers the person\'s devices.approve with the booted profile\'s local approval', async () => {
    expect(await main(['setup', '--yes'], context)).toBe(EXIT.ok)
    const approved: string[] = []
    const devices: LocalDeviceApproval = {
      openWindow: () => Promise.resolve(0),
      windowOpenUntil: () => undefined,
      pending: () => [],
      approve: (requestId, typedCode) => {
        approved.push(`${requestId} ${typedCode}`)
        return Promise.resolve({ id: 'device', label: 'Phone', address: 'https://home.example.ts.net' })
      },
      cancel: () => undefined,
      remove: () => Promise.resolve({ removed: true, sessions: 0, connections: 0 }),
    }
    const base = recording([])
    const withApproval: StartDependencies = { ...base, runProfile: async options => ({ ...await base.runProfile(options), devices: () => devices }) }
    expect(await startForeground({ home: deloHome, profile: 'default', open: false, output: context, env: context.env }, withApproval)).toBeUndefined()
    const lines = await sendHomeRequest(deloHome, 'default', { op: 'devices.approve', args: { requestId: 'A'.repeat(22), typedCode: '12345678' } })
    expect(lines.at(-1)).toMatchObject({ ok: true, device: { label: 'Phone' } })
    expect(approved).toEqual([`${'A'.repeat(22)} 12345678`])
  })
})

describe('starting a set-up home with the real profile runner', { timeout: 180_000 }, () => {
  const DRIVER = join(import.meta.dirname, 'fixtures/start-driver.ts')

  beforeAll(() => {
    // The bundle's built halves must exist to import. The check runner's `build:delo` check builds them before this
    // lane; a spec never builds, since other workers import the same output while it runs.
    const missing = ['index.js', 'client.js'].filter(file => !existsSync(join(BUNDLE_LOCAL_DIR, 'lib', file)))
    if (missing.length > 0) {
      throw new Error(`${LOCAL_BUNDLE} is not built (lib/${missing.join(', lib/')} missing); run node_modules/.bin/tsx delo/apps/tools/src/run-checks.ts --only build:delo`)
    }
  })

  /** What the start driver printed. */
  interface DriverReport {
    readonly outcome: 'started' | 'refused'
    readonly message?: string
    readonly rows: readonly BootedRow[]
    readonly sessionLogEnabled: unknown
    readonly runner?: string
    readonly confined?: ConfinementAttempt
    readonly unconfined?: ConfinementAttempt
  }

  /** What the workspace command of `--probe-confinement` reports. */
  interface ConfinementAttempt {
    readonly home: string
    readonly token: string
    readonly connect: string
    readonly answer?: string
  }

  /**
   * Run the start driver against the fixture home.
   * @returns its exit status and report.
   */
  function startDriver(...args: string[]): { status: number | null, report: DriverReport, stderr: string } {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(DSH_|DELO_|NODE_PATH$)/.test(name)))
    const result = spawnSync(process.execPath, ['--import', TSX_LOADER, DRIVER, ...args], {
      cwd: osHome, env: { ...inherited, HOME: osHome, USERPROFILE: osHome }, encoding: 'utf8', timeout: 150_000,
    })
    if (result.error !== undefined || result.signal !== null) throw new Error(`the start driver did not exit (${result.error?.message ?? String(result.signal)}):\n${result.stderr}`)
    const line = result.stdout.trim().split('\n').at(-1) ?? ''
    let report: DriverReport
    try {
      report = JSON.parse(line) as DriverReport
    } catch (error) {
      // A driver that failed before its report printed none; its standard error says why.
      throw new Error(`the start driver exited ${String(result.status)} without a report:\n${result.stderr}`, { cause: error })
    }
    return { status: result.status, report, stderr: result.stderr }
  }

  it('loads delo-privacy after a fresh home\'s setup, with no manual step, and keeps session-log upload off', () => {
    const setup = delorun(['setup', '--yes'])
    expect(setup.status).toBe(EXIT.ok)
    const manifest = JSON.parse(readFileSync(join(deloHome, 'profiles', 'default', 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(manifest.dependencies[LOCAL_BUNDLE]).toBe(`link:${BUNDLE_LOCAL_DIR}`)
    const started = startDriver()
    expect(started.report.outcome, String((started.report as { message?: unknown }).message)).toBe('started')
    expect(started.status).toBe(0)
    // A row that requires a service no enabled row provides stays pending, and the Host starts with a did-not-activate warning.
    expect(started.report.rows.filter(row => !row.disabled && row.state !== 'active')).toEqual([])
    expect(started.report.rows.find(row => row.id === 'delo-privacy')).toMatchObject({ name: LOCAL_BUNDLE, state: 'active', disabled: false })
    expect(started.report.sessionLogEnabled).toBe(false)
  })

  it('update-channel-connect-denied: a workspace command under the started profile cannot read the home or reach the update channel', (test) => {
    // A home outside the OS temporary directory, which upstream's profiles replace with a private /tmp whether or not C1's rule holds.
    rmSync(osHome, { recursive: true, force: true })
    mkdirSync('/var/tmp', { recursive: true })
    osHome = realpathSync(mkdtempSync(join('/var/tmp', 'delorun-cli-')))
    deloHome = join(osHome, '.delo')
    dshHome = join(osHome, '.dsh')
    expect(delorun(['setup', '--yes']).status).toBe(EXIT.ok)
    const started = startDriver('--probe-confinement')
    expect(started.report.outcome, started.stderr).toBe('started')
    // The same command unconfined reads the home and the token and is answered: the confinement, not the host, denies it.
    expect(started.report.unconfined).toEqual({ home: 'ok', token: 'ok', connect: 'ok', answer: 'ok' })
    const confined = started.report.confined
    if (started.report.runner === 'bwrap') {
      expect(confined?.home).not.toBe('ok')
      expect(confined?.token).not.toBe('ok')
      expect(confined?.connect).not.toBe('ok')
    } else if (started.report.runner?.endsWith('landlock-run') === true) {
      expect(confined).toEqual({ home: 'EACCES', token: 'EACCES', connect: 'ok', answer: 'UNAUTHENTICATED' })
    } else {
      test.skip(`not run: this host's sandbox runner is ${String(started.report.runner)}, neither bwrap nor Landlock`)
    }
    expect(existsSync(join(deloHome, 'run', 'default', 'sandbox.patch.yml'))).toBe(false)
  })

  it('refuses to start when delo-privacy fails to import, while the bundle\'s privacy rows still apply', () => {
    expect(delorun(['setup', '--yes']).status).toBe(EXIT.ok)
    // The bundle as an install whose Host half throws on import: the same manifest, patch and client, a broken lib/index.js.
    const broken = join(osHome, 'bundle-local-broken')
    mkdirSync(join(broken, 'lib'), { recursive: true })
    const real = JSON.parse(readFileSync(join(BUNDLE_LOCAL_DIR, 'package.json'), 'utf8')) as Record<string, unknown>
    writeFileSync(join(broken, 'package.json'), JSON.stringify({ name: real.name, version: real.version, type: 'module', exports: real.exports, dsh: real.dsh }))
    for (const file of ['cordis.patch.yml', 'lib/client.js']) writeFileSync(join(broken, file), readFileSync(join(BUNDLE_LOCAL_DIR, file)))
    writeFileSync(join(broken, 'lib', 'index.js'), 'throw new Error(\'forced import failure\')\n')
    const link = join(deloHome, 'profiles', 'default', 'node_modules', LOCAL_BUNDLE)
    rmSync(link)
    symlinkSync(broken, link, 'junction')
    const refused = startDriver()
    expect(refused.status).toBe(1)
    expect(refused.report.outcome).toBe('refused')
    expect(refused.report.message).toContain('so Delo stopped:\n  delo-privacy (@delo/bundle-local) failed to import')
    expect(refused.report.rows.find(row => row.id === 'delo-privacy')).toMatchObject({ state: 'not-imported', disabled: false })
    expect(refused.stderr).toContain('forced import failure')
    expect(refused.report.sessionLogEnabled).toBe(false)
    expect(startArtifacts(join(deloHome, 'run', 'default'))).toEqual(['changes-boot.json'])
  })
})
