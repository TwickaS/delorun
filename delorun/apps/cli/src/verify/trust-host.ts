/**
 * The trust bill in a running Host (contract C15): `delorun` attaches the bill's source to the `delorunTrust` service of
 * `@delorun/bundle-local`'s `delorun-trust` row, which serves the bill to the studio's badge. `read` produces the start bill
 * once, from the launcher's start check and the stored release-log record, without hashing anything or making a
 * request.
 *
 * `check`, the studio's Check now, runs `delorun --profile <profile> verify --json` through the launcher that started
 * this runtime, in a child process: the launcher hashes every runtime file before `delorun verify` starts, so the
 * check never runs through a runtime file that changed under a forged identity record. The launcher is the one the
 * start-check record in `DELORUN_START_CHECK` names for the running release; its package's `bin` is resolved inside its
 * directory, and the child gets `--release <running>` and this process's environment without the variables that load
 * code into a Node (`DROPPED_LAUNCH_ENV`). A bill of another release is refused. The child leads its own process
 * group, which a check that outlasts its deadline, or a background check a turn stops, ends whole; the background check
 * runs it at low priority (`nice` 10 and the lowest best-effort I/O class on Linux, below normal on Windows). When this
 * runtime was not started by a launcher, or the launcher's entry cannot be resolved (a source launch), the `verify`
 * stage runs in this process instead, and the bill's `checkedBy` says so and why, because a changed runtime file that a
 * rewritten identity record vouches for could then run unhashed. A launcher that refuses to run `delorun verify`, such as for a changed runtime
 * file, makes a bill whose runtime files failed, with the launcher's refusal as the detail.
 *
 * @module @delorun/cli/verify/trust-host
 */
