/**
 * The source checks signing runs before anything else reads the release's commit: the release tag is an annotated tag
 * for its own name, signed with an SSH key the committed allowed-signers file (`delo/release/allowed-signers`, git's
 * `gpg.ssh.allowedSignersFile` format) lists, and the commit it names is on the release branch. Each check runs git
 * without a shell and with a timeout, and returns the problem it found as text, or `undefined`.
 *
 * @module @delo/release/sign/source
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The allowed-signers file's path below the repository root. */
export const ALLOWED_SIGNERS_PATH = join('delo', 'release', 'allowed-signers')

/** The release branch a release commit must be on, unless the signer names another. */
export const DEFAULT_RELEASE_BRANCH = 'origin/v5'

/** How long one git invocation may run. */
const GIT_TIMEOUT_MS = 30_000

/** The armour line that starts an SSH signature in a tag object. */
const SSH_SIGNATURE = '-----BEGIN SSH SIGNATURE-----'

/** One finished git invocation. */
interface GitResult {
  /** The exit status; `null` when git did not exit on its own, as after the timeout. */
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Run git in a repository without a shell, with {@link GIT_TIMEOUT_MS}.
 * @param repository - the repository.
 * @param args - git's arguments.
 * @returns the exit status and both output streams.
 * @throws Error when git cannot be started.
 */
function git(repository: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: repository, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ status: 0, stdout, stderr })
        return
      }
      if (typeof error.code === 'string') {
        reject(error)
        return
      }
      resolve({ status: typeof error.code === 'number' ? error.code : null, stdout, stderr })
    })
  })
}

/**
 * The first lines of git's error output, on one line.
 * @param result - the invocation.
 * @returns the text, or the exit status when git wrote nothing.
 */
function gitError(result: GitResult): string {
  const text = result.stderr.trim().split('\n').slice(0, 3).join('; ')
  return text === '' ? `git ended with status ${String(result.status)}` : text
}

/**
 * The number of signer lines in an allowed-signers file: lines that are neither blank nor `#` comments.
 * @param text - the file's text.
 * @returns the count.
 */
export function signerLines(text: string): number {
  return text.split('\n').filter(line => line.trim() !== '' && !line.trim().startsWith('#')).length
}

/**
 * Check that a release tag is an annotated tag for its own name, naming a commit, signed with an SSH key that the
 * allowed-signers file lists for the `git` namespace. Verification is git's `verify-tag` with `gpg.format=ssh`,
 * `gpg.ssh.program=ssh-keygen` and the given file, so neither an OpenPGP signature nor a configured signing program
 * takes part.
 * @param repository - the repository holding the tag.
 * @param tag - the tag's name, such as `v0.1.0`.
 * @param allowedSigners - the allowed-signers file.
 * @returns the problem, or `undefined` when the signature verifies.
 * @throws Error when git cannot be started.
 */
export async function tagSignatureProblem(repository: string, tag: string, allowedSigners: string): Promise<string | undefined> {
  let signers: string
  try {
    signers = await readFile(allowedSigners, 'utf8')
  } catch (error) {
    return `the allowed-signers file ${allowedSigners} does not read: ${(error as Error).message}`
  }
  if (signerLines(signers) === 0) return `the allowed-signers file ${allowedSigners} lists no signer key, so no release tag verifies; the owner adds each release signer's SSH signing key to it`
  const ref = `refs/tags/${tag}`
  const kind = await git(repository, ['cat-file', '-t', ref])
  if (kind.status !== 0) return `the tag ${tag} does not exist in ${repository}: ${gitError(kind)}`
  if (kind.stdout.trim() !== 'tag') return `the tag ${tag} is a lightweight tag, which carries no signature; a release tag is an annotated tag signed with an SSH key the allowed-signers file lists`
  const object = await git(repository, ['cat-file', 'tag', ref])
  if (object.status !== 0) return `the tag ${tag} does not read: ${gitError(object)}`
  const [header = '', body = ''] = object.stdout.split(/\n\n(.*)/su)
  const fields = new Map(header.split('\n').map(line => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]))
  if (fields.get('type') !== 'commit') return `the tag ${tag} names a ${fields.get('type') ?? 'missing'} object, not a commit`
  if (fields.get('tag') !== tag) return `the tag object at ${ref} was made for the tag ${JSON.stringify(fields.get('tag') ?? '')}, not ${tag}`
  if (!body.includes(SSH_SIGNATURE)) return `the tag ${tag} carries no SSH signature; a release tag is signed with an SSH key the allowed-signers file lists`
  const verified = await git(repository, ['-c', 'gpg.format=ssh', '-c', 'gpg.ssh.program=ssh-keygen', '-c', `gpg.ssh.allowedSignersFile=${allowedSigners}`, 'verify-tag', ref])
  if (verified.status !== 0) return `the signature of tag ${tag} does not verify with a key the allowed-signers file ${allowedSigners} lists: ${gitError(verified)}`
  return undefined
}

/**
 * Check that a commit is on the release branch: the commit is the branch's tip or one of its ancestors.
 * @param repository - the repository.
 * @param commit - the release commit.
 * @param branch - the release branch, such as {@link DEFAULT_RELEASE_BRANCH}.
 * @returns the problem, or `undefined` when the commit is on the branch.
 * @throws Error when git cannot be started.
 */
export async function releaseBranchProblem(repository: string, commit: string, branch: string): Promise<string | undefined> {
  if (branch.startsWith('-')) return `the release branch ${JSON.stringify(branch)} is not a branch name`
  const tip = await git(repository, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`])
  if (tip.status !== 0) return `the release branch ${branch} names no commit in ${repository}; fetch it before signing`
  const ancestor = await git(repository, ['merge-base', '--is-ancestor', commit, tip.stdout.trim()])
  if (ancestor.status === 1) return `the release commit ${commit} is not on the release branch ${branch}`
  if (ancestor.status !== 0) return `git cannot tell whether the release commit ${commit} is on the release branch ${branch}: ${gitError(ancestor)}`
  return undefined
}
