/**
 * Fixture builders for the rehearsal specs: an upstream repository with a pinned tag `v1` and a later annotated tag
 * `v2`, and a fork built on `v1` whose ledger names the upstream repository by its local path, so no spec reaches the
 * network.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'vitest'
import type { Patch, PathRule } from '../../src/fork-boundary.ts'
import { REPO, runTsx, scratchRepo, type Scratch } from '../gates/support.ts'

/** The command under test. */
export const REHEARSE = join(REPO, 'delo/apps/tools/src/rehearse-upstream.ts')

/** Each run starts tsx and builds a worktree, so a spec that runs the command needs more than the default timeout. */
export const PROCESS_TIMEOUT_MS = 60_000

/** The prefix of the temporary directory that holds the scratch worktree. */
const SCRATCH_PREFIX = 'delo-rehearse-'

/**
 * A text file of numbered lines, with some lines replaced.
 * @param count - the number of lines.
 * @param edits - replacement text by one-based line number.
 * @returns the file's text with a final newline.
 */
export function lines(count: number, edits: Readonly<Record<number, string>> = {}): string {
  return `${Array.from({ length: count }, (_, index) => edits[index + 1] ?? `line ${String(index + 1)}`).join('\n')}\n`
}

/**
 * Replacement text for every given line number.
 * @param numbers - one-based line numbers.
 * @param label - the text each replaced line starts with.
 * @returns the edits for {@link lines}.
 */
export function editsAt(numbers: readonly number[], label: string): Record<number, string> {
  return Object.fromEntries(numbers.map(number => [number, `${label} ${String(number)}`]))
}

/** The repositories of one rehearsal fixture. */
export interface RehearsalFixture {
  /** The upstream repository, with tags `v1` and `v2`. */
  readonly upstream: Scratch
  /** The fork, on `main` at a commit that holds its edits and its ledger on top of `v1`. */
  readonly fork: Scratch
  /** The directory the command's temporary files go to, its `TMPDIR`. */
  readonly temp: string
}

/** The files of each side of a fixture. */
export interface FixtureFiles {
  /** Upstream's files at `v1`, the pin. */
  readonly base: Record<string, string>
  /** Upstream's changes from `v1` to `v2`. */
  readonly tag: Record<string, string>
  /** The fork's edits on top of `v1`. */
  readonly fork: Record<string, string>
  /** The fork ledger's patches. */
  readonly patches: readonly Patch[]
  /** The fork ledger's path rules; none when absent. */
  readonly rules?: readonly PathRule[]
}

/**
 * Build an upstream repository and a fork of it.
 * @param test - the running test, whose teardown removes both repositories and the temporary directory.
 * @param files - the files of each side and the fork's patches.
 * @returns the fixture.
 */
export function rehearsalFixture(test: TestContext, files: FixtureFiles): RehearsalFixture {
  const upstream = scratchRepo(test)
  const pin = upstream.commit(files.base)
  upstream.run(['tag', 'v1'])
  upstream.commit(files.tag)
  upstream.run(['tag', '-a', 'v2', '-m', 'v2'])
  const fork = scratchRepo(test)
  fork.run(['fetch', '-q', '--no-tags', upstream.root, 'refs/tags/v1'])
  fork.run(['reset', '-q', '--hard', 'FETCH_HEAD'])
  const ledger = {
    upstream: { repository: upstream.root, ref: 'v1', commit: pin },
    forkOwned: ['delo/'],
    rules: files.rules ?? [],
    patches: files.patches,
    retired: [],
  }
  fork.commit({ ...files.fork, 'delo/upstream-patches.json': `${JSON.stringify(ledger, null, 2)}\n` })
  const temp = mkdtempSync(join(tmpdir(), 'delo-rehearse-spec-'))
  test.onTestFinished(() => rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  return { upstream, fork, temp }
}

/**
 * Run the command in the fork with its temporary files kept in the fixture's directory.
 * @param fixture - the fixture.
 * @param args - the command-line arguments.
 * @returns the exit status and the combined output.
 */
export function rehearseIn(fixture: RehearsalFixture, args: readonly string[]): { status: number; output: string } {
  return runTsx(fixture.fork.root, REHEARSE, args, { TMPDIR: fixture.temp })
}

/**
 * The state of the fork that a rehearsal must leave unchanged: its status, index, refs, `HEAD`, worktrees and
 * `FETCH_HEAD`.
 * @param fork - the fork repository.
 * @returns the state as one comparable record.
 */
export function checkoutState(fork: Scratch): Record<string, string> {
  return {
    status: fork.run(['status', '--porcelain', '--untracked-files=all']),
    index: fork.run(['ls-files', '--stage']),
    refs: fork.run(['for-each-ref']),
    head: fork.run(['rev-parse', 'HEAD']),
    worktrees: fork.run(['worktree', 'list', '--porcelain']),
    fetchHead: fork.run(['rev-parse', '--verify', '--quiet', 'FETCH_HEAD']),
  }
}

/**
 * The scratch directories a run left in the fixture's temporary directory.
 * @param fixture - the fixture.
 * @returns the names of the leftover directories; empty after every run.
 */
export function leftoverScratch(fixture: RehearsalFixture): string[] {
  return readdirSync(fixture.temp).filter(name => name.startsWith(SCRATCH_PREFIX))
}
