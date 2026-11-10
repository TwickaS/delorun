/**
 * The Node versions the launcher itself runs on. The installed runtime brings its own Node (contract C1's launch
 * protocol 1), so this range concerns only the process `npx` starts. The check runs before the launcher's main module
 * is loaded, so an older Node reports the refusal instead of failing on syntax or a missing built-in it cannot read.
 *
 * @module @delo/npm-launcher/node-version
 */

/** The oldest Node the launcher runs on: the `engines` range of the published package is `>=` this version. */
export const MINIMUM_NODE: readonly [number, number, number] = [24, 9, 0]

/** The `engines.node` range the published package declares. */
export const NODE_ENGINES_RANGE = `>=${MINIMUM_NODE.join('.')}`

/**
 * Whether a Node version is at or above {@link MINIMUM_NODE}.
 * @param version - `process.versions.node`, such as `24.22.0`.
 * @returns `true` when the launcher runs on it.
 */
export function nodeIsSupported(version: string): boolean {
  const found = version.split('.').map(Number)
  for (const [position, needed] of MINIMUM_NODE.entries()) {
    const have = found[position] ?? 0
    if (have !== needed) return have > needed
  }
  return true
}

/**
 * The line to print when this Node is too old.
 * @param version - `process.versions.node`.
 * @returns the refusal, or `undefined` when the launcher runs on this Node.
 */
export function nodeRefusal(version: string): string | undefined {
  if (nodeIsSupported(version)) return undefined
  return `Delo needs Node ${MINIMUM_NODE[0]}.${MINIMUM_NODE[1]} or newer to start, and this is Node ${version}. Install a newer Node from https://nodejs.org, then run the same command again.`
}
