/**
 * `delorun headless` boots the home's `headless` profile through Delo's composition with upstream's real profile
 * runner, and the booted Host's guards refuse in the process that asks them (`fixtures/headless-driver.ts`). The
 * driver runs in a child process under an isolated home, with the profile's `headless-runner` row disabled by a test
 * overlay, so no task runs and no model is asked.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { LOCAL_BUNDLE } from '@delo/bundle-local/profile'

const DRIVER = join(import.meta.dirname, 'fixtures/headless-driver.ts')
const TSX_LOADER = import.meta.resolve('tsx/esm')
const BUNDLE_LOCAL_DIR = new URL('.', import.meta.resolve('@delo/bundle-local/package.json')).pathname

let osHome: string

/** A refusal the driver reports. */
interface Refusal {
  readonly refused: boolean
  readonly name?: string
  readonly code?: string
  readonly host?: string
  readonly message?: string
}

/** What the driver printed. */
interface DriverReport {
  readonly outcome: 'booted' | 'refused'
  readonly runnerCalls: number
  readonly message?: string
  readonly fetch?: Refusal
  readonly instructionWrite?: { readonly toolResults: readonly { readonly isError: boolean, readonly error?: { readonly name: string, readonly code: string } }[], readonly written: boolean }
  readonly fullAccess?: { readonly guardReason: string | null, readonly selection: Refusal, readonly modes: readonly string[] }
  readonly pluginChange?: {
    readonly decision: { readonly kind: string, readonly reason?: string, readonly info?: { readonly name: string, readonly code: string } }
    readonly pending: readonly { readonly kind: string, readonly state: string, readonly spec?: string }[]
    readonly installed: boolean
  }
  readonly turnGate?: {
    readonly present: boolean
    readonly held: boolean
    readonly releases: number
    readonly modelRequests: number
    readonly beforeRelease: { readonly modelRequests: number, readonly turnStarts: number, readonly agentStatus: string, readonly gateHeld: boolean | undefined, readonly releases: number }
  }
  /** Set by mode `permission-mode`, written as upstream's runner ends the process. */
  readonly exitCode?: number
  readonly modeEvents?: readonly string[]
}

beforeAll(() => {
  // The bundle's built halves must exist to import; the check runner's `build:delo` check builds them before this lane.
  const missing = ['index.js', 'client.js'].filter(file => !existsSync(join(BUNDLE_LOCAL_DIR, 'lib', file)))
  if (missing.length > 0) {
    throw new Error(`${LOCAL_BUNDLE} is not built (lib/${missing.join(', lib/')} missing); run node_modules/.bin/tsx delo/apps/tools/src/run-checks.ts --only build:delo`)
  }
})

beforeEach(() => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-headless-guards-')))
})

afterEach(() => {
  rmSync(osHome, { recursive: true, force: true })
})

/**
 * Run the headless driver in a child process under the fixture OS home.
 * @param mode - the driver's mode.
 * @returns its exit status, report and error output.
 */
function headlessDriver(mode: 'probe' | 'permission-mode' | 'disable-guard' | 'replace-guard'): { status: number | null, report: DriverReport, stderr: string } {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(DSH_|DELO_|NODE_PATH$|DEEPSEEK_)/.test(name)))
  const result = spawnSync(process.execPath, ['--import', TSX_LOADER, DRIVER, mode], {
    cwd: osHome, env: { ...inherited, HOME: osHome, USERPROFILE: osHome, DEEPSEEK_API_KEY: 'fixture-key' }, encoding: 'utf8', timeout: 150_000,
  })
  if (result.error !== undefined || result.signal !== null) throw new Error(`the headless driver did not exit (${result.error?.message ?? String(result.signal)}):\n${result.stderr}`)
  const line = result.stdout.trim().split('\n').at(-1) ?? ''
  return { status: result.status, report: JSON.parse(line) as DriverReport, stderr: result.stderr }
}

describe('the headless profile booted with upstream\'s real profile runner', { timeout: 180_000 }, () => {
  it('refuses a loopback fetch, an instruction-file write, full access without a grant and an agent\'s plugin install, and runs its turns only after the gate is released', () => {
    const run = headlessDriver('probe')
    expect(run.report.outcome, run.report.message ?? run.stderr).toBe('booted')
    expect(run.status).toBe(0)
    expect(run.report.runnerCalls).toBe(1)

    // The web seam's real HTTP provider asks the fetch guard before it opens a connection.
    expect(run.report.fetch).toMatchObject({ refused: true, name: 'FetchGuardRefusedError', code: 'loopback', host: '127.0.0.1' })

    // A model-requested write to an AGENTS.md reaches the consent review; no answerer exists, so the write is refused and nothing is written.
    expect(run.report.instructionWrite?.written).toBe(false)
    expect(run.report.instructionWrite?.toolResults[0]).toEqual({ isError: true, error: { name: 'WriteConsentRefusedError', code: 'FS_CONSENT_DENIED' } })

    // The guard refuses a switch for a workspace without a grant, and the preset service throws it.
    expect(run.report.fullAccess?.guardReason).toMatch(/needs one consent for that workspace first/)
    expect(run.report.fullAccess?.selection).toMatchObject({ refused: true, name: 'SandboxModeRefusedError' })
    expect(run.report.fullAccess?.modes).not.toContain('danger-full-access')

    // An agent's plugin install does not run: Changes records it in the headless profile's change log for the person.
    expect(run.report.pluginChange?.decision).toMatchObject({ kind: 'deny', info: { name: 'PluginChangePending', code: 'PLUGIN_CHANGE_PENDING' } })
    expect(run.report.pluginChange?.pending).toEqual([{ kind: 'plugin-install', state: 'pending', spec: 'left-pad' }])
    expect(run.report.pluginChange?.installed).toBe(false)

    // A turn started before the release waited at the gate: it was logged as started, and no model request was made.
    expect(run.report.turnGate?.beforeRelease).toMatchObject({ turnStarts: 1, modelRequests: 0, agentStatus: 'running', gateHeld: false, releases: 0 })

    // The gate was released once, after the invariants; the turn then reached the model.
    expect(run.report.turnGate).toMatchObject({ present: true, held: false, releases: 1 })
    expect(run.report.turnGate?.modelRequests).toBeGreaterThan(0)
  })

  it('refuses --permission-mode danger-full-access inside the Host when the runner is called without Delorun\'s pre-boot check', () => {
    const run = headlessDriver('permission-mode')
    // Upstream's runner reports the refusal and ends the process with a failure code; the session never took the mode.
    expect(run.report.runnerCalls).toBe(1)
    expect(run.report.exitCode).toBe(1)
    expect(run.stderr).toMatch(/sandbox-mode switch refused: full access for the workspace .* needs one consent for that workspace first/)
    expect(run.report.modeEvents).not.toContain('danger-full-access')
  })

  it.each([
    ['disable-guard', 'delo-fetch-guard is disabled'],
    ['replace-guard', 'delo-fetch-guard is inserted again, which would replace the plugin @delo/plugin-fetch-guard'],
  ] as const)('refuses an overlay that changes the fetch guard row (%s) before the profile runner is called', (mode, problem) => {
    const run = headlessDriver(mode)
    expect(run.status).toBe(1)
    expect(run.report.outcome).toBe('refused')
    expect(run.report.runnerCalls).toBe(0)
    expect(run.report.message).toContain('would boot without protections Delorun requires, so Delorun did not start it')
    expect(run.report.message).toContain(problem)
  })
})
