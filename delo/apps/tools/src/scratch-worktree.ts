/**
 * A throwaway git worktree for the ledger tools that need to run git over a tree other than the checkout's own: the
 * rehearsal merge and the upstream update path. The worktree lives in a temporary directory, is detached at a commit
 * the caller names, and is removed whatever the body does, so the checkout's refs, index and working tree stay
 * unchanged.
 *
 * @module @delo/tools/scratch-worktree
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, runGit } from './git.ts'

/** Git configuration for every command in a scratch worktree: no hooks, no recorded resolutions, plain markers. */
export const SCRATCH_CONFIG = ['-c', `core.hooksPath=${devNull}`, '-c', 'rerere.enabled=false', '-c', 'merge.conflictStyle=merge'] as const

/** An identity for commands git requires one for even though the scratch work never commits. */
export const SCRATCH_IDENTITY = ['-c', 'user.name=Delo scratch', '-c', 'user.email=scratch@delo.invalid'] as const

/**
 * Create a scratch worktree detached at a commit, run a body in it, and remove it whatever the outcome.
 * @param root - the checkout whose repository the worktree is added to.
 * @param head - the commit to detach at.
 * @param body - the work to run with the worktree's path.
 * @param prefix - the name prefix of the temporary directory, so a caller's residue stays identifiable.
 * @returns the body's result.
 * @throws the body's error, or an Error naming the leftover worktree when removal fails.
 */
export function withScratchWorktree<T>(root: string, head: string, body: (tree: string) => T, prefix = 'delo-scratch-'): T {
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
