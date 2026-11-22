/**
 * Rehearsal merge of an upstream commit against the divergence budget. Run from anywhere inside the repository:
 * `node_modules/.bin/tsx delorun/apps/tools/src/rehearse-upstream.ts --tag <tag> | --ref <ref>`. `--tag` fetches the tag
 * from the ledger's upstream repository; `--ref` names a commit or branch already in the clone, such as
 * `upstream/master`, and fetches nothing. It merges the commit without committing in a scratch worktree detached at
 * `HEAD`, prints the conflicted paths and the ledger's growth per class against the budget's caps, and exits 1 when the
 * merge breaks the budget. The scratch worktree lives in a temporary directory and is removed on every path; the
 * checkout it starts from, its branches, index and working tree stay unchanged. The budget's rules are in
 * `delorun/docs/reference/parity-with-deepseek-harness/divergence/README.md`.
 *
 * @module @delorun/tools/rehearse-upstream
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { changedSince, hunkCount } from './check-fork-boundary.ts'
import { coveringRules, divergence, isForkOwned, MANIFEST_PATH, parseManifest, type Patch, type PatchManifest } from './fork-boundary.ts'
import { git, repositoryRoot, runGit } from './git.ts'
import { SCRATCH_CONFIG, SCRATCH_IDENTITY, withScratchWorktree } from './scratch-worktree.ts'

/** The growth floors the divergence budget names: the caps until the first release's baseline is recorded. */
export const GROWTH_FLOORS = { entries: 20, hunks: 150 } as const

/** The share of the first release's baseline that the growth caps rise to when it exceeds the floors. */
export const BASELINE_SHARE = 0.1

/** The largest share of the ledger's hunks at the merged commit that may conflict in a rehearsal merge. */
export const CONFLICT_SHARE_LIMIT = 0.15

/**
 * The classes a count is kept for: the ledger's three, `ruled` for differing paths that a path rule covers and no entry
 * lists, and `unlisted` for differing paths that neither an entry nor a rule covers.
 */
export type CountedClass = Patch['class'] | 'ruled' | 'unlisted'

/** Every counted class, in the order the report prints them. */
export const COUNTED_CLASSES: readonly CountedClass[] = ['delorun-feature', 'generic-fix', 'security', 'ruled', 'unlisted']

/** Entries and hunks of one class, or of the whole ledger. */
export interface Count {
  /** Paths that differ from the measured upstream commit. */
  readonly entries: number
  /** Their hunks, as `git diff --unified=0` splits them. */
  readonly hunks: number
}

/** One count per counted class. */
export type ClassCounts = Readonly<Record<CountedClass, Count>>

/** The growth caps a rehearsal is held to. */
export interface BudgetCaps {
  /** The largest entry growth that stays within the budget. */
  readonly entries: number
  /** The largest hunk growth that stays within the budget. */
  readonly hunks: number
  /** False while the first release's baseline is not recorded, so the caps are the floors. */
  readonly baselineRecorded: boolean
}

/** What the command line asks for: an upstream tag to fetch, or a commit or branch already in the clone. */
export type RehearsalRequest =
  | {
    /** The upstream tag to fetch and merge. */
    readonly tag: string
  }
  | {
    /** The commit or branch to merge, already in the clone, such as `upstream/master`. */
    readonly ref: string
  }

/** The commit a rehearsal merges. */
export type RehearsalTarget =
  | {
    /** A tag fetched from the upstream repository when the rehearsal runs. */
    readonly kind: 'tag'
    /** The tag's name. */
    readonly name: string
  }
  | {
    /** A commit or branch already in the clone; nothing is fetched. */
    readonly kind: 'ref'
    /** The ref as the command line named it. */
    readonly name: string
    /** The commit it names. */
    readonly commit: string
  }

/** One rehearsal, resolved from a request: everything {@link rehearse} reads, named explicitly. */
export interface RehearsalSpec {
  /** The top level of the checkout the rehearsal starts from. */
  readonly root: string
  /** The commit to merge. */
  readonly target: RehearsalTarget
  /** The upstream repository a tag is fetched from, the ledger's `upstream.repository`. */
  readonly repository: string
  /** The ledger's current pin. */
  readonly pin: { readonly ref: string; readonly commit: string }
  /** The commit the scratch worktree is detached at, the checkout's `HEAD`. */
  readonly head: string
  /** The ledger at `head`. */
  readonly manifest: PatchManifest
  /** The growth caps. */
  readonly caps: BudgetCaps
}

