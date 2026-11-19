/**
 * The build stamp: a record of the commit a successful artifact build ran against, so a release cut that reuses the
 * worktree's `lib/` directories can tell whether they were built from the commit being cut.
 *
 * @module build-stamp
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Repository-relative path of the build stamp; git ignores `.dsh-build/`. */
export const BUILD_STAMP_PATH = '.dsh-build/build-stamp.json'

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

/**
 * Read the commit a build is about to run against. Call it before the build starts.
 * @param root - the repository root.
 * @returns HEAD, or undefined when tracked files already differ from it.
 */
export function captureBuildStart(root: string): string | undefined {
  return trackedFilesClean(root) ? headCommit(root) : undefined
}

/**
 * Record the commit a successful artifact build ran at. No stamp is written, and an older one is removed, when the build
 * started with edited tracked files, or when HEAD or the tracked files changed while it ran: its artifacts are then no
 * commit's.
 * @param root - the repository root.
 * @param start - the result of {@link captureBuildStart} before the build.
 * @returns the stamp, or undefined when none was written.
 */
export function writeBuildStamp(root: string, start: string | undefined): BuildStamp | undefined {
  clearBuildStamp(root)
  if (start === undefined || headCommit(root) !== start || !trackedFilesClean(root)) return undefined
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
