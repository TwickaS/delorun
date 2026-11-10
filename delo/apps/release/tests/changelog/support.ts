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

/** The folder of unreleased fragments. */
export const UNRELEASED = 'delo/changelog/unreleased/'

/** The folder of pending fragments. */
export const PENDING_DIR = 'delo/changelog/pending/'

/** A commit message trailer that satisfies the sign-off rule of the fixture history. */
export const SIGNED = 'Signed-off-by: Fixture Author <fixture@example.test>'

/** The divergence ledger the assembly reads for the upstream release. */
export const LEDGER = JSON.stringify({
  upstream: { repository: 'https://example.invalid/upstream.git', ref: 'dsh-v0.2.2-rc.1', commit: 'a'.repeat(40) },
  forkOwned: ['delo/'],
  patches: [],
  retired: [],
})

/**
 * A fragment file's text.
 * @param area - the area the front matter names.
 * @param section - the section the front matter names.
 * @param bullets - the bullet texts of the body.
 * @param extra - further front matter lines, such as `waits: the update command`.
 * @returns the file text.
 */
export function fragmentText(area: string, section: string, bullets: readonly string[], extra: readonly string[] = []): string {
  return `---\narea: ${area}\nsection: ${section}\n${extra.map(line => `${line}\n`).join('')}---\n\n${bullets.map(bullet => `- ${bullet}`).join('\n')}\n`
}

/** Captured command output. */
export interface Captured {
  /** Lines printed to standard output. */
  readonly out: string[]
  /** Lines printed to standard error. */
  readonly err: string[]
  /** The two streams' lines, standard output first. */
  readonly all: () => string
}

/**
 * An output sink that keeps what the command prints.
 * @returns the captured lines and the sink to pass to the command.
 */
export function capture(): Captured & { readonly sink: { readonly log: (line: string) => void, readonly error: (line: string) => void } } {
  const out: string[] = []
  const err: string[] = []
  return { out, err, all: () => [...out, ...err].join('\n'), sink: { log: line => out.push(line), error: line => err.push(line) } }
}
