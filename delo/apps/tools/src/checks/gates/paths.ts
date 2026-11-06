/**
 * Path selection and upstream line lookup for the gates that scan file contents: the paths the runner passed,
 * or every path that differs from the pinned upstream commit.
 *
 * @module @delo/tools/checks/gates/paths
 */
import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { changedSince, readManifest } from '../../check-fork-boundary.ts'
import { git, runGit } from '../../git.ts'

/** The paths one content-scanning gate reads, and the upstream commit whose lines they may hold. */
export interface ScanTarget {
  /** Repository-relative paths; the paths the runner passed, or every path that differs from upstream. */
  readonly paths: readonly string[]
  /** The commit pinned in the divergence ledger, against which a line counts as upstream's. */
  readonly upstreamCommit: string
}

/**
 * Select the paths a content-scanning gate reads.
 * @param root - the repository root.
 * @param given - the paths the runner passed at pre-commit; empty when the gate runs over the whole fork diff.
 * @returns the paths, without deleted ones when they come from the fork diff, and the pinned upstream commit.
 * @throws Error when the divergence ledger is missing or invalid, or its pinned commit is not in the clone.
 */
export function scanTarget(root: string, given: readonly string[]): ScanTarget {
  const { commit } = readManifest(root).upstream
  if (given.length > 0) return { paths: given, upstreamCommit: commit }
  const paths = changedSince(root, commit).filter(entry => entry.status !== 'deleted').map(entry => entry.path)
  return { paths, upstreamCommit: commit }
}

/**
 * Keep the paths that name a regular file. Directories, symbolic links and deleted paths are skipped, so a
 * symbolic link is read at its target's own path.
 * @param root - the repository root.
 * @param paths - repository-relative paths.
 * @returns the paths that name regular files.
 */
export function regularFiles(root: string, paths: readonly string[]): string[] {
  return paths.filter(path => existsSync(join(root, path)) && lstatSync(join(root, path)).isFile())
}

/**
 * The lines of one path's copy at the upstream commit, for exempting a line the fork did not add.
 * @param root - the repository root.
 * @param commit - the pinned upstream commit.
 * @param path - a repository-relative path.
 * @returns the set of the copy's lines, or undefined when upstream has no such path.
 */
export function upstreamLines(root: string, commit: string, path: string): ReadonlySet<string> | undefined {
  if (runGit(root, ['cat-file', '-e', `${commit}:${path}`]).status !== 0) return undefined
  return new Set(git(root, ['show', `${commit}:${path}`]).split('\n'))
}
