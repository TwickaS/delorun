/**
 * The ledger's writer: brings `delo/upstream-patches.json` in step with the working tree, so that people and agents never
 * write entries or digests by hand. Run from anywhere inside the repository:
 *
 * ```sh
 * node_modules/.bin/tsx delo/apps/tools/src/ledger-record.ts [--check]
 * ```
 *
 * It compares the working tree with the pinned upstream commit, adds a stub entry for each differing path that neither
 * an entry nor a path rule covers, removes each entry whose path no longer differs, and re-records the digest of each
 * security entry whose file changed. A stub carries `TODO` as its feature and reason, which the entry rules refuse until
 * the lead writes them. A re-recorded digest exits 3, because a changed security file needs the lead's review. `--check`
 * changes nothing and exits 1 when the run would change the ledger.
 *
 * @module @delo/tools/ledger-record
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { changedSince, readManifest } from './check-fork-boundary.ts'
import { coveringRules, isForkOwned, MANIFEST_PATH, TODO_VALUE, type ChangedPath, type Patch, type PatchManifest } from './fork-boundary.ts'
import { repositoryRoot } from './git.ts'
import { securityPaths, worktreeDigests } from './ledger-digests.ts'

/** A security entry whose recorded digest differs from its file. */
export interface Redigested {
  /** The listed path. */
  readonly path: string
  /** The digest the entry recorded, absent when it recorded none. */
  readonly recorded?: string
  /** The digest the file has. */
  readonly actual: string
}

/** What one run changes in the ledger. */
export interface RecordPlan {
  /** The differing paths that gained a stub entry. */
  readonly added: readonly string[]
  /** The listed paths that no longer differ, whose entries are removed. */
  readonly removed: readonly string[]
  /** The security entries whose digest is re-recorded. */
  readonly redigested: readonly Redigested[]
  /** The security entries whose path holds no file to digest; they are left as they are. */
  readonly unreadable: readonly string[]
  /** The ledger with every change applied. */
  readonly manifest: PatchManifest
}

/** The exit status of a run that re-recorded a security digest, so a caller cannot miss the lead's re-review. */
export const SECURITY_CHANGED_STATUS = 3

/**
 * Plan the changes that bring a ledger in step with a tree. A retired path that differs again gains no stub, because
 * the boundary check names it under its own rule.
 * @param manifest - the parsed ledger.
 * @param changed - the paths that differ from the pinned upstream commit.
 * @param digests - the digest of each security entry's file in the tree, by path; a path without a file is absent.
 * @returns the stub entries, the removed entries, the re-recorded and unreadable security digests, and the new ledger.
 */
export function planRecord(manifest: PatchManifest, changed: readonly ChangedPath[], digests: ReadonlyMap<string, string>): RecordPlan {
  const differing = new Set(changed.map(entry => entry.path))
  const entries = new Set([...manifest.patches, ...manifest.retired].map(entry => entry.path))
  const added = changed
    .map(entry => entry.path)
    .filter(path => !entries.has(path) && !isForkOwned(path, manifest.forkOwned) && coveringRules(path, manifest.rules).length === 0)
  const removed = manifest.patches.filter(patch => !differing.has(patch.path)).map(patch => patch.path)
  const redigested: Redigested[] = []
  const unreadable: string[] = []
  const kept = manifest.patches.filter(patch => differing.has(patch.path)).map((patch): Patch => {
    if (patch.class !== 'security') return patch
    const actual = digests.get(patch.path)
    if (actual === undefined) {
      unreadable.push(patch.path)
      return patch
    }
    if (actual === patch.sha256) return patch
    redigested.push({ path: patch.path, ...patch.sha256 === undefined ? {} : { recorded: patch.sha256 }, actual })
    return { ...patch, sha256: actual }
  })
  const stubs = added.map((path): Patch => ({ path, class: 'delo-feature', feature: TODO_VALUE, reason: TODO_VALUE }))
  return { added, removed, redigested, unreadable, manifest: { ...manifest, patches: [...kept, ...stubs] } }
}

/**
 * Report whether a plan changes the ledger.
 * @param plan - the planned run.
 * @returns true when the plan adds, removes or re-records anything.
 */
export function changesLedger(plan: RecordPlan): boolean {
  return plan.added.length > 0 || plan.removed.length > 0 || plan.redigested.length > 0
}

/**
 * Format a plan as the lines a run prints.
 * @param plan - the planned run.
 * @param check - true for `--check`, which reports what a run would change.
 * @returns one line per stub, removal, re-recorded digest and unreadable security file, then a summary line.
 */
export function formatPlan(plan: RecordPlan, check: boolean): string[] {
  const verb = (done: string, planned: string): string => (check ? planned : done)
  const lines = [
    ...plan.added.map(path => `${path}: ${verb('added', 'would add')} a stub entry; the lead writes its class, feature and reason`),
    ...plan.removed.map(path => `${path}: ${verb('removed', 'would remove')} the entry, because the path no longer differs from upstream`),
    ...plan.redigested.map(entry => `${entry.path}: security file changed; ${verb('re-recorded', 'would re-record')} sha256 ${entry.recorded ?? 'none'} → ${entry.actual}; the lead re-reviews it`),
    ...plan.unreadable.map(path => `${path}: security entry holds no file to digest; restore the file or remove the entry`),
  ]
  lines.push(changesLedger(plan) ? `${verb('updated', 'would update')} ${MANIFEST_PATH}` : `${MANIFEST_PATH} is in step with the tree`)
  return lines
}

/**
 * Plan a run against a repository's working tree.
 * @param root - the repository root.
 * @returns the plan.
 * @throws Error when the ledger is missing or invalid, or its pinned commit is not in the clone.
 */
export function planRepository(root: string): RecordPlan {
  const manifest = readManifest(root)
  const changed = changedSince(root, manifest.upstream.commit)
  return planRecord(manifest, changed, worktreeDigests(root, securityPaths(manifest)))
}

/**
 * Run the command line.
 * @param argv - the arguments, without the script.
 * @param cwd - the directory the run starts from, inside the repository.
 * @returns 0 when nothing changes or a run wrote stubs or removals only, 1 when `--check` finds a change or a security
 * entry holds no file, 2 for a bad command line or an unusable ledger, and 3 when a run re-recorded a security digest.
 */
export function main(argv: readonly string[], cwd: string): number {
  let check: boolean
  try {
    check = parseArgs({ args: [...argv], options: { check: { type: 'boolean', default: false } }, strict: true, allowPositionals: false }).values.check
  } catch (error) {
    console.error(`ledger-record: ${String(error)}`)
    console.error('usage: ledger-record.ts [--check]')
    return 2
  }
  let root: string
  let plan: RecordPlan
  try {
    root = repositoryRoot(cwd)
    plan = planRepository(root)
  } catch (error) {
    console.error(`ledger-record: ${String(error)}`)
    return 2
  }
  for (const line of formatPlan(plan, check)) console.log(`ledger-record: ${line}`)
  if (check) return changesLedger(plan) || plan.unreadable.length > 0 ? 1 : 0
  if (changesLedger(plan)) writeFileSync(join(root, MANIFEST_PATH), `${JSON.stringify(plan.manifest, null, 2)}\n`)
  if (plan.redigested.length > 0) return SECURITY_CHANGED_STATUS
  return plan.unreadable.length > 0 ? 1 : 0
}

/* v8 ignore start -- the entry-point guard runs only when the module is the command, which the specs run in-process through main */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2), process.cwd())
}
/* v8 ignore stop */
