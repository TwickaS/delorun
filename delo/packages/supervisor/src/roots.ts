/**
 * Supervisor roots (contract C9, "Supervisor roots"): the setup-time roots file the supervisor reads at its start,
 * and the resolution of a workspace root against it. Only `delorun setup` writes `supervisor/roots.json`; nothing in
 * this package writes it, and no request carries a parent.
 *
 * Paths are compared by file identity (device and inode) along each path's chain of ancestors, not by their text, so
 * a bind mount or another alias of the OS home, the Delo home or another workspace's root is recognised as that
 * directory.
 *
 * @module @delo/supervisor/roots
 */
import { lstat, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { SUPERVISOR_ROOTS_FILE } from '@delo/contract-home-layout'
import { MAX_ROOT_PARENTS, type SupervisorRoots } from '@delo/contract-runtime-supervisor'
import { readProtectedFile } from '@delo/home'
import { z } from 'zod'
import { SupervisorError } from './errors.ts'

/**
 * The identities of a directory and each of its ancestors up to the filesystem root, the directory's own first; an
 * identity is its device and inode.
 */
export type IdentityChain = readonly string[]

/** The paths a root is compared with, each canonical, with their identity chains. */
export interface RootRules {
  /** Canonical parent directories from the roots file. */
  readonly parents: readonly string[]
  /** The identity of each parent, in the order of {@link parents}. */
  readonly parentIdentities: readonly string[]
  /** The canonical OS home directory. */
  readonly osHome: string
  /** The OS home's identity chain. */
  readonly osHomeChain: IdentityChain
  /** The canonical Delo home. */
  readonly deloHome: string
  /** The Delo home's identity chain. */
  readonly deloHomeChain: IdentityChain
  /** The person's uid, which must own a workspace root; `undefined` on Windows. */
  readonly uid: number | undefined
}

const rootsFile = z.strictObject({
  v: z.literal(1),
  parents: z.array(z.string()).max(MAX_ROOT_PARENTS),
})

/**
 * The identity chain of a canonical directory.
 * @param path - a canonical path that exists.
 * @returns the identities of the path and of each ancestor, the path's first.
 */
export async function identityChain(path: string): Promise<IdentityChain> {
  const chain: string[] = []
  let current = path
  for (;;) {
    const stats = await stat(current, { bigint: true })
    chain.push(`${String(stats.dev)}:${String(stats.ino)}`)
    const parent = dirname(current)
    if (parent === current) return chain
    current = parent
  }
}

/**
 * Why a directory may not be a parent or a root, or `undefined` when it may: the filesystem root, the OS home
 * directory, the Delo home, a directory containing the Delo home or one inside it.
 * @param chain - the directory's identity chain.
 * @param rules - the OS home's and the Delo home's chains.
 * @returns the reason, or `undefined`.
 */
function forbidden(chain: IdentityChain, rules: Pick<RootRules, 'osHomeChain' | 'deloHomeChain'>): string | undefined {
  const [self = ''] = chain
  if (chain.length === 1) return 'is the filesystem root'
  if (self === rules.osHomeChain[0]) return 'is the OS home directory'
  if (self === rules.deloHomeChain[0]) return 'is the Delo home'
  if (rules.deloHomeChain.includes(self)) return 'contains the Delo home'
  if (chain.includes(rules.deloHomeChain[0] ?? '')) return 'lies inside the Delo home'
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
  const deloHome = await realpath(home)
  const canonicalOsHome = await realpath(osHome)
  const homes = { osHome: canonicalOsHome, osHomeChain: await identityChain(canonicalOsHome), deloHome, deloHomeChain: await identityChain(deloHome) }
  const uid = process.getuid?.()
  let bytes: Buffer
  try {
    bytes = await readProtectedFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { parents: [], parentIdentities: [], ...homes, uid }
    throw error
  }
  let record: SupervisorRoots
  try {
    record = rootsFile.parse(JSON.parse(bytes.toString('utf8')))
  } catch (error) {
    throw new Error(`${path} is not a supervisor roots record ({"v":1,"parents":[...]} with at most ${String(MAX_ROOT_PARENTS)} parents)`, { cause: error })
  }
  const parentIdentities: string[] = []
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
    const chain = await identityChain(parent)
    const reason = forbidden(chain, homes)
    if (reason !== undefined) throw new Error(`${path}: parent ${JSON.stringify(parent)} ${reason}`)
    parentIdentities.push(chain[0] ?? '')
  }
  return { parents: record.parents, parentIdentities, ...homes, uid }
}

