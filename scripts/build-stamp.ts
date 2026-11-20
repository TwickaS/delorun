/**
 * The build stamp: a record of the commit a successful artifact build ran against, so a release cut that reuses the
 * worktree's `lib/` directories can tell whether they were built from the commit being cut.
 *
 * @module build-stamp
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Repository-relative path of the build stamp; git ignores `.dsh-build/`. */
export const BUILD_STAMP_PATH = '.dsh-build/build-stamp.json'

/** Environment variable that names the commit an exported source tree without `.git` was exported from. */
export const BUILD_SOURCE_COMMIT_ENV = 'DSH_BUILD_SOURCE_COMMIT'

/**
 * Environment variable that states an exported source tree's tracked files equal its commit;
 * the only accepted value is {@link BUILD_SOURCE_TREE_CLEAN}.
 */
export const BUILD_SOURCE_TREE_ENV = 'DSH_BUILD_SOURCE_TREE'

/** The value of {@link BUILD_SOURCE_TREE_ENV} that asserts a clean export. */
export const BUILD_SOURCE_TREE_CLEAN = 'clean'

/** What the stamp holds. */
export interface BuildStamp {
  /** The commit the build ran at. */
  readonly commit: string
}

/**
 * Remove the stamp, so an interrupted or failed build leaves none.
 * @param root - the repository root.
 */
export function clearBuildStamp(root: string): void {
  rmSync(join(root, BUILD_STAMP_PATH), { force: true })
}

/** The commit a build runs against and whether its tracked files equal that commit. */
interface SourceFacts {
  readonly commit: string
  readonly clean: boolean
}

/**
 * Read the source facts: from git inside a checkout, otherwise from {@link BUILD_SOURCE_COMMIT_ENV} and
 * {@link BUILD_SOURCE_TREE_ENV}, which an exporter of a commit's tree sets. Inside a checkout the variables are ignored.
 * @param root - the repository root.
 * @param env - the environment that may carry the variables.
 * @returns the commit and whether the tracked files are clean.
 * @throws Error when there is no `.git` and the variables are absent or invalid: the build never guesses a commit or a clean tree.
 */
function sourceFacts(root: string, env: NodeJS.ProcessEnv): SourceFacts {
  if (existsSync(join(root, '.git'))) return { commit: headCommit(root), clean: trackedFilesClean(root) }
  const commit = env[BUILD_SOURCE_COMMIT_ENV]
  const tree = env[BUILD_SOURCE_TREE_ENV]
  if (commit === undefined || tree === undefined) {
    throw new Error(`build stamp: the source tree has no .git, so ${BUILD_SOURCE_COMMIT_ENV} (the full commit id) and ${BUILD_SOURCE_TREE_ENV}=${BUILD_SOURCE_TREE_CLEAN} must name the commit it was exported from`)
  }
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`build stamp: ${BUILD_SOURCE_COMMIT_ENV} must be a full 40-character lowercase commit id`)
  if (tree !== BUILD_SOURCE_TREE_CLEAN) throw new Error(`build stamp: ${BUILD_SOURCE_TREE_ENV} must be ${BUILD_SOURCE_TREE_CLEAN}`)
  return { commit, clean: true }
}

/**
 * Read the commit a build is about to run against. Call it before the build starts.
 * @param root - the repository root.
 * @param env - the environment that carries the source facts when `root` has no `.git`.
 * @returns the commit, or undefined when tracked files already differ from it.
 * @throws Error when `root` has no `.git` and the environment lacks valid source facts.
 */
export function captureBuildStart(root: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const facts = sourceFacts(root, env)
  return facts.clean ? facts.commit : undefined
}

/**
 * Record the commit a successful artifact build ran at. No stamp is written, and an older one is removed, when the build
 * started with edited tracked files, or when HEAD or the tracked files changed while it ran: its artifacts are then no
 * commit's.
 * @param root - the repository root.
 * @param start - the result of {@link captureBuildStart} before the build.
 * @param env - the environment that carries the source facts when `root` has no `.git`.
 * @returns the stamp, or undefined when none was written.
 * @throws Error when `root` has no `.git` and the environment lacks valid source facts.
 */
export function writeBuildStamp(root: string, start: string | undefined, env: NodeJS.ProcessEnv = process.env): BuildStamp | undefined {
  clearBuildStamp(root)
  if (start === undefined) return undefined
  const facts = sourceFacts(root, env)
  if (facts.commit !== start || !facts.clean) return undefined
  const stamp: BuildStamp = { commit: start }
  mkdirSync(dirname(join(root, BUILD_STAMP_PATH)), { recursive: true })
  writeFileSync(join(root, BUILD_STAMP_PATH), `${JSON.stringify(stamp)}\n`)
  return stamp
}

function headCommit(root: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

function trackedFilesClean(root: string): boolean {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim() === ''
}

/**
 * Read the stamp.
 * @param root - the repository root.
 * @returns the stamp, or undefined when absent or not a stamp.
 */
export function readBuildStamp(root: string): BuildStamp | undefined {
  let text: string
  try {
    text = readFileSync(join(root, BUILD_STAMP_PATH), 'utf8')
  } catch (error) {
    // No stamp file (or unreadable): the caller treats the artifacts as unstamped.
    void error
    return undefined
  }
  try {
    const parsed = JSON.parse(text) as { commit?: unknown }
    return typeof parsed.commit === 'string' ? { commit: parsed.commit } : undefined
  } catch (error) {
    // A truncated stamp is as good as none.
    void error
    return undefined
  }
}
