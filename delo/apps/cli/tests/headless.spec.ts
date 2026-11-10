/**
 * `delorun headless` boots upstream's `headless` profile through Delo's composition (`delo/apps/cli/src/headless.ts`):
 * with C1's sandbox overlay last, upstream's launcher options refused, the booted rows held to the sandbox invariants,
 * and the run registered as a shared user of the chat data. Upstream's runner is replaced by one that mounts what
 * the composition composed.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunProfileOptions } from '@deepseek-ai/dsh/profile-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { HostNotStoppedError } from '@delo/home-process'
import { stringify } from 'yaml'
import { prepareHome, type CommandContext } from '../src/command.ts'
import { NO_APPROVED_CONTENT } from '../src/compose.ts'
import type { BootedRow } from '../src/delo-bundles.ts'
import { CliError, EXIT } from '../src/exit.ts'
import { cliRefusal } from '../src/refusals.ts'
import { HEADLESS_PROFILE, refuseLauncherOptions, type HeadlessDependencies } from '../src/headless.ts'
import { headless, headlessCommand, headlessDependencies } from '../src/upstream.ts'
import { upstreamDependencies } from '../src/start.ts'
import { composedBootRows, composedProviders } from './fixtures/composed-rows.ts'

let osHome: string
let deloHome: string
let context: CommandContext

beforeEach(async () => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-headless-')))
  deloHome = join(osHome, '.delo')
  vi.stubEnv('HOME', osHome)
  vi.stubEnv('USERPROFILE', osHome)
  vi.stubEnv('DSH_HOME', join(osHome, '.dsh'))
  vi.stubEnv('DELO_HOME', undefined)
  vi.stubEnv('DELO_PROFILE', undefined)
  context = { env: { HOME: osHome, DSH_HOME: join(osHome, '.dsh') }, stdout: () => undefined, stderr: () => undefined }
  await prepareHome(context, undefined)
})

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
function recording(seen: RunProfileOptions[], stops: string[], overrides: readonly BootedRow[] = []): HeadlessDependencies {
  return {
    prepareProfile: upstreamDependencies().prepareProfile,
    approvedPluginContent: NO_APPROVED_CONTENT,
    preStartSteps: upstreamDependencies().preStartSteps,
    loadEnvironment: () => createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]),
    runProfile: (options) => {
      seen.push(options)
      const rows = (): BootedRow[] => composedBootRows(deloHome, options, overrides)
      return Promise.resolve({
        rows,
        providerOf: composedProviders(rows),
        releaseTurns: () => undefined,
        shutdown: (code) => { stops.push(`shutdown ${String(code)}`); return Promise.resolve() },
        dispose: () => { stops.push('dispose'); return Promise.resolve() },
        watchChats: () => undefined,
        studio: () => undefined,
        studioLink: () => ({ kind: 'unavailable', reason: 'the Host serves no studio' }),
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
    expect(seen[0]).toMatchObject({ profile: HEADLESS_PROFILE, args: ['--json', 'what is 2+2'], patchFiles: [join(deloHome, 'run', HEADLESS_PROFILE, 'sandbox.patch.yml')] })
    expect(existsSync(join(deloHome, 'run', HEADLESS_PROFILE, 'sandbox.patch.yml'))).toBe(true)
    expect(exits).toHaveLength(1)
    exits[0]!()
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
    writeFileSync(join(deloHome, 'cordis.patch.yml'), stringify([{ id: 'sandbox', disabled: true }]))
    const seen: RunProfileOptions[] = []
    await expect(headless(['task'], context, recording(seen, []), () => undefined)).rejects.toThrow('sandbox is disabled')
    expect(seen).toEqual([])
    rmSync(join(deloHome, 'cordis.patch.yml'))
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
    expect(ran).toEqual(['stock-import-recovery', 'update-notice'])
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
    expect(Object.keys(headlessDependencies()).sort()).toEqual(['approvedPluginContent', 'loadEnvironment', 'preStartSteps', 'prepareProfile', 'runProfile'])
  })
})
