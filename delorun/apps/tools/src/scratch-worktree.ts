/**
 * A throwaway git worktree for the ledger tools that need to run git over a tree other than the checkout's own: the
 * rehearsal merge and the upstream update path. The worktree lives in a temporary directory, is detached at a commit
 * the caller names, and is removed whatever the body does, so the checkout's refs, index and working tree stay
 * unchanged.
 *
 * @module @delorun/tools/scratch-worktree
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { git, runGit } from './git.ts'

/** Git configuration for every command in a scratch worktree: no hooks, no recorded resolutions, plain markers. */
export const SCRATCH_CONFIG = ['-c', `core.hooksPath=${devNull}`, '-c', 'rerere.enabled=false', '-c', 'merge.conflictStyle=merge'] as const

/** An identity for commands git requires one for even though the scratch work never commits. */
export const SCRATCH_IDENTITY = ['-c', 'user.name=Delorun scratch', '-c', 'user.email=scratch@delorun.invalid'] as const

/**
 * Create a scratch worktree detached at a commit, run a body in it, and remove it whatever the outcome.
 * @param root - the checkout whose repository the worktree is added to.
 * @param head - the commit to detach at.
 * @param body - the work to run with the worktree's path.
 * @param prefix - the name prefix of the temporary directory, so a caller's residue stays identifiable.
 * @returns the body's result.
 * @throws the body's error, or an Error naming the leftover worktree when removal fails.
 */
export function withScratchWorktree<T>(root: string, head: string, body: (tree: string) => T, prefix = 'delorun-scratch-'): T {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  const tree = join(directory, 'tree')
  let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
  try {
    git(root, [...SCRATCH_CONFIG, 'worktree', 'add', '--detach', '--quiet', tree, head])
    outcome = { ok: true, value: body(tree) }
  } catch (error) {
    outcome = { ok: false, error }
  }
  const leftover = removeScratchWorktree(root, directory, tree)
  if (leftover !== undefined) throw new Error(outcome.ok ? leftover : `${errorText(outcome.error)}; ${leftover}`)
  if (!outcome.ok) throw outcome.error
  return outcome.value
}

/**
 * Remove the scratch worktrees a killed run left registered in the checkout. A run that is stopped between adding its
 * worktree and removing it cannot clean up after itself, and the registration it leaves behind belongs to a temporary
 * directory nobody will look at again; the next run sweeps it before adding one of its own. Only worktrees under the
 * system's temporary directory whose name carries the prefix are touched, so a worktree a person made is left alone.
 * @param root - the checkout the worktrees were added to.
 * @param prefix - the name prefix of the temporary directory, as {@link withScratchWorktree} was given it.
 * @returns the worktree directories that were swept; empty when the checkout holds none.
 * @throws Error when git fails or the registration survives the sweep.
 */
export function sweepScratchWorktrees(root: string, prefix: string): string[] {
  const temporary = join(realpathSync(tmpdir()), prefix)
  const leaked = git(root, ['worktree', 'list', '--porcelain', '-z']).split('\0')
    .filter(entry => entry.startsWith('worktree '))
    .map(entry => entry.slice('worktree '.length))
    .filter(tree => dirname(tree).startsWith(temporary))
  if (leaked.length === 0) return []
  // The directory goes first: prune drops a registration whose worktree is missing, and nothing else here is touched.
  for (const tree of leaked) rmSync(dirname(tree), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  git(root, ['worktree', 'prune'])
  const remaining = leaked.filter(tree => isRegisteredWorktree(root, tree))
  if (remaining.length > 0) throw new Error(`scratch worktrees ${remaining.join(', ')} are still registered; run \`git worktree prune\``)
  return leaked
}

/**
 * Remove a scratch worktree's registration and its temporary directory.
 * @param root - the checkout the worktree was added to.
 * @param directory - the temporary directory that holds the worktree.
 * @param tree - the worktree's path.
 * @returns a message when the registration remains, or undefined when the worktree is gone.
 */
function removeScratchWorktree(root: string, directory: string, tree: string): string | undefined {
  const removal = isRegisteredWorktree(root, tree) ? runGit(root, ['worktree', 'remove', '--force', tree]) : undefined
  rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  if (!isRegisteredWorktree(root, tree)) return undefined
  return `scratch worktree ${tree} is still registered (${removal?.stderr.trim() ?? 'not removed'}); run \`git worktree prune\``
}

/**
 * Whether a path is still one of the checkout's registered worktrees.
 * @param root - the checkout.
 * @param tree - the worktree's path.
 * @returns true when git still lists it.
 */
function isRegisteredWorktree(root: string, tree: string): boolean {
  return git(root, ['worktree', 'list', '--porcelain', '-z']).split('\0').includes(`worktree ${tree}`)
}

/**
 * The message of an error, whatever was thrown.
 * @param error - the caught value.
 * @returns the error's message, or its string form when it is not an Error.
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