import { spawn } from 'node:child_process'
import { constants, existsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { constants as osConstants, setPriority } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { DELORUN_HOME_ENV, DELORUN_LAUNCHER_ROOTS_ENV, DELORUN_PROFILE_ENV, DELORUN_START_CHECK_ENV, inheritableEnvironment } from '@delorun/contract-home-layout'
import type { TrustCheckOptions, TrustSource } from '@delorun/bundle-local/trust'
import { TrustBillSchema } from '@delorun/bundle-local/trust-schema'
import type { TrustBill, TrustCheckRoute, TrustHostCheckReason } from '@delorun/bundle-local/trust-bill'
import type { DelorunLogger } from '@delorun/logs'
import type { Fetch } from '@delorun/release-verify'
import { parseStartCheckHandoff } from '@delorun/runtime-store'
import { printable } from '../terminal-text.ts'
import { runVerifyStage, startBill, type BillContext, type ChangesReader, type PluginInstallCheck } from './bill.ts'
import { boundedDetail, utcText } from './checks.ts'
import { processChangesReader } from './changes.ts'
import { processPluginsCheck } from './plugin-bill.ts'

/** What the Host's bill needs. */
export interface TrustWatchOptions {
  /** The resolved Delorun home. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
  /** `<process.platform>-<process.arch>`. */
  readonly platform: string
  /** The version this process runs from the store. */
  readonly running: string
  /** This process's environment, read for the launcher's handoff and roots, and passed to the launcher's child. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The Node executable the launcher's child runs under: this runtime's own. */
  readonly node: string
  /** The home log, which the check's warnings, notices and the runtime store's reports go to. */
  readonly logger: DelorunLogger
  /** The fetch the in-process `verify` stage's online release-log check goes through. */
  readonly fetch: Fetch
  /**
   * The clock.
   * @returns Unix seconds.
   */
  readonly now: () => number
  /**
   * The clock the check's duration is measured with.
   * @returns milliseconds from any fixed point.
   */
  readonly elapsed: () => number
  /** The plugin install check; absent leaves the bill's plugins `unknown`. */
  readonly plugins?: PluginInstallCheck
  /** Changes; absent leaves the bill's changes `unknown`. */
  readonly changes?: ChangesReader
}

/** The command that runs `delorun verify --json` through the launcher. */
export interface LauncherVerify {
  /** The Node executable. */
  readonly command: string
  /** The launcher's entry file, then its arguments. */
  readonly args: readonly string[]
  /** The child's whole environment. */
  readonly env: Readonly<Record<string, string>>
}

/** How a child process ended. */
export interface ChildRun {
  /** Its exit status, or `null` when a signal ended it. */
  readonly status: number | null
  /** Its standard output, up to {@link CHILD_OUTPUT_LIMIT} bytes. */
  readonly stdout: string
  /** Its standard error, up to {@link CHILD_OUTPUT_LIMIT} bytes. */
  readonly stderr: string
  /** Whether it was stopped because it outlasted its time. */
  readonly timedOut: boolean
}

/**
 * Run a child process to its end.
 * @param command - the command.
 * @param timeoutMs - how long it may run before it is stopped.
 * @param options - low priority, and the signal that stops the child.
 * @returns how it ended.
 */
export type RunChild = (command: LauncherVerify, timeoutMs: number, options?: TrustCheckOptions) => Promise<ChildRun>

/** The ways a bill is produced. */
export interface TrustStages {
  /** The start bill, which hashes nothing and makes no request. */
  readonly start: typeof startBill
  /** The `verify` stage in this process, for a runtime no launcher started. */
  readonly verify: typeof runVerifyStage
  /** Runs the launcher's child. */
  readonly launcher: RunChild
}

/** The most of a child's standard output or error kept; `delorun verify --json` writes a few hundred kilobytes. */
export const CHILD_OUTPUT_LIMIT = 32 * 1024 * 1024

/** The largest launcher `package.json` read for its `bin`. */
const LAUNCHER_MANIFEST_LIMIT = 65_536

/** How long a stopped child's process group has to end after `SIGTERM` before it gets `SIGKILL`. */
const KILL_GRACE_MS = 5_000

/**
 * How long, after the child exits, its output may stay open before it is read as ended: a process the child left behind
 * can hold its standard output and error open for good.
 */
const CLOSE_GRACE_MS = 2_000

/** The `nice` value of a background check: low, but above the idle class, so it still finishes on a busy computer. */
export const BACKGROUND_NICE = 10

/** Where Linux distributions install `ionice`; it is run by absolute path, never looked up on `PATH`. */
const IONICE_PATHS: readonly string[] = ['/usr/bin/ionice', '/bin/ionice']

/**
 * Lower a child's priority as soon as it starts, before it reads a runtime file: `nice` {@link BACKGROUND_NICE}
 * (below normal on Windows) and, on Linux, the lowest best-effort I/O class through `ionice`; the child's own children
 * inherit both. A priority that cannot be set is no failure: the check runs at normal priority.
 * @param pid - the child's process id.
 */
function lowerPriority(pid: number): void {
  try {
    setPriority(pid, process.platform === 'win32' ? osConstants.priority.PRIORITY_BELOW_NORMAL : BACKGROUND_NICE)
  } catch {
    // Not permitted or the child has already ended; the check runs at normal priority.
  }
  if (process.platform !== 'linux') return
  const ionice = IONICE_PATHS.find(path => existsSync(path))
  if (ionice === undefined) return
  spawn(ionice, ['-c', '2', '-n', '7', '-p', String(pid)], { stdio: 'ignore' }).on('error', () => {
    // ionice could not start; on Linux the I/O priority then follows the nice value.
  })
}

/** This process's fetch, which the in-process `verify` stage sends its online release-log check through. */
export const PROCESS_FETCH: Fetch = globalThis.fetch.bind(globalThis)

/**
 * Signal every process of a child's tree: on POSIX the child leads its own process group, which `process.kill` with
 * the negated id reaches; on Windows `taskkill /T /F` ends the tree, whatever the signal. A tree that has already
 * ended is no failure.
 * @param pid - the child's process id.
 * @param signal - the signal.
 */
function signalTree(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {
      // taskkill could not start; the child's own end still settles the run.
    })
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    // ESRCH: every process of the group has ended.
  }
}