/** One path the rehearsal merge left conflicted. */
export interface Conflict {
  /** Repository-relative path. */
  readonly path: string
  /** The class of the ledger entry that lists the path, `ruled` when a path rule covers it, or `unlisted`. */
  readonly class: CountedClass
  /** Conflict regions in the file; a conflict without markers, such as modify/delete or binary, counts as one. */
  readonly hunks: number
}

/** A listed entry that differs from the pin but not from the target, so the target absorbs it. */
export interface AbsorbedEntry {
  /** Repository-relative path. */
  readonly path: string
  /** The entry's class. */
  readonly class: Patch['class']
  /** Its hunks against the pin, the credit it earns. */
  readonly hunks: number
}

/** The measured outcome of one rehearsal merge. */
export interface Rehearsal {
  /** The rehearsal that was run. */
  readonly spec: RehearsalSpec
  /** The commit the target names. */
  readonly targetCommit: string
  /** The conflicted paths, in git's order. */
  readonly conflicts: readonly Conflict[]
  /** The ledger at `HEAD` measured against the pin. */
  readonly current: ClassCounts
  /** The merged tree measured against the target; a conflicted file is measured with its conflict markers. */
  readonly atTarget: ClassCounts
  /** Entries the target absorbs; they are absent from `atTarget`, so the growth is net of them. */
  readonly absorbed: readonly AbsorbedEntry[]
}

/** The prefix of the rehearsal's scratch directory, which the specs look for when they check for residue. */
export const SCRATCH_PREFIX = 'delorun-rehearse-'

const USAGE = 'usage: rehearse-upstream.ts --tag <tag> | --ref <ref>'

/**
 * The growth caps: the larger of each floor and {@link BASELINE_SHARE} of the first release's baseline.
 * @param baseline - the first release's baseline, or undefined while it is not recorded.
 * @returns the caps; without a baseline they are {@link GROWTH_FLOORS}.
 */
export function budgetCaps(baseline: Count | undefined): BudgetCaps {
  if (baseline === undefined) return { ...GROWTH_FLOORS, baselineRecorded: false }
  return {
    entries: Math.max(GROWTH_FLOORS.entries, baseline.entries * BASELINE_SHARE),
    hunks: Math.max(GROWTH_FLOORS.hunks, baseline.hunks * BASELINE_SHARE),
    baselineRecorded: true,
  }
}

/**
 * Resolve a request into the rehearsal it describes, reading the ledger at `HEAD`.
 * @param root - the top level of the checkout to rehearse from.
 * @param request - the tag or the ref to merge.
 * @returns the spec, with the upstream repository and the pin from the ledger and the caps from the floors.
 * @throws Error when the tag is not a valid tag name, the ref names no commit in the clone, or the ledger at `HEAD` is
 * missing or invalid.
 */
export function resolveRehearsal(root: string, request: RehearsalRequest): RehearsalSpec {
  const manifest = parseManifest(git(root, ['show', `HEAD:${MANIFEST_PATH}`]))
  return {
    root,
    target: resolveTarget(root, request),
    repository: manifest.upstream.repository,
    pin: { ref: manifest.upstream.ref, commit: manifest.upstream.commit },
    head: git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim(),
    manifest,
    caps: budgetCaps(undefined),
  }
}

/**
 * Resolve the commit a request names. A tag is checked for a valid name and fetched when the rehearsal runs; a ref must
 * name a commit the clone already holds.
 * @param root - the top level of the checkout.
 * @param request - the tag or the ref to merge.
 * @returns the target.
 * @throws Error when the tag is not a valid tag name, or the ref starts with `-` or names no commit in the clone.
 */
function resolveTarget(root: string, request: RehearsalRequest): RehearsalTarget {
  if ('tag' in request) {
    if (runGit(root, ['check-ref-format', `refs/tags/${request.tag}`]).status !== 0) throw new Error(`${request.tag} is not a valid tag name`)
    return { kind: 'tag', name: request.tag }
  }
  const resolved = request.ref.startsWith('-') ? undefined : runGit(root, ['rev-parse', '--verify', '--quiet', `${request.ref}^{commit}`])
  if (resolved === undefined || resolved.status !== 0) throw new Error(`${request.ref} names no commit in this clone; fetch it first or pass --tag`)
  return { kind: 'ref', name: request.ref, commit: resolved.stdout.trim() }
}

