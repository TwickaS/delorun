/**
 * Fixtures for the changelog specs: temporary git repositories whose history stays inside them, and the changelog
 * entry points run as child processes with a repository as their working directory, as the gate runner and the
 * release manager run them.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TestContext } from 'vitest'

/** The repository root, five directories above this file. */
export const REPO = fileURLToPath(new URL('../../../../../', import.meta.url))

/** The local `tsx` binary that runs the TypeScript entry points. */
const TSX = join(REPO, 'node_modules/.bin/tsx')

/** The changelog gate's entry point. */
export const CHECK = join(REPO, 'delo/apps/release/src/changelog/check.ts')

/** The release-notes assembly's entry point. */
export const ASSEMBLE = join(REPO, 'delo/apps/release/src/changelog/assemble.ts')

/** A temporary repository and the helpers that write and commit to it. */
export interface Scratch {
  /** The repository's top-level directory. */
  readonly root: string
  /** Run git in the repository and return its standard output, trimmed. */
  readonly run: (args: readonly string[]) => string
  /** Write files, commit everything with a message, and return the new commit id. */
  readonly commit: (files: Record<string, string>, message?: string) => string
  /** Write files without committing them. */
  readonly write: (files: Record<string, string>) => void
}

/**
 * A temporary repository with a fixed identity and no global or system git configuration, removed when the test ends.
 * @param test - the running test, whose teardown removes the repository.
 * @returns the repository and its helpers.
 */
export function scratchRepo(test: TestContext): Scratch {
  const root = mkdtempSync(join(tmpdir(), 'delo-changelog-'))
  test.onTestFinished(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture Author',
    GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture Author',
    GIT_COMMITTER_EMAIL: 'fixture@example.test',
  }
  const run = (args: readonly string[]): string => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim()
  const write = (files: Record<string, string>): void => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), text)
    }
  }
  const commit = (files: Record<string, string>, message = 'fixture'): string => {
    write(files)
    run(['add', '-A'])
    run(['commit', '-q', '--allow-empty', '-m', message])
    return run(['rev-parse', 'HEAD'])
  }
  run(['init', '-q', '-b', 'main'])
  return { root, run, commit, write }
}

/**
 * Run a changelog entry point with `tsx` in a directory.
 * @param cwd - the directory to run in: the fixture repository.
 * @param script - the absolute path of the entry point.
 * @param args - the command-line arguments.
 * @returns the exit status and the combined standard output and error.
 */
export function runTsx(cwd: string, script: string, args: readonly string[]): { status: number; output: string } {
  const result = spawnSync(TSX, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' },
  })
  return { status: result.status ?? 1, output: `${result.stdout}${result.stderr}` }
}
