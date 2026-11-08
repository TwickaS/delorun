/**
 * Fixtures for the upstream update path: an upstream repository with the pinned tag `v1` and a later tag `v2`, and a
 * fork whose ledger pins `v1`, lists the fork's edits and records the digest of each one, so no spec reaches the
 * network. A fixture can merge `v2` into the fork, which is the state `--write` records.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'vitest'
import type { Patch, PatchManifest } from '../../src/fork-boundary.ts'
import { patchDigest } from '../../src/ledger-digests.ts'
import { REPO, runTsx, scratchRepo, type Scratch } from '../gates/support.ts'

/** The command under test. */
export const UPDATE = join(REPO, 'delo/apps/tools/src/upstream-update.ts')

/** The ledger gate, run over a fixture to show that the carried ledger holds. */
export const BOUNDARY = join(REPO, 'delo/apps/tools/src/check-fork-boundary.ts')

/** Each run starts tsx and builds a worktree, so a spec that runs the command needs more than the default timeout. */
export const PROCESS_TIMEOUT_MS = 60_000

/** The prefix of the temporary directory that holds the scratch worktree. */
const SCRATCH_PREFIX = 'delo-update-'

/** The files of each side of a fixture. */
export interface UpdateFiles {
  /** Upstream's files at `v1`, the pin. */
  readonly base: Record<string, string>
  /** Upstream's changes from `v1` to `v2`. */
  readonly tag: Record<string, string>
  /** The fork's edits on top of `v1`. */
  readonly fork: Record<string, string>
  /** The fork ledger's patches. */
  readonly patches: readonly Patch[]
}

/** How a fixture departs from a coherent, recorded, unmerged patch set. */
export interface UpdateOptions {
  /** Record each patch's digest in the ledger; default true. */
  readonly record?: boolean
  /** Merge `v2` into the fork, the state `--write` records. */
  readonly merge?: boolean
  /** The tag the ledger pins, when a spec needs it to disagree with the clone. */
  readonly ref?: string
  /** The commit the ledger records for the pin, when a spec needs it to disagree with the tag. */
  readonly commit?: string
  /**
   * Run in the fork after its edits and ledger are committed and before `v2` is merged, for a spec that needs history
   * between the two: a ledger entry dropped, a file deleted, a patch edited after it was recorded, or a merge resolved
   * in the release's favour. It may commit, and it may merge `v2` itself, in which case the fixture's own merge finds
   * the release already in `HEAD`.
   */
  readonly between?: (fork: Scratch) => void
}

/** A fixture's repositories and the pin they were built from. */
export interface UpdateFixture {
  /** The upstream repository, with tags `v1` and `v2`. */
  readonly upstream: Scratch
  /** The fork, on `main` at a commit that holds its edits and its ledger on top of `v1`. */
  readonly fork: Scratch
  /** The directory the command's temporary files go to, its `TMPDIR`. */
  readonly temp: string
  /** The commit `v1` names. */
  readonly pin: string
  /** The commit `v2` names. */
  readonly target: string
}

/**
 * Build an upstream repository and a fork of it.
 * @param test - the running test, whose teardown removes both repositories and the temporary directory.
 * @param files - the files of each side and the fork's patches.
 * @param options - how the fixture departs from a coherent, recorded, unmerged patch set.
 * @returns the fixture.
 */
export function updateFixture(test: TestContext, files: UpdateFiles, options: UpdateOptions = {}): UpdateFixture {
  const upstream = scratchRepo(test)
  const pin = upstream.commit(files.base)
  upstream.run(['tag', 'v1'])
  const target = upstream.commit(files.tag)
  upstream.run(['tag', '-a', 'v2', '-m', 'v2'])
  const fork = scratchRepo(test)
  fork.run(['fetch', '-q', '--no-tags', upstream.root, 'refs/tags/v1:refs/tags/v1'])
  fork.run(['reset', '-q', '--hard', 'FETCH_HEAD'])
  // The release tag is in the clone before the update path runs; fetching it is the owner-approved release merge's step.
  fork.run(['fetch', '-q', '--no-tags', upstream.root, 'refs/tags/v2:refs/tags/v2'])
  fork.commit(files.fork)
  const patches = files.patches.map(patch => options.record === false
    ? patch
    : { ...patch, sha256: patchDigest(readFileSync(join(fork.root, patch.path))) })
  const ledger = {
    upstream: { repository: upstream.root, ref: options.ref ?? 'v1', commit: options.commit ?? pin },
    forkOwned: ['delo/'],
    patches,
    retired: [],
  }
  fork.commit({ 'delo/upstream-patches.json': `${JSON.stringify(ledger, null, 2)}\n` })
  options.between?.(fork)
  if (options.merge === true) fork.run(['merge', '-q', '--no-ff', '-m', 'release v2', 'v2'])
  const temp = mkdtempSync(join(tmpdir(), 'delo-update-spec-'))
  test.onTestFinished(() => rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  return { upstream, fork, temp, pin, target }
}

/**
 * Run the command in the fork with its temporary files kept in the fixture's directory.
 * @param fixture - the fixture.
 * @param args - the command-line arguments.
 * @returns the exit status and the combined output.
 */
export function runUpdate(fixture: UpdateFixture, args: readonly string[]): { status: number; output: string } {
  return runTsx(fixture.fork.root, UPDATE, args, { TMPDIR: fixture.temp })
}

/**
 * Run the ledger gate in the fork, as a reviewer would after the update path wrote the ledger.
 * @param fixture - the fixture.
 * @returns the exit status and the combined output.
 */
export function checkBoundary(fixture: UpdateFixture): { status: number; output: string } {
  return runTsx(fixture.fork.root, BOUNDARY, [])
}

/**
 * The fork's ledger, as the file on disk holds it.
 * @param fixture - the fixture.
 * @returns the parsed ledger.
 */
export function ledgerOf(fixture: UpdateFixture): PatchManifest {
  return JSON.parse(readFileSync(join(fixture.fork.root, 'delo/upstream-patches.json'), 'utf8')) as PatchManifest
}

/**
 * The scratch directories a run left in the fixture's temporary directory.
 * @param fixture - the fixture.
 * @returns the names of the leftover directories; empty after every run.
 */
export function leftoverScratch(fixture: UpdateFixture): string[] {
  return readdirSync(fixture.temp).filter(name => name.startsWith(SCRATCH_PREFIX))
}
