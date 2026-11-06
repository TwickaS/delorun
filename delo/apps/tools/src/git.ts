/**
 * Git for the ledger tools: one synchronous runner that reports the exit status, so a
 * caller can tell a negative answer from a failure, and a helper that throws on failure.
 *
 * @module @delo/tools/git
 */
import { spawnSync } from 'node:child_process'

/** The output buffer for one git invocation; a whole-tree listing can be large. */
const MAX_BUFFER = 256 * 1024 * 1024

/** The outcome of one git invocation. */
export interface GitRun {
  /** The exit status, or null when git ended by a signal. */
  readonly status: number | null
  /** Standard output, decoded as UTF-8. */
  readonly stdout: string
  /** Standard error, decoded as UTF-8. */
  readonly stderr: string
}

/**
 * Run git and return its status and both output streams without throwing on a nonzero status.
 * @param cwd - the directory to run in.
 * @param args - git's arguments.
 * @returns the exit status and the captured output.
 */
export function runGit(cwd: string, args: readonly string[]): GitRun {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER })
  if (result.error !== undefined) throw result.error
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/**
 * Run git and return its standard output; a nonzero exit throws with git's error text.
 * @param cwd - the directory to run in.
 * @param args - git's arguments.
 * @returns the output as git wrote it, so a NUL-separated listing keeps its last entry.
 */
export function git(cwd: string, args: readonly string[]): string {
  const run = runGit(cwd, args)
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} exited ${String(run.status)}: ${run.stderr.trim()}`)
  return run.stdout
}

/**
 * The root of the repository a directory lies in.
 * @param cwd - a directory inside the repository.
 * @returns the absolute path of its top level.
 */
export function repositoryRoot(cwd: string): string {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim()
}
