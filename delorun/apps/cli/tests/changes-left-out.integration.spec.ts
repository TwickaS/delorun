/**
 * A start that fails right after a change starts again without that change: the foreground start of a set-up home,
 * with upstream's profile runner replaced by one that fails while a plugin's active directory holds its newest change,
 * and the child process of the second start replaced by a second start in this process. The child process itself is
 * started for real by {@link relaunchForeground}'s spec at the end.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunProfileOptions } from '@deepseek-ai/dsh/profile-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { activeDirectory, applyChange, attestTerminal, enforceApprovedContent, listChanges, readChangeLog, setProtection, type ChangeEntry } from '@delorun/changes'
import { isCarriedPackage } from '../src/changes/start.ts'
import { CHANGES_RETRY_ENV, relaunchForeground, SECOND_FAILURE_LINE } from '../src/changes/retry.ts'
import type { CommandContext } from '../src/command.ts'
import { NO_APPROVED_CONTENT } from '../src/compose.ts'
import { NO_RELEASE_PACKS } from '../src/release-packs.ts'
import type { BootedRow } from '../src/delorun-bundles.ts'
import { CliError, EXIT } from '../src/exit.ts'
import { main } from '../src/main.ts'
import { requestStudioLink } from '../src/open/studio.ts'
import { realPreStartSteps, startForeground, upstreamDependencies, type StartDependencies, type StartRequest } from '../src/start.ts'
import { runtimeOfFile } from '../src/update/runtime.ts'
import { composedBootRows, composedProviders } from './fixtures/composed-rows.ts'

let osHome: string
let delorunHome: string
let context: CommandContext
let stdout: string[]
let stderr: string[]

beforeEach(() => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-left-out-')))
  delorunHome = join(osHome, '.delorun')
  vi.stubEnv('HOME', osHome)
  vi.stubEnv('USERPROFILE', osHome)
  // prepareHome sets these on the process; stubbing them first restores them afterwards.
  vi.stubEnv('DSH_HOME', join(osHome, '.dsh'))
  vi.stubEnv('DELORUN_HOME', undefined)
  vi.stubEnv('DELORUN_PROFILE', undefined)
  stdout = []
  stderr = []
  context = { env: { HOME: osHome, DSH_HOME: join(osHome, '.dsh'), DEEPSEEK_API_KEY: 'fixture-key' }, stdout: text => void stdout.push(text), stderr: text => void stderr.push(text) }
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(osHome, { recursive: true, force: true })
})

const PROFILE = 'default'

/**
 * @returns the CLI profile's directory.
 */
function profileDir(): string {
  return join(delorunHome, 'profiles', PROFILE)
}

/**
 * Link plugins from folders into the set-up CLI profile, as `delorun plugin add link:` leaves them, turn protection on,
 * and bring them under Changes as the first start does, approving each as it is.
 * @param names - the plugins' package names, each also its folder's name and row id.
 * @returns each plugin's folder, by name.
 */
async function linkedPlugins(...names: string[]): Promise<Record<string, string>> {
  const folders: Record<string, string> = {}
  const path = join(profileDir(), 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dependencies?: Record<string, string> }
  for (const name of names) {
    const folder = join(osHome, name)
    mkdirSync(folder)
    writeFileSync(join(folder, 'package.json'), `{"name":"${name}","version":"1.0.0"}\n`)
    writeFileSync(join(folder, 'index.js'), 'export default "one"\n')
    manifest.dependencies = { ...manifest.dependencies, [name]: `link:${folder}` }
    const link = join(profileDir(), 'node_modules', name)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(folder, link, 'junction')
    folders[name] = folder
  }
  writeFileSync(path, JSON.stringify(manifest))
  // With protection on, each edit waits for review until the spec applies it.
  await setProtection(delorunHome, 'on', attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } }))
  await enforceApprovedContent({ home: delorunHome, profile: PROFILE, profileDir: profileDir(), harnessLink: isCarriedPackage })
  return folders
}

/**
 * Edit a plugin's folder and apply the change at a terminal while Delorun does not run.
 * @param folder - the plugin's folder.
 * @param at - when the change is applied.
 * @returns the applied change.
 */
