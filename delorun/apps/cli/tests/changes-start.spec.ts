/**
 * Changes' part of a start: a fresh start from the runtime store refuses a runtime whose files differ from the signed
 * release before the profile is touched, and every start, `delorun headless` included, makes each plugin the profile
 * links from a folder load from its active directory before upstream reads the profile.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { activeDirectory, attestTerminal, ChangesError, readChangeLog, setProtection } from '@delorun/changes'
import { RuntimeStoreError } from '@delorun/runtime-store'
import { changesApprovedContent, isCarriedPackage, repointForSuccessor, repointingBoot, repointsBeforeBoot, startChanges } from '../src/changes/start.ts'
import { carriedPackageDirectory } from '../src/delorun-bundles.ts'
import { prepareHome, type CommandContext } from '../src/command.ts'
import { NO_APPROVED_CONTENT } from '../src/compose.ts'
import { NO_RELEASE_PACKS } from '../src/release-packs.ts'
import { CliError, EXIT } from '../src/exit.ts'
import type { HeadlessDependencies } from '../src/headless.ts'
import { realPreStartSteps, startForeground, upstreamDependencies, type StartDependencies } from '../src/start.ts'
import { headless } from '../src/upstream.ts'
import { runtimeOfFile } from '../src/update/runtime.ts'
import { checkRunningRuntime } from '../src/changes/harness-start.ts'
import { storeUpdateSupport } from '../src/update/store-support.ts'

const hooks = vi.hoisted(() => ({ markError: undefined as Error | undefined }))

vi.mock('@delorun/changes', async importOriginal => {
  const actual = await importOriginal<typeof import('@delorun/changes')>()
  return {
    ...actual,
    markShownAtUpgrade: async (...args: Parameters<typeof actual.markShownAtUpgrade>) => {
      if (hooks.markError !== undefined) throw hooks.markError
      return actual.markShownAtUpgrade(...args)
    },
  }
})

let base: string
let home: string
let context: CommandContext & { printed: string[], errors: string[] }

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-changes-')))
  home = join(base, '.delorun')
  vi.stubEnv('HOME', base)
  vi.stubEnv('USERPROFILE', base)
  // prepareHome sets these on the process; stubbing them first restores them afterwards.
  vi.stubEnv('DSH_HOME', join(base, '.dsh'))
  vi.stubEnv('DELORUN_HOME', undefined)
  vi.stubEnv('DELORUN_PROFILE', undefined)
  const printed: string[] = []
  const errors: string[] = []
  context = { env: { HOME: base, DSH_HOME: join(base, '.dsh'), DELORUN_HOME: home }, stdout: text => void printed.push(text), stderr: text => void errors.push(text), printed, errors }
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(base, { recursive: true, force: true })
})

/**
 * A profile under the home that links the plugin `plug` from a folder, as `delorun plugin add link:<folder>` leaves it.
 * @param profile - the profile's name.
 * @returns the folder.
 */