/**
 * Run a rehearsal: fetch the tag or take the ref's commit, merge it without committing in a scratch worktree detached
 * at the spec's `HEAD`, and measure the ledger before and after. Objects a fetch downloads stay in the clone's object
 * store; no ref, branch, index or working tree of the checkout changes, and the scratch worktree is removed on every path.
 * @param spec - the resolved rehearsal.
 * @returns the conflicts and the counts against the pin and the target.
 * @throws Error when the fetch or the merge fails other than by conflicting, or when the scratch worktree cannot be
 * removed; a removal failure names the leftover registration.
 */
export function rehearse(spec: RehearsalSpec): Rehearsal {
  return withScratchWorktree(spec.root, spec.head, tree => {
    const current = measure(tree, spec.manifest, spec.pin.commit)
    const targetCommit = spec.target.kind === 'tag' ? fetchTag(tree, spec.repository, spec.target.name) : spec.target.commit
    const conflicted = mergeWithoutCommit(tree, targetCommit)
    const atTarget = measure(tree, spec.manifest, targetCommit)
    const conflicts = conflicted.map((path): Conflict => ({ path, class: classOf(spec.manifest, path), hunks: conflictRegions(tree, path) }))
    const absorbed = spec.manifest.patches
      .filter(patch => current.hunks.has(patch.path) && !atTarget.hunks.has(patch.path))
      .map(patch => ({ path: patch.path, class: patch.class, hunks: current.hunks.get(patch.path) ?? 0 }))
    return { spec, targetCommit, conflicts, current: current.counts, atTarget: atTarget.counts, absorbed }
  }, SCRATCH_PREFIX)
}

/**
 * The counted class of one differing path.
 * @param manifest - the ledger.
 * @param path - a differing path that is not fork-owned.
 * @returns the class of the entry that lists it, `ruled` when a path rule covers it, or `unlisted`.
 */
function classOf(manifest: PatchManifest, path: string): CountedClass {
  const entry = manifest.patches.find(patch => patch.path === path)
  if (entry !== undefined) return entry.class
  return coveringRules(path, manifest.rules).length > 0 ? 'ruled' : 'unlisted'
}

/**
 * Total a count over every class.
 * @param counts - one count per class.
 * @returns the summed entries and hunks.
 */
export function totalCount(counts: ClassCounts): Count {
  return COUNTED_CLASSES.reduce((sum, name) => ({ entries: sum.entries + counts[name].entries, hunks: sum.hunks + counts[name].hunks }), { entries: 0, hunks: 0 })
}

/**
 * The conflicted hunks of a rehearsal as a share of the ledger's hunks at the target.
 * @param rehearsal - the measured rehearsal.
 * @returns the share from 0; any conflict against a ledger without hunks is an infinite share.
 */
export function conflictShare(rehearsal: Rehearsal): number {
  const conflicted = conflictedHunks(rehearsal)
  const hunks = totalCount(rehearsal.atTarget).hunks
  if (conflicted === 0) return 0
  return hunks === 0 ? Number.POSITIVE_INFINITY : conflicted / hunks
}

/**
 * Apply the divergence budget to a rehearsal.
 * @param rehearsal - the measured rehearsal.
 * @returns one line per failure: entry growth or hunk growth above its cap, conflicted hunks above
 * {@link CONFLICT_SHARE_LIMIT} of the ledger's hunks at the target, and each conflicted `security`-class file; the ledger
 * records no maintainer decision, so every `security`-class conflict fails. Empty when the merge stays within budget.
 */
export function budgetFailures(rehearsal: Rehearsal): string[] {
  const failures: string[] = []
  const { caps } = rehearsal.spec
  const growth = difference(totalCount(rehearsal.atTarget), totalCount(rehearsal.current))
  if (growth.entries > caps.entries) failures.push(`entry growth ${signed(growth.entries)} exceeds the cap of ${String(caps.entries)}`)
  if (growth.hunks > caps.hunks) failures.push(`hunk growth ${signed(growth.hunks)} exceeds the cap of ${String(caps.hunks)}`)
  const share = conflictShare(rehearsal)
  if (share > CONFLICT_SHARE_LIMIT) {
    failures.push(`conflicted hunks ${conflictSummary(rehearsal)} exceed the limit of ${percent(CONFLICT_SHARE_LIMIT)}`)
  }
  for (const conflict of rehearsal.conflicts) {
    if (conflict.class === 'security') failures.push(`${conflict.path}: security-class file conflicts without a recorded maintainer decision`)
  }
  return failures
}

/**
 * Format a rehearsal as the lines the command prints.
 * @param rehearsal - the measured rehearsal.
 * @returns the merge, the conflicted paths, the conflict share, one count line per class and the total against the
 * caps, the absorbed entries, and the notes on the caps and on generated paths.
 */
