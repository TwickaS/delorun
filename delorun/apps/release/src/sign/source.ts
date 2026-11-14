/**
 * The source checks signing runs before anything else reads the release's commit: the release tag is an annotated tag
 * for its own name, signed with an SSH key the allowed-signers file (`delorun/release/allowed-signers`, git's
 * `gpg.ssh.allowedSignersFile` format) lists, and the commit it names is on the release branch; and the signing key is
 * one the production-keys registry (`delorun/release/production-keys.json`) lists. Both files are read as the release
 * branch commits them (`git show <branch>:<path>`), never from the working tree, so a file edited in the checkout
 * cannot add a signer or a key. Each check runs git without a shell and with a timeout, and returns the problem it
 * found as text, or `undefined`.
 *
 * @module @delorun/release/sign/source
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KeyId } from '@delorun/contract-release-manifest'
import { readProductionKeys } from '../local/production-keys.ts'

/** The allowed-signers file's path in the repository, as git names it. */
export const ALLOWED_SIGNERS_PATH = 'delorun/release/allowed-signers'

/** The production-keys registry's path in the repository, as git names it. */
export const PRODUCTION_KEYS_REPOSITORY_PATH = 'delorun/release/production-keys.json'

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
 * A file as the release branch commits it.
 * @param repository - the repository.
 * @param branch - the release branch.
 * @param path - the file's path in the repository, `/`-separated.
 * @returns the file's text, or the problem that kept it from being read.
 * @throws Error when git cannot be started.
 */
export async function committedFile(repository: string, branch: string, path: string): Promise<{ readonly text: string } | { readonly problem: string }> {
  if (branch.startsWith('-')) return { problem: `the release branch ${JSON.stringify(branch)} is not a branch name` }
  const tip = await git(repository, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`])
  if (tip.status !== 0) return { problem: `the release branch ${branch} names no commit in ${repository}; fetch it before signing` }
  const shown = await git(repository, ['show', `${tip.stdout.trim()}:${path}`])
  if (shown.status !== 0) return { problem: `the release branch ${branch} holds no ${path}: ${gitError(shown)}` }
  return { text: shown.stdout }
}

/**
 * Check that a signing key is listed in the production-keys registry the release branch commits. An empty registry
 * lists no key, so it refuses every key: production signing stops until the owner records the keys of the key
 * ceremony.
 * @param repository - the repository.
 * @param branch - the release branch.
 * @param keyid - the signing key's id.
 * @param role - the key's role, which the problem names, such as `targets`.
 * @returns the problem, or `undefined` when the registry lists the key.
 * @throws Error when git cannot be started.
 */
export async function productionKeyProblem(repository: string, branch: string, keyid: KeyId, role: string): Promise<string | undefined> {
  const file = await committedFile(repository, branch, PRODUCTION_KEYS_REPOSITORY_PATH)
  if ('problem' in file) return file.problem
  let listed: ReadonlySet<KeyId>
  try {
    listed = readProductionKeys(Buffer.from(file.text)).keyids
  } catch (error) {
    return `${PRODUCTION_KEYS_REPOSITORY_PATH} on the release branch ${branch} does not read: ${(error as Error).message}`
  }
  if (listed.size === 0) return `${PRODUCTION_KEYS_REPOSITORY_PATH} on the release branch ${branch} lists no production key, so no production signing runs until the owner records the keys of the key ceremony`
  if (!listed.has(keyid)) return `the ${role} key ${keyid} is not a production key: ${PRODUCTION_KEYS_REPOSITORY_PATH} on the release branch ${branch} does not list it`
  return undefined
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
 * allowed-signers file the release branch commits lists for the `git` namespace. Verification is git's `verify-tag`
 * with `gpg.format=ssh`, `gpg.ssh.program=ssh-keygen` and a private copy of that file, so neither an OpenPGP signature,
 * a configured signing program nor the working tree's copy of the file takes part.
 * @param repository - the repository holding the tag.
 * @param tag - the tag's name, such as `v0.1.0`.
 * @param branch - the release branch, whose commit of {@link ALLOWED_SIGNERS_PATH} lists the signers.
 * @returns the problem, or `undefined` when the signature verifies.
 * @throws Error when git cannot be started, or the private copy cannot be written.
 */
export async function tagSignatureProblem(repository: string, tag: string, branch: string): Promise<string | undefined> {
  const file = await committedFile(repository, branch, ALLOWED_SIGNERS_PATH)
  if ('problem' in file) return file.problem
  const named = `${ALLOWED_SIGNERS_PATH} on the release branch ${branch}`
  if (signerLines(file.text) === 0) return `the allowed-signers file ${named} lists no signer key, so no release tag verifies; the owner adds each release signer's SSH signing key to it`
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
  const directory = await mkdtemp(join(tmpdir(), 'delorun-allowed-signers-'))
  try {
    const allowedSigners = join(directory, 'allowed-signers')
    await writeFile(allowedSigners, file.text, { mode: 0o600 })
    const verified = await git(repository, ['-c', 'gpg.format=ssh', '-c', 'gpg.ssh.program=ssh-keygen', '-c', `gpg.ssh.allowedSignersFile=${allowedSigners}`, 'verify-tag', ref])
    if (verified.status !== 0) return `the signature of tag ${tag} does not verify with a key the allowed-signers file ${named} lists: ${gitError(verified)}`
    return undefined
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
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
