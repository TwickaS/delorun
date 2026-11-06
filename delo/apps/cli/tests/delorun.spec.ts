import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunProfileOptions } from '@deepseek-ai/dsh/profile-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { prepareHome, type CommandContext } from '../src/command.ts'
import { EXIT } from '../src/exit.ts'
import { main } from '../src/main.ts'
import { startForeground, type StartDependencies } from '../src/start.ts'

const BIN = join(import.meta.dirname, '../src/bin.ts')
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
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(DSH_|DELO_)/.test(name)))
  const result = spawnSync(process.execPath, ['--import', TSX_LOADER, BIN, ...args], {
    cwd: osHome,
    env: { ...inherited, HOME: osHome, USERPROFILE: osHome, DSH_HOME: dshHome, ...env },
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
    const first = delorun([])
    expect(first.stderr).toBe('')
    expect(first.status).toBe(EXIT.ok)
    expect(first.stdout).toContain(`Set up the CLI profile default at ${join(deloHome, 'profiles', 'default')}`)
    const manifest = JSON.parse(readFileSync(join(deloHome, 'profiles', 'default', 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles).toContain('@deepseek-ai/dsh-web-app')
    if (POSIX) {
      expect(lstatSync(deloHome).mode & 0o777).toBe(0o700)
      expect(lstatSync(join(deloHome, 'secrets')).mode & 0o777).toBe(0o700)
    }
    const again = delorun(['setup'])
    expect(again.status).toBe(EXIT.ok)
    expect(again.stdout).toContain('already set up')
  })

  it('gives upstream the Delo home as DSH_HOME and leaves a fixture ~/.dsh byte-identical', () => {
    const before = snapshot(dshHome)
    expect(delorun([]).status).toBe(EXIT.ok)
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
    expect(delorun([]).status).toBe(EXIT.ok)
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

  it('reports wrong command lines with the usage code', () => {
    expect(delorun(['start']).status).toBe(EXIT.usage)
    expect(delorun(['start']).stderr).toContain('delorun start --foreground')
    expect(delorun(['frobnicate']).status).toBe(EXIT.usage)
    expect(delorun(['status', '--bogus']).status).toBe(EXIT.usage)
    expect(delorun(['--profile', '..']).status).toBe(EXIT.usage)
    const help = delorun(['--help'])
    expect(help.status).toBe(EXIT.ok)
    expect(help.stdout).toContain('Usage: delorun')
  })
})

describe('starting the home process', () => {
  let context: CommandContext

  beforeEach(() => {
    vi.stubEnv('HOME', osHome)
    vi.stubEnv('USERPROFILE', osHome)
    // prepareHome sets these on the process; stubbing them first restores them afterwards.
    vi.stubEnv('DSH_HOME', dshHome)
    vi.stubEnv('DELO_HOME', undefined)
    vi.stubEnv('DELO_PROFILE', undefined)
    context = { env: { HOME: osHome, DSH_HOME: dshHome }, stdout: () => undefined, stderr: () => undefined }
  })

  /**
   * Start dependencies that record what the profile runner saw.
   * @param seen - collects each run's options and DSH_HOME.
   * @returns the dependencies.
   */
  function recording(seen: { options: RunProfileOptions, dshHome: string | undefined }[]): StartDependencies {
    return {
      runProfile: (options) => {
        seen.push({ options, dshHome: process.env.DSH_HOME })
        return Promise.resolve()
      },
      loadEnvironment: () => createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]),
      probe: () => Promise.resolve('answered'),
      onExit: () => undefined,
    }
  }

  it('boots the CLI profile with DSH_HOME set to the Delo home, and a second start leaves one holder', async () => {
    expect(await main(['setup'], context)).toBe(EXIT.ok)
    const prepared = await prepareHome(context, undefined)
    expect(prepared.home).toEqual({ path: deloHome, ignoredDshHome: dshHome })
    const seen: { options: RunProfileOptions, dshHome: string | undefined }[] = []
    expect(await startForeground({ home: deloHome, profile: 'default', open: true, output: context }, recording(seen))).toBeUndefined()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ dshHome: deloHome, options: { profile: 'default', patchFiles: [], args: [] } })
    expect(process.env.DELO_HOME).toBe(deloHome)
    expect(process.env.DELO_PROFILE).toBe('default')
    const lock = JSON.parse(readFileSync(join(deloHome, 'run', 'default', 'home.lock'), 'utf8')) as { pid: number }
    expect(lock.pid).toBe(process.pid)
    const printed: string[] = []
    expect(await startForeground({ home: deloHome, profile: 'default', open: false, output: { ...context, stdout: text => void printed.push(text) } }, recording(seen))).toBe(EXIT.ok)
    expect(printed.join('')).toContain(`Delo is already running for the profile default (process ${String(process.pid)}`)
    expect(seen).toHaveLength(1)
    const silent: StartDependencies = { ...recording(seen), probe: () => Promise.resolve('silent') }
    await expect(startForeground({ home: deloHome, profile: 'default', open: false, output: context }, silent)).rejects.toMatchObject({ code: 'HOME_UNRESPONSIVE' })
    expect(seen).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(deloHome, 'run', 'default', 'home.lock'), 'utf8'))).toEqual(lock)
  })

  it('releases the lock when the profile fails to boot, and refuses a home without the CLI profile', async () => {
    await prepareHome(context, undefined)
    await expect(startForeground({ home: deloHome, profile: 'default', open: false, output: context }, recording([]))).rejects.toThrow('run: delorun setup')
    expect(await main(['setup'], context)).toBe(EXIT.ok)
    const failing: StartDependencies = { ...recording([]), runProfile: () => Promise.reject(new Error('boot failed')) }
    await expect(startForeground({ home: deloHome, profile: 'default', open: false, output: context }, failing)).rejects.toThrow('failed to start: boot failed')
    expect(readdirSync(join(deloHome, 'run', 'default'))).toEqual([])
  })
})
