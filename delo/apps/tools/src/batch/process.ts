/**
 * The batch tool's processes. Every git, check-runner and push invocation passes through {@link assertGated}, which
 * refuses the arguments and variables that would let a commit reach the trunk without the merge tier: a forced push, a
 * skipped or reconfigured hook, a skipped check or the agent tier.
 *
 * @module @delo/tools/batch/process
 */
import { spawnSync } from 'node:child_process'
import { BatchError } from './errors.ts'

/** The outcome of one process. */
export interface ProcessRun {
  /** The exit status, or null when the process ended by a signal. */
  readonly status: number | null
  /** Standard output; empty when it was shown on the terminal. */
  readonly stdout: string
  /** Standard error, always captured. */
  readonly stderr: string
}

/** How a process's output is handled: `capture` keeps both streams; `show` prints standard output and keeps standard error. */
export type Output = 'capture' | 'show'

/** Where and how one process runs. */
export interface ExecOptions {
  /** The working directory. */
  readonly cwd: string
  /** The whole environment of the process. */
  readonly env: NodeJS.ProcessEnv
  /** What happens to its output. */
  readonly output: Output
}

/** Starts one process and waits for it. */
export type Exec = (command: string, args: readonly string[], options: ExecOptions) => ProcessRun

/** The check runner, started through tsx from the repository root. */
export const TSX = 'node_modules/.bin/tsx'
/** The check runner's entry, relative to the repository root. */
export const RUN_CHECKS = 'delo/apps/tools/src/run-checks.ts'

/** Arguments that force a push or skip its hook, whatever the process. */
const FORBIDDEN = new Set(['--force', '-f', '--no-verify', '--force-if-includes'])
/** The tiers lighter than the merge tier, which no batch process may ask for. */
const LIGHTER_TIERS = ['agent', 'lane'] as const
/** The variables that lower the tier or disable the hook; {@link childEnvironment} removes them from every child. */
const OVERRIDES = ['DELO_PUSH_SKIP', 'DELO_TIER', 'LEFTHOOK', 'LEFTHOOK_EXCLUDE', 'LEFTHOOK_BIN']
/** The values of `LEFTHOOK` that keep the hook enabled. */
const LEFTHOOK_ON = ['1', 'true']

/**
 * The first variable that skips checks or disables, replaces or reconfigures the pre-push hook: `DELO_PUSH_SKIP`,
 * `LEFTHOOK` set to anything but `1` or `true`, `LEFTHOOK_EXCLUDE`, `LEFTHOOK_BIN`, or any `GIT_CONFIG*` variable.
 * @param env - the environment.
 * @returns the variable's name, or undefined when there is none.
 */
export function bypassVariable(env: NodeJS.ProcessEnv): string | undefined {
  const lefthook = env['LEFTHOOK']
  if (lefthook !== undefined && !LEFTHOOK_ON.includes(lefthook)) return 'LEFTHOOK'
  return Object.keys(env).find(name => name === 'DELO_PUSH_SKIP' || name === 'LEFTHOOK_EXCLUDE' || name === 'LEFTHOOK_BIN' || name.startsWith('GIT_CONFIG'))
}

/**
 * Refuse a process whose arguments or environment would let a commit reach the trunk without the merge tier: a forced push
 * (`--force`, `-f`, `--force-with-lease`, `--force-if-includes`, or a refspec starting with `+`), a skipped hook
 * (`--no-verify`), skipped checks (`--skip`, `--skip=...` except `git cherry-pick --skip`, `DELO_PUSH_SKIP`), a tier lighter than the merge tier
 * (`--tier agent|lane`, `--tier=agent|lane`, `DELO_TIER=agent|lane`), a reconfigured hook (`-c core.hooksPath=...`,
 * `--config-env`), or a variable from {@link bypassVariable}.
 * @param args - the process's arguments.
 * @param env - the process's environment.
 * @throws BatchError with code `forbidden-argument` naming the offending argument or variable.
 */
