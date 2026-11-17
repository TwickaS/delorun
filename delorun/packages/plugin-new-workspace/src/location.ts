/**
 * Where the flow may make a folder: inside one of the configured roots once symbolic links are resolved, and never where
 * `@delorun/home` refuses a workspace. A missing tail is checked where it would be created.
 * @module @delorun/plugin-new-workspace/location
 */
import { homedir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'
import { canonicalizeWatchPath } from '@deepseek-ai/dsh-home-paths'
import { resolveDelorunHome, workspaceLocationHomes, workspaceLocationProblem, type WorkspaceLocationHomes, type WorkspaceLocationProblem } from '@delorun/home'
import type { LocationProblem, PlaceProblem } from './wire.ts'

// Compile-time check that the wire's list names exactly `@delorun/home`'s problems.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const SAME_PROBLEMS: Same<LocationProblem, WorkspaceLocationProblem> = true
void SAME_PROBLEMS

/** What a location check needs from the harness. */
export interface LocationDeps {
  /** The environment the Delorun home is resolved from. */
  readonly env: Readonly<Record<string, string | undefined>>
  /**
   * Write one line to the harness's log.
   * @param message - the line, which names no path.
   */
  readonly warn: (message: string) => void
}

/**
 * Expand a configured place: `~` and `~/…` from the home directory; an absolute path as written.
 * @param place - the place as configured.
 * @param home - the home directory.
 * @returns the absolute path.
 */
export function expandPlace(place: string, home: string = homedir()): string {
  if (place === '~') return home
  if (place.startsWith('~/')) return join(home, place.slice(2))
  return place
}

/**
 * Compare two canonical paths as the platform's default filesystem does: without case on Windows and macOS.
 * @param path - a canonical path.
 * @returns the comparison key.
 */
function comparable(path: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path
}

/**
 * Whether a canonical path is a root or lies inside it.
 * @param path - the candidate, canonical.
 * @param root - the root, canonical.
 * @returns true when `path` is `root` or below it.
 */
function within(path: string, root: string): boolean {
  const [candidate, base] = [comparable(path), comparable(root)]
  return candidate === base || candidate.startsWith(base.endsWith(sep) ? base : base + sep)
}

/**
 * The homes a location is held against, or `unresolved` when the Delorun home cannot be resolved.
 * @param deps - the environment and the log.
 * @returns the homes.
 */
export async function locationHomes(deps: LocationDeps): Promise<WorkspaceLocationHomes | 'unresolved'> {
  try {
    return workspaceLocationHomes((await resolveDelorunHome(deps.env)).path)
  } catch (error) {
    deps.warn(`the Delorun home could not be resolved, so no folder is used: ${codeOf(error)}`)
    return 'unresolved'
  }
}

/**
 * Hold a folder against the locations Delorun never adds as a workspace.
 * @param path - the folder.
 * @param deps - the environment and the log.
 * @returns the problem, `undefined` for a folder that may be a workspace, or `unresolved` when the Delorun home cannot be resolved.
 */
export async function locationProblem(path: string, deps: LocationDeps): Promise<WorkspaceLocationProblem | 'unresolved' | undefined> {
  const homes = await locationHomes(deps)
  if (homes === 'unresolved') return homes
  try {
    return await workspaceLocationProblem(path, homes)
  } catch (error) {
    // A path whose existing part is not a folder cannot be canonicalized; it names no folder a workspace can be.
    deps.warn(`a folder could not be checked: ${codeOf(error)}`)
    return 'unresolved'
  }
}

/**
 * The canonical spelling of each configured root that exists. A root that is missing or unreadable holds nothing.
 * @param roots - the configured roots, as {@link expandPlace} takes them.
 * @returns the canonical roots.
 */
export async function canonicalRoots(roots: readonly string[]): Promise<string[]> {
  const found: string[] = []
  for (const root of roots) {
    try {
      found.push(await canonicalizeWatchPath(expandPlace(root)))
    } catch (_unreadable) {
      // A root that cannot be resolved holds no folder this flow makes.
    }
  }
  return found
}

/**
 * Hold a folder the flow is about to make, or search under, against the roots and the locations Delorun never adds.
 * Symbolic links in its existing part are resolved first, so a link that leaves every root is refused.
 * @param path - the folder, absolute.
 * @param roots - the configured roots.
 * @param deps - the environment and the log.
 * @returns the problem, `undefined` when the folder may be made, or `unresolved`.
 */
export async function placeProblem(path: string, roots: readonly string[], deps: LocationDeps): Promise<PlaceProblem | 'unresolved' | undefined> {
  if (!isAbsolute(path)) return 'not-absolute'
  const problem = await locationProblem(path, deps)
  if (problem !== undefined) return problem
  let canonical: string
  try {
    canonical = await canonicalizeWatchPath(path)
  } catch (error) {
    deps.warn(`a folder could not be checked: ${codeOf(error)}`)
    return 'unresolved'
  }
  return (await canonicalRoots(roots)).some(root => within(canonical, root)) ? undefined : 'outside-roots'
}

/**
 * The code a failure gives without naming a path: its system code, or its name.
 * @param error - the failure.
 * @returns the code.
 */
export function codeOf(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code
  return error instanceof Error ? error.name : 'unexpected failure'
}
