/**
 * The ledger's writer: brings `delo/upstream-patches.json` in step with the working tree, so that people and agents never
 * write entries or digests by hand. Run from anywhere inside the repository:
 *
 * ```sh
 * node_modules/.bin/tsx delo/apps/tools/src/ledger-record.ts [--check]
 * node_modules/.bin/tsx delo/apps/tools/src/ledger-record.ts --non-model-visible-hunk <path>:<line> --reason "<one line>"
 * ```
 *
 * It compares the working tree with the pinned upstream commit, adds a stub entry for each differing path that neither
 * an entry nor a path rule covers, removes each entry whose path no longer differs, and re-records the digest of each
 * security entry whose file changed. A stub carries `TODO` as its feature and reason, which the entry rules refuse until
 * the lead writes them. A re-recorded digest exits 3, because a changed security file needs the lead's review. `--check`
 * changes nothing and exits 1 when the run would change the ledger.
 *
 * `--non-model-visible-hunk` also adds one record to the path's security entry's `nonModelVisibleHunks`: the digest of
 * the zero-context diff hunk the working tree's file has at the line, which is a line the hunk adds or, for a
 * deletion-only hunk, the line before the deletion, and the reason. It refuses a path without a security entry, a line
 * no hunk is read at, a hunk that touches no top-level statement that registers a model-visible contribution, a hunk
 * whose digest every matching hunk's record already covers, and an empty or multi-line reason, and exits 2 for each. A
 * written record exits 3, because the entry's verdict now covers it and needs the lead's review.
 *
 * @module @delo/tools/ledger-record
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { readFileSync, writeFileSync } from 'node:fs'
import { changedSince, readManifest } from './check-fork-boundary.ts'
import { coveringRules, isForkOwned, MANIFEST_PATH, ONE_LINE_REASON, TODO_VALUE, type ChangedPath, type Patch, type PatchManifest } from './fork-boundary.ts'
import { repositoryRoot } from './git.ts'
import { securityPaths, worktreeDigests } from './ledger-digests.ts'
import { gitChanges } from './parity/composition/check-parity-switches.ts'
import { findContributions, hunkLines, recordableHunks, type DiffHunk } from './parity/composition/contributions.ts'

/** A security entry whose recorded digest differs from its file. */
export interface Redigested {
  /** The listed path. */
  readonly path: string
  /** The digest the entry recorded, absent when it recorded none. */
  readonly recorded?: string
  /** The digest the file has. */
  readonly actual: string
}

/** A non-model-visible hunk record a run adds. */
export interface RecordedHunk {
  /** The security entry's path. */
  readonly path: string
  /** The 1-based line the request named, which the hunk is read at. */
  readonly line: number
  /** The hunk's digest. */
  readonly sha256: string
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
  /** The non-model-visible hunk records added. */
  readonly recordedHunks: readonly RecordedHunk[]
  /** The non-model-visible hunk records removed because no recordable hunk of their file has their digest any more. */
  readonly droppedHunks: readonly { readonly path: string; readonly sha256: string }[]
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
  return { added, removed, redigested, unreadable, recordedHunks: [], droppedHunks: [], manifest: { ...manifest, patches: [...kept, ...stubs] } }
}

/** A request to record one diff hunk as not model-visible. */
export interface HunkRequest {
  /** The security entry's path. */
  readonly path: string
  /** A 1-based working-tree line the hunk is read at: a line it adds, or the line before a deletion-only hunk. */
  readonly line: number
  /** Why the model sees no difference: one line. */
  readonly reason: string
}

/** How {@link planHunkRecord} reads the repository. */
export interface HunkSources {
  /** The file's text in the working tree. */
  readonly read: (path: string) => string
  /** The file's zero-context diff hunks against the pinned commit, or `all` when the commit lacks it. */
  readonly edits: (path: string) => 'all' | readonly DiffHunk[]
}

/**
 * Add a non-model-visible hunk record to a planned run.
 * @param plan - the planned run, whose ledger gains the record.
 * @param request - the line that selects the hunk, and the reason.
 * @param sources - the file's text and its hunks.
 * @returns the plan with the record added, or the reason the request is refused.
 */