async function applyEdit(folder: string, at: Date): Promise<ChangeEntry> {
  writeFileSync(join(folder, 'index.js'), 'export default "two"\n')
  const ctx = { home: delorunHome, profile: PROFILE, profileDir: profileDir(), now: () => at }
  const change = (await listChanges(ctx)).pending.find(candidate => candidate.source === folder)!
  return (await applyChange(ctx, change.id, attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } }), { reload: () => Promise.resolve(undefined) })).entry
}

/**
 * @param name - a plugin's package name.
 * @returns the `index.js` its active directory holds, or undefined when it holds none.
 */
function activeIndex(name: string): string | undefined {
  const path = join(activeDirectory(delorunHome, PROFILE, name), 'index.js')
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

/** What each boot saw, and how many second starts ran. */
interface Runs {
  /** Each boot's `index.js` of the plugins named, by plugin. */
  readonly boots: Record<string, string | undefined>[]
  /** The second starts. */
  readonly relaunches: StartRequest[]
}

/**
 * Start dependencies whose profile runner fails while a plugin's active directory holds `two`, as a change that breaks
 * the start does, and whose second start runs in this process with the retry marker.
 * @param plugins - the plugins whose content each boot reads.
 * @param fails - whether a boot fails for what it saw; by default when any plugin holds `two`.
 * @param rows - the rows a boot reports beside the composed ones.
 * @returns the dependencies and what they saw.
 */
function breakingDependencies(plugins: readonly string[], fails: (seen: Record<string, string | undefined>) => boolean = seen => Object.values(seen).some(text => text?.includes('two') === true), rows: (seen: Record<string, string | undefined>) => readonly BootedRow[] = () => []): { readonly dependencies: StartDependencies, readonly runs: Runs } {
  const runs: Runs = { boots: [], relaunches: [] }
  const dependencies: StartDependencies = {
    approvedPluginContent: NO_APPROVED_CONTENT,
    releasePacks: NO_RELEASE_PACKS,
    preStartSteps: realPreStartSteps(() => Promise.resolve(false), () => Promise.resolve(false)),
    fatalRelease: () => () => undefined,
    prepareProfile: upstreamDependencies().prepareProfile,
    runProfile: (options: RunProfileOptions) => {
      const seen = Object.fromEntries(plugins.map(name => [name, activeIndex(name)]))
      runs.boots.push(seen)
      if (fails(seen)) return Promise.reject(new Error(`SyntaxError: Unexpected token in ${plugins.join(', ')}`))
      const booted = (): BootedRow[] => composedBootRows(delorunHome, options, rows(seen))
      return Promise.resolve({ configSchemas: () => [], settleSecretValues: () => Promise.resolve({ moved: [], notices: [] }), rows: booted, providerOf: composedProviders(booted), releaseTurns: () => {}, shutdown: () => Promise.resolve(), dispose: () => Promise.resolve(), watchChats: () => {}, watchUpdates: () => Promise.resolve(), studio: () => undefined, studioLink: () => ({ kind: 'unavailable', reason: 'the Host serves no studio' }), reload: () => Promise.resolve({ ok: true }) })
    },
    loadEnvironment: () => createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]),
    probe: () => () => Promise.resolve('answered'),
    onSignal: () => () => undefined,
    onExit: () => undefined,
    exit: () => undefined,
    captureOutput: () => () => undefined,
    runtime: home => runtimeOfFile(home, join(home, 'not-a-runtime')),
    updates: () => { throw new Error('a start outside the store has no update support') },
    checkRuntime: () => Promise.reject(new Error('a start outside the store checks no stored runtime')),
    successorStartCheck: () => Promise.reject(new Error('a start outside the store has no successor')),
    handover: () => Promise.resolve(undefined),
    handOff: () => Promise.resolve(undefined),
    opener: { canOpen: () => true, link: requestStudioLink, open: () => Promise.reject(new Error('no link reaches the browser here')) },
    relaunch: (request) => {
      runs.relaunches.push({ ...request, home: delorunHome })
      return startForeground({ home: delorunHome, profile: request.profile, open: request.open, output: request.output, env: { ...request.env, [CHANGES_RETRY_ENV]: '1' } }, dependencies)
    },
  }
  return { dependencies, runs }
}

/**
 * @returns a foreground start of the CLI profile.
 */
