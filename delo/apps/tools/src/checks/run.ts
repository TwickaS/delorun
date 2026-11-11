/**
 * Run a plan: start each check once its needs have passed and the CPUs it
 * asks for are free, serve a check from the pass cache when its key matches a
 * stored pass, write each one's output to its own log, and stop every process a
 * check started when the run is interrupted, so no local compiler or worker
 * outlives it.
 *
 * @module @delo/tools/checks/run
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PassCache, PassSource } from './cache.ts'
import type { GateTier, Planned } from './plan.ts'
import { commandFor, type Unit, type WithUnits } from './units.ts'

/** How a check ended. */
export type Outcome = 'passed' | 'failed' | 'declined' | 'skipped'

/**
 * Whether an outcome fails the run on its own: `declined` (this host cannot run it) and `skipped` do not.
 * {@link gateFailure} adds the declined merge-only check.
 * @param outcome - how a check ended.
 * @returns true when the run fails.
 */
export function failing(outcome: Outcome): boolean {
  return outcome === 'failed'
}

/**
 * Whether a result fails a run of a tier: a failed check, and in the merge tier a merge-only check this host could not run
 * (`Result.unrun`), because only the merge tier's pass lets a commit reach the trunk and it passes nothing it did not run.
 * @param result - one check's result.
 * @param tier - the run's gate tier; absent (the full gate) counts as the merge tier.
 * @returns true when the run fails.
 */
export function gateFailure(result: Result, tier: GateTier | undefined): boolean {
  return failing(result.outcome) || (result.unrun === true && (tier === undefined || tier === 'merge'))
}

/** The command that asks Docker whether an engine answers, and how long it may take. */
const DOCKER_ASK = { args: ['info', '--format', '{{.ServerVersion}}'], timeoutMs: 30_000 } as const

/** What {@link probeDocker} needs from a process runner. */
export type DockerRun = (command: string, args: readonly string[], timeoutMs: number) => { readonly status: number | null, readonly stderr: string, readonly error?: Error | undefined }

/**
 * Ask the Docker engine of the active context whether it answers, for the Docker lane's plan.
 * @param run - runs `docker` with arguments within a timeout.
 * @returns undefined when an engine answers, otherwise why none does and how to start one.
 */
export function probeDocker(run: DockerRun): string | undefined {
  const answer = run('docker', DOCKER_ASK.args, DOCKER_ASK.timeoutMs)
  if (answer.status === 0) return undefined
  const line = answer.stderr.split('\n').find(text => text.trim() !== '')?.trim()
  const why = answer.error?.message ?? line ?? (answer.status === null ? 'no answer within the timeout' : `exit ${String(answer.status)}`)
  return `no Docker engine answers at the active context (${why}); start Docker Desktop (on a WSL host, start it on Windows and enable its WSL integration) or the Docker engine, wait until \`docker info\` answers, and run the lane again`
}

/** One check's result. */
export interface Result {
  readonly id: string
  readonly outcome: Outcome
  readonly seconds: number
  /** The log's path, for a check that ran. */
  readonly log?: string
  /** Why it was declined or skipped, the exit status that failed it, or the pass it was served from. */
  readonly detail?: string
  /** Whether a stored pass with the same key served the result, so the check did not run. */
  readonly cached?: boolean
  /** Where the stored pass that served the result was kept: this worktree or the machine-wide store. */
  readonly cacheSource?: PassSource
  /** The resident memory of its process group at its peak, sampled every half second. */
  readonly peakBytes?: number
  /** Whether the kernel's out-of-memory killer stopped one of its processes. */
  readonly oomKilled?: boolean
  /** True when a merge-only check was declined for a limit of this host and never ran; {@link gateFailure} fails the merge tier for it. */
  readonly unrun?: true
  /** For a unitised suite: how many packages it covered, how many ran, and how many stored passes served. */
  readonly units?: UnitCounts
}