export function planHunkRecord(plan: RecordPlan, request: HunkRequest, sources: HunkSources): RecordPlan | { readonly refused: string } {
  const { path, line, reason } = request
  const at = `${path}:${String(line)}`
  if (!ONE_LINE_REASON.test(reason)) return { refused: `${at}: the reason must be one line that holds a non-space character` }
  const patch = plan.manifest.patches.find(entry => entry.path === path)
  if (patch?.class !== 'security') return { refused: `${at}: ${path} has no security entry; only a security entry records non-model-visible hunks` }
  const edited = sources.edits(path)
  if (edited === 'all') return { refused: `${at}: the pinned commit lacks ${path}, so every contribution in it counts and no hunk can be recorded` }
  const hunk = edited.find(candidate => candidate.lines.includes(line))
  if (hunk === undefined) return { refused: `${at}: no hunk of the edit against the pinned commit adds this line or deletes after it` }
  const recordable = recordableHunks(findContributions(path, sources.read(path), hunkLines(edited)), edited).get(hunk.sha256) ?? []
  if (!recordable.includes(hunk)) {
    return { refused: `${at}: the hunk touches no top-level statement that registers a model-visible contribution, so parity-switches does not count it` }
  }
  const records = patch.nonModelVisibleHunks ?? []
  if (records.filter(record => record.sha256 === hunk.sha256).length >= recordable.length) {
    return { refused: `${at}: every hunk with this digest (read at line ${recordable.map(each => each.lines[0]).join(', ')}) already has its record` }
  }
  const recorded: Patch = { ...patch, nonModelVisibleHunks: [...records, { sha256: hunk.sha256, reason }] }
  return {
    ...plan,
    recordedHunks: [...plan.recordedHunks, { path, line, sha256: hunk.sha256 }],
    manifest: { ...plan.manifest, patches: plan.manifest.patches.map(entry => entry === patch ? recorded : entry) },
  }
}

/**
 * Drop the non-model-visible hunk records that match no recordable hunk of their file any more, as `parity-switches`
 * reports them stale. Dropping a record only narrows what the check passes; the hunk that replaced it needs its own
 * review and record.
 * @param plan - the planned run.
 * @param sources - each file's text and its hunks.
 * @returns the plan without the stale records.
 */
export function planDropStaleHunks(plan: RecordPlan, sources: HunkSources): RecordPlan {
  const dropped: { path: string; sha256: string }[] = []
  const patches = plan.manifest.patches.map((patch) => {
    const records = patch.nonModelVisibleHunks
    if (records === undefined) return patch
    const edited = sources.edits(patch.path)
    const recordable = edited === 'all' ? new Map<string, DiffHunk[]>() : recordableHunks(findContributions(patch.path, sources.read(patch.path), hunkLines(edited)), edited)
    const left = new Map([...recordable].map(([digest, hunks]) => [digest, hunks.length]))
    const kept = records.filter((record) => {
      const count = left.get(record.sha256) ?? 0
      if (count > 0) {
        left.set(record.sha256, count - 1)
        return true
      }
      dropped.push({ path: patch.path, sha256: record.sha256 })
      return false
    })
    if (kept.length === records.length) return patch
    const { nonModelVisibleHunks: _dropped, ...rest } = patch
    return kept.length === 0 ? rest : { ...rest, nonModelVisibleHunks: kept }
  })
  return dropped.length === 0 ? plan : { ...plan, droppedHunks: [...plan.droppedHunks, ...dropped], manifest: { ...plan.manifest, patches } }
}

/**
 * Report whether a plan changes the ledger.
 * @param plan - the planned run.
 * @returns true when the plan adds, removes, re-records or records anything.
 */
export function changesLedger(plan: RecordPlan): boolean {
  return plan.added.length > 0 || plan.removed.length > 0 || plan.redigested.length > 0 || plan.recordedHunks.length > 0
    || plan.droppedHunks.length > 0
}

/**
 * Format a plan as the lines a run prints.
 * @param plan - the planned run.
 * @param check - true for `--check`, which reports what a run would change.
 * @returns one line per stub, removal, re-recorded digest, unreadable security file and recorded hunk, then a summary
 * line.
 */
