/**
 * Supervisor roots (contract C9, "Supervisor roots"): the setup-time roots file the supervisor reads at its start,
 * and the resolution of a workspace root against it. Only `delorun setup` writes `supervisor/roots.json`; nothing in
 * this package writes it, and no request carries a parent.
 *
 * @module @delo/supervisor/roots
 */
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, parse, sep } from 'node:path'
import { SUPERVISOR_ROOTS_FILE } from '@delo/contract-home-layout'
import { MAX_ROOT_PARENTS, type SupervisorRoots } from '@delo/contract-runtime-supervisor'
import { readProtectedFile } from '@delo/home'
import { z } from 'zod'
import { SupervisorError } from './errors.ts'

/** The paths a root is compared with, each canonical. */
export interface RootRules {
  /** Canonical parent directories from the roots file. */
  readonly parents: readonly string[]
  /** The canonical OS home directory. */
  readonly osHome: string
  /** The canonical Delo home. */
  readonly deloHome: string
  /** The person's uid, which must own a workspace root; `undefined` on Windows. */
  readonly uid: number | undefined
}

const rootsFile = z.strictObject({
  v: z.literal(1),
  parents: z.array(z.string()).max(MAX_ROOT_PARENTS),
})

/**
 * Whether `inner` lies strictly inside `outer`; both canonical.
 * @param inner - a canonical path.
 * @param outer - a canonical directory.
 * @returns true when `inner` is below `outer` and not `outer` itself.
 */
function strictlyInside(inner: string, outer: string): boolean {
  return inner.startsWith(outer.endsWith(sep) ? outer : outer + sep)
}

/**
 * Why a canonical path may not be a parent or a root, or `undefined` when it may: the filesystem root, the OS home
 * directory, the Delo home, a path containing the Delo home or a path inside it.
 * @param path - the canonical path.
 * @param osHome - the canonical OS home directory.
 * @param deloHome - the canonical Delo home.
 * @returns the reason, or `undefined`.
 */
function forbidden(path: string, osHome: string, deloHome: string): string | undefined {
  if (path === parse(path).root) return 'is the filesystem root'
  if (path === osHome) return 'is the OS home directory'
  if (path === deloHome) return 'is the Delo home'
  if (strictlyInside(deloHome, path)) return 'contains the Delo home'
  if (strictlyInside(path, deloHome)) return 'lies inside the Delo home'
  return undefined
}

/**
 * Read the roots file at the supervisor's start. A missing file means setup chose no parent, so every workspace root
 * is refused with `ROOT_NOT_UNDER_PARENT`. Each parent must already be stored as its canonical absolute path and
 * must not be a path setup refuses; a file that breaks either rule is refused whole.
 * @param home - the resolved Delo home.
 * @param osHome - the OS home directory.
 * @returns the rules every workspace root is resolved against.
 * @throws {HomeLayoutError} `SECRET_FILE_MODE` for a laxer, linked or foreign roots file.
 * @throws {Error} naming the file and the problem for a file that is not C9's record.
 */
export async function loadRootRules(home: string, osHome: string): Promise<RootRules> {
  const path = join(home, SUPERVISOR_ROOTS_FILE)
  const canonicalHome = await realpath(home)
  const canonicalOsHome = await realpath(osHome)
  const uid = process.getuid?.()
  let bytes: Buffer
  try {
    bytes = await readProtectedFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { parents: [], osHome: canonicalOsHome, deloHome: canonicalHome, uid }
    throw error
  }
  let record: SupervisorRoots
  try {
    record = rootsFile.parse(JSON.parse(bytes.toString('utf8')))
  } catch (error) {
    throw new Error(`${path} is not a supervisor roots record ({"v":1,"parents":[...]} with at most ${String(MAX_ROOT_PARENTS)} parents)`, { cause: error })
  }
  for (const parent of record.parents) {
    if (!isAbsolute(parent)) throw new Error(`${path}: parent ${JSON.stringify(parent)} is not an absolute path`)
    let canonical: string | undefined
    try {
      canonical = await realpath(parent)
    } catch (_missing) {
      // A parent that no longer resolves fails the comparison below, which names it.
      canonical = undefined
    }
    if (canonical !== parent) throw new Error(`${path}: parent ${JSON.stringify(parent)} is not stored as an existing canonical path`)
    const reason = forbidden(parent, canonicalOsHome, canonicalHome)
    if (reason !== undefined) throw new Error(`${path}: parent ${JSON.stringify(parent)} ${reason}`)
  }
  return { parents: record.parents, osHome: canonicalOsHome, deloHome: canonicalHome, uid }
}

/**
 * Resolve a requested workspace root with `realpath` and check it against the rules.
 * @param root - the request's absolute root.
 * @param rules - the rules from {@link loadRootRules}.
 * @returns the canonical root the container mounts.
 * @throws {SupervisorError} `ROOT_REFUSED` for `/`, the OS home, the Delo home, a path containing or inside the Delo
 *   home, a path that does not exist, or one that is not a directory the person owns; `ROOT_NOT_UNDER_PARENT` for a
 *   root not strictly inside a parent.
 */
export async function resolveWorkspaceRoot(root: string, rules: RootRules): Promise<string> {
  let resolved: string
  try {
    resolved = await realpath(root)
  } catch (error) {
    throw new SupervisorError('ROOT_REFUSED', `${root} cannot be resolved (${(error as NodeJS.ErrnoException).code ?? 'error'})`)
  }
  const reason = forbidden(resolved, rules.osHome, rules.deloHome)
  if (reason !== undefined) throw new SupervisorError('ROOT_REFUSED', `${resolved} ${reason}`)
  const stats = await lstat(resolved)
  if (!stats.isDirectory()) throw new SupervisorError('ROOT_REFUSED', `${resolved} is not a directory`)
  if (rules.uid !== undefined && stats.uid !== rules.uid) throw new SupervisorError('ROOT_REFUSED', `${resolved} belongs to another user (uid ${String(stats.uid)})`)
  if (!rules.parents.some(parent => strictlyInside(resolved, parent))) throw new SupervisorError('ROOT_NOT_UNDER_PARENT', `${resolved} is not inside a parent chosen at setup`)
  return resolved
}