/**
 * Resolve a requested workspace root with `realpath` and check it against the rules and the roots of the other
 * workspaces this supervisor manages.
 * @param root - the request's absolute root.
 * @param rules - the rules from {@link loadRootRules}.
 * @param others - the canonical roots of the other workspaces this supervisor manages.
 * @returns the canonical root the container mounts.
 * @throws {SupervisorError} `ROOT_REFUSED` for `/`, the OS home, the Delo home, a path containing the OS home or
 *   containing or inside the Delo home, a path inside or containing another workspace's root, a path that does not
 *   exist, or one that is not a directory the person owns; `ROOT_NOT_UNDER_PARENT` for a root not strictly inside a
 *   parent.
 */
export async function resolveWorkspaceRoot(root: string, rules: RootRules, others: readonly string[]): Promise<string> {
  let resolved: string
  try {
    resolved = await realpath(root)
  } catch (error) {
    throw new SupervisorError('ROOT_REFUSED', `${root} cannot be resolved (${(error as NodeJS.ErrnoException).code ?? 'error'})`)
  }
  const chain = await identityChain(resolved)
  const [self = ''] = chain
  const reason = forbidden(chain, rules) ?? (rules.osHomeChain.includes(self) ? 'contains the OS home directory' : undefined)
  if (reason !== undefined) throw new SupervisorError('ROOT_REFUSED', `${resolved} ${reason}`)
  const stats = await lstat(resolved)
  if (!stats.isDirectory()) throw new SupervisorError('ROOT_REFUSED', `${resolved} is not a directory`)
  if (rules.uid !== undefined && stats.uid !== rules.uid) throw new SupervisorError('ROOT_REFUSED', `${resolved} belongs to another user (uid ${String(stats.uid)})`)
  for (const other of others) {
    let otherChain: IdentityChain
    try {
      otherChain = await identityChain(await realpath(other))
    } catch (_gone) {
      // A root that no longer exists contains nothing and lies inside nothing.
      continue
    }
    if (chain.includes(otherChain[0] ?? '') || otherChain.includes(self)) throw new SupervisorError('ROOT_REFUSED', `${resolved} lies inside or contains the root of another workspace, ${other}`)
  }
  if (!rules.parentIdentities.some(parent => chain.slice(1).includes(parent))) throw new SupervisorError('ROOT_NOT_UNDER_PARENT', `${resolved} is not inside a parent chosen at setup`)
  return resolved
}

/**
 * Check a mount source of an existing workspace container before it starts: it must still resolve to itself and pass
 * every rule a new root passes.
 * @param source - the container's recorded mount source.
 * @param rules - the rules from {@link loadRootRules}.
 * @param others - the canonical roots of the other workspaces this supervisor manages.
 * @throws {SupervisorError} `ROOT_REFUSED` when the source no longer resolves to itself, or a refusal of
 *   {@link resolveWorkspaceRoot}.
 */
export async function recheckMountedRoot(source: string, rules: RootRules, others: readonly string[]): Promise<void> {
  let resolved: string
  try {
    resolved = await realpath(source)
  } catch (error) {
    throw new SupervisorError('ROOT_REFUSED', `${source} cannot be resolved (${(error as NodeJS.ErrnoException).code ?? 'error'})`)
  }
  if (resolved !== source) throw new SupervisorError('ROOT_REFUSED', `${source} now resolves to ${resolved}`)
  await resolveWorkspaceRoot(source, rules, others)
}