function request(): StartRequest {
  return { home: delorunHome, profile: PROFILE, open: false, output: context, env: context.env }
}

describe('a start that fails right after a change', { timeout: 120_000 }, () => {
  it('a start that fails on a new plugin starts without it and names it', async () => {
    expect(await main(['setup', '--yes'], context)).toBe(EXIT.ok)
    const { plug } = await linkedPlugins('plug')
    const change = await applyEdit(plug!, new Date(Date.now() + 60_000))
    stdout.length = 0
    stderr.length = 0
    const { dependencies, runs } = breakingDependencies(['plug'])
    expect(await startForeground(request(), dependencies)).toBeUndefined()
    expect(runs.boots).toEqual([{ plug: 'export default "two"\n' }, { plug: 'export default "one"\n' }])
    expect(runs.relaunches).toHaveLength(1)
    const words = [
      `Delorun did not start with your latest change to plug (${change.id}): SyntaxError: Unexpected token in plug.`,
      'It starts without it now; your files are unchanged.',
      `To try it again: delorun changes apply ${change.id}. To undo it: delorun changes undo ${change.id}.`,
    ].join('\n')
    expect(stderr.join('')).toBe(`${words}\n`)
    // The second start's own notice names it too, as every later start does.
    expect(stdout.join('')).toContain(words)
    expect((await readChangeLog(delorunHome, PROFILE)).entries.find(entry => entry.id === change.id)).toMatchObject({ state: 'left-out-at-start', decidedFrom: 'start', leftOut: { failure: 'SyntaxError: Unexpected token in plug' } })
    expect(readFileSync(join(plug!, 'index.js'), 'utf8')).toBe('export default "two"\n')
  })

  it('a second failure stops with the safe-mode command and does not retry again', async () => {
    expect(await main(['setup', '--yes'], context)).toBe(EXIT.ok)
    const { plug, plug2 } = await linkedPlugins('plug', 'plug2')
    const older = await applyEdit(plug!, new Date(Date.now() + 60_000))
    const newer = await applyEdit(plug2!, new Date(Date.now() + 120_000))
    stderr.length = 0
    // Both changes break the start, so leaving out the newer one is not enough.
    const { dependencies, runs } = breakingDependencies(['plug', 'plug2'])
    const refusal = await startForeground(request(), dependencies).then(() => undefined, (error: unknown) => error)
    expect(refusal).toBeInstanceOf(CliError)
    expect(refusal).toMatchObject({ exit: EXIT.failed, message: 'delorun: the CLI profile default failed to start: SyntaxError: Unexpected token in plug, plug2' })
    expect(runs.relaunches).toHaveLength(1)
    expect(runs.boots).toEqual([{ plug: 'export default "two"\n', plug2: 'export default "two"\n' }, { plug: 'export default "two"\n', plug2: 'export default "one"\n' }])
    expect(stderr.join('')).toContain(`Delorun did not start with your latest change to plug2 (${newer.id})`)
    expect(stderr.join('')).toContain(`${SECOND_FAILURE_LINE}\n`)
    expect(stderr.join('').split(SECOND_FAILURE_LINE)).toHaveLength(2)
    const entries = (await readChangeLog(delorunHome, PROFILE)).entries
    expect(entries.find(entry => entry.id === newer.id)?.state).toBe('left-out-at-start')
    expect(entries.find(entry => entry.id === older.id)?.state).toBe('applied')
  })

  it('leaves the change out when a row of its plugin did not activate, and starts as before when no change can be left out', async () => {
    expect(await main(['setup', '--yes'], context)).toBe(EXIT.ok)
    const { plug } = await linkedPlugins('plug')
    const change = await applyEdit(plug!, new Date(Date.now() + 60_000))
    const failedRow = (seen: Record<string, string | undefined>): readonly BootedRow[] => seen.plug?.includes('two') === true ? [{ id: 'plug', name: 'plug', disabled: false, state: 'failed' }] : []
    const { dependencies, runs } = breakingDependencies(['plug'], () => false, failedRow)
    expect(await startForeground(request(), dependencies)).toBeUndefined()
    expect(runs.relaunches).toHaveLength(1)
    expect(stderr.join('')).toContain(`Delorun did not start with your latest change to plug (${change.id}): plug did not load: row plug is failed.`)
    rmSync(join(delorunHome, 'run', PROFILE, 'home.lock'), { force: true })

    // The change is left out already, so a failed start leaves nothing more out and fails as before.
    const failing = breakingDependencies(['plug'], () => true)
    await expect(startForeground(request(), failing.dependencies)).rejects.toThrow('failed to start: SyntaxError')
    expect(failing.runs.relaunches).toHaveLength(0)
  })
})

