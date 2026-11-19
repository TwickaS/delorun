/**
 * The release before a candidate in a release channel directory, for the installed smoke's upgrade step.
 *
 * @module @delorun/release/installed-smoke/previous-release
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Compare two release versions by their dot-separated identifiers: numbers as numbers, and a number before text.
 * @param a - a version such as `0.1.0-preview.1.9`.
 * @param b - another.
 * @returns a negative number when `a` is older, positive when newer, 0 when equal.
 */
export function compareReleases(a: string, b: string): number {
  const [coreA = '', ...preA] = a.split(/-(.*)/u)
  const [coreB = '', ...preB] = b.split(/-(.*)/u)
  const parts = (text: string): string[] => text.split(/[.-]/u).filter(part => part !== '')
  const left = [...parts(coreA), ...parts(preA[0] ?? '')]
  const right = [...parts(coreB), ...parts(preB[0] ?? '')]
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index]
    const y = right[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const numeric = /^\d+$/u.test(x) && /^\d+$/u.test(y)
    if (numeric && Number(x) !== Number(y)) return Number(x) - Number(y)
    if (!numeric && x !== y) return /^\d+$/u.test(x) ? -1 : /^\d+$/u.test(y) ? 1 : x < y ? -1 : 1
  }
  return 0
}

/**
 * The newest release older than a candidate among the releases a channel directory holds.
 * @param channel - the channel directory, with `releases/download/v<version>/` for each release.
 * @param candidate - the release under test.
 * @returns the previous release's version, or `undefined` when the channel holds no older release.
 * @throws Error when the directory cannot be read other than for lacking `releases/download`.
 */
export async function previousRelease(channel: string, candidate: string): Promise<string | undefined> {
  let names: string[]
  try {
    names = await readdir(join(channel, 'releases', 'download'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const older = names.filter(name => name.startsWith('v')).map(name => name.slice(1)).filter(version => compareReleases(version, candidate) < 0)
  return older.sort(compareReleases).at(-1)
}
