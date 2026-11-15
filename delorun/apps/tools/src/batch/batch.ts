/**
 * The integrator's batch: several lanes replayed onto the trunk as one candidate, gated once by the merge tier, landed
 * through the protected push, and each failure sent back to the lane that caused it. Run from the root of a clean
 * integrator worktree:
 *
 * ```sh
 * node_modules/.bin/tsx delorun/apps/tools/src/batch/batch.ts --lanes <branch>[,<branch>...] [--trunk main] [--remote origin] [--no-land]
 * node_modules/.bin/tsx delorun/apps/tools/src/batch/batch.ts --lanes <branch>[,<branch>...] --plan
 * node_modules/.bin/tsx delorun/apps/tools/src/batch/batch.ts --resume <batch id>
 * ```
 *
 * The candidate branch `batch/<id>` starts at `<remote>/<trunk>` and each lane's commits are replayed onto it in order
 * (`candidate.ts`). The gate is the batch's own run of the check runner's `--changed --tier merge` on the candidate, which
 * must leave a merge-tier tree-pass record for the candidate's commit; the push is never trusted as the gate. A landing batch
 * then runs `git push <remote> batch/<id>:refs/heads/<trunk>`, and `--no-land` stops after the gate. A batch refuses to start
 * when the pre-push hook is missing or a variable bypasses it (`hooks.ts`). A failing gate's checks are
 * rerun once on the same candidate, the ones that pass are reported flaky, and the rest are attributed to lanes by rerunning
 * only them on candidates without some lanes (`attribute.ts`); the candidate is then rebuilt without the faulted lanes and
 * gated again. Every step's outcome is recorded in `<git common dir>/delorun-batch/<id>/state.json` before the next starts, and
 * the reports are written beside it (`report.ts`). The only process that can change the remote is the push, and every
 * process passes through the guard in `process.ts`.
 *
 * @module @delorun/tools/batch
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { treeOfRef, treeRecordsDir, readTreePass } from '../checks/tree-pass.ts'
import { repositoryRoot } from '../git.ts'
import { narrow, suspectsOf, type LaneFacts, type TrialResult } from './attribute.ts'
import { applyLane, assemble, commitOf, currentBranch, gitText, inspectLane, isClean, laneTip, lines, resetTo } from './candidate.ts'
import { BatchError } from './errors.ts'
import { assertHooksInstalled } from './hooks.ts'
import { failuresOf, readReport, REPORT_PATH } from './logs.ts'
import { readPlanSource, type PlanSource, type SelectedCheck } from './plan-source.ts'
import { processPorts, spawnExec, type Ports } from './process.ts'
import { laneReports, outcomeLine, planText, summaryText, type FaultedGroup, type SetAsideLane } from './report.ts'
import { nodeFiles, ofKind, parseState, stateText, STATE_VERSION, type Application, type BatchState, type FailedCheck, type Files, type Gate, type Outcome, type Step } from './state.ts'

/** What the command line asks for. */
export type BatchOptions =
  /** Start a batch of these lanes, or print its plan. */
  | { readonly kind: 'start', readonly lanes: readonly string[], readonly trunk: string, readonly remote: string, readonly land: boolean, readonly plan: boolean }
  /** Continue a recorded batch. */
  | { readonly kind: 'resume', readonly id: string }

/** The batch's side effects. */
export interface BatchDeps {
  /** The integrator worktree's root. */
  readonly root: string
  /** The integrator's environment, which {@link assertHooksInstalled} checks for bypasses. */
  readonly env: NodeJS.ProcessEnv
  readonly ports: Ports
  readonly files: Files
  /**
   * Read the check runner's selection from the worktree; called once, when a lane's suspects are first needed.
   * @returns the selection.
   */
  readonly planSource: () => PlanSource
  /**
   * Read the check runner's tree-pass record for a commit's tree.
   * @param commit - the commit.
   * @returns the record's tier and head commit, or undefined when none exists.
   */
  readonly mergeRecord: (commit: string) => { readonly tier: string, readonly head: string } | undefined
  /**
   * The current time, which names a new batch.
   * @returns the time.
   */
  readonly now: () => Date
  /**
   * Print one progress line.
   * @param line - the line.
   */
  readonly say: (line: string) => void
}