export function formatRehearsal(rehearsal: Rehearsal): string[] {
  const { spec } = rehearsal
  const target = spec.target.name
  const source = spec.target.kind === 'tag' ? `from ${spec.repository}` : 'from this clone'
  const lines = [
    `rehearsal merge of ${target} (${rehearsal.targetCommit}) ${source} into HEAD ${spec.head}, pinned at ${spec.pin.ref} (${spec.pin.commit})`,
  ]
  if (rehearsal.conflicts.length === 0) {
    lines.push('conflicted paths: none')
  } else {
    lines.push(`conflicted paths: ${String(rehearsal.conflicts.length)}`)
    for (const conflict of rehearsal.conflicts) lines.push(`  ${conflict.path} (${conflict.class}, ${counted(conflict.hunks, 'hunk')})`)
  }
  lines.push(`conflicted hunks: ${conflictSummary(rehearsal)}, limit ${percent(CONFLICT_SHARE_LIMIT)}`)
  lines.push(`ledger growth from ${spec.pin.ref} to ${target}:`)
  for (const name of COUNTED_CLASSES) lines.push(`  ${name}: ${growthText(rehearsal.current[name], rehearsal.atTarget[name])}`)
  const total = growthText(totalCount(rehearsal.current), totalCount(rehearsal.atTarget), spec.caps)
  lines.push(`  total: ${total}`)
  if (rehearsal.absorbed.length > 0) {
    const credited = rehearsal.absorbed.reduce((sum, entry) => sum + entry.hunks, 0)
    lines.push(`absorbed by ${target} (credited): ${counted(rehearsal.absorbed.length, 'entry', 'entries')}, ${counted(credited, 'hunk')}`)
    for (const entry of rehearsal.absorbed) lines.push(`  ${entry.path} (${entry.class}, ${counted(entry.hunks, 'hunk')})`)
  }
  lines.push(spec.caps.baselineRecorded
    ? 'caps: 10 % of the first release\'s baseline, at least the floors of 20 entries and 150 hunks'
    : 'caps: the floors of 20 entries and 150 hunks; the first release\'s baseline is not recorded')
  lines.push('generated paths are counted with the rule-covered paths under ruled, not separated')
  return lines
}

/**
 * Fetch one tag into the scratch worktree's own `FETCH_HEAD`, so that no ref of the checkout changes.
 * @param tree - the scratch worktree.
 * @param repository - the upstream repository.
 * @param tag - the tag to fetch.
 * @returns the commit the tag names.
 * @throws Error when the fetch fails or the tag names no commit.
 */