/**
 * A child runner: the child leads a process group of its own (a tree on Windows). A child that outlasts its time gets
 * `SIGTERM` on its whole group, then `SIGKILL` after the kill grace. The run settles when the child exits: its output is
 * read until it closes or the close grace passes, after which the group gets `SIGKILL` and the streams are destroyed,
 * so a process the child left holding its output neither keeps the run open nor outlives it.
 * @param grace - the kill and close graces, in milliseconds.
 * @param grace.killMs - how long after `SIGTERM` the group gets `SIGKILL`.
 * @param grace.closeMs - how long after the child's exit its output may stay open.
 * @returns the runner.
 */
export function childRunner(grace: { readonly killMs: number, readonly closeMs: number }): RunChild {
  return (command, timeoutMs, options = {}) => new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted === true) {
      reject(abortReason(options.signal))
      return
    }
    const child = spawn(command.command, [...command.args], { env: command.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true })
    if (options.lowPriority === true && child.pid !== undefined) lowerPriority(child.pid)
    const collect = (stream: NodeJS.ReadableStream): (() => string) => {
      const chunks: Buffer[] = []
      let length = 0
      stream.on('data', (chunk: Buffer) => {
        if (length >= CHILD_OUTPUT_LIMIT) return
        chunks.push(chunk.subarray(0, CHILD_OUTPUT_LIMIT - length))
        length += chunk.byteLength
      })
      return () => Buffer.concat(chunks).toString('utf8')
    }
    const stdout = collect(child.stdout)
    const stderr = collect(child.stderr)
    let timedOut = false
    let kill: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let aborted = false
    const stop = (): void => {
      if (kill !== undefined) return
      if (child.pid !== undefined) signalTree(child.pid, 'SIGTERM')
      kill = setTimeout(() => { if (child.pid !== undefined) signalTree(child.pid, 'SIGKILL') }, grace.killMs)
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)
    const onAbort = (): void => {
      aborted = true
      stop()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const stopTimers = (): void => {
      clearTimeout(timer)
      if (kill !== undefined) clearTimeout(kill)
      options.signal?.removeEventListener('abort', onAbort)
    }
    child.on('error', (error) => {
      if (settled) return
      settled = true
      stopTimers()
      reject(error)
    })
    child.on('exit', (status) => {
      if (settled) return
      settled = true
      stopTimers()
      const done = (): void => {
        clearTimeout(closing)
        if (aborted && options.signal !== undefined) reject(abortReason(options.signal))
        else resolvePromise({ status, stdout: stdout(), stderr: stderr(), timedOut })
      }
      const closing = setTimeout(() => {
        // Something the child left behind still holds its output: end the group and stop reading.
        if (child.pid !== undefined) signalTree(child.pid, 'SIGKILL')
        child.stdout.destroy()
        child.stderr.destroy()
        done()
      }, grace.closeMs)
      if (child.stdout.readableEnded && child.stderr.readableEnded) done()
      else child.once('close', done)
    })
  })
}

/**
 * The error a stopped run rejects with.
 * @param signal - the signal that stopped it.
 * @returns its reason when that is an error, otherwise an error naming the stop.
 */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error('the check was stopped')
}

/** Runs a child with the Host's graces. */
export const runChild: RunChild = childRunner({ killMs: KILL_GRACE_MS, closeMs: CLOSE_GRACE_MS })

/** The stages a running Host uses. */
export const TRUST_STAGES: TrustStages = { start: startBill, verify: runVerifyStage, launcher: runChild }

/**
 * The bill context at one moment.
 * @param options - the home, the profile, the platform, the running version, the environment and the readers.
 * @returns the context, with the clock read now.
 */
function billContext(options: TrustWatchOptions): BillContext {
  return {
    home: options.home,
    profile: options.profile,
    platform: options.platform,
    running: options.running,
    env: options.env,
    now: options.now(),
    ...options.plugins === undefined ? {} : { plugins: options.plugins },
    ...options.changes === undefined ? {} : { changes: options.changes },
  }
}

