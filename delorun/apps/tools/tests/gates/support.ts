/**
 * Fixtures for the gate specs: temporary git repositories whose history stays inside them, and the gate scripts run as
 * child processes with a repository as their working directory, as the runner runs them.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TestContext } from 'vitest'

/** The repository root, five directories above this file. */
export const REPO = fileURLToPath(new URL('../../../../../', import.meta.url))

const TSX = join(REPO, 'node_modules/.bin/tsx')

/** A temporary repository and the helpers that write and commit to it. */
export interface Scratch {
  /** The repository's top-level directory. */
  readonly root: string
  /** Run git in the repository and return its standard output, trimmed. */
  readonly run: (args: readonly string[]) => string
  /** Write files, commit everything, and return the new commit id. */
  readonly commit: (files: Record<string, string>) => string
  /** Write files without committing them. */
  readonly write: (files: Record<string, string>) => void
}

/**
 * A temporary repository with its own identity and no global or system git configuration, removed when the test ends.
 * @param test - the running test, whose teardown removes the repository.
 * @returns the repository and its helpers.
 */
export function scratchRepo(test: TestContext): Scratch {
  const root = mkdtempSync(join(tmpdir(), 'delorun-gate-'))
  test.onTestFinished(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const env = gitEnv()
  const run = (args: readonly string[]): string => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 30_000 }).trim()
  const write = (files: Record<string, string>): void => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), text)
    }
  }
  const commit = (files: Record<string, string>): string => {
    write(files)
    run(['add', '-A'])
    run(['commit', '-q', '--allow-empty', '-m', 'fixture'])
    return run(['rev-parse', 'HEAD'])
  }
  run(['init', '-q', '-b', 'main'])
  return { root, run, commit, write }
}

/**
 * The environment for git in a fixture: a fixed identity, and no configuration from the user or the system.
 * @returns the child-process environment, without inherited GIT_ variables.
 */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture Author',
    GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture Author',
    GIT_COMMITTER_EMAIL: 'fixture@example.test',
  }
}

/**
 * The text of a divergence ledger pinned to one commit, with no patches.
 * @param commit - the pinned upstream commit.
 * @returns the ledger's JSON text.
 */
export function ledgerText(commit: string): string {
  return JSON.stringify({
    upstream: { repository: 'https://example.invalid/upstream.git', ref: 'v1', commit },
    forkOwned: ['delorun/'],
    patches: [],
    retired: [],
  }, null, 2)
}

/**
 * A scratch repository whose first commit is the upstream base and whose second commit holds a divergence ledger
 * pinned to that base, the state the content-scanning gates read.
 * @param test - the running test.
 * @returns the repository and the base commit.
 */
export function ledgerRepo(test: TestContext): { repo: Scratch; base: string } {
  const repo = scratchRepo(test)
  const base = repo.commit({ 'upstream.ts': 'export const upstream = 1\n' })
  repo.commit({ 'delorun/upstream-patches.json': ledgerText(base) })
  return { repo, base }
}

/**
 * The absolute path of one gate module.
 * @param name - the module's name without its extension, such as `dco`.
 * @returns the path under `delorun/apps/tools/src/checks/gates`.
 */
export function gatePath(name: string): string {
  return join(REPO, 'delorun/apps/tools/src/checks/gates', `${name}.ts`)
}

/**
 * Run one TypeScript entry point with `tsx` in a directory, as the runner runs a gate from the repository root.
 * @param cwd - the directory to run in, a repository for the gates that read git history.
 * @param script - the absolute path of the entry point.
 * @param args - the command-line arguments.
 * @param env - variables added to the inherited environment.
 * @returns the exit status and the combined standard output and error.
 */
export function runTsx(cwd: string, script: string, args: readonly string[] = [], env: Record<string, string> = {}): { status: number; output: string } {
  const result = spawnSync(TSX, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', ...env },
    timeout: 50_000,
  })
  if (result.status === null) throw new Error(`tsx ${script} ended by signal ${String(result.signal)}: ${result.stderr}`)
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}
