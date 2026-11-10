/**
 * Fixtures for the batch specs: a temporary bare remote with a clone that serves as the integrator worktree, lane
 * branches, a stand-in check runner that fails chosen checks for chosen file contents, and a stand-in pre-push hook that
 * runs the same rules before a real push to the bare remote. No real check runner or remote is involved.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { REPORT_PATH } from '../../src/batch/logs.ts'
import type { PlanSource } from '../../src/batch/plan-source.ts'
import { processPorts, spawnExec, TSX, type Exec, type ProcessRun } from '../../src/batch/process.ts'
import { nodeFiles } from '../../src/batch/state.ts'
import type { BatchDeps } from '../../src/batch/batch.ts'

const temporary: string[] = []

/**
 * A fresh temporary directory, removed by {@link cleanUp}.
 * @param prefix - the directory name's prefix.
 * @returns the directory.
 */
export function tempDir(prefix: string): string {
  // Memory-backed where the host has it: the specs' many small git writes stall on a busy disk.
  const dir = mkdtempSync(join(existsSync('/dev/shm') ? '/dev/shm' : tmpdir(), prefix))
  temporary.push(dir)
  return dir
}

/** Remove every temporary directory the fixtures made. */
export function cleanUp(): void {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/**
 * The environment the fixtures' git runs in: no repository variables, no system or user configuration, no runner overrides.
 * @returns a new environment.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') && !name.startsWith('DELO_')))
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
}

/**
 * Run git in a directory.
 * @param cwd - the directory.
 * @param args - git's arguments.
 * @param env - extra variables, such as an author.
 * @returns standard output.
 */
export function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', [...args], { cwd, env: { ...gitEnv(), ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** One commit of a lane. */
export interface CommitSpec {
  readonly files: Readonly<Record<string, string>>
  readonly message: string
  readonly author?: string
}

/** A bare remote and an integrator clone on `v5`. */
export interface Sandbox {
  readonly remote: string
  readonly root: string
  /**
   * Write files in the integrator clone.
   * @param files - contents by repository-relative path.
   */
  write(files: Readonly<Record<string, string>>): void
  /**
   * Create a lane branch from a start point, one commit per entry.
   * @param name - the branch.
   * @param commits - the commits.
   * @param from - the start point.
   * @returns the lane's tip.
   */
  lane(name: string, commits: readonly CommitSpec[], from?: string): string
  /**
   * Move the remote trunk from a second clone, as another integrator would.
   * @param files - the files the commit writes.
   * @returns the new trunk commit.
   */
  moveTrunk(files: Readonly<Record<string, string>>): string
  /**
   * The remote trunk's commit.
   * @returns its id.
   */
  trunk(): string
}

/**
 * The `git clone` options that give a clone an identity, no hooks and no signing.
 * @param hooks - an empty hooks directory.
 * @returns the options.
 */
function cloneConfig(hooks: string): string[] {
  return ['-c', 'user.name=Integrator', '-c', 'user.email=integrator@example.com', '-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgsign=false']
}

/**
 * A bare remote whose `v5` holds two Delo apps and a shared file, and an integrator clone on `v5`.
 * @returns the sandbox.
 */
export function makeSandbox(): Sandbox {
  const base = tempDir('delo-batch-')
  const remote = join(base, 'remote.git')
  const root = join(base, 'integrator')
  const hooks = join(base, 'hooks')
  mkdirSync(hooks)
  git(base, ['init', '-q', '--bare', '-b', 'v5', remote])
  git(base, ['clone', '-q', ...cloneConfig(hooks), remote, root])
  git(root, ['checkout', '-q', '-b', 'v5'])
  const write = (dir: string, files: Readonly<Record<string, string>>): void => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
  }
  write(root, { '.gitignore': 'node_modules/\n', 'delo/apps/a/src/a.ts': 'a\n', 'delo/apps/b/src/b.ts': 'b\n', 'shared.txt': 'one\ntwo\nthree\n' })
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'chore: the trunk'])
  git(root, ['push', '-q', 'origin', 'v5'])
  let others = 0
  return {
    remote,
    root,
    write: files => { write(root, files) },
    lane: (name, commits, from = 'origin/v5') => {
      git(root, ['checkout', '-q', '-b', name, from])
      for (const commit of commits) {
        write(root, commit.files)
        git(root, ['add', '-A'])
        const author = commit.author ?? 'Lane Author'
        git(root, ['commit', '-q', '-m', commit.message], { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: 'lane@example.com', GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z' })
      }
      const tip = git(root, ['rev-parse', 'HEAD']).trim()
      git(root, ['checkout', '-q', 'v5'])
      return tip
    },
    moveTrunk: files => {
      others += 1
      const other = join(base, `other-${String(others)}`)
      git(base, ['clone', '-q', ...cloneConfig(hooks), '-b', 'v5', remote, other])
      write(other, files)
      git(other, ['add', '-A'])
      git(other, ['commit', '-q', '-m', 'chore: elsewhere'])
      git(other, ['push', '-q', 'origin', 'v5'])
      return git(other, ['rev-parse', 'HEAD']).trim()
    },
    trunk: () => git(remote, ['rev-parse', 'v5']).trim(),
  }
}

/** A check the stand-in runner knows: it fails when `fails` says so for the worktree's files. */
export interface Rule {
  readonly check: string
  /**
   * Whether the check fails.
   * @param read - reads a worktree file; undefined when it does not exist.
   * @returns true to fail.
   */
  readonly fails: (read: (path: string) => string | undefined) => boolean
  /** The log a failure writes, or a function that writes it from the worktree's state. */
  readonly log?: string | (() => string)
}

/** One process the batch started. */
export interface Call {
  readonly command: string
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
}

/** The stand-in process starter and what it saw. */
export interface Fake {
  readonly exec: Exec
  readonly calls: Call[]
  /** The check runner's arguments, one entry per run. */
  readonly runs: (readonly string[])[]
  /** How many pushes reached the stand-in hook. */
  pushes: number
}

/** Options of the stand-in runner. */
export interface FakeOptions {
  /** Throw from the n-th check-runner run (1-based), as an interruption would stop the batch. */
  readonly interruptAt?: number
  /** Fail every push before the hook writes a report, with this standard error. */
  readonly pushError?: string
  /** Leave no report behind a failing check-runner run. */
  readonly noReport?: boolean
  /** Report these checks declined, with their reasons. */
  readonly declined?: readonly { readonly check: string, readonly reason: string | null }[]
  /** Runs before each push reaches the stand-in hook, such as another integrator moving the trunk. */
  readonly beforePush?: () => void
  /** Throw after this git invocation ran, as an interruption in the middle of a step would. */
  readonly interruptAfterGit?: (args: readonly string[]) => boolean
}

/**
 * A process starter that runs git for real and stands in for the check runner and the pre-push hook.
 * @param root - the integrator worktree.
 * @param rules - the checks and when they fail.
 * @param options - interruptions and failures to simulate.
 * @returns the starter and its record.
 */
export function fakeExec(root: string, rules: readonly Rule[], options: FakeOptions = {}): Fake {
  const read = (path: string): string | undefined => existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : undefined
  const evaluate = (ids: readonly string[]): number => {
    const chosen = rules.filter(rule => ids.length === 0 || ids.includes(rule.check))
    const logDir = join(root, 'node_modules/.cache/delo-checks/logs')
    mkdirSync(logDir, { recursive: true })
    const checks = chosen.map(rule => {
      const failed = rule.fails(read)
      const logPath = `node_modules/.cache/delo-checks/logs/${rule.check}.log`
      const log = typeof rule.log === 'function' ? rule.log() : rule.log
      writeFileSync(join(root, logPath), failed ? log ?? `Error: ${rule.check} failed\n` : 'ok\n')
      return { check: rule.check, status: failed ? 'failed' : 'passed', reason: failed ? 'exit 1' : null, logPath }
    })
    const declined = (options.declined ?? []).map(({ check, reason }) => ({ check, status: 'declined', reason, logPath: null }))
    const failed = checks.some(check => check.status === 'failed') || declined.length > 0
    if (!(failed && options.noReport === true)) writeFileSync(join(root, REPORT_PATH), JSON.stringify({ checks: [...checks, ...declined] }))
    return failed ? 1 : 0
  }
  const fake: Fake = {
    calls: [],
    runs: [],
    pushes: 0,
    exec: (command, args, execOptions): ProcessRun => {
      fake.calls.push({ command, args: [...args], env: { ...execOptions.env } })
      if (command === TSX) {
        fake.runs.push(args.slice(1))
        if (fake.runs.length === options.interruptAt) throw new Error('interrupted')
        const at = args.indexOf('--only')
        const status = evaluate(at < 0 ? [] : (args[at + 1] ?? '').split(','))
        return { status, stdout: '', stderr: '' }
      }
      if (command === 'git' && args[0] === 'push') {
        fake.pushes += 1
        options.beforePush?.()
        if (options.pushError !== undefined) return { status: 1, stdout: '', stderr: options.pushError }
        if (evaluate([]) !== 0) return { status: 1, stdout: '', stderr: 'error: failed to push some refs to the remote\n' }
      }
      const run = spawnExec(command, args, { ...execOptions, output: 'capture' })
      if (command === 'git' && options.interruptAfterGit?.(args) === true) throw new Error('interrupted')
      return run
    },
  }
  return fake
}

/**
 * The stand-in selection: the gates for every change, `tests:fork` over the Delo apps a change touches, and
 * `typecheck:delo:<app>` per app.
 */
export const fakePlan: PlanSource = {
  select: paths => {
    const apps = [...new Set(paths.flatMap(path => /^delo\/apps\/[^/]+/.exec(path)?.[0] ?? []))]
    return [
      { id: 'gates:dco' },
      { id: 'gates:commits' },
      ...apps.length === 0 ? [] : [{ id: 'tests:fork', scope: apps.map(app => `${app}/`) }],
      ...apps.map(app => ({ id: `typecheck:delo:${app.split('/').at(-1) ?? ''}` })),
      ...paths.includes('shared.txt') ? [{ id: 'shared' }] : [],
    ]
  },
  packageOf: path => /^delo\/apps\/[^/]+/.exec(path)?.[0],
}

/**
 * The batch's side effects over a sandbox and a stand-in starter.
 * @param root - the integrator worktree.
 * @param fake - the stand-in starter.
 * @param said - collects the progress lines.
 * @param second - the second of the clock's first reading.
 * @returns the side effects.
 */
export function depsFor(root: string, fake: Fake, said: string[] = [], second = 0): BatchDeps {
  let seconds = second
  return {
    root,
    ports: processPorts(fake.exec, root, gitEnv()),
    files: nodeFiles,
    planSource: () => fakePlan,
    now: () => new Date(Date.UTC(2026, 10, 10, 12, 0, seconds++)),
    say: line => { said.push(line) },
  }
}

/**
 * The directory a batch's state and reports live in.
 * @param root - the integrator worktree.
 * @param id - the batch id.
 * @returns the directory.
 */
export function batchDirOf(root: string, id: string): string {
  return join(root, '.git', 'delo-batch', id)
}