/**
 * Read a launcher package's `bin` entry for `delorun`, refusing a link, a file larger than its limit and an entry
 * outside the package's directory.
 * @param directory - the launcher package's directory.
 * @returns the entry file's absolute path, or `undefined` when it cannot be resolved.
 */
async function launcherEntry(directory: string): Promise<string | undefined> {
  if (!isAbsolute(directory)) return undefined
  let text: string
  try {
    const handle = await open(join(directory, 'package.json'), constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK))
    try {
      const stats = await handle.stat()
      if (!stats.isFile() || stats.size > LAUNCHER_MANIFEST_LIMIT) return undefined
      text = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    // No readable manifest: a source launch's directory, or a launcher removed since it started this runtime.
    return undefined
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(text)
  } catch {
    // Not JSON: no entry to run.
    return undefined
  }
  const bin: unknown = typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'bin') : undefined
  const named: unknown = typeof bin === 'string' ? bin : typeof bin === 'object' && bin !== null ? Reflect.get(bin, 'delorun') : undefined
  if (typeof named !== 'string' || named === '') return undefined
  const entry = resolve(directory, named)
  const inside = relative(directory, entry)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return undefined
  try {
    const handle = await open(entry, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK))
    try {
      if (!(await handle.stat()).isFile()) return undefined
    } finally {
      await handle.close()
    }
  } catch {
    // The named entry is missing or a link: the launcher cannot be run from here.
    return undefined
  }
  return entry
}

/**
 * The command that runs `delorun verify --json` through the launcher the start-check record names.
 * @param options - the Host's options.
 * @returns the command, or why the check has to run in this process.
 */
export async function launcherVerifyCommand(options: Pick<TrustWatchOptions, 'env' | 'home' | 'profile' | 'node' | 'running'>): Promise<LauncherVerify | TrustHostCheckReason> {
  const handoff = parseStartCheckHandoff(options.env[DELORUN_START_CHECK_ENV])
  // A record of another release describes another start, such as the one an update's predecessor was given.
  if (handoff?.release !== options.running) return 'no-launcher'
  const entry = await launcherEntry(handoff.launcher.path)
  if (entry === undefined) return 'launcher-unresolvable'
  const env = inheritableEnvironment(options.env)
  // The launcher sets both for the runtime it starts; this runtime's own values would describe another start.
  delete env[DELORUN_START_CHECK_ENV]
  delete env[DELORUN_LAUNCHER_ROOTS_ENV]
  env[DELORUN_HOME_ENV] = options.home
  env[DELORUN_PROFILE_ENV] = options.profile
  // After `--` the launcher reads no option of its own, so `--release` names the release `delorun verify` checks.
  return { command: options.node, args: [entry, '--profile', options.profile, '--', 'verify', '--release', options.running, '--json'], env }
}

/**
 * The bill a `delorun verify --json` run printed.
 * @param stdout - its standard output.
 * @returns the validated bill, or `undefined` when the output holds no report with a bill.
 */
export function billOfVerifyOutput(stdout: string): TrustBill | undefined {
  for (const line of stdout.split('\n').reverse()) {
    if (!line.startsWith('{')) continue
    let report: unknown
    try {
      report = JSON.parse(line)
    } catch {
      // Not the report's line.
      continue
    }
    const bill: unknown = typeof report === 'object' && report !== null ? Reflect.get(report, 'bill') : undefined
    const parsed = TrustBillSchema.safeParse(bill)
    return parsed.success ? parsed.data : undefined
  }
  return undefined
}

/**
 * How the next Check now will run, for the bill to say.
 * @param command - the launcher's command, or why the check runs in this process.
 * @returns the route.
 */
function routeOf(command: LauncherVerify | TrustHostCheckReason): TrustCheckRoute {
  return typeof command === 'string' ? { via: 'host', reason: command } : { via: 'launcher' }
}

/**
 * The options of a running Host with the readers `delorun verify` uses: without the plugin install check and Changes the
 * start bill's plugins and changes are `unknown`, and the studio's badge reads Unknown for a release that verifies.
 * @param base - the options other than the readers.
 * @returns the options with the plugin install check and Changes.
 */