/** How a unitised suite's packages were served. */
export interface UnitCounts {
  readonly total: number
  readonly ran: number
  readonly local: number
  readonly shared: number
}

/**
 * The checks that compile upstream's projects with `tsc -b` and write their emitted declarations, in the order they run:
 * one at a time, so they never write the same files at once, and the later ones find the declarations the first emitted.
 */
export const DECLARATION_WRITERS: readonly string[] = ['typecheck:upstream', 'build:artifacts', 'gates:docs']

/** What the run needs from its caller. */
export interface RunOptions {
  /** The repository root, which each check's `cwd` is relative to. */
  readonly root: string
  /** The environment every check inherits. */
  readonly env: NodeJS.ProcessEnv
  /** Where the logs go, one `<id>.log` each. */
  readonly logDir: string
  /** The CPUs the checks may keep busy at once; a check asking for more runs alone. */
  readonly cpus: number
  /** The memory the checks may hold at once; a check needing more than all of it is declined. */
  readonly memoryBytes: number
  /** The cgroup's count of out-of-memory kills so far, read before and after each check; undefined where there is none. */
  readonly oomKills?: () => number | undefined
  /** Stop starting checks after the first failure. */
  readonly bail: boolean
  /** The gate tier, which decides whether a declined merge-only check fails the run ({@link gateFailure}); absent counts as the merge tier. */
  readonly tier?: GateTier
  /** Which ready check to start first: a higher value first, such as `criticalPath` (plan.ts) gives; ties keep plan order. */
  readonly priority?: ReadonlyMap<string, number>
  /** The pass cache; undefined runs every check. */
  readonly cache?: PassCache
  /** Told as each check starts and ends. */
  readonly report: (event: { readonly kind: 'start'; readonly check: Planned } | { readonly kind: 'end'; readonly check: Planned; readonly result: Result }) => void
}

/**
 * The last lines of a log.
 * @param path - the log.
 * @param lines - how many.
 * @returns the text, or an empty string when it cannot be read.
 */
export function logTail(path: string, lines: number): string {
  try {
    return readFileSync(path, 'utf8').trimEnd().split('\n').slice(-lines).join('\n')
  } catch (error) {
    // A check declined before it started has no log.
    if (error instanceof Error) return ''
    throw error
  }
}

/**
 * Stop a check's process group. Each check leads its own group, so the worker
 * and compiler processes it started stop with it, including any it left
 * running after it exited.
 * @param child - the check's process.
 */
function stopGroup(child: ChildProcess): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch (error) {
    // ESRCH: the group has no process left.
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
  }
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}

const PAGE_BYTES = 4096

/**
 * The resident memory of every process in a process group, from `/proc`.
 * @param group - the group's id, its leader's pid.
 * @returns the sum in bytes, or 0 where `/proc` cannot be read.
 */
export function groupResidentBytes(group: number): number {
  let total = 0
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch (error) {
    // Not Linux: no sample.
    if (error instanceof Error) return 0
    throw error
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      // Fields after the command's closing parenthesis: state, ppid, pgrp, ... rss is the 22nd after it.
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (Number(fields[2]) === group) total += Number(fields[21]) * PAGE_BYTES
    } catch (error) {
      // The process exited between the listing and the read.
      void error
    }
  }
  return total
}

/**
 * Run every check of a plan.
 * @param plan - the checks, in catalog order; needs refer to checks of the plan.
 * @param options - the root, environment, logs, CPU budget, pass cache and reporter.
 * @returns each check's result, in plan order.
 */