describe('the second start in its own process', { timeout: 60_000 }, () => {
  it('runs delorun start --foreground with the retry marker, and exits with its code', async () => {
    const script = join(osHome, 'entry.mjs')
    const record = join(osHome, 'record.json')
    writeFileSync(script, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), retry: process.env.${CHANGES_RETRY_ENV} ?? null, home: process.env.HOME }))\nprocess.exit(3)\n`)
    const previous = process.exitCode
    try {
      expect(await relaunchForeground({ profile: 'work', open: true, output: context, env: { HOME: osHome, PATH: process.env.PATH } }, { entry: script, execArgv: [] })).toBeUndefined()
      expect(process.exitCode).toBe(3)
    } finally {
      process.exitCode = previous
    }
    expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({ argv: ['start', '--foreground', '--profile', 'work', '--open'], retry: '1', home: osHome })
    await expect(relaunchForeground({ profile: 'work', open: false, output: context, env: {} }, { entry: undefined, execArgv: [] })).rejects.toThrow('entry point is unknown')
  })

  it('passes SIGTERM and SIGHUP to the second start, waits through SIGINT, and stops passing them once it ends', async () => {
    const script = join(osHome, 'entry.mjs')
    const ready = join(osHome, 'ready')
    const hup = join(osHome, 'hup')
    writeFileSync(script, `import { writeFileSync } from 'node:fs'\nlet hups = 0\nprocess.on('SIGINT', () => {})\nprocess.on('SIGHUP', () => { hups += 1; writeFileSync(${JSON.stringify(hup)}, '') })\nprocess.on('SIGTERM', () => process.exit(10 + hups))\nwriteFileSync(${JSON.stringify(ready)}, '')\nsetInterval(() => {}, 1000)\n`)
    const previous = process.exitCode
    const listeners = process.listenerCount('SIGTERM')
    try {
      const ended = relaunchForeground({ profile: 'default', open: false, output: context, env: { PATH: process.env.PATH } }, { entry: script, execArgv: [] })
      await vi.waitFor(() => { expect(existsSync(ready)).toBe(true) }, { timeout: 30_000, interval: 50 })
      process.emit('SIGINT')
      process.emit('SIGHUP')
      await vi.waitFor(() => { expect(existsSync(hup)).toBe(true) }, { timeout: 30_000, interval: 50 })
      await vi.waitFor(async () => {
        process.emit('SIGTERM')
        expect(await Promise.race([ended.then(() => 'ended'), new Promise(resolve => { setTimeout(resolve, 100, 'waiting') })])).toBe('ended')
      }, { timeout: 30_000, interval: 50 })
      expect(process.exitCode).toBe(11)
    } finally {
      process.exitCode = previous
    }
    expect(process.listenerCount('SIGTERM')).toBe(listeners)
  })

  it('exits failed when a signal ended the second start', async () => {
    const script = join(osHome, 'entry.mjs')
    writeFileSync(script, 'process.kill(process.pid, \'SIGKILL\')\n')
    const previous = process.exitCode
    try {
      expect(await relaunchForeground({ profile: 'default', open: false, output: context, env: { PATH: process.env.PATH } }, { entry: script, execArgv: [] })).toBeUndefined()
      expect(process.exitCode).toBe(EXIT.failed)
    } finally {
      process.exitCode = previous
    }
  })

  it('refuses when the child cannot be started', async () => {
    const original = process.execPath
    Object.defineProperty(process, 'execPath', { value: join(osHome, 'no-node'), configurable: true })
    try {
      await expect(relaunchForeground({ profile: 'default', open: false, output: context, env: {} }, { entry: join(osHome, 'entry.mjs'), execArgv: [] })).rejects.toThrow(/could not start again without the change: spawn .*ENOENT/)
    } finally {
      Object.defineProperty(process, 'execPath', { value: original, configurable: true })
    }
  })
})