export function hostTrustOptions(base: Omit<TrustWatchOptions, 'plugins' | 'changes'>): TrustWatchOptions {
  return { ...base, plugins: processPluginsCheck, changes: processChangesReader }
}

/**
 * The source `delorun` attaches to the Host's `delorunTrust` service.
 * @param options - the home, the profile, the platform, the running version, the environment, the log and the clocks.
 * @param stages - how a bill is produced.
 * @returns the source: `read` produces the start bill once and answers it after, and a read that failed is produced
 *   again on the next call; `refresh` produces a new start bill each time; `check` runs `delorun verify --json` through the launcher, or the `verify` stage in this
 *   process when no launcher can be run, and logs what the check warned about.
 */
export function trustSource(options: TrustWatchOptions, stages: TrustStages): TrustSource {
  let start: Promise<TrustBill> | undefined
  const fresh = (): Promise<TrustBill> => Promise.all([stages.start(billContext(options)), launcherVerifyCommand(options)]).then(([bill, command]) => ({ ...bill, checkNow: routeOf(command) }))
  return {
    read: async () => {
      start ??= fresh()
      try {
        return await start
      } catch (error) {
        start = undefined
        throw error
      }
    },
    refresh: fresh,
    check: async (timeoutMs, checkOptions = {}) => {
      const began = options.elapsed()
      const seconds = (): number => Math.round((options.elapsed() - began) / 100) / 10
      const command = await launcherVerifyCommand(options)
      if (typeof command === 'string') {
        const { bill, outcome } = await stages.verify(billContext(options), { fetch: options.fetch, logger: options.logger })
        for (const warning of outcome.warnings) options.logger.warn(`delorun-trust: ${printable(warning)}`)
        for (const notice of outcome.notices) options.logger.info(`delorun-trust: ${printable(notice)}`)
        return { ...bill, checkedBy: { via: 'host', reason: command, seconds: seconds() }, checkNow: routeOf(command) }
      }
      const run = await stages.launcher(command, timeoutMs, checkOptions)
      for (const line of run.stderr.split('\n')) if (line.trim() !== '') options.logger.info(`delorun-trust: delorun verify: ${printable(line)}`)
      if (run.timedOut) throw new Error(`delorun verify through the launcher did not finish within ${String(Math.round(timeoutMs / 1000))} s and was stopped`)
      const checked = billOfVerifyOutput(run.stdout)
      if (checked !== undefined) {
        if (checked.release.version !== options.running) throw new Error(`delorun verify through the launcher reported release ${String(checked.release.version)}, not the running ${options.running}`)
        return { ...checked, checkedBy: { via: 'launcher', seconds: seconds() }, checkNow: routeOf(command) }
      }
      // No report: the launcher refused to start `delorun verify`, which it does when a runtime file fails its hash.
      const context = billContext(options)
      const refused = await stages.start(context)
      const reason = run.stderr.trim() === '' ? `the launcher exited with status ${String(run.status)} and printed no report` : run.stderr.trim()
      return {
        ...refused,
        stage: 'verify',
        generatedAt: utcText(context.now),
        release: { ...refused.release, signature: 'unknown', files: 'fail', detail: boundedDetail(`the launcher refused to run delorun verify: ${reason.replace(/\s*\n\s*/gu, ' ')}`) },
        checkedBy: { via: 'launcher', seconds: seconds() },
        checkNow: routeOf(command),
      }
    },
  }
}

/**
 * Attach the bill's source to the booted Host's `delorunTrust` service whenever the service is present.
 * @param ctx - the booted profile's root context, after its startup settled.
 * @param options - the home, the profile, the platform, the running version, the environment, the log and the clocks.
 * @param stages - how a bill is produced.
 */
export function watchTrust(ctx: Context, options: TrustWatchOptions, stages: TrustStages): void {
  const source = trustSource(options, stages)
  ctx.inject(['delorunTrust'], (scope) => {
    scope.effect(() => scope.delorunTrust.attach(source))
  })
}
