/**
 * The candidate branch: lanes found and replayed onto `<remote>/<trunk>` with `git cherry-pick`, one commit at a time,
 * keeping each commit's author, author date and message. A lane whose commit conflicts is undone to the candidate
 * before it and set aside with the conflicting paths; a commit that the candidate already holds becomes empty and is
 * dropped.
 *
 * @module @delorun/tools/batch/candidate
 */
import { BatchError } from './errors.ts'
import type { Ports } from './process.ts'
import type { Application, Lane, SetAside } from './state.ts'

/** Runs git in the integrator worktree. */
export type Git = Ports['git']

/**
 * Run git and return its standard output.
 * @param git - the git port.
 * @param args - git's arguments.
 * @returns standard output.
 * @throws BatchError with code `git` and git's error text on a nonzero exit.
 */
export function gitText(git: Git, args: readonly string[]): string {
  const run = git(args)
  if (run.status !== 0) throw new BatchError('git', `git ${args.join(' ')} exited ${String(run.status)}: ${run.stderr.trim()}`)
  return run.stdout
}

/**
 * The non-empty lines of a text.
 * @param text - the text.
 * @returns its lines without empty ones.
 */
export function lines(text: string): string[] {
  return text.split('\n').filter(line => line.length > 0)
}

/**
 * The branch HEAD is on.
 * @param git - the git port.
 * @returns its short name, or undefined when HEAD is detached.
 */
export function currentBranch(git: Git): string | undefined {
  const run = git(['symbolic-ref', '--short', '-q', 'HEAD'])
  return run.status === 0 ? run.stdout.trim() : undefined
}

/**
 * Whether the worktree equals HEAD: no tracked change and no untracked file outside the ignore rules.
 * @param git - the git port.
 * @returns true when clean.
 */
export function isClean(git: Git): boolean {
  return gitText(git, ['status', '--porcelain', '--untracked-files=all']) === ''
}

/**
 * The commit a revision names.
 * @param git - the git port.
 * @param revision - a branch, remote-tracking branch or commit.
 * @returns the commit id, or undefined when the revision names no commit.
 */
export function commitOf(git: Git, revision: string): string | undefined {
  const run = git(['rev-parse', '--verify', '-q', `${revision}^{commit}`])
  return run.status === 0 ? run.stdout.trim() : undefined
}

/**
 * A lane's tip, refusing a name that is not a branch name or names no commit.
 * @param git - the git port.
 * @param name - the lane's branch, local or remote-tracking.
 * @returns the tip's commit id.
 * @throws BatchError with code `unknown-lane`.
 */
export function laneTip(git: Git, name: string): string {
  const valid = !name.startsWith('-') && git(['check-ref-format', '--branch', name]).status === 0
  const tip = valid ? commitOf(git, name) : undefined
  if (tip === undefined) throw new BatchError('unknown-lane', `the lane branch ${name} does not exist; fetch it or correct --lanes`)
  return tip
}

/**
 * A lane as the batch replays it: the commits from its merge base with the trunk to its tip.
 * @param git - the git port.
 * @param name - the lane's branch.
 * @param tip - its tip.
 * @param start - the trunk commit the batch builds on.
 * @returns the lane.
 */
export function inspectLane(git: Git, name: string, tip: string, start: string): Lane {
  const base = gitText(git, ['merge-base', start, tip]).trim()
  const range = `${base}..${tip}`
  return {
    name,
    tip,
    base,
    commits: lines(gitText(git, ['rev-list', '--reverse', '--topo-order', range])),
    merges: lines(gitText(git, ['rev-list', '--merges', range])),
  }
}

/**
 * Move the candidate branch, which HEAD is on, and the worktree to a commit.
 * @param git - the git port.
 * @param commit - the commit.
 */
export function resetTo(git: Git, commit: string): void {
  gitText(git, ['reset', '--quiet', '--hard', commit])
}

/** A lane replayed, or why it was set aside. */
export type LaneResult =
  | { readonly kind: 'applied', readonly application: Application }
  | { readonly kind: 'set-aside', readonly reason: SetAside }

/**
 * Replay a lane onto HEAD. A lane with merge commits or no commits is set aside before anything changes; a lane that
 * fails to apply leaves HEAD where it was.
 * @param git - the git port.
 * @param lane - the lane.
 * @returns the replayed commits and the paths they change, or why the lane was set aside.
 */
export function applyLane(git: Git, lane: Lane): LaneResult {
  if (lane.merges.length > 0) return { kind: 'set-aside', reason: { kind: 'merge-commits', commits: lane.merges } }
  if (lane.commits.length === 0) return { kind: 'set-aside', reason: { kind: 'no-commits' } }
  const before = gitText(git, ['rev-parse', 'HEAD']).trim()
  const commits: Application['commits'] = []
  for (const original of lane.commits) {
    const pick = git(['cherry-pick', '--allow-empty', original])
    if (pick.status === 0) {
      commits.push({ original, applied: gitText(git, ['rev-parse', 'HEAD']).trim() })
      continue
    }
    const conflicts = lines(gitText(git, ['diff', '--name-only', '--diff-filter=U']))
    if (conflicts.length === 0 && isClean(git)) {
      // The candidate already holds this change, so the commit became empty: drop it and go on.
      gitText(git, ['cherry-pick', '--skip'])
      commits.push({ original, applied: null })
      continue
    }
    // The status is ignored: a pick that failed before it started leaves no cherry-pick to abort.
    git(['cherry-pick', '--abort'])
    resetTo(git, before)
    return {
      kind: 'set-aside',
      reason: conflicts.length > 0 ? { kind: 'conflict', commit: original, paths: conflicts } : { kind: 'pick-failed', commit: original, detail: lines(pick.stderr)[0] ?? `exit ${String(pick.status)}` },
    }
  }
  const after = gitText(git, ['rev-parse', 'HEAD']).trim()
  const paths = lines(gitText(git, ['diff', '--name-only', '--no-renames', before, after]))
  return { kind: 'applied', application: { lane: lane.name, before, after, commits, paths } }
}

/** A candidate built from the start commit. */
export interface Assembly {
  /** The candidate's commit. */
  readonly commit: string
  /** The lanes that applied, in order. */
  readonly applied: readonly Application[]
  /** The lanes that did not, with why. */
  readonly setAside: readonly { readonly lane: string, readonly reason: SetAside }[]
}

/**
 * Build a candidate on the candidate branch: reset it to the start commit and replay the lanes in order.
 * @param git - the git port.
 * @param start - the trunk commit.
 * @param lanes - the lanes, in batch order.
 * @returns the candidate.
 */
export function assemble(git: Git, start: string, lanes: readonly Lane[]): Assembly {
  resetTo(git, start)
  const applied: Application[] = []
  const setAside: { lane: string, reason: SetAside }[] = []
  for (const lane of lanes) {
    const result = applyLane(git, lane)
    if (result.kind === 'applied') applied.push(result.application)
    else setAside.push({ lane: lane.name, reason: result.reason })
  }
  return { commit: gitText(git, ['rev-parse', 'HEAD']).trim(), applied, setAside }
}
