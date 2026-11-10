import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunProfileOptions } from '@deepseek-ai/dsh/profile-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { DELO_PROFILE_BUNDLES, LOCAL_BUNDLE } from '@delo/bundle-local/profile'
import { READ_EXEMPTIONS } from '@delo/contract-home-layout'
import { parse } from 'yaml'
import { prepareHome, type CommandContext } from '../src/command.ts'
import { EXIT } from '../src/exit.ts'
import { main } from '../src/main.ts'
import type { BootedRow } from '../src/delo-bundles.ts'
import { startForeground, upstreamDependencies, type StartDependencies } from '../src/start.ts'
import { runtimeOfFile } from '../src/update/runtime.ts'

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
    const plugin = delorun(['plugin', '--profile', 'desktop', 'add', 'some-plugin'])
    expect(plugin.status).toBe(1)
    expect(plugin.stderr).toContain('profile "desktop" is managed exclusively by the Electron application')
    expect(delorun(['status']).status).toBe(EXIT.notRunning)
    expect(snapshot(desktopProfile)).toEqual(before)
    expect(readdirSync(join(deloHome, 'run'))).toEqual(['default'])
  })

  it('refuses to start a profile whose composition skipped @delo/bundle-local, and starts nothing', () => {
    expect(delorun(['setup', '--yes']).status).toBe(EXIT.ok)
    // Setup linked the bundle; removing the link is what an incomplete install leaves.
    rmSync(join(deloHome, 'profiles', 'default', 'node_modules', LOCAL_BUNDLE))
    const refused = delorun(['start', '--foreground'])
    expect(refused.status).toBe(EXIT.failed)
    expect(refused.stderr).toContain('delorun: the CLI profile default could not load Delo\'s bundle, so Delo did not start:')
    expect(refused.stderr).toContain(`  ${LOCAL_BUNDLE}: Error: dsh: cannot resolve profile bundle "${LOCAL_BUNDLE}"`)
    expect(refused.stderr).toContain(`  To fix it, run: delorun plugin --profile default add link:${BUNDLE_LOCAL_DIR}`)
    expect(refused.stderr).toContain('upload session logs to DeepSeek')
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
    spawnSync('chmod', ['755', deloHome])
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
  function recording(seen: { options: RunProfileOptions, dshHome: string | undefined }[], rows: readonly BootedRow[] = [], shutdowns: number[] = []): StartDependencies {
    return {
      prepareProfile: upstreamDependencies().prepareProfile,
      runProfile: (options) => {
        seen.push({ options, dshHome: process.env.DSH_HOME })
        return Promise.resolve({ rows: () => rows, shutdown: (code) => { shutdowns.push(code); return Promise.resolve() }, watchChats: () => {}, studio: () => undefined })
      },
      loadEnvironment: () => createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]),
      probe: () => () => Promise.resolve('answered'),
      onExit: () => undefined,
      exit: () => undefined,
      captureOutput: () => () => undefined,
      runtime: home => runtimeOfFile(home, join(home, 'not-a-runtime')),
      updates: () => { throw new Error('a start outside the store has no update support') },
      handover: async () => Promise.resolve(undefined),
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

  it('boots the CLI profile with DSH_HOME set to the Delo home, and a second start leaves one holder', async () => {
    expect(await main(['setup', '--yes'], context)).toBe(EXIT.ok)
    const prepared = await prepareHome(context, undefined)
    expect(prepared.home).toEqual({ path: deloHome, ignoredDshHome: dshHome })
    const seen: { options: RunProfileOptions, dshHome: string | undefined }[] = []
    expect(await startForeground({ home: deloHome, profile: 'default', open: true, output: context }, recording(seen))).toBeUndefined()
    expect(seen).toHaveLength(1)
    const overlay = join(deloHome, 'run', 'default', 'sandbox.patch.yml')
    expect(seen[0]).toMatchObject({ dshHome: deloHome, options: { profile: 'default', patchFiles: [overlay], args: [] } })
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
    const printed: string[] = []
    expect(await startForeground({ home: deloHome, profile: 'default', open: false, output: { ...context, stdout: text => void printed.push(text) } }, recording(seen))).toBe(EXIT.ok)
    expect(printed.join('')).toContain(`Delo is already running for the profile default (process ${String(process.pid)}`)
    expect(seen).toHaveLength(1)
    const silent: StartDependencies = { ...recording(seen), probe: () => () => Promise.resolve('silent') }
    await expect(startForeground({ home: deloHome, profile: 'default', open: false, output: context }, silent)).rejects.toMatchObject({ code: 'HOME_UNRESPONSIVE' })
    expect(seen).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(deloHome, 'run', 'default', 'home.lock'), 'utf8'))).toEqual(lock)
  })

  it('releases the lock when the profile fails to boot, and refuses a home without the CLI profile', async () => {
    await prepareHome(context, undefined)
    await expect(startForeground({ home: deloHome, profile: 'default', open: false, output: context }, recording([]))).rejects.toThrow('run: delorun setup')
    expect(await main(['setup', '--yes'], context)).toBe(EXIT.ok)
    const failing: StartDependencies = { ...recording([]), runProfile: () => Promise.reject(new Error('boot failed')) }
    await expect(startForeground({ home: deloHome, profile: 'default', open: false, output: context }, failing)).rejects.toThrow('failed to start: boot failed')
    expect(readdirSync(join(deloHome, 'run', 'default'))).toEqual([])
  })

  it('refuses a Delo bundle that resolves but fails to load, and still starts over a skipped upstream bundle', async () => {
    expect(await main(['setup', '--yes'], context)).toBe(EXIT.ok)
    const broken = join(osHome, 'bundle-broken')
    mkdirSync(broken)
    writeFileSync(join(broken, 'package.json'), '{"name":"@delo/bundle-broken","version":"0.0.0"}\n')
    linkIntoProfile('@delo/bundle-broken', broken)
    appendBundles('@delo/bundle-broken')
    const seen: { options: RunProfileOptions, dshHome: string | undefined }[] = []
    await expect(startForeground({ home: deloHome, profile: 'default', open: false, output: context }, recording(seen)))
      .rejects.toThrow(/@delo\/bundle-broken: Error: dsh: profile bundle "@delo\/bundle-broken" declares no dsh.bundle[^\n]*\n {2}To fix it, reinstall Delo, or run: delorun plugin --profile default install/)
    expect(seen).toHaveLength(0)
    const manifest = JSON.parse(readFileSync(join(deloHome, 'profiles', 'default', 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    manifest.dsh.profile.bundles = [...DELO_PROFILE_BUNDLES, '@deepseek-ai/dsh-not-installed']
    writeFileSync(join(deloHome, 'profiles', 'default', 'package.json'), JSON.stringify(manifest))
    expect(await startForeground({ home: deloHome, profile: 'default', open: false, output: context }, recording(seen))).toBeUndefined()
    expect(seen[0]!.options.resolvedProfile?.profile.skippedBundles.map(bundle => bundle.packageName)).toEqual(['@deepseek-ai/dsh-not-installed'])
  })

  it('shuts down and refuses a profile in which a row of a Delo bundle did not import, and starts over inactive upstream rows', async () => {
    expect(await main(['setup', '--yes'], context)).toBe(EXIT.ok)
    const shutdowns: number[] = []
    const rows: BootedRow[] = [
      { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop', disabled: false, state: 'active' },
      { id: 'delo-privacy', name: LOCAL_BUNDLE, disabled: false, state: 'not-imported' },
    ]
    const refusal = startForeground({ home: deloHome, profile: 'default', open: false, output: context }, recording([], rows, shutdowns))
    await expect(refusal).rejects.toThrow(/delo-privacy \(@delo\/bundle-local\) failed to import\n {2}To fix it, build it in this source checkout with: pnpm --filter @delo\/bundle-local run build/)
    expect(shutdowns).toEqual([EXIT.failed])
    expect(readdirSync(join(deloHome, 'run', 'default'))).toEqual([])
    const upstreamOnly: BootedRow[] = [{ id: 'mcp', name: '@deepseek-ai/dsh-mcp-client', disabled: false, state: 'failed' }, { ...rows[1]!, disabled: true }]
    expect(await startForeground({ home: deloHome, profile: 'default', open: false, output: context }, recording([], upstreamOnly, shutdowns))).toBeUndefined()
    expect(shutdowns).toEqual([EXIT.failed])
  })
})

describe('starting a set-up home with the real profile runner', { timeout: 180_000 }, () => {
  const DRIVER = join(import.meta.dirname, 'fixtures/start-driver.ts')

  beforeAll(() => {
    // Upstream's build:artifacts does not build Delo's packages; the bundle's Host half must exist to import.
    if (!existsSync(join(BUNDLE_LOCAL_DIR, 'lib', 'index.js')) || !existsSync(join(BUNDLE_LOCAL_DIR, 'lib', 'client.js'))) {
      execFileSync('pnpm', ['--filter', LOCAL_BUNDLE, 'run', 'build'], { cwd: join(import.meta.dirname, '../../../..'), stdio: 'pipe' })
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
    const line = result.stdout.trim().split('\n').at(-1) ?? ''
    return { status: result.status, report: JSON.parse(line) as DriverReport, stderr: result.stderr }
  }

  it('loads delo-privacy after a fresh home\'s setup, with no manual step, and keeps session-log upload off', () => {
    const setup = delorun(['setup', '--yes'])
    expect(setup.status).toBe(EXIT.ok)
    const manifest = JSON.parse(readFileSync(join(deloHome, 'profiles', 'default', 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(manifest.dependencies[LOCAL_BUNDLE]).toBe(`link:${BUNDLE_LOCAL_DIR}`)
    const started = startDriver()
    expect(started.report.outcome, started.stderr).toBe('started')
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
    expect(readdirSync(join(deloHome, 'run', 'default'))).toEqual([])
  })
})