export async function runPlan(plan: readonly WithUnits<Planned>[], options: RunOptions): Promise<Result[]> {
  const results = new Map<string, Result>()
  const running = new Map<string, ChildProcess>()
  // Each check's pass key, computed before any check runs: a check's key describes the inputs it started from.
  // A unitised suite is keyed per package only: the whole suite's key would not record what each package reads.
  const keys = new Map(plan.map(check => [check.id, (check.units?.length ?? 0) > 0 ? undefined : options.cache?.keyOf(check)]))
  // Each unit's key, also computed before any check runs.
  const unitKeys = new Map(plan.map(check => [check.id, options.cache === undefined ? [] : (check.units ?? []).map(unit => ({ unit, key: options.cache?.unitKey(check, unit) ?? '' }))]))
  let busy = 0
  let held = 0
  let alone = false
  let failed = false
  let interrupted = false

  const stopAll = (): void => {
    interrupted = true
    for (const child of running.values()) stopGroup(child)
  }
  process.once('SIGINT', stopAll)
  process.once('SIGTERM', stopAll)

  const finish = (check: Planned, result: Result): void => {
    results.set(check.id, result)
    if (gateFailure(result, options.tier)) failed = true
    options.report({ kind: 'end', check, result })
  }

  const ordered = [...plan].sort((a, b) => (options.priority?.get(b.id) ?? 0) - (options.priority?.get(a.id) ?? 0))
  try {
    await new Promise<void>((resolve, reject) => {
    const pump = (): void => {
      // A check settled without a process (cached, skipped, declined) can release a check earlier in this pass, and no
      // process is left to pump again, so the pass repeats until it settles nothing.
      let settled: number
      do {
        settled = results.size
        pass()
      } while (results.size !== settled)
      if (results.size === plan.length) resolve()
      else if (running.size === 0) reject(new Error(`run-checks: ${String(plan.length - results.size)} check(s) can neither start nor finish and nothing is running: ${plan.filter(check => !results.has(check.id)).map(check => check.id).join(', ')}`))
    }

    const pass = (): void => {
      for (const check of ordered) {
        if (results.has(check.id) || running.has(check.id)) continue
        const unmet = check.needs.filter(need => results.get(need)?.outcome !== 'passed')
        const blocked = check.needs.find(need => { const outcome = results.get(need)?.outcome; return outcome !== undefined && outcome !== 'passed' })
        if (blocked !== undefined || interrupted || (failed && options.bail)) {
          finish(check, { id: check.id, outcome: 'skipped', seconds: 0, detail: blocked !== undefined ? `${blocked} did not pass` : interrupted ? 'interrupted' : 'an earlier check failed (--bail)' })
          continue
        }
        if (check.declined !== undefined) {
          finish(check, { id: check.id, outcome: 'declined', seconds: 0, detail: check.declined, ...check.mergeOnly === true && check.declinedByHost === true ? { unrun: true } : {} })
          continue
        }
        if (check.memoryBytes > options.memoryBytes) {
          finish(check, { id: check.id, outcome: 'declined', seconds: 0, detail: `it needs ${gib(check.memoryBytes)} and the run's ceiling is ${gib(options.memoryBytes)}; run it on a bigger host`, ...check.mergeOnly === true ? { unrun: true } : {} })
          continue
        }
        if (unmet.length > 0) continue
        const key = keys.get(check.id)
        const source = key === undefined ? undefined : options.cache?.lookup(check, key)
        if (key !== undefined && source !== undefined) {
          finish(check, { id: check.id, outcome: 'passed', seconds: 0, cached: true, cacheSource: source, detail: `cached pass (${source === 'shared' ? 'shared, ' : ''}${key.slice(0, 12)})` })
          continue
        }
        const keyed = unitKeys.get(check.id) ?? []
        const served = keyed.map(({ unit, key }) => ({ unit, key, source: options.cache?.lookupUnit(check, unit, key) }))
        const pending = served.filter(each => each.source === undefined)
        const counts = { total: served.length, ran: pending.length, local: served.filter(each => each.source === 'local').length, shared: served.filter(each => each.source === 'shared').length }
        if (keyed.length > 0 && pending.length === 0) {
          finish(check, { id: check.id, outcome: 'passed', seconds: 0, cached: true, cacheSource: counts.shared > 0 ? 'shared' : 'local', units: counts, detail: `cached pass of all ${String(counts.total)} packages (${String(counts.local)} in this worktree, ${String(counts.shared)} shared)` })
          continue
        }
        if (alone || (check.exclusive === true && running.size > 0)) continue
        const writer = DECLARATION_WRITERS.indexOf(check.id)
        if (writer >= 0 && (DECLARATION_WRITERS.slice(0, writer).some(id => plan.some(each => each.id === id) && !results.has(id)) || [...running.keys()].some(id => DECLARATION_WRITERS.includes(id)))) continue
        if (busy > 0 && busy + check.cpus > options.cpus) continue
        if (held > 0 && held + check.memoryBytes > options.memoryBytes) continue
        start(check, keyed.length === 0 ? undefined : { pending, counts })
      }
    }

    const start = (check: Planned, units?: { readonly pending: ReadonlyArray<{ readonly unit: Unit, readonly key: string }>, readonly counts: UnitCounts }): void => {
      const log = join(options.logDir, `${check.id.replaceAll(':', '-')}.log`)
      const out = createWriteStream(log)
      const begun = performance.now()
      // A unitised suite runs only its packages without a stored pass.
      const argv = units === undefined ? check.command : commandFor(check, units.pending.map(each => each.unit))
      const [command = '', ...args] = argv
      const child = spawn(command, args, { cwd: join(options.root, check.cwd), env: { ...options.env, ...check.environment }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      running.set(check.id, child)
      busy += check.cpus
      held += check.memoryBytes
      if (check.exclusive === true) alone = true
      const oomBefore = options.oomKills?.()
      let peakBytes = 0
      const sampler = setInterval(() => { peakBytes = Math.max(peakBytes, child.pid === undefined ? 0 : groupResidentBytes(child.pid)) }, 500)
      options.report({ kind: 'start', check })
      child.stdout.pipe(out, { end: false })
      child.stderr.pipe(out, { end: false })
      const done = (outcome: Outcome, detail?: string, signal?: NodeJS.Signals | null): void => {
        if (!running.delete(check.id)) return
        clearInterval(sampler)
        busy -= check.cpus
        held -= check.memoryBytes
        if (check.exclusive === true) alone = false
        stopGroup(child)
        const oomAfter = options.oomKills?.()
        const oomKilled = signal === 'SIGKILL' && oomBefore !== undefined && oomAfter !== undefined && oomAfter > oomBefore
        const key = keys.get(check.id)
        if (outcome === 'passed' && key !== undefined) options.cache?.store(check, key)
        let unitNote: string | undefined
        if (units !== undefined) {
          // Only a passing run records its packages: an error Vitest does not attribute to a spec file can fail a run whose
          // every file reports a pass.
          if (outcome === 'passed') for (const each of units.pending) options.cache?.storeUnit(check, each.unit, each.key)
          unitNote = `${String(units.counts.ran)} of ${String(units.counts.total)} packages ran, ${String(units.counts.local)} served from this worktree and ${String(units.counts.shared)} shared`
        }
        const text = detail === undefined ? unitNote : `${oomKilled ? `${detail}, at the memory ceiling` : detail}${unitNote === undefined ? '' : `; ${unitNote}`}`
        out.end(() => {
          finish(check, { id: check.id, outcome, seconds: (performance.now() - begun) / 1000, log, ...text === undefined ? {} : { detail: text }, ...units === undefined ? {} : { units: units.counts }, ...peakBytes > 0 ? { peakBytes } : {}, ...oomKilled ? { oomKilled } : {} })
          pump()
        })
      }
      child.once('error', error => { done('failed', error.message) })
      child.once('close', (code, signal) => { done(code === 0 ? 'passed' : 'failed', code === 0 ? undefined : signal === null ? `exit ${String(code)}` : `stopped by ${signal}`, signal) })
    }

    pump()
    })
  } finally {
    process.off('SIGINT', stopAll)
    process.off('SIGTERM', stopAll)
  }
  return plan.map(check => results.get(check.id) ?? { id: check.id, outcome: 'skipped', seconds: 0 })
}