/** A batch id: the UTC time it started, `YYYYMMDD-HHMMSS`. */
const BATCH_ID = /^\d{8}-\d{6}$/
/** A remote or trunk name the batch passes to git: no option and no refspec syntax. */
const REF_NAME = /^[\w.][\w./-]*$/
/** A push the remote refused because the trunk moved. */
const NON_FAST_FORWARD = /\[rejected\].*\((?:non-fast-forward|fetch first)\)/

/**
 * Parse the command line.
 * @param argv - the arguments, without the script.
 * @returns the options.
 * @throws BatchError with code `usage` on an unknown, missing or conflicting option.
 */
export function parseOptions(argv: readonly string[]): BatchOptions {
  let values: { lanes?: string | undefined, trunk?: string | undefined, remote?: string | undefined, resume?: string | undefined, plan: boolean, 'no-land': boolean }
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        'lanes': { type: 'string' },
        'trunk': { type: 'string' },
        'remote': { type: 'string' },
        'resume': { type: 'string' },
        'plan': { type: 'boolean', default: false },
        'no-land': { type: 'boolean', default: false },
      },
    }).values
  } catch (error) {
    // parseArgs throws a TypeError for an unknown option, a missing value or a positional argument.
    throw new BatchError('usage', String(error))
  }
  if (values.resume !== undefined) {
    if (values.lanes !== undefined || values.trunk !== undefined || values.remote !== undefined || values.plan || values['no-land']) {
      throw new BatchError('usage', '--resume continues the recorded batch with its own lanes, trunk, remote and landing; give it alone')
    }
    if (!BATCH_ID.test(values.resume)) throw new BatchError('usage', `--resume takes a batch id such as 20261110-153000, got ${values.resume}`)
    return { kind: 'resume', id: values.resume }
  }
  const lanes = (values.lanes ?? '').split(',').map(lane => lane.trim()).filter(lane => lane.length > 0)
  if (lanes.length === 0) throw new BatchError('usage', '--lanes names at least one lane branch, or --resume names a batch')
  if (new Set(lanes).size !== lanes.length) throw new BatchError('usage', `--lanes names a lane twice: ${lanes.join(',')}`)
  const trunk = values.trunk ?? 'main'
  const remote = values.remote ?? 'origin'
  for (const name of [trunk, remote]) if (!REF_NAME.test(name)) throw new BatchError('usage', `--trunk and --remote take plain names, got ${name}`)
  return { kind: 'start', lanes, trunk, remote, land: !values['no-land'], plan: values.plan }
}

/**
 * A batch's id from the time it starts.
 * @param now - the time.
 * @returns `YYYYMMDD-HHMMSS` in UTC.
 */
export function batchId(now: Date): string {
  const iso = now.toISOString()
  return `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`
}

/**
 * The directory a batch's state and reports live in.
 * @param ports - the process ports.
 * @param id - the batch id.
 * @returns `<git common dir>/delorun-batch/<id>`.
 */
