/**
 * `delorun headless` boots upstream's `headless` profile through Delorun's composition (`delorun/apps/cli/src/headless.ts`):
 * with C1's sandbox overlay last, upstream's launcher options refused, the booted rows held to the sandbox invariants,
 * and the run registered as a shared user of the chat data. Upstream's runner is replaced by one that mounts what
 * the composition composed.
 */
import { CLI_PROFILE } from '@delorun/contract-home-layout'
import { shellQuote } from '@delorun/home'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunProfileOptions } from '@deepseek-ai/dsh/profile-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { HostNotStoppedError } from '@delorun/home-process'
import { dangerousGrantPath, permissionStorePath, writeDangerousGrant, writePermissionStore, type WorkspacePermission } from '@delorun/plugin-permission-defaults/store'
import { ANSWERS_FILENAME } from '@delorun/setup-apply'
import { workspaceKey } from '@delorun/plugin-permission-defaults/workspace'
import { stringify } from 'yaml'
import { prepareHome, type CommandContext } from '../src/command.ts'
import { NO_APPROVED_CONTENT } from '../src/compose.ts'
import { NO_RELEASE_PACKS } from '../src/release-packs.ts'
import type { BootedRow } from '../src/delorun-bundles.ts'
import { CliError, EXIT } from '../src/exit.ts'
import { cliRefusal } from '../src/refusals.ts'
import { fullAccessPresetNames, fullAccessRequests, HEADLESS_PROFILE, refuseLauncherOptions, type HeadlessDependencies } from '../src/headless.ts'
import type { PatchLayer } from '../src/patch-layers.ts'
import { headless, headlessCommand, headlessDependencies } from '../src/upstream.ts'
import { installCliLastResort, registerFatalRelease } from '../src/last-resort.ts'
import { upstreamAddHeadlessBundle, upstreamDependencies } from '../src/start.ts'
import { composedBootRows, composedProviders } from './fixtures/composed-rows.ts'

let osHome: string
let delorunHome: string
let workspace: string
let context: CommandContext

beforeEach(async () => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-headless-')))
  delorunHome = join(osHome, '.delorun')
  workspace = join(osHome, 'work')
  mkdirSync(workspace)
  vi.stubEnv('HOME', osHome)
  vi.stubEnv('USERPROFILE', osHome)
  vi.stubEnv('DSH_HOME', join(osHome, '.dsh'))
  vi.stubEnv('DELORUN_HOME', undefined)
  vi.stubEnv('DELORUN_PROFILE', undefined)
  context = { env: { HOME: osHome, DSH_HOME: join(osHome, '.dsh') }, stdout: () => undefined, stderr: () => undefined }
  await prepareHome(context, undefined, true)
  await upstreamAddHeadlessBundle(delorunHome, context)
}, 120_000)

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(osHome, { recursive: true, force: true })
})

/**
 * Dependencies whose runner records what it was given and mounts the composition, with rows replaced.
 * @param seen - collects the runner's options.
 * @param stops - collects each stop: `shutdown <code>` through upstream's process shutdown, `dispose` through the
 *   profile's own teardown.
 * @param overrides - rows that replace the composed ones.
 * @returns the dependencies.
 */
function recording(seen: RunProfileOptions[], stops: string[], overrides: readonly BootedRow[] = [], fatalRelease: HeadlessDependencies['fatalRelease'] = () => () => undefined): HeadlessDependencies {
  return {
    fatalRelease,
    missingModelKey: () => Promise.resolve(undefined),
    prepareProfile: upstreamDependencies().prepareProfile,
    approvedPluginContent: NO_APPROVED_CONTENT,
    releasePacks: NO_RELEASE_PACKS,
    preStartSteps: upstreamDependencies().preStartSteps,
    cwd: () => workspace,
    loadEnvironment: () => createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]),
    runProfile: (options) => {
      seen.push(options)
      const rows = (): BootedRow[] => composedBootRows(delorunHome, options, overrides)
      return Promise.resolve({
        configSchemas: () => [],
        settleSecretValues: () => Promise.resolve({ moved: [], notices: [] }),
        rows,
        providerOf: composedProviders(rows),
        releaseTurns: () => undefined,
        shutdown: (code) => { stops.push(`shutdown ${String(code)}`); return Promise.resolve() },
        dispose: () => { stops.push('dispose'); return Promise.resolve() },
        watchChats: () => undefined,
        watchUpdates: () => Promise.resolve(),
        studio: () => undefined,
        studioLink: () => ({ kind: 'unavailable', reason: 'the Host serves no studio' }),
        reload: () => Promise.resolve({ ok: true }),
      })
    },
  }
}

