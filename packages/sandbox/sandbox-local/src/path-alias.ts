/** Whether another mount reaches a path, as the host's mount table shows. */
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { aliasCoverage, readMountTable } from './mounts.ts'
import type { AliasCoverage } from './mounts.ts'

/**
 * Whether every other mount that reaches `path` can be found on this host, read from this process's mount table.
 * Setup and verification use it to report a rule that depends on aliases as unknown rather than enforced.
 * @param path - the path, resolved before it is checked.
 * @returns `complete`, or `unknown` when the path's filesystem hides its aliases from the mount table.
 * @throws {SandboxUnsupportedPolicyError} when the Linux mount table cannot be read.
 */
export function pathAliasCoverage(path: string): AliasCoverage {
  return aliasCoverage(canonicalPath(path), readMountTable())
}