function batchDir(ports: Ports, id: string): string {
  return join(gitText(ports.git, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(), 'delorun-batch', id)
}

/**
 * The trunk commit a batch starts from.
 * @param ports - the process ports.
 * @param remote - the remote.
 * @param trunk - the trunk.
 * @returns the commit of `<remote>/<trunk>`.
 * @throws BatchError with code `git` when the clone has no such ref.
 */
function trunkCommit(ports: Ports, remote: string, trunk: string): string {
  const start = commitOf(ports.git, `refs/remotes/${remote}/${trunk}`)
  if (start === undefined) throw new BatchError('git', `${remote}/${trunk} does not exist in this clone; fetch it or correct --remote and --trunk`)
  return start
}

/**
 * Print the plan of a batch without changing anything: no fetch, no branch, no state.
 * @param options - the lanes, trunk and remote.
 * @param deps - the side effects.
 * @returns 0.
 */
function printPlan(options: Extract<BatchOptions, { kind: 'start' }>, deps: BatchDeps): number {
  const start = trunkCommit(deps.ports, options.remote, options.trunk)
  const lanes = options.lanes.map(name => inspectLane(deps.ports.git, name, laneTip(deps.ports.git, name), start))
  const source = deps.planSource()
  const planned = lanes.map(lane => {
    const paths = lines(gitText(deps.ports.git, ['diff', '--name-only', '--no-renames', lane.base, lane.tip]))
    const packages = [...new Set(paths.flatMap(path => source.packageOf(path) ?? []))]
    return { lane, packages, checks: source.select(paths).map(check => check.id) }
  })
  deps.say(planText(options.remote, options.trunk, start, planned))
  return 0
}

/**
 * Start a batch: refuse a worktree that is dirty or detached, fetch the trunk, resolve the lanes, create the candidate
 * branch at the trunk and record the state.
 * @param options - the lanes, trunk, remote and landing.
 * @param deps - the side effects.
 * @returns the recorded state.
 * @throws BatchError when the worktree, a lane or the candidate branch refuses the batch.
 */
function begin(options: Extract<BatchOptions, { kind: 'start' }>, deps: BatchDeps): BatchState {
  const { git } = deps.ports
  if (currentBranch(git) === undefined) throw new BatchError('detached', 'HEAD is detached; check out a branch in the integrator worktree first')
  if (!isClean(git)) throw new BatchError('dirty-tree', 'the integrator worktree has uncommitted or untracked changes; commit, stash or remove them first')
  gitText(git, ['fetch', '--quiet', options.remote, options.trunk])
  const start = trunkCommit(deps.ports, options.remote, options.trunk)
  const tips = options.lanes.map(name => ({ name, tip: laneTip(git, name) }))
  const id = batchId(deps.now())
  if (commitOf(git, `refs/heads/batch/${id}`) !== undefined) throw new BatchError('branch-exists', `the branch batch/${id} exists already; wait a second and start again`)
  const lanes = tips.map(({ name, tip }) => inspectLane(git, name, tip, start))
  gitText(git, ['checkout', '--quiet', '-b', `batch/${id}`, start])
  const state: BatchState = { version: STATE_VERSION, id, trunk: options.trunk, remote: options.remote, land: options.land, start, lanes, candidate: start, steps: {}, outcome: null }
  const dir = batchDir(deps.ports, id)
  deps.files.write(join(dir, 'state.json'), stateText(state))
  deps.say(`delorun batch ${id}: ${String(lanes.length)} lane(s) onto ${options.remote}/${options.trunk} at ${start.slice(0, 12)}; state in ${dir}`)
  return state
}

/**
 * Reopen a recorded batch: check out its candidate branch at the last recorded commit, ending a cherry-pick an
 * interruption left on that branch.
 * @param id - the batch id.
 * @param deps - the side effects.
 * @returns the recorded state.
 * @throws BatchError when there is no such batch or the worktree refuses it.
 */
function reopen(id: string, deps: BatchDeps): BatchState {
  const { git } = deps.ports
  const path = join(batchDir(deps.ports, id), 'state.json')
  const text = deps.files.read(path)
  if (text === undefined) throw new BatchError('state', `no batch ${id}: ${path} does not exist`)
  const state = parseState(text, path)
  const branch = currentBranch(git)
  if (branch === `batch/${id}`) {
    // The status is ignored: an interruption outside a cherry-pick leaves none to abort.
    git(['cherry-pick', '--abort'])
    resetTo(git, state.candidate)
  } else {
    if (branch === undefined) throw new BatchError('detached', 'HEAD is detached; check out a branch in the integrator worktree first')
    if (!isClean(git)) throw new BatchError('dirty-tree', 'the integrator worktree has uncommitted or untracked changes; commit, stash or remove them first')
    gitText(git, ['checkout', '--quiet', '-B', `batch/${id}`, state.candidate])
  }
  if (!isClean(git)) throw new BatchError('dirty-tree', `untracked files remain on batch/${id} after resetting it to ${state.candidate.slice(0, 12)}; remove them and resume again`)
  deps.say(`delorun batch ${id}: resuming at ${state.candidate.slice(0, 12)}`)
  return state
}

/**
 * Run a batch's remaining steps and write its reports. Recorded steps are replayed from the state without running
 * anything, so a resumed batch continues at its first unfinished step.
 * @param state - the state, which this function updates and records.
 * @param deps - the side effects.
 * @returns 0 when the candidate landed, or passed with landing off; otherwise 1.
 */
function proceed(state: BatchState, deps: BatchDeps): number {
  const { git } = deps.ports
  const dir = batchDir(deps.ports, state.id)
  const reportPath = join(deps.root, REPORT_PATH)
  const save = (): void => { deps.files.write(join(dir, 'state.json'), stateText(state)) }
  const step = <T extends Step>(key: string, recorded: (step: Step) => step is T, run: () => T): T => {
    const found = state.steps[key]
    if (found !== undefined) {
      if (recorded(found)) return found
      throw new BatchError('state', `step ${key} is recorded as ${found.kind}, which this batch does not expect there; start a new batch`)
    }
    const result = run()
    state.steps[key] = result
    save()
    return result
  }
  let source: PlanSource | undefined
  const selections = new Map<string, SelectedCheck[]>()
  const selected = (application: Application): SelectedCheck[] => {
    source ??= deps.planSource()
    const known = selections.get(application.lane) ?? source.select(application.paths)
    selections.set(application.lane, known)
    return known
  }

  const setAside: SetAsideLane[] = []
  const faults: FaultedGroup[] = []
  const flaky: string[] = []
  // Each lane's first replay, whose changed paths are the lane's own.
  const own = new Map<string, Application>()
  for (const lane of state.lanes) {
    const result = step(`lane:${lane.name}`, ofKind('applied', 'set-aside'), () => {
      deps.say(`delorun batch: replaying ${lane.name} (${String(lane.commits.length)} commit(s))`)
      resetTo(git, state.candidate)
      const applied = applyLane(git, lane)
      if (applied.kind === 'set-aside') return { kind: 'set-aside', lane: lane.name, reason: applied.reason }
      state.candidate = applied.application.after
      return { kind: 'applied', application: applied.application }
    })
    if (result.kind === 'set-aside') setAside.push({ lane: result.lane, reason: result.reason, round: 0 })
    else own.set(lane.name, result.application)
  }

  const end = (outcome: Outcome, included: readonly string[]): number => {
    state.outcome = outcome
    save()
    const summary = { id: state.id, remote: state.remote, trunk: state.trunk, start: state.start, included, setAside, faults, flaky: [...new Set(flaky)], outcome }
    for (const report of laneReports(summary)) deps.files.write(join(dir, `${report.lane}.md`), report.text)
    deps.files.write(join(dir, 'summary.md'), summaryText(summary))
    deps.say(`delorun batch ${state.id}: ${outcomeLine(summary)}; reports in ${dir}`)
    return outcome.kind === 'landed' || outcome.kind === 'passed' ? 0 : 1
  }

  /**
   * Run checks once on the worktree and read which of them did not pass.
   * @param checks - the check ids.
   * @returns the ones that did not pass; all of them when the run left no report and failed.
   */
  const stillFailing = (checks: readonly string[]): string[] => {
    deps.files.remove(reportPath)
    const status = deps.ports.checks(['--only', checks.join(','), '--changed', '--base', state.start, '--tier', 'merge'])
    const report = readReport(deps.files, deps.root)
    if (report === undefined) return status === 0 ? [] : [...checks]
    return checks.filter(check => !report.some(entry => entry.check === check && entry.status === 'passed'))
  }

  const gateOf = (detail: string): Gate => {
    const report = readReport(deps.files, deps.root)
    const failing = report === undefined ? [] : failuresOf(deps.files, deps.root, report)
    if (failing.length > 0) return { kind: 'failed', failing }
    const declined = (report ?? []).filter(entry => entry.status === 'declined').map(entry => `${entry.check} declined: ${entry.reason ?? 'no reason given'}`)
    return { kind: 'gate-error', detail: [...declined, detail].join('; ') }
  }

  const gate = (commit: string): Gate => {
    resetTo(git, commit)
    deps.files.remove(reportPath)
    const status = deps.ports.checks(['--changed', '--base', state.start, '--tier', 'merge'])
    if (status !== 0) return gateOf(`the merge tier exited ${String(status)}`)
    const record = deps.mergeRecord(commit)
    if (record?.tier !== 'merge' || record.head !== commit) return { kind: 'gate-error', detail: `the merge tier left no merge-tier tree-pass record for ${commit.slice(0, 12)}` }
    if (!state.land) return { kind: 'passed' }
    deps.say(`delorun batch: pushing batch/${state.id} to ${state.remote}/${state.trunk}`)
    const push = deps.ports.push(state.remote, `batch/${state.id}:refs/heads/${state.trunk}`)
    if (push.status === 0) return { kind: 'passed' }
    const rejected = lines(push.stderr).find(line => NON_FAST_FORWARD.test(line))
    if (rejected !== undefined) return { kind: 'trunk-moved', detail: rejected.trim() }
    return gateOf(lines(push.stderr).slice(-3).join(' ') || `git push exited ${String(push.status)}`)
  }

  let build: { readonly commit: string, readonly applied: readonly Application[] } = { commit: state.lanes.reduce((commit, lane) => own.get(lane.name)?.after ?? commit, state.start), applied: [...own.values()] }
  const faulted = new Set<string>()
  let flakeRounds = 0
  for (let round = 0; ; round += 1) {
    const wanted = state.lanes.filter(lane => build.applied.some(application => application.lane === lane.name) && !faulted.has(lane.name))
    if (wanted.length !== build.applied.length) {
      const rebuilt = step(`round:${String(round)}:build`, ofKind('build'), () => {
        deps.say(`delorun batch: rebuilding the candidate with ${wanted.map(lane => lane.name).join(', ') || 'no lane'}`)
        const assembly = assemble(git, state.start, wanted)
        state.candidate = assembly.commit
        return { kind: 'build', commit: assembly.commit, applied: [...assembly.applied], setAside: [...assembly.setAside] }
      })
      setAside.push(...rebuilt.setAside.map(entry => ({ ...entry, round })))
      build = rebuilt
    }
    const included = build.applied.map(application => application.lane)
    if (included.length === 0) return end({ kind: 'nothing-to-land' }, included)
    const candidate = build.commit
    const gated = step(`round:${String(round)}:gate`, ofKind('gate'), () => ({ kind: 'gate', commit: candidate, gate: gate(candidate) })).gate
    if (gated.kind === 'passed') return end(state.land ? { kind: 'landed', commit: candidate } : { kind: 'passed', commit: candidate }, included)
    if (gated.kind !== 'failed') return end(gated, included)

    const failingIds = gated.failing.map(failure => failure.check)
    const rerun = step(`round:${String(round)}:rerun`, ofKind('rerun'), () => {
      deps.say(`delorun batch: rerunning ${failingIds.join(', ')} once on the same candidate`)
      resetTo(git, candidate)
      const failing = stillFailing(failingIds)
      return { kind: 'rerun', failing, flaky: failingIds.filter(check => !failing.includes(check)) }
    })
    flaky.push(...rerun.flaky)
    if (rerun.failing.length === 0) {
      flakeRounds += 1
      if (flakeRounds > 1) return end({ kind: 'flaky', checks: rerun.flaky }, included)
      continue
    }
    const still: FailedCheck[] = gated.failing.filter(failure => rerun.failing.includes(failure.check))
    const trial = (lanes: readonly string[]): TrialResult => step(`round:${String(round)}:trial:${lanes.join(',')}`, ofKind('trial'), () => {
      deps.say(`delorun batch: ${rerun.failing.join(', ')} on the trunk with ${lanes.join(', ') || 'no lane'}`)
      const assembly = assemble(git, state.start, state.lanes.filter(lane => lanes.includes(lane.name)))
      if (assembly.setAside.length > 0) return { kind: 'trial', lanes: [...lanes], result: 'unbuildable', failing: [] }
      const failing = stillFailing(rerun.failing)
      return { kind: 'trial', lanes: [...lanes], result: failing.length === 0 ? 'passed' : 'failed', failing }
    }).result
    const verdict = step(`round:${String(round)}:verdict`, ofKind('verdict'), () => {
      const facts: LaneFacts[] = state.lanes.flatMap(lane => {
        const first = own.get(lane.name)
        const current = build.applied.find(application => application.lane === lane.name)
        if (first === undefined || current === undefined) return []
        const commits = [...first.commits, ...current.commits].flatMap(commit => [commit.original, ...commit.applied === null ? [] : [commit.applied]])
        return [{ name: lane.name, selected: selected(first), commits }]
      })
      return { kind: 'verdict', verdict: narrow(included, suspectsOf(still, facts), trial) }
    }).verdict
    if (verdict.kind === 'not-attributable') return end(verdict, included)
    for (const fault of verdict.faults) {
      faults.push({ fault, failures: still.filter(failure => fault.checks.includes(failure.check)) })
      for (const lane of fault.lanes) faulted.add(lane)
    }
  }
}

/**
 * Run the batch the options ask for.
 * @param options - the parsed command line.
 * @param deps - the side effects.
 * @returns the exit status: 0 when the plan printed or the candidate landed or passed, 1 when the batch stopped without landing.
 * @throws BatchError when the worktree, a lane or the state refuses the batch.
 */
export function runBatch(options: BatchOptions, deps: BatchDeps): number {
  if (options.kind === 'start' && options.plan) return printPlan(options, deps)
  assertHooksInstalled(deps.ports.git, deps.root, deps.env, deps.files)
  return proceed(options.kind === 'start' ? begin(options, deps) : reopen(options.id, deps), deps)
}

/**
 * Read the merge-tier record the check runner left for a commit.
 * @param root - the repository root.
 * @returns a reader of the record for a commit's tree under this Node major.
 */
export function mergeRecordOf(root: string): BatchDeps['mergeRecord'] {
  return commit => readTreePass(treeRecordsDir(root), treeOfRef(root, commit) ?? '', process.version)
}

/**
 * The command line's entry.
 * @param argv - the arguments, without the script.
 * @param env - the integrator's environment.
 * @param cwd - a directory in the integrator worktree.
 * @returns the exit status; 2 when the batch was refused.
 */
export function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): number {
  try {
    const options = parseOptions(argv)
    const root = repositoryRoot(cwd)
    return runBatch(options, {
      root,
      env,
      ports: processPorts(spawnExec, root, env),
      files: nodeFiles,
      planSource: () => readPlanSource(root),
      mergeRecord: mergeRecordOf(root),
      now: () => new Date(),
      say: line => { console.log(line) },
    })
  } catch (error) {
    if (!(error instanceof BatchError)) throw error
    console.error(`delorun batch: ${error.message}`)
    return 2
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