export function formatPlan(plan: RecordPlan, check: boolean): string[] {
  const verb = (done: string, planned: string): string => (check ? planned : done)
  const lines = [
    ...plan.added.map(path => `${path}: ${verb('added', 'would add')} a stub entry; the lead writes its class, feature and reason`),
    ...plan.removed.map(path => `${path}: ${verb('removed', 'would remove')} the entry, because the path no longer differs from upstream`),
    ...plan.redigested.map(entry => `${entry.path}: security file changed; ${verb('re-recorded', 'would re-record')} sha256 ${entry.recorded ?? 'none'} → ${entry.actual}; the lead re-reviews it`),
    ...plan.unreadable.map(path => `${path}: security entry holds no file to digest; restore the file or remove the entry`),
    ...plan.recordedHunks.map(entry => `${entry.path}:${String(entry.line)}: recorded the non-model-visible hunk sha256 ${entry.sha256}; the lead re-reviews the entry`),
    ...plan.droppedHunks.map(entry => `${entry.path}: ${verb('dropped', 'would drop')} the stale non-model-visible hunk record sha256 ${entry.sha256}; record the hunk that replaced it after review`),
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

const USAGE = 'usage: ledger-record.ts [--check] | --non-model-visible-hunk <path>:<line> --reason "<one line>"'

/**
 * Read the command line.
 * @param argv - the arguments, without the script.
 * @returns `--check`, and the hunk request when `--non-model-visible-hunk` is given.
 * @throws Error for an unknown option, a positional argument, a malformed line, `--reason` without a line, a line
 * without `--reason`, or a line with `--check`.
 */
function readArguments(argv: readonly string[]): { readonly check: boolean; readonly request?: HunkRequest } {
  const { values } = parseArgs({
    args: [...argv],
    options: { 'check': { type: 'boolean', default: false }, 'non-model-visible-hunk': { type: 'string' }, 'reason': { type: 'string' } },
    strict: true,
    allowPositionals: false,
  })
  const target = values['non-model-visible-hunk']
  if (target === undefined) {
    if (values.reason !== undefined) throw new Error('--reason belongs to --non-model-visible-hunk')
    return { check: values.check }
  }
  const match = /^(.+):([1-9][0-9]*)$/u.exec(target)
  if (match?.[1] === undefined || match[2] === undefined) throw new Error(`--non-model-visible-hunk ${target} is not <path>:<line>`)
  if (values.reason === undefined) throw new Error('--non-model-visible-hunk needs --reason')
  if (values.check) throw new Error('--check records nothing, so it takes no --non-model-visible-hunk')
  return { check: false, request: { path: match[1], line: Number(match[2]), reason: values.reason } }
}

/**
 * Run the command line.
 * @param argv - the arguments, without the script.
 * @param cwd - the directory the run starts from, inside the repository.
 * @returns 0 when nothing changes or a run wrote stubs or removals only, 1 when `--check` finds a change or a security
 * entry holds no file, 2 for a bad command line, an unusable ledger or a refused hunk record, and 3 when a run
 * re-recorded a security digest or recorded a non-model-visible hunk.
 */
export function main(argv: readonly string[], cwd: string): number {
  let options: ReturnType<typeof readArguments>
  try {
    options = readArguments(argv)
  } catch (error) {
    console.error(`ledger-record: ${String(error)}`)
    console.error(USAGE)
    return 2
  }
  const { check, request } = options
  let root: string
  let plan: RecordPlan
  try {
    root = repositoryRoot(cwd)
    const sources: HunkSources = { read: path => readFileSync(join(root, path), 'utf8'), edits: gitChanges(root, readManifest(root).upstream.commit) }
    plan = planDropStaleHunks(planRepository(root), sources)
    if (request !== undefined) {
      const recorded = planHunkRecord(plan, request, sources)
      if ('refused' in recorded) {
        console.error(`ledger-record: ${recorded.refused}`)
        return 2
      }
      plan = recorded
    }
  } catch (error) {
    console.error(`ledger-record: ${String(error)}`)
    return 2
  }
  for (const line of formatPlan(plan, check)) console.log(`ledger-record: ${line}`)
  if (check) return changesLedger(plan) || plan.unreadable.length > 0 ? 1 : 0
  if (changesLedger(plan)) writeFileSync(join(root, MANIFEST_PATH), `${JSON.stringify(plan.manifest, null, 2)}\n`)
  if (plan.redigested.length > 0 || plan.recordedHunks.length > 0 || plan.droppedHunks.length > 0) return SECURITY_CHANGED_STATUS
  return plan.unreadable.length > 0 ? 1 : 0
}

/* v8 ignore start -- the entry-point guard runs only when the module is the command, which the specs run in-process through main */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2), process.cwd())
}
/* v8 ignore stop */
