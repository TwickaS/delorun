/**
 * Throwaway roots: every suite works in a new directory under the system's temporary directory (or under `--root-base`),
 * whose `home/` is the `HOME` of every process the suite starts, so Delo's home is `home/.delo` inside it. A root never
 * resolves to the person's real home, an ancestor of it, or anything inside the real home's `.delo` or `.dsh`; the
 * harness refuses to run otherwise. Child processes get an environment built from nothing: no variable of the person's
 * shell reaches them.
 *
 * @module @delo/benchmarks/harness/roots
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

/** A refusal to run in a place that is, or holds, the person's real data. */
export class RealHomeRefusal extends Error {
  override readonly name = 'RealHomeRefusal'
}

/** One throwaway root. */
export interface BenchRoot {
  /** The root directory, created by the harness. */
  readonly path: string
  /** The `HOME` of every child process: `<root>/home`. */
  readonly home: string
  /** Delo's home inside it: `<root>/home/.delo`. */
  readonly deloHome: string
  /** The child processes' `TMPDIR`: `<root>/tmp`. */
  readonly tmp: string
  /** Remove the root and everything in it. */
  dispose(): void
}

/**
 * The real home directories of the person running the harness, resolved through symbolic links where they exist.
 * @param env - the harness's environment.
 * @returns each distinct directory.
 */
export function realHomes(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const candidates = [homedir(), userInfo().homedir, env.HOME].filter((path): path is string => path !== undefined && path !== '')
  return [...new Set(candidates.map(path => canonical(path)))]
}

/**
 * A path with symbolic links resolved as far as it exists.
 * @param path - the path.
 * @returns the resolved path; the existing ancestor resolved and the rest appended when it does not exist yet.
 */
export function canonical(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch (_missing) {
    // A path that does not exist yet resolves through its nearest existing ancestor.
    const parent = resolve(absolute, '..')
    return parent === absolute ? absolute : join(canonical(parent), relative(parent, absolute))
  }
}

/**
 * Whether one path is another or lies inside it.
 * @param path - the candidate.
 * @param directory - the directory.
 * @returns true when `path` is `directory` or below it.
 */
function within(path: string, directory: string): boolean {
  return path === directory || path.startsWith(directory.endsWith(sep) ? directory : `${directory}${sep}`)
}

/**
 * Refuse a directory that a suite would use as `HOME` or as Delo's home when it is the real home, contains it, or lies
 * inside the real home's `.delo` or `.dsh`.
 * @param candidate - the directory.
 * @param homes - the real home directories.
 * @throws {RealHomeRefusal} when it does.
 */
export function assertThrowaway(candidate: string, homes: readonly string[] = realHomes()): void {
  const path = canonical(candidate)
  for (const home of homes) {
    if (within(home, path)) throw new RealHomeRefusal(`refusing to use ${path}: it is or contains the real home directory; the benchmark works only in a throwaway directory`)
    for (const data of ['.delo', '.dsh']) {
      if (within(path, join(home, data))) throw new RealHomeRefusal(`refusing to use ${path}: it lies inside the real home's ${data}`)
    }
  }
}

/**
 * Create a throwaway root.
 * @param base - the directory to create it in; the system's temporary directory by default.
 * @param homes - the real home directories.
 * @returns the root, with `home/` and `tmp/` created.
 * @throws {RealHomeRefusal} when the root or its home would be a refused place.
 */
export function createRoot(base: string = tmpdir(), homes: readonly string[] = realHomes()): BenchRoot {
  const path = mkdtempSync(join(canonical(base), 'delo-bench-'))
  const home = join(path, 'home')
  const deloHome = join(home, '.delo')
  try {
    assertThrowaway(path, homes)
    assertThrowaway(home, homes)
    assertThrowaway(deloHome, homes)
  } catch (error) {
    rmSync(path, { recursive: true, force: true })
    throw error
  }
  const tmp = join(path, 'tmp')
  mkdirSync(home)
  mkdirSync(tmp)
  return {
    path, home, deloHome, tmp,
    dispose() {
      removeTree(path)
    },
  }
}

/**
 * Remove a directory tree, first making its directories writable: an installed runtime is read-only (contract C1).
 * Files keep their modes, because a repetition's runtime files are hard links to its template's.
 * @param path - the tree; nothing happens when it does not exist.
 */
export function removeTree(path: string): void {
  if (!existsSync(path)) return
  execFileSync('find', [path, '-type', 'd', '-exec', 'chmod', 'u+rwx', '{}', '+'])
  rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

/**
 * The whole environment of a child process in a root: its `HOME`, a `PATH` of the given directories and the system's
 * own, a fixed locale and time zone, and its `TMPDIR`. Nothing is inherited.
 * @param root - the root.
 * @param path - directories put before `/usr/bin:/bin`, such as the runtime's or the harness's Node.
 * @param extra - variables a suite adds.
 * @returns the environment.
 */
export function childEnvironment(root: BenchRoot, path: readonly string[], extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return { HOME: root.home, TMPDIR: root.tmp, PATH: [...path, '/usr/bin', '/bin'].join(':'), LANG: 'C.UTF-8', TZ: 'UTC', ...extra }
}
