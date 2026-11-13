/**
 * Shared file listing and entry-point detection for the gates that scan Delorun's tracked prose.
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * List the git-tracked files under `delo/` that a gate checks.
 * @param repoRoot - the repository root.
 * @param accepts - whether the gate checks a repository-relative slash path.
 * @returns the accepted tracked paths.
 */
export function trackedDeloFiles(repoRoot: string, accepts: (file: string) => boolean): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', 'delo'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .split('\0')
    .filter(accepts)
}

/**
 * Whether a module is the process entry point.
 * @param moduleUrl - the module's `import.meta.url`.
 * @returns true when the module was started directly and not imported.
 */
export function isEntryPoint(moduleUrl: string): boolean {
  const invokedPath = process.argv[1]
  return invokedPath !== undefined && moduleUrl === pathToFileURL(resolve(invokedPath)).href
}