describe('delorun headless', { timeout: 60_000 }, () => {
  it('boots the headless profile with the sandbox overlay last and the task\'s arguments, registered as a shared user', async () => {
    const seen: RunProfileOptions[] = []
    const exits: (() => void)[] = []
    expect(await headless(['--json', 'what is 2+2'], context, recording(seen, []), (listener) => { exits.push(listener) })).toBeUndefined()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ profile: HEADLESS_PROFILE, args: ['--json', 'what is 2+2'], patchFiles: [join(delorunHome, 'run', HEADLESS_PROFILE, 'sandbox.patch.yml')] })
    expect(existsSync(join(delorunHome, 'run', HEADLESS_PROFILE, 'sandbox.patch.yml'))).toBe(true)
    expect(exits).toHaveLength(1)
    exits[0]!()
  })

  it('refuses before booting when the profile\'s model needs a key that is not set, naming the provider and variable', async () => {
    const seen: RunProfileOptions[] = []
    const dependencies: HeadlessDependencies = { ...recording(seen, []), missingModelKey: () => Promise.resolve({ label: 'OpenAI', variable: 'OPENAI_API_KEY' }) }
    const error: unknown = await headless(['task'], context, dependencies, () => undefined).then(() => undefined, (failure: unknown) => failure)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).message).toBe('delorun headless: Delorun has no OpenAI API key, so it cannot answer. Set OPENAI_API_KEY in your shell, or run delorun setup key.')
    expect(seen).toEqual([])
  })

  it('boots without a key when the profile\'s model needs none from the CLI', async () => {
    const seen: RunProfileOptions[] = []
    const exits: (() => void)[] = []
    const dependencies: HeadlessDependencies = { ...recording(seen, []), missingModelKey: () => Promise.resolve(undefined) }
    expect(await headless(['task'], context, dependencies, (listener) => { exits.push(listener) })).toBeUndefined()
    expect(seen).toHaveLength(1)
    exits[0]!()
  })

  it('disposes the booted Host within the bound when the run crashes after boot, then exits 1', async () => {
    const emitter = new EventEmitter()
    const exits: number[] = []
    const uninstall = installCliLastResort(['headless', 'task'], { process: emitter, stderr: () => undefined, exit: (code) => { exits.push(code) } })
    const stops: string[] = []
    let unregister: (() => void) | undefined
    try {
      expect(await headless(['task'], context, recording([], stops, [], (teardown) => (unregister = registerFatalRelease(teardown))), () => undefined)).toBeUndefined()
      emitter.emit('uncaughtException', new Error('the task crashed'))
      await vi.waitFor(() => { expect(exits).toEqual([1]) })
      expect(stops).toEqual(['dispose'])
    } finally {
      unregister?.()
      uninstall()
    }
  })

  it('leaves no crash teardown registered after a refused Host stopped', async () => {
    let registered = 0
    const fatalRelease: HeadlessDependencies['fatalRelease'] = () => { registered += 1; return () => { registered -= 1 } }
    const refused = await headless(['task'], context, recording([], [], [{ id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local', disabled: false, state: 'failed' }], fatalRelease), () => undefined).then(() => undefined, (failure: unknown) => failure)
    expect(refused).toBeInstanceOf(CliError)
    expect(registered).toBe(0)
  })

  it('refuses upstream\'s launcher options before anything runs', async () => {
    for (const option of ['--profile', '--patch=x.yml', '--from-default-profile', '--dump-config']) {
      const error: unknown = await headless([option, 'task'], context, recording([], [])).then(() => undefined, (failure: unknown) => failure)
      expect(error).toBeInstanceOf(CliError)
      expect((error as CliError).exit).toBe(EXIT.usage)
      expect((error as CliError).message).toContain(`${option.split('=')[0]!} is refused`)
    }
    expect(() => { refuseLauncherOptions(['task', 'with', 'words']) }).not.toThrow()
  })

  it('refuses a home patch that disables the sandbox row, and stops a Host whose sandbox row did not start', async () => {
    writeFileSync(join(delorunHome, 'cordis.patch.yml'), stringify([{ id: 'sandbox', disabled: true }]))
    const seen: RunProfileOptions[] = []
    await expect(headless(['task'], context, recording(seen, []), () => undefined)).rejects.toThrow('sandbox is disabled')
    expect(seen).toEqual([])
    rmSync(join(delorunHome, 'cordis.patch.yml'))
    const stops: string[] = []
    await expect(headless(['task'], context, recording(seen, stops, [{ id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local', disabled: false, state: 'failed' }]), () => undefined)).rejects.toThrow('sandbox did not start (failed)')
    // Upstream's process shutdown may end the process before `main` prints the refusal; the profile's teardown does not.
    expect(stops).toEqual(['dispose'])
  })

  it('reports a refused Host whose teardown fails with the refusal, and hands the process to upstream\'s shutdown only after the report', async () => {
    const stops: string[] = []
    const base = recording([], stops, [{ id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local', disabled: false, state: 'failed' }])
    const stuck: HeadlessDependencies = { ...base, runProfile: async options => ({ ...await base.runProfile(options), dispose: async () => Promise.reject(new Error('a row did not dispose')) }) }
    const failure = await headless(['task'], context, stuck, () => undefined).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HostNotStoppedError)
    const reported = cliRefusal(failure, ['headless', 'task'])
    expect(reported.text).toContain('sandbox did not start (failed)')
    expect(reported.text).toContain('the refused Host failed to stop (a row did not dispose) and may still run')
    expect(reported.exit).toBe(EXIT.failed)
    expect(stops).toEqual([])
    await new Promise(resolve => setImmediate(resolve))
    expect(stops).toEqual([`shutdown ${String(EXIT.failed)}`])
  })

  it('runs the pre-start steps for headless before it composes, and a refusing step stops it before any boot', async () => {
    const ran: string[] = []
    const steps = upstreamDependencies().preStartSteps.map(step => ({ ...step, run: () => { ran.push(step.name); return Promise.resolve() } }))
    const seen: RunProfileOptions[] = []
    expect(await headless(['task'], context, { ...recording(seen, []), preStartSteps: steps }, () => undefined)).toBeUndefined()
    expect(ran).toEqual(['stock-import-recovery', 'data-format-record', 'profile-migrations', 'changes', 'plugin-changes', 'update-notice'])
    const refusal = new CliError(EXIT.failed, 'delorun: an import was interrupted')
    const refusing = steps.map(step => step.name === 'stock-import-recovery' ? { ...step, run: () => Promise.reject(refusal) } : step)
    await expect(headless(['task'], context, { ...recording(seen, []), preStartSteps: refusing }, () => undefined)).rejects.toBe(refusal)
    expect(seen).toHaveLength(1)
  })

  it('releases the turn gate\'s start hold after the booted Host passed its check, and not for one it stops', async () => {
    const released: string[] = []
    const watching = (overrides: readonly BootedRow[]): HeadlessDependencies => {
      const base = recording([], [], overrides)
      return { ...base, runProfile: async options => ({ ...await base.runProfile(options), releaseTurns: () => { released.push('release') } }) }
    }
    await expect(headless(['task'], context, watching([{ id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local', disabled: false, state: 'failed' }]), () => undefined)).rejects.toThrow('sandbox did not start (failed)')
    expect(released).toEqual([])
    expect(await headless(['task'], context, watching([]), () => undefined)).toBeUndefined()
    expect(released).toEqual(['release'])
  })

  it('reports a profile that fails to boot', async () => {
    const failing: HeadlessDependencies = { ...recording([], []), runProfile: () => Promise.reject(new Error('boot failed')) }
    await expect(headless(['task'], context, failing, () => undefined)).rejects.toThrow('the headless profile failed to start: boot failed')
    await expect(headless(['task'], context, { ...failing, runProfile: () => Promise.reject('plain') }, () => undefined)).rejects.toThrow('failed to start: plain')
  })

  it('is the command delorun runs, over upstream\'s runner', () => {
    expect(headlessCommand.name).toBe('headless')
    expect(headlessDependencies().cwd()).toBe(process.cwd())
    expect(Object.keys(headlessDependencies()).sort()).toEqual(['approvedPluginContent', 'cwd', 'fatalRelease', 'loadEnvironment', 'missingModelKey', 'preStartSteps', 'prepareProfile', 'releasePacks', 'runProfile'])
  })
})

/**
 * Record entries in the home's permission store, as the studio and `delorun workspace full-access` do.
 * @param entries - the workspace keys and their recorded permissions.
 */
async function writeStore(entries: readonly (readonly [string, WorkspacePermission])[]): Promise<void> {
  const path = permissionStorePath(delorunHome)
  mkdirSync(dirname(dirname(path)), { recursive: true, mode: 0o700 })
  await writePermissionStore(path, new Map(entries))
}

describe('delorun headless asking for full access', { timeout: 60_000 }, () => {
  const FULL = 'danger-full-access'
  const grant: WorkspacePermission = { preset: FULL, fullAccessGrantedAt: 1_700_000_000_000 }

  /**
   * Run the task with the given arguments and environment variable.
   * @param args - the arguments after `headless`.
   * @param env - extra launch variables.
   * @param seen - collects the runner's options.
   * @returns the run's outcome: the error it rejected with, if any.
   */
  async function attempt(args: readonly string[], env: Record<string, string>, seen: RunProfileOptions[]): Promise<unknown> {
    return headless(args, { ...context, env: { ...context.env, ...env } }, recording(seen, []), () => undefined).then(() => undefined, (failure: unknown) => failure)
  }

  it.each([
    ['--permission-mode danger-full-access', ['--permission-mode', FULL, 'task'], {}],
    ['--permission-mode=danger-full-access', [`--permission-mode=${FULL}`, 'task'], {}],
    ['DSH_PERMISSION_MODE=danger-full-access in the environment', ['task'], { DSH_PERMISSION_MODE: FULL }],
  ] as const)('refuses %s in a workspace without a grant, before the profile boots, naming the workspace and how to grant it', async (_name, args, env) => {
    const seen: RunProfileOptions[] = []
    const error = await attempt(args, env, seen)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).exit).toBe(EXIT.failed)
    expect((error as CliError).message).toContain(JSON.stringify(workspaceKey(workspace)))
    expect((error as CliError).message).toContain(`run delorun workspace full-access ${shellQuote(workspaceKey(workspace))} on`)
    expect((error as CliError).message).toContain('in the studio\'s Settings → Safety → Permissions;')
    expect(seen).toEqual([])
  })

  it('refuses it when the store grants only another workspace or records the preset without a grant', async () => {
    await writeStore([[join(osHome, 'elsewhere'), grant], [workspaceKey(workspace), { preset: FULL, fullAccessGrantedAt: null }]])
    const seen: RunProfileOptions[] = []
    expect(await attempt(['--permission-mode', FULL], {}, seen)).toBeInstanceOf(CliError)
    expect(seen).toEqual([])
  })

  it('allows it when the store holds a grant for the workspace', async () => {
    await writeStore([[workspaceKey(workspace), grant]])
    const seen: RunProfileOptions[] = []
    expect(await attempt(['--permission-mode', FULL, 'task'], { DSH_PERMISSION_MODE: FULL }, seen)).toBeUndefined()
    expect(seen).toHaveLength(1)
    expect(seen[0]?.args).toEqual(['--permission-mode', FULL, 'task'])
  })

  describe('in dangerous mode', () => {
    /**
     * Record the setup answer of the CLI profile, which `delorun headless` reads its dangerous mode from.
     * @param prompts - the prompts answer.
     */
    function answer(prompts: string): void {
      const directory = join(delorunHome, 'profiles', CLI_PROFILE)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, ANSWERS_FILENAME), JSON.stringify({ prompts }))
    }

    it.each([
      ['the grant file is missing', 'dangerous', false],
      ['the answer is stock', 'stock', true],
      ['the answer is safer', 'safer', true],
    ] as const)('still refuses full access in a workspace without a grant when %s', async (_name, prompts, withGrantFile) => {
      answer(prompts)
      if (withGrantFile) await writeDangerousGrant(delorunHome)
      const seen: RunProfileOptions[] = []
      expect(await attempt(['--permission-mode', FULL, 'task'], {}, seen)).toBeInstanceOf(CliError)
      expect(seen).toEqual([])
    })

    it('still refuses it when the grant file is a symbolic link', async () => {
      answer('dangerous')
      const path = dangerousGrantPath(delorunHome)
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      writeFileSync(join(osHome, 'real.json'), '{}', { mode: 0o600 })
      symlinkSync(join(osHome, 'real.json'), path)
      expect(await attempt(['--permission-mode', FULL, 'task'], {}, [])).toBeInstanceOf(CliError)
    })

    it('runs a full-access task in a workspace without its own grant when the answer is dangerous and the grant file is valid', async () => {
      answer('dangerous')
      await writeDangerousGrant(delorunHome)
      const seen: RunProfileOptions[] = []
      expect(await attempt(['--permission-mode', FULL, 'task'], {}, seen)).toBeUndefined()
      expect(seen).toHaveLength(1)
    })
  })

  it('refuses it naming the store when the store cannot be read, even though a grant may be in it', async () => {
    const path = permissionStorePath(delorunHome)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, 'not a permission store', { mode: 0o600 })
    const seen: RunProfileOptions[] = []
    const error = await attempt(['--permission-mode', FULL], {}, seen)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).message).toContain(path)
    expect((error as CliError).message).toContain('cannot be read')
    expect(seen).toEqual([])
  })

  it('does not ask for the store when the run asks for no full access', async () => {
    const path = permissionStorePath(delorunHome)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, 'not a permission store', { mode: 0o600 })
    const seen: RunProfileOptions[] = []
    expect(await attempt(['--permission-mode', 'workspace-write', 'task'], {}, seen)).toBeUndefined()
    expect(seen).toHaveLength(1)
  })

  it('lists the requests: the option, the variable, both, and neither for a safer mode or an argument after "--"', () => {
    expect(fullAccessRequests(['--permission-mode', FULL], {})).toEqual([`--permission-mode ${FULL}`])
    expect(fullAccessRequests([`--permission-mode=${FULL}`], {})).toEqual([`--permission-mode ${FULL}`])
    expect(fullAccessRequests(['task'], { DSH_PERMISSION_MODE: FULL })).toEqual([`DSH_PERMISSION_MODE=${FULL}`])
    expect(fullAccessRequests(['--permission-mode', FULL], { DSH_PERMISSION_MODE: FULL })).toEqual([`--permission-mode ${FULL}`, `DSH_PERMISSION_MODE=${FULL}`])
    expect(fullAccessRequests(['--permission-mode', 'workspace-write', 'task'], {})).toEqual([])
    expect(fullAccessRequests(['--permission-mode=workspace-write'], { DSH_PERMISSION_MODE: 'workspace-write' })).toEqual([])
    expect(fullAccessRequests(['--', '--permission-mode', FULL], {})).toEqual([])
    expect(fullAccessRequests(['task', '--', `--permission-mode=${FULL}`], {})).toEqual([])
  })

  it('reads a request trimmed and case-folded, in the option and in the variable', () => {
    expect(fullAccessRequests(['--permission-mode', ` ${FULL.toUpperCase()} `], {})).toEqual([`--permission-mode ${FULL.toUpperCase()}`])
    expect(fullAccessRequests(['task'], { DSH_PERMISSION_MODE: ` Danger-Full-Access\t` })).toEqual(['DSH_PERMISSION_MODE=Danger-Full-Access'])
  })

  it('counts a preset of the profile that selects the full-access sandbox mode, in any layer, and no other preset', () => {
    const layers: PatchLayer[] = [
      { source: 'base', patches: [{ insert: [{ id: 'permission', name: '@deepseek-ai/dsh-permission-presets', config: { presets: { 'workspace-write': { sandbox: 'workspace-write' } } } }] }] },
      { source: 'profile', patches: [{ id: 'permission', config: { presets: { Yolo: { sandbox: ' DANGER-full-access' }, careful: { sandbox: 'read-only' } } } }] },
    ]
    const presets = fullAccessPresetNames(layers)
    expect([...presets].sort()).toEqual([FULL, 'yolo'])
    expect(fullAccessRequests(['--permission-mode', 'yolo'], {}, presets)).toEqual(['--permission-mode yolo'])
    expect(fullAccessRequests(['--permission-mode=careful'], {}, presets)).toEqual([])
  })
})