export function assertGated(args: readonly string[], env: NodeJS.ProcessEnv): void {
  const refuse = (what: string): never => {
    throw new BatchError('forbidden-argument', `refusing to start a process with ${what}: nothing reaches the trunk except through the merge tier`)
  }
  args.forEach((arg, index) => {
    if (FORBIDDEN.has(arg) || arg.startsWith('--force-with-lease')) refuse(arg)
    if (arg.startsWith('+')) refuse(`the forced refspec ${arg}`)
    if ((arg === '--skip' || arg.startsWith('--skip=')) && args[0] !== 'cherry-pick') refuse('--skip')
    const lower = arg.toLowerCase()
    const next = (args[index + 1] ?? '').toLowerCase()
    if (lower.startsWith('--config-env') || (lower === '-c' && (next.includes('core.hookspath') || next.includes('--config-env'))) || (lower.startsWith('-c') && lower.includes('core.hookspath'))) refuse(`the git configuration override ${arg}`)
    for (const tier of LIGHTER_TIERS) if (arg === `--tier=${tier}` || (arg === '--tier' && args[index + 1] === tier)) refuse(`--tier ${tier}`)
  })
  const bypass = bypassVariable(env)
  if (bypass !== undefined) refuse(bypass)
  for (const tier of LIGHTER_TIERS) if (env['DELO_TIER'] === tier) refuse(`DELO_TIER=${tier}`)
}

/**
 * The environment the batch's processes inherit: the integrator's, without the variables that skip checks, choose the
 * tier or disable the hook (`DELO_PUSH_SKIP`, `DELO_TIER`, `LEFTHOOK*`, `GIT_CONFIG*`).
 * @param env - the integrator's environment.
 * @returns a new environment.
 */
export function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !OVERRIDES.includes(name) && !name.startsWith('GIT_CONFIG')))
}

/** The three kinds of process the batch starts, each in the repository root and through {@link assertGated}. */
export interface Ports {
  /**
   * Run git with both streams captured.
   * @param args - git's arguments.
   * @returns the outcome.
   */
  readonly git: (args: readonly string[]) => ProcessRun
  /**
   * Run the check runner with its output on the terminal.
   * @param args - the runner's arguments.
   * @returns its exit status; 1 when it ended by a signal.
   */
  readonly checks: (args: readonly string[]) => number
  /**
   * Push one refspec with the repository's pre-push hook, in the merge tier (`DELO_TIER=merge`).
   * @param remote - the remote.
   * @param refspec - `<source>:<destination>`.
   * @returns the outcome; standard error holds git's rejection lines.
   */
  readonly push: (remote: string, refspec: string) => ProcessRun
}

/**
 * The batch's process ports over one process starter.
 * @param exec - starts a process; {@link spawnExec} in use.
 * @param root - the repository root every process runs in.
 * @param env - the integrator's environment, which {@link childEnvironment} filters.
 * @returns the ports.
 */
export function processPorts(exec: Exec, root: string, env: NodeJS.ProcessEnv): Ports {
  const inherited = childEnvironment(env)
  const gated: Exec = (command, args, options) => {
    assertGated(args, options.env)
    return exec(command, args, options)
  }
  return {
    git: args => gated('git', args, { cwd: root, env: inherited, output: 'capture' }),
    checks: args => gated(TSX, [RUN_CHECKS, ...args], { cwd: root, env: inherited, output: 'show' }).status ?? 1,
    push: (remote, refspec) => gated('git', ['push', remote, refspec], { cwd: root, env: { ...inherited, DELO_TIER: 'merge' }, output: 'show' }),
  }
}

/** The output buffer of a captured process; a whole-range listing can be large. */
const MAX_BUFFER = 256 * 1024 * 1024

/**
 * Start a process with `spawnSync`. A shown process prints its standard output on the terminal and its captured standard
 * error after it ends.
 * @param command - the program.
 * @param args - its arguments.
 * @param options - where and how it runs.
 * @returns the outcome.
 * @throws Error when the program cannot be started.
 */
export const spawnExec: Exec = (command, args, options) => {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: options.output === 'show' ? ['ignore', 'inherit', 'pipe'] : 'pipe',
  })
  if (result.error !== undefined) throw result.error
  if (options.output === 'capture') return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  // The shown stream is inherited, so spawnSync returns no standard output for it.
  process.stderr.write(result.stderr)
  return { status: result.status, stdout: '', stderr: result.stderr }
}