function profileLinkingPlug(profile: string): string {
  const folder = join(base, 'plug')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'package.json'), '{"name":"plug","version":"1.0.0"}\n')
  writeFileSync(join(folder, 'index.js'), 'export default 1\n')
  const profileDir = join(home, 'profiles', profile)
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: `dsh-profile-${profile}`, private: true, dependencies: { plug: `link:${folder}` } }, undefined, 2)}\n`)
  symlinkSync(relative(join(profileDir, 'node_modules'), folder), join(profileDir, 'node_modules', 'plug'))
  return folder
}

/**
 * @param profile - the profile's name.
 * @returns the manifest's spec for `plug`.
 */
function plugSpec(profile: string): string | undefined {
  return (JSON.parse(readFileSync(join(home, 'profiles', profile, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies.plug
}

/**
 * Start dependencies that stop at the profile's preparation, recording the profile's spec for `plug` there.
 * @param seen - receives the spec each preparation saw.
 * @param overrides - replaced dependencies.
 * @returns the dependencies.
 */
function stoppingAtPrepare(seen: (string | undefined)[], overrides: Partial<StartDependencies> = {}): StartDependencies {
  return {
    approvedPluginContent: NO_APPROVED_CONTENT,
    releasePacks: NO_RELEASE_PACKS,
    preStartSteps: realPreStartSteps(() => Promise.resolve(false), () => Promise.resolve(false)),
    fatalRelease: () => () => undefined,
    prepareProfile: () => {
      seen.push(plugSpec('default'))
      return Promise.reject(new Error('stopped after Changes'))
    },
    runProfile: () => Promise.reject(new Error('not reached')),
    loadEnvironment: () => createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]),
    probe: () => () => Promise.resolve('answered'),
    onSignal: () => () => undefined,
    onExit: () => undefined,
    exit: () => undefined,
    captureOutput: () => () => undefined,
    runtime: home => runtimeOfFile(home, join(home, 'not-a-runtime')),
    updates: storeUpdateSupport,
    checkRuntime: () => Promise.reject(new Error('a start outside the store checks no stored runtime')),
    successorStartCheck: () => Promise.reject(new Error('a start outside the store has no successor')),
    handover: () => Promise.resolve(undefined),
    opener: { canOpen: () => false, link: () => Promise.reject(new Error('not reached')), open: () => Promise.reject(new Error('not reached')) },
    relaunch: () => Promise.reject(new Error('no second start here')),
    handOff: () => Promise.resolve(undefined),
    ...overrides,
  }
}

/** The runtime of a home process started from the store's `runtimes/1.2.3/`. */
const fromStore = (home: string): ReturnType<typeof runtimeOfFile> => runtimeOfFile(home, join(home, 'runtimes', '1.2.3', 'lib', 'start.js'))

describe('a start of the CLI profile', { timeout: 60_000 }, () => {
  it('approves a linked plugin at the first start and loads it from its active directory before the profile is read', async () => {
    await prepareHome(context, undefined, true)
    const folder = profileLinkingPlug('default')
    const seen: (string | undefined)[] = []
    await expect(startForeground({ home, profile: 'default', open: false, output: context, env: context.env }, stoppingAtPrepare(seen))).rejects.toThrow('could not be loaded: stopped after Changes')
    const active = activeDirectory(home, 'default', 'plug')
    expect(seen).toEqual([`link:${active}`])
    expect(realpathSync(join(home, 'profiles', 'default', 'node_modules', 'plug'))).toBe(active)
    expect(context.printed.join('')).toBe(`Delorun now runs the approved copy of plug, linked from ${folder}. Edits in that folder wait for your review: delorun changes list.\n`)
  })

  it('refuses a fresh start from the store whose runtime files differ, before the profile is touched', async () => {
    await prepareHome(context, undefined, true)
    profileLinkingPlug('default')
    const seen: (string | undefined)[] = []
    const checked: string[] = []
    const refusal = startForeground({ home, profile: 'default', open: false, output: context, env: context.env }, stoppingAtPrepare(seen, {
      runtime: fromStore,
      checkRuntime: (checkedHome, version) => {
        checked.push(`${checkedHome} ${version}`)
        return Promise.reject(new RuntimeStoreError('RUNTIME_CHANGED', join(checkedHome, 'runtimes', version), `runtime ${version} differs from its signed file list: changed lib/start.js`))
      },
    }))
    await expect(refusal).rejects.toThrow(new CliError(EXIT.failed, 'delorun: Delorun 1.2.3 was not started, because its files differ from the signed release: runtime 1.2.3 differs from its signed file list: changed lib/start.js. See what differs with: delorun verify'))
    expect(checked).toEqual([`${home} 1.2.3`])
    expect(seen).toEqual([])
    expect(plugSpec('default')).toBe(`link:${join(base, 'plug')}`)
    expect((await readChangeLog(home, 'default')).migratedAt).toBeUndefined()
  })

  it('starts from the store when its runtime check passes', async () => {
    await prepareHome(context, undefined, true)
    profileLinkingPlug('default')
    const seen: (string | undefined)[] = []
    await expect(startForeground({ home, profile: 'default', open: false, output: context, env: context.env }, stoppingAtPrepare(seen, { runtime: fromStore, checkRuntime: () => Promise.resolve() })))
      .rejects.toThrow('stopped after Changes')
    expect(seen).toEqual([`link:${activeDirectory(home, 'default', 'plug')}`])
  })
})

describe('the start\'s dependencies', () => {
  it('check a stored runtime with the store\'s own start check', () => {
    expect(upstreamDependencies().checkRuntime).toBe(checkRunningRuntime)
  })
})

describe('isCarriedPackage', () => {
  it('holds only for the directory this installation resolves for the name', () => {
    const carried = carriedPackageDirectory('@delorun/bundle-local')!
    expect(isCarriedPackage('@delorun/bundle-local', carried)).toBe(true)
    expect(isCarriedPackage('@delorun/bundle-local', join(base, 'fork'))).toBe(false)
    expect(isCarriedPackage('@x/not-carried', carried)).toBe(false)
  })
})

describe('startChanges', () => {
  it('passes on a failure of the runtime check that is not the store\'s refusal', async () => {
    const failure = new Error('the store could not be read')
    await expect(startChanges({ home, profile: 'default', runtime: { version: fromStore(home).version, check: () => Promise.reject(failure) } }, () => {})).rejects.toBe(failure)
  })

  it('leaves a link to the bundle this installation carries alone, as a source checkout\'s setup writes it', async () => {
    await prepareHome(context, undefined, true)
    const carried = carriedPackageDirectory('@delorun/bundle-local')!
    mkdirSync(join(home, 'profiles', 'default'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'default', 'package.json'), `${JSON.stringify({ name: 'dsh-profile-default', dependencies: { '@delorun/bundle-local': `link:${carried}` } })}\n`)
    await startChanges({ home, profile: 'default' }, context.stdout)
    expect(context.printed).toEqual([])
    expect(JSON.parse(readFileSync(join(home, 'profiles', 'default', 'package.json'), 'utf8'))).toEqual({ name: 'dsh-profile-default', dependencies: { '@delorun/bundle-local': `link:${carried}` } })
  })

  it('prints nothing for a profile that links no plugin from a folder', async () => {
    await prepareHome(context, undefined, true)
    mkdirSync(join(home, 'profiles', 'default'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'default', 'package.json'), '{"name":"dsh-profile-default","dependencies":{}}\n')
    await startChanges({ home, profile: 'default' }, context.stdout)
    expect(context.printed).toEqual([])
    expect((await readChangeLog(home, 'default')).migratedAt).toBeDefined()
  })

  it('refuses the start when a record of Changes cannot be read, naming it', async () => {
    await prepareHome(context, undefined, true)
    profileLinkingPlug('default')
    mkdirSync(join(home, 'changes', 'profiles', 'default'), { recursive: true, mode: 0o700 })
    writeFileSync(join(home, 'changes', 'profiles', 'default', 'log.json'), '{"schema":"other"}\n', { mode: 0o600 })
    const refusal = startChanges({ home, profile: 'default' }, () => {})
    await expect(refusal).rejects.toBeInstanceOf(CliError)
    await expect(refusal).rejects.toThrow(/^delorun: the profile default was not started, because the plugins it links from folders could not be prepared: .*log\.json/)
  })

  it('a start whose output reaches no terminal names the plugins approved at upgrade again at the next start', async () => {
    await prepareHome(context, undefined, true)
    const folder = profileLinkingPlug('default')
    const notice = `Delorun now runs the approved copy of plug, linked from ${folder}. Edits in that folder wait for your review: delorun changes list.\n`
    // `delorun start` runs the home process with its output in the log only.
    await startChanges({ home, profile: 'default', terminal: false }, context.stdout)
    expect(context.printed).toEqual([notice])
    expect((await readChangeLog(home, 'default')).entries[0]!.shownAt).toBeUndefined()
    await startChanges({ home, profile: 'default', terminal: true }, context.stdout)
    expect(context.printed).toEqual([notice, notice])
    expect((await readChangeLog(home, 'default')).entries[0]!.shownAt).toEqual(expect.any(String))
    await startChanges({ home, profile: 'default' }, context.stdout)
    expect(context.printed).toEqual([notice, notice])
  })

  it('a start goes on when it cannot record that the notice was shown, and says so', async () => {
    await prepareHome(context, undefined, true)
    profileLinkingPlug('default')
    hooks.markError = new Error('the log is busy\u001b[2J')
    await startChanges({ home, profile: 'default', terminal: true }, context.stdout)
    expect(context.printed.at(-1)).toBe('Delorun could not record that you saw this, so the next start says it again: Error: the log is busy\\u001b[2J\n')
    hooks.markError = new ChangesError('RECORD_UNREADABLE', 'log.json', 'log.json is not a record Delorun wrote')
    await startChanges({ home, profile: 'default', terminal: true }, context.stdout)
    expect(context.printed.at(-1)).toBe('Delorun could not record that you saw this, so the next start says it again: log.json is not a record Delorun wrote\n')
    hooks.markError = undefined
  })

  it('a start without a terminal setting records the notice as shown only when standard output and standard error both are terminals', async () => {
    await prepareHome(context, undefined, true)
    profileLinkingPlug('default')
    const before = { stdout: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'), stderr: Object.getOwnPropertyDescriptor(process.stderr, 'isTTY') }
    const terminals = (stdout: boolean, stderr: boolean): void => {
      Object.defineProperty(process.stdout, 'isTTY', { value: stdout, configurable: true, writable: true })
      Object.defineProperty(process.stderr, 'isTTY', { value: stderr, configurable: true, writable: true })
    }
    try {
      terminals(true, false)
      await startChanges({ home, profile: 'default' }, context.stdout)
      expect((await readChangeLog(home, 'default')).entries[0]!.shownAt).toBeUndefined()
      terminals(true, true)
      await startChanges({ home, profile: 'default' }, context.stdout)
      expect((await readChangeLog(home, 'default')).entries[0]!.shownAt).toEqual(expect.any(String))
    } finally {
      for (const [name, descriptor] of Object.entries(before)) {
        const stream = name === 'stdout' ? process.stdout : process.stderr
        if (descriptor === undefined) Reflect.deleteProperty(stream, 'isTTY')
        else Object.defineProperty(stream, 'isTTY', descriptor)
      }
    }
  })

  it('a profile created after the first start under Changes does not approve its links at upgrade', async () => {
    await prepareHome(context, undefined, true)
    await setProtection(home, 'on', attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } }))
    mkdirSync(join(home, 'profiles', 'default'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'default', 'package.json'), '{"name":"dsh-profile-default","dependencies":{}}\n')
    await startChanges({ home, profile: 'default', terminal: true }, context.stdout)
    // A second profile, created after the upgrade, links a plugin from a folder.
    profileLinkingPlug('second')
    await startChanges({ home, profile: 'second', terminal: true }, context.stdout)
    const [entry] = (await readChangeLog(home, 'second')).entries
    expect(entry).toMatchObject({ kind: 'plugin-install', state: 'pending', subject: { plugin: 'plug' } })
    expect(entry!.decidedFrom).toBeUndefined()
    expect(context.printed.join('')).toMatch(/^plug is not loaded until you review it: delorun changes show c[0-9a-f]{10}\n$/u)
  })

  it('refuses the start when the profile history cannot record the change', async () => {
    await prepareHome(context, undefined, true)
    profileLinkingPlug('default')
    vi.stubEnv('PATH', join(base, 'no-git'))
    await expect(startChanges({ home, profile: 'default' }, () => {})).rejects.toThrow(/could not be prepared: HistoryUnavailableError: /)
  })
})

describe('the approved plugin content step', () => {
  /**
   * The composition's request for a profile.
   * @param profile - the profile's name.
   * @returns the draft the step reads.
   */
  const draft = (profile: string): Parameters<typeof changesApprovedContent>[0] => ({ request: { home, profile, kind: 'cli', output: context, env: context.env } })

  it('adds no overlay when every invariant holds, and for a profile the home does not have', async () => {
    await prepareHome(context, undefined, true)
    profileLinkingPlug('default')
    await startChanges({ home, profile: 'default' }, () => {})
    await expect(changesApprovedContent(draft('default'))).resolves.toEqual([])
    await expect(changesApprovedContent(draft('other'))).resolves.toEqual([])
  })

  it('refuses the start, naming each broken invariant, when an active directory holds what Changes did not keep', async () => {
    await prepareHome(context, undefined, true)
    profileLinkingPlug('default')
    await startChanges({ home, profile: 'default' }, () => {})
    writeFileSync(join(activeDirectory(home, 'default', 'plug'), 'index.js'), 'export default 2\n')
    const refusal = changesApprovedContent(draft('default'))
    await expect(refusal).rejects.toBeInstanceOf(CliError)
    await expect(refusal).rejects.toThrow(/^delorun: the profile default was not started, because what it would load is not what Changes keeps for it:\n {2}.*plug/)
  })
})

describe('repointsBeforeBoot', () => {
  it('re-points for a successor and for any Host booted after the first, never for a fresh start\'s first', () => {
    expect(repointsBeforeBoot(false, 0)).toBe(false)
    expect(repointsBeforeBoot(true, 0)).toBe(true)
    expect(repointsBeforeBoot(false, 1)).toBe(true)
  })
})

describe('repointingBoot', () => {
  it('re-points before a successor\'s first boot, and before a second boot of a process that failed a switch, never before a fresh first boot', async () => {
    const calls: string[] = []
    const repoint = (_request: unknown, afterFailedSwitch: boolean): Promise<void> => { calls.push(afterFailedSwitch ? 'repoint-after-failed-switch' : 'repoint'); return Promise.resolve() }
    const fresh = repointingBoot({ home, profile: 'default' }, false, () => { calls.push('boot'); return Promise.resolve(1) }, repoint)
    await fresh()
    await fresh()
    expect(calls).toEqual(['boot', 'repoint-after-failed-switch', 'boot'])
    calls.length = 0
    const successor = repointingBoot({ home, profile: 'default' }, true, () => { calls.push('boot'); return Promise.resolve(1) }, repoint)
    await successor()
    await successor()
    expect(calls).toEqual(['repoint', 'boot', 'repoint-after-failed-switch', 'boot'])
  })
})

describe('repointForSuccessor', () => {
  it('leaves a home without the profile, and a profile whose copies already hold their versions, alone', async () => {
    await prepareHome(context, undefined, true)
    await expect(repointForSuccessor({ home, profile: 'other' })).resolves.toBeUndefined()
    profileLinkingPlug('default')
    await startChanges({ home, profile: 'default' }, () => {})
    await expect(repointForSuccessor({ home, profile: 'default' })).resolves.toBeUndefined()
  })

  it('refuses the successor\'s boot, naming the profile, when a record of Changes cannot be read', async () => {
    await prepareHome(context, undefined, true)
    profileLinkingPlug('default')
    await startChanges({ home, profile: 'default' }, () => {})
    writeFileSync(join(home, 'changes', 'profiles', 'default', 'active.json'), 'not json')
    const refusal = repointForSuccessor({ home, profile: 'default' })
    await expect(refusal).rejects.toBeInstanceOf(CliError)
    await expect(refusal).rejects.toThrow(/^delorun: the profile default was not started, because its plugin copies could not be pointed at this release: /)
  })
})

describe('delorun headless', () => {
  /**
   * Headless dependencies that stop at the profile's preparation, recording the profile's spec for `plug` there.
   * @param seen - receives the spec each preparation saw.
   * @returns the dependencies.
   */
  function headlessStoppingAtPrepare(seen: (string | undefined)[]): HeadlessDependencies {
    const start = stoppingAtPrepare([])
    return {
      prepareProfile: () => {
        seen.push(existsSync(join(home, 'profiles', 'headless', 'package.json')) ? plugSpec('headless') : undefined)
        return Promise.reject(new Error('stopped after Changes'))
      },
      missingModelKey: () => Promise.resolve(undefined),
      approvedPluginContent: changesApprovedContent,
      releasePacks: NO_RELEASE_PACKS,
      preStartSteps: start.preStartSteps,
      runProfile: start.runProfile,
      loadEnvironment: start.loadEnvironment,
      cwd: () => home,
      fatalRelease: () => () => undefined,
    }
  }

  it('brings the headless profile\'s linked plugins under Changes before upstream prepares it, and says so on standard error', async () => {
    await prepareHome(context, undefined, true)
    const folder = profileLinkingPlug('headless')
    const seen: (string | undefined)[] = []
    await expect(headless(['say hello'], context, headlessStoppingAtPrepare(seen), () => undefined)).rejects.toThrow('stopped after Changes')
    expect(seen).toEqual([`link:${activeDirectory(home, 'headless', 'plug')}`])
    expect(context.errors.join('')).toBe(`Delorun now runs the approved copy of plug, linked from ${folder}. Edits in that folder wait for your review: delorun changes list.\n`)
    expect(context.printed).toEqual([])
    expect(readlinkSync(join(home, 'profiles', 'headless', 'node_modules', 'plug'))).toBe(relative(join(home, 'profiles', 'headless', 'node_modules'), activeDirectory(home, 'headless', 'plug')))
  })

  it('leaves a home without the headless profile alone', async () => {
    const seen: (string | undefined)[] = []
    const dependencies = headlessStoppingAtPrepare(seen)
    // The headless profile's one-time change, which creates the profile in a real run, is left out here.
    const withoutMigrations = { ...dependencies, preStartSteps: dependencies.preStartSteps.filter(step => step.name !== 'profile-migrations') }
    await expect(headless(['say hello'], context, withoutMigrations, () => undefined)).rejects.toThrow('stopped after Changes')
    expect(seen).toEqual([undefined])
    expect(context.errors).toEqual([])
  })
})
