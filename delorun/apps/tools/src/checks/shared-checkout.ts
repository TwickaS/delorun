/**
 * The shared checkout guard: a push from a linked worktree is refused while the clone's main worktree holds changes to
 * tracked content. `~/delorun/code` is one checkout that every session and every lane shares, and a lane's stray write
 * there once emptied `README.md` and broke four checks, which cost a twenty-minute push.
 *
 * The main worktree is the first entry of `git worktree list`, the one that owns the clone's git directory. A run inside
 * that worktree is the pusher's own tree, which the checks already measure, so it is never refused. Untracked files are
 * named in a note but do not refuse: they cannot change what a commit contains, and build residue such as a Python
 * bytecode cache would otherwise stop every push in the clone.
 *
 * The guard sits in the pre-push path of `run-checks.ts` beside the trunk-narrowing refusal, not in the gate catalogue,
 * because a gate can be left out with `DELORUN_PUSH_SKIP` and covered by a tree pass recorded before the shared
 * checkout was touched; a refusal before the plan can be neither skipped nor cached.
 *
 * Git exports `GIT_DIR` and `GIT_WORK_TREE` to a hook, so a plain `git status` in the shared checkout would read the
 * pushing worktree's index against the shared checkout's tree and report the pusher's own files as the shared tree's
 * changes. Every read here therefore runs git with those variables removed, so it sees the shared checkout's own state.
 *
 * @module @delorun/tools/checks/shared-checkout
 */
import { resolve } from 'node:path'
import { git } from '../git.ts'

/** The variables git exports to a hook, which would point a read at the pushing worktree instead of the shared checkout. */
const HOOK_GIT_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR'] as const

/**
 * The environment for a git read of a worktree other than the one the process runs in.
 * @param env - the process's environment.
 * @returns the environment without the variables git exports to a hook.
 */
export function worktreeEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env }
  for (const name of HOOK_GIT_VARIABLES) delete clean[name]
  return clean
}

/** How many paths a refusal names before it counts the rest. */
const NAMED = 3

/** The changes one worktree holds: what differs from HEAD in tracked content, and what git does not track. */
export interface WorktreeDirt {
  /** The worktree's absolute path. */
  readonly path: string
  /** Paths whose tracked content differs from HEAD, staged or not, deletions included. */
  readonly tracked: readonly string[]
  /** Paths git does not track and does not ignore. */
  readonly untracked: readonly string[]
}

/**
 * The clone's main worktree: the first entry of `git worktree list`, which owns the git directory every worktree shares.
 * @param root - the repository root of any worktree of the clone.
 * @returns the absolute path, or undefined when git lists no worktree.
 */
export function mainWorktree(root: string): string | undefined {
  const first = git(root, ['worktree', 'list', '--porcelain'], worktreeEnvironment()).split('\n').find(line => line.startsWith('worktree '))
  return first === undefined ? undefined : first.slice('worktree '.length)
}

/**
 * The changes a worktree holds, from `git status --porcelain -z`.
 * @param path - the worktree's absolute path.
 * @returns the tracked and untracked paths.
 * @throws Error when git cannot read the worktree.
 */
export function worktreeDirt(path: string): WorktreeDirt {
  const entries = git(path, ['status', '--porcelain', '-z', '--untracked-files=all'], worktreeEnvironment()).split('\0').filter(entry => entry.length > 0)
  const tracked: string[] = []
  const untracked: string[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? ''
    const code = entry.slice(0, 2)
    const named = entry.slice(3)
    // A rename or a copy records the original path in the next field.
    if (code.startsWith('R') || code.startsWith('C')) index += 1
    if (code === '??') untracked.push(named)
    else tracked.push(named)
  }
  return { path, tracked, untracked }
}

/**
 * The dirt of the clone's main worktree, when the run happens in another worktree of the same clone.
 * @param root - the repository root of the worktree the run happens in.
 * @returns the main worktree's changes, or undefined when the run is inside it or the clone has no other worktree.
 * @throws Error when git cannot read the main worktree.
 */
export function sharedCheckoutDirt(root: string): WorktreeDirt | undefined {
  const main = mainWorktree(root)
  if (main === undefined || resolve(main) === resolve(root)) return undefined
  return worktreeDirt(main)
}

/**
 * The refusal for a push from a linked worktree while the shared checkout holds changes to tracked content.
 * @param root - the repository root of the worktree the push happens in.
 * @returns one actionable line naming the shared checkout and its changed paths, or undefined when it is clean.
 * @throws Error when git cannot read the main worktree.
 */
export function sharedCheckoutRefusal(root: string): string | undefined {
  const dirt = sharedCheckoutDirt(root)
  if (dirt === undefined || dirt.tracked.length === 0) return undefined
  const named = dirt.tracked.slice(0, NAMED).join(', ')
  const more = dirt.tracked.length > NAMED ? ` and ${String(dirt.tracked.length - NAMED)} more` : ''
  return `the shared checkout ${dirt.path} has uncommitted changes to ${named}${more}; commit or restore them there before pushing from ${root}, because every worktree of this clone reads that tree`
}

/**
 * The note for untracked files in the shared checkout, which do not refuse a push.
 * @param root - the repository root of the worktree the push happens in.
 * @returns one line naming the files, or undefined when there are none.
 * @throws Error when git cannot read the main worktree.
 */
export function sharedCheckoutNote(root: string): string | undefined {
  const dirt = sharedCheckoutDirt(root)
  if (dirt === undefined || dirt.untracked.length === 0) return undefined
  const named = dirt.untracked.slice(0, NAMED).join(', ')
  const more = dirt.untracked.length > NAMED ? ` and ${String(dirt.untracked.length - NAMED)} more` : ''
  return `the shared checkout ${dirt.path} holds untracked files (${named}${more}); they do not refuse this push, but a stray write there is what this guard exists to catch`
}