function fetchTag(tree: string, repository: string, tag: string): string {
  const fetch = runGit(tree, [
    ...SCRATCH_CONFIG, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
    'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--', repository, `refs/tags/${tag}`,
  ])
  if (fetch.status !== 0) throw new Error(`cannot fetch tag ${tag} from ${repository}: ${fetch.stderr.trim()}`)
  return git(tree, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']).trim()
}

/**
 * Merge a commit into the scratch worktree without committing.
 * @param tree - the scratch worktree.
 * @param commit - the commit to merge.
 * @returns the conflicted paths; empty for a clean merge.
 * @throws Error when git fails other than by stopping at conflicts.
 */
function mergeWithoutCommit(tree: string, commit: string): string[] {
  const merge = runGit(tree, [...SCRATCH_CONFIG, ...SCRATCH_IDENTITY, 'merge', '--no-ff', '--no-commit', '--no-edit', '--quiet', commit])
  const conflicted = git(tree, ['diff', '--name-only', '--diff-filter=U', '-z']).split('\0').filter(path => path.length > 0)
  if (merge.status === 0 || (merge.status === 1 && conflicted.length > 0)) return conflicted
  throw new Error(`git merge ${commit} exited ${String(merge.status)}: ${`${merge.stderr}${merge.stdout}`.trim()}`)
}

/**
 * Count the conflict regions git wrote into a conflicted file.
 * @param tree - the scratch worktree.
 * @param path - the conflicted path.
 * @returns the number of opening markers, at least one.
 */
function conflictRegions(tree: string, path: string): number {
  const file = join(tree, path)
  if (!existsSync(file)) return 1
  return Math.max(1, readFileSync(file, 'utf8').match(/^<{7}(?: |$)/gmu)?.length ?? 0)
}

/**
 * Measure the scratch worktree against one upstream commit, per class.
 * @param tree - the scratch worktree.
 * @param manifest - the ledger whose entries name the classes, whose rules cover paths, and whose fork-owned paths are left out.
 * @param commit - the upstream commit to measure against.
 * @returns the counts per class, and the hunks of every differing path that is not fork-owned.
 */
function measure(tree: string, manifest: PatchManifest, commit: string): { counts: ClassCounts; hunks: ReadonlyMap<string, number> } {
  const hunks = new Map<string, number>()
  for (const change of changedSince(tree, commit)) {
    if (!isForkOwned(change.path, manifest.forkOwned)) hunks.set(change.path, hunkCount(tree, commit, change))
  }
  const listed = new Set(manifest.patches.map(patch => patch.path))
  const ofClass = (name: Patch['class']): Count => {
    const count = divergence({ ...manifest, patches: manifest.patches.filter(patch => patch.class === name) }, hunks, [])
    return { entries: count.entries, hunks: count.hunks }
  }
  const rest = [...hunks].filter(([path]) => !listed.has(path))
  const ruled = rest.filter(([path]) => coveringRules(path, manifest.rules).length > 0)
  const unlisted = rest.filter(([path]) => coveringRules(path, manifest.rules).length === 0)
  const total = (paths: ReadonlyArray<readonly [string, number]>): Count => ({ entries: paths.length, hunks: paths.reduce((sum, [, count]) => sum + count, 0) })
  return {
    counts: {
      'delorun-feature': ofClass('delorun-feature'),
      'generic-fix': ofClass('generic-fix'),
      security: ofClass('security'),
      ruled: total(ruled),
      unlisted: total(unlisted),
    },
    hunks,
  }
}

function conflictedHunks(rehearsal: Rehearsal): number {
  return rehearsal.conflicts.reduce((sum, conflict) => sum + conflict.hunks, 0)
}

function conflictSummary(rehearsal: Rehearsal): string {
  const hunks = totalCount(rehearsal.atTarget).hunks
  return `${String(conflictedHunks(rehearsal))} of ${counted(hunks, 'ledger hunk')} at ${rehearsal.spec.target.name} (${percent(conflictShare(rehearsal))})`
}

function growthText(before: Count, after: Count, caps?: BudgetCaps): string {
  const growth = difference(after, before)
  const cap = (limit: number | undefined): string => (limit === undefined ? '' : `, cap ${String(limit)}`)
  return `${String(before.entries)} → ${String(after.entries)} entries (${signed(growth.entries)}${cap(caps?.entries)}), `
    + `${String(before.hunks)} → ${String(after.hunks)} hunks (${signed(growth.hunks)}${cap(caps?.hunks)})`
}

function difference(after: Count, before: Count): Count {
  return { entries: after.entries - before.entries, hunks: after.hunks - before.hunks }
}

function signed(value: number): string {
  return value > 0 ? `+${String(value)}` : String(value)
}

function percent(share: number): string {
  return Number.isFinite(share) ? `${(share * 100).toFixed(1).replace(/\.0$/u, '')} %` : 'all'
}

function counted(count: number, singular: string, plural = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : plural}`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read the command line into a request.
 * @param argv - the arguments, without the script.
 * @returns the request, or undefined when the arguments do not name exactly one non-empty `--tag` or `--ref`.
 */
function readRequest(argv: readonly string[]): RehearsalRequest | undefined {
  let values: { tag?: string | undefined; ref?: string | undefined }
  try {
    values = parseArgs({ args: [...argv], options: { tag: { type: 'string' }, ref: { type: 'string' } }, strict: true, allowPositionals: false }).values
  } catch (error) {
    console.error(`rehearse-upstream: ${errorText(error)}`)
    return undefined
  }
  const { tag, ref } = values
  if (tag !== undefined && ref === undefined && tag.length > 0) return { tag }
  if (ref !== undefined && tag === undefined && ref.length > 0) return { ref }
  return undefined
}

function main(argv: readonly string[]): number {
  const request = readRequest(argv)
  if (request === undefined) {
    console.error(USAGE)
    return 2
  }
  let rehearsal: Rehearsal
  try {
    rehearsal = rehearse(resolveRehearsal(repositoryRoot(process.cwd()), request))
  } catch (error) {
    console.error(`rehearse-upstream: ${errorText(error)}`)
    return 2
  }
  for (const line of formatRehearsal(rehearsal)) console.log(line)
  const failures = budgetFailures(rehearsal)
  for (const failure of failures) console.error(`rehearse-upstream: ${failure}`)
  if (failures.length === 0) console.log(`rehearse-upstream: ${rehearsal.spec.target.name} merges within the divergence budget`)
  return failures.length === 0 ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
