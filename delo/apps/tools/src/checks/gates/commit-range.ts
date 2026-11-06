/**
 * The commits a push adds, read from git history for the range gates: the commits reachable from HEAD and
 * not from the base, with merge commits left out.
 *
 * @module @delo/tools/checks/gates/commit-range
 */
import { git } from '../../git.ts'

/** A name and email as a commit records them. */
export interface Identity {
  /** The name, exactly as the commit records it. */
  readonly name: string
  /** The email address, exactly as the commit records it. */
  readonly email: string
}

/** One commit of a range. */
export interface RangeCommit {
  /** The full commit id. */
  readonly sha: string
  /** The author recorded in the commit. */
  readonly author: Identity
  /** The committer recorded in the commit. */
  readonly committer: Identity
  /** The full commit message, including its trailers. */
  readonly message: string
  /** Paths the commit adds. */
  readonly added: readonly string[]
}

const FIELD_SEPARATOR = '\x1f'
const RECORD_END = '\x1e'

/**
 * Read the commits of a range, oldest first.
 * @param root - the repository root.
 * @param base - the revision the range starts after; it must be in the clone.
 * @returns the commits of `base..HEAD` that are not merges, with their identities, message and added paths.
 * @throws Error when git fails, for example when the base revision is not in the clone.
 */
export function rangeCommits(root: string, base: string): RangeCommit[] {
  const shas = git(root, ['rev-list', '--reverse', '--no-merges', `${base}..HEAD`]).split('\n').filter(line => line.length > 0)
  return shas.map((sha) => {
    const format = ['%an', '%ae', '%cn', '%ce', '%B'].join(FIELD_SEPARATOR) + RECORD_END
    const [name = '', email = '', committerName = '', committerEmail = '', message = ''] = git(root, ['log', '-1', `--format=${format}`, sha])
      .replace(new RegExp(`${RECORD_END}\\n?$`, 'u'), '')
      .split(FIELD_SEPARATOR)
    const added = git(root, ['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=A', '-r', sha])
      .split('\n')
      .filter(line => line.length > 0)
    return {
      sha,
      author: { name, email },
      committer: { name: committerName, email: committerEmail },
      message,
      added,
    }
  })
}
