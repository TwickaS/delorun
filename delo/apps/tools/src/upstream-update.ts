/**
 * The upstream update path: carry Delo's listed patches from the ledger's pin onto a later upstream tag, and verify the
 * result before the ledger records it. Run from anywhere inside the repository:
 *
 * ```sh
 * node_modules/.bin/tsx delo/apps/tools/src/upstream-update.ts --tag <tag> [--write]
 * ```
 *
 * `--tag` resolves the tag in the clone, applies every listed patch to that tag's commit in a scratch worktree, retires
 * the entries the tag already absorbed, renders the ledger that describes the result, and checks that ledger against
 * the applied tree; `--write` writes it once the release merge is in `HEAD`. A security entry is carried only when its
 * file still has the digest the ledger records, which `ledger-record.ts` writes. Paths that a path rule covers are not
 * carried as patches: the release merge brings them, and the rules carry over unchanged.
 * A refusal is reported with its code and the checkout is left unchanged. Nothing is fetched and no version is
 * bumped: the tag must already be in the clone, because the release merge is a separate, owner-approved action
 * (`rehearse-upstream.ts` measures that merge against the divergence budget).
 *
 * The ledger and the checksum record describe the checkout before the release merge, so the path measures that state
 * once, at the start of a run, and reads everything else from it: the ledger's shape, the recorded digests, the patch
 * text and the hunks at the pin. Once the merge is in `HEAD` that state is the fork's own side of the merge, found by
 * walking first parents; measuring `HEAD` instead would read the release's own changes as the fork's, and trusting a
 * clean `git diff` against the tag would record a dropped patch as absorbed.
 *
 * @module @delo/tools/upstream-update
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { changedBetween, changedSince, hunkCount, treeFiles } from './check-fork-boundary.ts'
import { forkBoundaryErrors, MANIFEST_PATH, manifestErrors, parseManifest, type Patch, type PatchManifest } from './fork-boundary.ts'
import { git, repositoryRoot, runGit } from './git.ts'
import { commitDigests, digestDefects, digestErrors, patchDigest, securityPaths, worktreeDigests } from './ledger-digests.ts'
import { SCRATCH_CONFIG, sweepScratchWorktrees, withScratchWorktree } from './scratch-worktree.ts'

/** The prefix of the update path's scratch directory, which the specs look for when they check for residue. */
export const SCRATCH_PREFIX = 'delo-update-'

/**
 * The codes a refusal is reported under. Each names the check that stopped the update: the ledger's pin, the checksum
 * record, the patch application, the verification of the carried ledger, or the merge it would be recorded against.
 */
export type RefusalCode =
  | 'baseline-tag-missing'
  | 'baseline-commit-mismatch'
  | 'ledger-inconsistent'
  | 'measurement-failed'
  | 'merge-side-missing'
  | 'checksum-drift'
  | 'patch-deletes-file'
  | 'patch-does-not-apply'
  | 'verification-failed'
  | 'merge-not-landed'

/**
 * One reason the update path stopped. A refusal is data rather than a thrown error, so one run reports every check
 * that failed instead of only the first.
 */
export interface Refusal {
  /** Which check refused. */
  readonly code: RefusalCode
  /** What failed and what would make it pass, in a line a person can act on. */
  readonly message: string
  /** The upstream path the refusal names, when it names one. */
  readonly path?: string
}

/** What the command line asks for: the tag to carry the patch set onto, and whether the run writes the ledger. */
export interface UpdateRequest {
  /** The upstream tag to carry the patch set onto. */
  readonly tag: string
  /** Write the carried ledger into the checkout; without it the command reports what it would write. */
  readonly write: boolean
}

/** The ledger's upstream pin. */
export interface Baseline {
  /** The upstream tag the ledger pins, `upstream.ref`. */
  readonly ref: string
  /** The commit the ledger records for it, `upstream.commit`. */
  readonly commit: string
}

/**
 * The state the ledger and its checksum record describe: the checkout as it stood before the release merge. A run
 * measures it once and threads it through every check and every patch it reads, so no check can be skipped or read the
 * release's own changes as the fork's because the merge is already in `HEAD`.
 */
export interface Measured {
  /** The commit whose tree the ledger describes: `HEAD` before the merge, the fork's own side of it after. */
  readonly commit: string
  /** True while that commit is `HEAD`, so the checkout's uncommitted work is part of what the ledger describes too. */
  readonly checkout: boolean
}

/** A listed patch that still differs from the target. */
export interface CarriedEntry {
  /** Repository-relative path. */
  readonly path: string
  /** The entry's class. */
  readonly class: PatchManifest['patches'][number]['class']
  /** The digest of a security entry's content in the applied tree, which the carried ledger records; absent for the other classes. */
  readonly sha256?: string
  /** The hunks the patch has against the target, as `git diff --unified=0` splits them. */
  readonly hunks: number
}

/** A listed patch the target absorbed, retired by the carry-forward. */
export interface RetiredEntry {
  /** Repository-relative path. */
  readonly path: string
  /** The hunks the entry had at the pin, which its retired entry records as the credit. */
  readonly hunks: number
}

/** A carry-forward that passed every check: what the ledger would say after the release merge. */
export interface UpdatePlan {
  /** The checkout the plan was made in. */
  readonly root: string
  /** The tag the patch set was carried onto. */
  readonly tag: string
  /** The commit the tag names. */
  readonly targetCommit: string
  /** The checkout's `HEAD` when the plan was made. */
  readonly head: string
  /** The state the ledger and the patch set were measured against, which is `head` until the release merge lands. */
  readonly measured: Measured
  /** The ledger's pin before the update. */
  readonly baseline: Baseline
  /** The listed patches that still differ from the target, in ledger order. */
  readonly carried: readonly CarriedEntry[]
  /** The listed patches the target absorbed, in ledger order. */
  readonly absorbed: readonly RetiredEntry[]
  /** The carried ledger's text. */
  readonly ledger: string
}

/** The outcome of one run: the refusals, and the plan when none refused. */
export interface UpdateOutcome {
  /** Every check that refused, in the order the path checks them; empty when the plan holds. */
  readonly refusals: readonly Refusal[]
  /** The carry-forward, absent when a check refused. */
  readonly plan?: UpdatePlan
}

/** A failure that stops the run before it can check anything: a bad input, or git failing under the path. */
export class UpstreamUpdateError extends Error {
  /** The failure's code, such as `target-tag-missing`. */
  readonly code: string

  /**
   * @param code - the failure's code, such as `target-tag-missing`.
   * @param message - what failed and what would make it pass.
   */
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'UpstreamUpdateError'
  }
}

const USAGE = 'usage: upstream-update.ts --tag <tag> [--write]'

/**
 * Read the ledger at `HEAD`, so a run measures the committed patch set rather than a working tree in flux.
 * @param root - the repository root.
 * @returns the parsed ledger.
 * @throws UpstreamUpdateError when the ledger is absent from `HEAD` or does not parse.
 */
export function headManifest(root: string): PatchManifest {
  const text = runGit(root, ['show', `HEAD:${MANIFEST_PATH}`])
  if (text.status !== 0) throw new UpstreamUpdateError('ledger-missing', `${MANIFEST_PATH} is not in HEAD: ${text.stderr.trim()}`)
  try {
    return parseManifest(text.stdout)
  } catch (error) {
    throw new UpstreamUpdateError('ledger-invalid', error instanceof Error ? error.message : String(error))
  }
}

/**
 * Resolve a tag in the clone. The update path never fetches: the release merge is the owner-approved action that brings
 * the tag in, and a tag this clone lacks cannot be merged either.
 * @param root - the repository root.
 * @param tag - the tag name.
 * @returns the commit the tag names.
 * @throws UpstreamUpdateError when the tag is absent from the clone.
 */
export function resolveTag(root: string, tag: string): string {
  const run = runGit(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`])
  if (run.status !== 0) {
    throw new UpstreamUpdateError('target-tag-missing', `tag ${tag} is not in this clone; merge the release it names first, then retry`)
  }
  return run.stdout.trim()
}

/**
 * Check the ledger's pin against the clone: the tag it names must be here, and it must name the recorded commit.
 * @param root - the repository root.
 * @param manifest - the ledger at `HEAD`.
 * @returns the pin and the refusals; the pin is absent when either check refused.
 */
export function resolveBaseline(root: string, manifest: PatchManifest): { readonly baseline?: Baseline; readonly refusals: Refusal[] } {
  const { ref, commit } = manifest.upstream
  const resolved = runGit(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${ref}^{commit}`])
  if (resolved.status !== 0) {
    return {
      refusals: [{
        code: 'baseline-tag-missing',
        message: `the ledger pins ${ref}, which is not in this clone; fetch the tag or correct upstream.ref in ${MANIFEST_PATH}`,
      }],
    }
  }
  const tagCommit = resolved.stdout.trim()
  if (tagCommit !== commit) {
    return {
      refusals: [{
        code: 'baseline-commit-mismatch',
        message: `the ledger pins ${ref} at ${commit}, but the tag in this clone names ${tagCommit}; ${MANIFEST_PATH} and the tag disagree`,
      }],
    }
  }
  return { baseline: { ref, commit }, refusals: [] }
}

/**
 * Check that the ledger describes the state the patch set is measured in: every difference from the pin is a listed
 * entry or covered by a path rule, every listed entry still differs, and no entry is both retired and still different. A bump starts from a
 * coherent ledger, so this refuses before anything is applied.
 * @param root - the repository root.
 * @param manifest - the ledger at `HEAD`.
 * @param measured - the state the ledger describes, from {@link measuredState}.
 * @returns one refusal per violation of the ledger's rules; empty when the ledger describes the measured state.
 */
export function checkLedger(root: string, manifest: PatchManifest, measured: Measured): Refusal[] {
  const pin = manifest.upstream.commit
  const changed = measured.checkout ? changedSince(root, pin) : changedBetween(root, pin, measured.commit)
  return forkBoundaryErrors(manifest, changed, filesOf(root, measured))
    .map(message => ({ code: 'ledger-inconsistent' as const, message: `${message}; the ledger must describe the checkout before the patch set is carried` }))
}

/**
 * Every path present in the measured state, which the ledger rules use to spot compiled output beside its source. The
 * checkout brings its untracked files along; a commit measured behind the merge brings what its tree holds.
 * @param root - the repository root.
 * @param measured - the state the ledger describes.
 * @returns the paths, repository-relative with `/` separators.
 */
function filesOf(root: string, measured: Measured): Set<string> {
  if (!measured.checkout) return treeFiles(root, measured.commit)
  return new Set(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(path => path.length > 0))
}

/**
 * Check the listed files and the checksum record: every listed path must hold a file in the measured state, because no
 * entry may delete the file it names, and every digest a security entry records must match its file there, because a
 * changed security file would otherwise travel without the lead's review. `manifestErrors` has already refused a
 * security entry that records no digest.
 * @param root - the repository root.
 * @param manifest - the ledger at `HEAD`.
 * @param measured - the state the ledger describes, from {@link measuredState}.
 * @returns one refusal per listed path with no file, and one per drifted digest.
 */
export function checkDigests(root: string, manifest: PatchManifest, measured: Measured): Refusal[] {
  const refusals: Refusal[] = []
  const digests = commitDigests(root, measured.commit, manifest.patches.map(patch => patch.path))
  for (const patch of manifest.patches) {
    if (digests.has(patch.path)) continue
    refusals.push({
      code: 'patch-deletes-file',
      path: patch.path,
      message: `${patch.path} is listed in ${MANIFEST_PATH}, but ${where(measured)} holds no file there; a listed patch must edit the file it`
        + ' names, so restore it, or drop the entry and let upstream own the path',
    })
  }
  for (const defect of digestDefects(manifest, digests)) {
    if (defect.kind === 'missing') continue
    refusals.push({
      code: 'checksum-drift',
      path: defect.path,
      message: `${defect.path}: recorded sha256 ${defect.recorded}, but the file is ${defect.actual};`
        + ' the lead reviews the change, then `ledger-record.ts` re-records the digest',
    })
  }
  return refusals
}

/**
 * Name the measured state in a message a person can act on.
 * @param measured - the state the ledger describes.
 * @returns `HEAD`, or the pre-merge commit's short id when the release merge is in `HEAD`.
 */
function where(measured: Measured): string {
  return measured.checkout ? 'HEAD' : `the pre-merge state ${measured.commit.slice(0, 12)}`
}

/**
 * The patch text that turns a file at the pin into the fork's version of it in the measured state.
 * @param root - the repository root.
 * @param baseline - the commit the ledger pins.
 * @param commit - the commit holding the fork's version, which is the measured state and not `HEAD` once a release merge
 * is in `HEAD`: a patch taken across the merge would carry the release's own changes as the fork's.
 * @param path - the upstream path.
 * @returns the diff, binary-safe and without renames, so that `git apply` reproduces the content exactly.
 */
function patchText(root: string, baseline: string, commit: string, path: string): string {
  return git(root, ['diff', '--binary', '--no-renames', '--no-color', '--no-ext-diff', baseline, commit, '--', path])
}

/**
 * The hunks a listed patch has at the pin, which a retired entry records as the credit against the divergence budget.
 * @param root - the repository root.
 * @param baseline - the commit the ledger pins.
 * @param commit - the commit holding the fork's version, the measured state, for the reason {@link patchText} gives.
 * @param path - the upstream path.
 * @returns the number of `@@` headers in the patch.
 */
function hunksAtPin(root: string, baseline: string, commit: string, path: string): number {
  return git(root, ['diff', '--no-color', '--no-ext-diff', '--no-renames', '--unified=0', baseline, commit, '--', path])
    .split('\n').filter(line => line.startsWith('@@')).length
}

/**
 * Apply one patch to a scratch tree, three-way so a target that moved the surrounding lines still takes it.
 * @param tree - the scratch worktree, detached at the target commit.
 * @param text - the patch text.
 * @returns git's exit status and its output, for the refusal that names why the patch did not apply.
 */
function applyPatch(tree: string, text: string): { readonly status: number | null; readonly output: string } {
  const run = runGit(tree, [...SCRATCH_CONFIG, 'apply', '--3way', '--whitespace=nowarn'], text)
  return { status: run.status, output: `${run.stderr}${run.stdout}`.trim() }
}

/**
 * Render the ledger that describes the release merge, and check that its text is one the ledger parser and the entry
 * rules accept. Each carried entry keeps its feature and reason, a security entry records its digest in the applied
 * tree, and the path rules carry over unchanged.
 * @param manifest - the ledger at `HEAD`.
 * @param tag - the target tag.
 * @param targetCommit - the commit the tag names.
 * @param carried - the entries that still differ from the target.
 * @param absorbed - the entries the target absorbed.
 * @returns the carried ledger's text and one refusal per defect the ledger would have.
 */
export function carriedLedger(
  manifest: PatchManifest, tag: string, targetCommit: string, carried: readonly CarriedEntry[], absorbed: readonly RetiredEntry[],
): { readonly ledger: string; readonly refusals: Refusal[] } {
  const listed = new Map(manifest.patches.map(patch => [patch.path, patch]))
  const carriedManifest: PatchManifest = {
    ...manifest,
    upstream: { ...manifest.upstream, ref: tag, commit: targetCommit },
    patches: carried.map((entry): Patch => {
      const patch = listed.get(entry.path)
      return {
        path: entry.path,
        class: entry.class,
        ...patch?.feature === undefined ? {} : { feature: patch.feature },
        reason: patch?.reason ?? '',
        ...entry.sha256 === undefined ? {} : { sha256: entry.sha256 },
      }
    }),
    retired: [
      ...manifest.retired,
      ...absorbed.map(entry => ({ path: entry.path, reason: 'absorbed' as const, upstreamCommit: targetCommit, hunks: entry.hunks })),
    ],
  }
  const ledger = `${JSON.stringify(carriedManifest, null, 2)}\n`
  return { ledger, refusals: ledgerDefects(ledger, carriedManifest) }
}

/**
 * Check a carried ledger's text against the reader and the entry rules.
 * @param ledger - the ledger's text.
 * @param manifest - the ledger it renders.
 * @returns one refusal per defect; empty when the text holds.
 */
function ledgerDefects(ledger: string, manifest: PatchManifest): Refusal[] {
  const defects: string[] = manifestErrors(manifest)
  try {
    parseManifest(ledger)
  } catch (error) {
    defects.push(error instanceof Error ? error.message : String(error))
  }
  return defects.map(message => ({ code: 'verification-failed' as const, message: `the carried ledger would not hold: ${message}` }))
}

/**
 * Verify a carried patch set describes the applied tree: every difference from the target is a listed entry or covered
 * by a path rule, every listed entry still differs, every carried security digest matches the applied file, and no listed patch vanished from
 * both lists.
 * @param manifest - the carried ledger, re-read as a reader would read it.
 * @param tree - the scratch worktree with the patch set applied.
 * @param targetCommit - the commit the target tag names.
 * @param listed - the patches the ledger listed before the carry-forward.
 * @param absorbed - the entries the carry-forward retired.
 * @returns one refusal per violation; empty when the applied tree and the ledger agree.
 */
export function verifyApplied(
  manifest: PatchManifest, tree: string, targetCommit: string, listed: readonly string[], absorbed: readonly RetiredEntry[],
): Refusal[] {
  const changed = changedSince(tree, targetCommit)
  const files = new Set(git(tree, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(path => path.length > 0))
  const digests = worktreeDigests(tree, securityPaths(manifest))
  const accounted = new Set([...manifest.patches.map(patch => patch.path), ...absorbed.map(entry => entry.path)])
  const dropped = listed.filter(path => !accounted.has(path))
  return [
    ...forkBoundaryErrors(manifest, changed, files),
    ...digestErrors(manifest, digests),
    ...dropped.map(path => `${path}: listed in the ledger, but the applied tree neither carries it nor absorbed it`),
  ].map(message => ({ code: 'verification-failed' as const, message: `the applied tree and the carried ledger disagree: ${message}` }))
}

/**
 * Carry the patch set onto a tag and verify the result.
 * @param root - the repository root.
 * @param tag - the upstream tag to carry the patch set onto.
 * @param write - write the carried ledger into the checkout instead of only reporting it.
 * @returns the refusals, and the plan when every check passed.
 * @throws UpstreamUpdateError when the tag is absent from the clone or the ledger at `HEAD` is unusable.
 */
export function carryForward(root: string, tag: string, write = false): UpdateOutcome {
  const manifest = headManifest(root)
  const targetCommit = resolveTag(root, tag)
  const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim()
  const { baseline, refusals: pinRefusals } = resolveBaseline(root, manifest)
  // A pin that does not resolve leaves nothing to measure the checkout against, so only that refusal is reported.
  if (baseline === undefined) return { refusals: pinRefusals }
  const pinned = baseline
  // The ledger and its checksum record describe the checkout as it stood before the release merge, so that state is
  // measured once here and read by every check and every patch below. Once the merge is in HEAD this is the fork's own
  // side of it: the same run that lands the merge is the run whose checks would otherwise be skipped, and a patch taken
  // across the merge would carry the release's changes as the fork's. A history that names no such side refuses here,
  // before a check can read the pin as the state and call the patch set absorbed.
  const state = measuredState(root, head, pinned, targetCommit)
  if (state.measured === undefined) return { refusals: state.refusals }
  const measured = state.measured
  const ledgerRefusals = guarded(() => checkLedger(root, manifest, measured))
  if (ledgerRefusals.length > 0) return { refusals: ledgerRefusals }
  // Only a ledger that holds is asked for its digests: a path the object store cannot read back would otherwise be
  // answered for by another file's content.
  const digestRefusals = guarded(() => checkDigests(root, manifest, measured))
  if (digestRefusals.length > 0) return { refusals: digestRefusals }

  // A run that was killed cannot remove its own scratch worktree, so the next run sweeps what the clone still
  // registers before it adds one of its own.
  sweepScratchWorktrees(root, SCRATCH_PREFIX)

  const applied = withScratchWorktree(root, targetCommit, (tree): { refusals: Refusal[]; carried?: CarriedEntry[]; absorbed?: RetiredEntry[]; ledger?: string } => {
    const failures: Refusal[] = []
    for (const patch of manifest.patches) {
      // The entry's patch is the fork's own change at the pin, and it is applied to the target in every case: whether
      // the release absorbed the change is then a fact about the applied tree, not an inference from the merge.
      const run = applyPatch(tree, patchText(root, pinned.commit, measured.commit, patch.path))
      if (run.status === 0) continue
      failures.push({
        code: 'patch-does-not-apply',
        path: patch.path,
        message: `${patch.path} no longer applies to ${tag}`
          + `${patch.class === 'security' ? ', and it is a security-class change that needs a lead\'s verdict' : ''}`
          + `; reconcile it by hand: ${run.output}`,
      })
    }
    if (failures.length > 0) return { refusals: failures }
    const changes = new Map(changedSince(tree, targetCommit).map(change => [change.path, change]))
    const carried: CarriedEntry[] = []
    const absorbed: RetiredEntry[] = []
    const deleted: Refusal[] = []
    for (const patch of manifest.patches) {
      const change = changes.get(patch.path)
      // A patch the target already holds leaves the file identical to the target's, which is what absorption means.
      if (change === undefined) {
        absorbed.push({ path: patch.path, hunks: hunksAtPin(root, pinned.commit, measured.commit, patch.path) })
        continue
      }
      // A listed patch edits the file it names; no entry may delete one, and a deleted path holds no content to record.
      if (change.status === 'deleted') {
        deleted.push({
          code: 'patch-deletes-file',
          path: patch.path,
          message: `${patch.path}: applying its patch to ${tag} deletes the file; a listed patch must edit the file it names,`
            + ' so reconcile the release by hand',
        })
        continue
      }
      carried.push({
        path: patch.path,
        class: patch.class,
        ...patch.class === 'security' ? { sha256: patchDigest(readFileSync(join(tree, patch.path))) } : {},
        hunks: hunkCount(tree, targetCommit, change),
      })
    }
    if (deleted.length > 0) return { refusals: deleted }
    const rendered = carriedLedger(manifest, tag, targetCommit, carried, absorbed)
    const verified = verifyApplied(parseManifest(rendered.ledger), tree, targetCommit, manifest.patches.map(patch => patch.path), absorbed)
    return { refusals: [...rendered.refusals, ...verified], carried, absorbed, ledger: rendered.ledger }
  }, SCRATCH_PREFIX)
  if (applied.carried === undefined || applied.absorbed === undefined || applied.ledger === undefined || applied.refusals.length > 0) {
    return { refusals: applied.refusals }
  }
  const plan: UpdatePlan = {
    root,
    tag,
    targetCommit,
    head,
    measured,
    baseline: pinned,
    carried: applied.carried,
    absorbed: applied.absorbed,
    ledger: applied.ledger,
  }
  if (!write) return { refusals: [], plan }
  return { refusals: writeBack(root, plan), plan }
}

/**
 * Measure the state the ledger and the checksum record describe, once. While the release merge is not in `HEAD` that
 * state is the checkout itself, uncommitted work included; once it is, the state is the fork's own side of the merge,
 * which is found by walking first parents down to the commit that brought the release in.
 *
 * The merge is in `HEAD` only when the release arrived with it, which is what the pin rules out: a fork's pin is always
 * an ancestor of `HEAD`, and a tag at or below the pin is in `HEAD`'s history already. Reading that as a landed merge
 * walked the first parents down to the pin, measured the pin's own tree, and so saw none of the patch set — every entry
 * then looked absorbed and the run would have retired the lot.
 * @param root - the repository root.
 * @param head - the checkout's `HEAD`.
 * @param baseline - the ledger's pin, the oldest state its entries can describe, where the walk stops.
 * @param targetCommit - the release the patch set is carried onto.
 * @returns the measured state, or one refusal when it cannot be named.
 */
export function measuredState(root: string, head: string, baseline: Baseline, targetCommit: string): MeasuredState {
  if (!isAncestor(root, targetCommit, head) || isAncestor(root, targetCommit, baseline.commit)) {
    return { measured: { commit: head, checkout: true }, refusals: [] }
  }
  return forkSide(root, head, baseline.commit, targetCommit)
}

/** What measuring the state the ledger describes found. */
export interface MeasuredState {
  /** The state the ledger describes, absent when the history cannot name it. */
  readonly measured?: Measured
  /** One refusal when `HEAD` holds the release with no fork commit above the pin to measure; empty otherwise. */
  readonly refusals: readonly Refusal[]
}

/**
 * The refusal for a walk that reaches the pin: there the history holds the release above the pin itself, so the only
 * state the walk can name is the pin, which has none of the fork's changes. A run that measured it would see no
 * differing path, classify every entry as absorbed and retire the whole patch set.
 * @param pin - the commit the walk stopped at.
 * @param targetCommit - the release the walk looked for.
 * @returns the refusal.
 */
function pinReached(pin: string, targetCommit: string): Refusal {
  return {
    code: 'merge-side-missing',
    path: MANIFEST_PATH,
    message: `the walk from HEAD reaches the pin ${pin} without passing a fork commit that lacks the release ${targetCommit},`
      + ' so the state the ledger describes is not in this history: measuring the pin would show every listed patch as absorbed;'
      + ' land the release on the fork\'s own side with a merge commit (git merge --no-ff), or correct upstream.commit in the ledger',
  }
}

/**
 * The fork's own state before the release merge: the side of the commit that brought the release into `head`. Merging
 * the release into the fork makes the release an ancestor of `head`, so `git merge-base head <tag>` answers the release
 * itself; the state the ledger describes sits one first-parent step below the merge, and this walks to it, past the
 * merge commit and any commit made on top of it since.
 *
 * A release that arrives by fast-forward is the one case with no such step: there the fork's own tree and the release's
 * are the same commit, and that commit is the state the ledger describes.
 * @param root - the repository root.
 * @param head - the commit the release merge landed in.
 * @param pin - the ledger's pin, where the walk stops.
 * @param targetCommit - the release the patch set is carried onto.
 * @returns the commit whose tree the ledger describes, or the refusal for a walk that reaches the pin.
 */
function forkSide(root: string, head: string, pin: string, targetCommit: string): MeasuredState {
  let cursor = head
  while (cursor !== pin) {
    const fields = git(root, ['rev-list', '--parents', '-n', '1', cursor]).trim().split(' ')
    const first = fields[1]
    if (first === undefined) return { measured: { commit: cursor, checkout: false }, refusals: [] }
    if (!isAncestor(root, targetCommit, first)) {
      const side = fields.length > 2 ? first : cursor
      // The pin is where the walk stops and the oldest state the entries can describe, so a side that is the pin names
      // no fork commit at all: the release sits on the pin, and the ledger's state is not in this history.
      if (side === pin) return { refusals: [pinReached(pin, targetCommit)] }
      return { measured: { commit: side, checkout: false }, refusals: [] }
    }
    cursor = first
  }
  return { refusals: [pinReached(pin, targetCommit)] }
}

/**
 * Run one check, turning a failure inside it into a refusal. The checks shell out to git and read the object store, so
 * a failure there is a refusal the run reports rather than an exception that ends it without a code.
 * @param check - the check to run.
 * @returns the check's refusals, or one refusal naming the failure.
 */
function guarded(check: () => Refusal[]): Refusal[] {
  try {
    return check()
  } catch (error) {
    return [{
      code: 'measurement-failed',
      message: `the pre-merge state could not be measured: ${error instanceof Error ? error.message : String(error)};`
        + ' repair the checkout and run the same command again',
    }]
  }
}

/**
 * Whether a commit is in `HEAD`'s history.
 * @param root - the repository root.
 * @param commit - the commit to look for.
 * @param head - the commit to search from.
 * @returns true when `commit` is `head` or one of its ancestors.
 */
function isAncestor(root: string, commit: string, head: string): boolean {
  return runGit(root, ['merge-base', '--is-ancestor', commit, head]).status === 0
}

/**
 * Write the carried ledger, after checking that `HEAD` holds the release merge it describes: a ledger written for a
 * release the checkout does not hold would pin a commit no merge reaches. The update path expects the ledger to be part
 * of the merge commit's tree, so the merge and the ledger land together.
 * @param root - the repository root.
 * @param plan - the verified carry-forward.
 * @returns one refusal when the release is not in `HEAD`'s history, and none when the ledger was written.
 */
export function writeBack(root: string, plan: UpdatePlan): Refusal[] {
  if (!isAncestor(root, plan.targetCommit, git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim())) {
    return [{
      code: 'merge-not-landed',
      message: `${plan.tag} (${plan.targetCommit}) is not in HEAD's history; merge the release, then run the same command with --write`,
    }]
  }
  writeFileSync(join(root, MANIFEST_PATH), plan.ledger)
  return []
}

/**
 * Format a carry-forward as the lines the command prints.
 * @param plan - the verified carry-forward.
 * @returns the merge it describes, the carried entries with their digests, the absorbed entries, and the verification.
 */
export function formatPlan(plan: UpdatePlan): string[] {
  const lines = [
    `carry-forward onto ${plan.tag} (${plan.targetCommit}) from pin ${plan.baseline.ref} (${plan.baseline.commit}) at HEAD ${plan.head}`
      + `${plan.measured.commit === plan.head ? '' : `, measured at the pre-merge state ${plan.measured.commit.slice(0, 12)}`}`,
    `carried: ${counted(plan.carried.length, 'entry', 'entries')}, ${counted(hunksOf(plan.carried), 'hunk')}`,
  ]
  for (const entry of plan.carried) {
    const digest = entry.sha256 === undefined ? '' : `, sha256 ${entry.sha256.slice(0, 12)}`
    lines.push(`  ${entry.path} (${entry.class}, ${counted(entry.hunks, 'hunk')}${digest})`)
  }
  if (plan.absorbed.length > 0) {
    lines.push(`absorbed by ${plan.tag} (retired): ${counted(plan.absorbed.length, 'entry', 'entries')}, ${counted(hunksOf(plan.absorbed), 'hunk')} at the pin`)
    for (const entry of plan.absorbed) lines.push(`  ${entry.path}`)
  }
  lines.push(`verified: every listed patch applies to ${plan.tag}, and the carried ledger describes the applied tree`)
  return lines
}

/**
 * Total the hunks of the carried or retired entries.
 * @param entries - the entries.
 * @returns their hunks.
 */
function hunksOf(entries: readonly { readonly hunks: number }[]): number {
  return entries.reduce((total, entry) => total + entry.hunks, 0)
}

/**
 * Format a count with its noun.
 * @param count - the number.
 * @param singular - the noun in the singular.
 * @param plural - the noun in the plural.
 * @returns such as `1 entry` or `3 entries`.
 */
function counted(count: number, singular: string, plural = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : plural}`
}

/**
 * Report refusals on standard error.
 * @param refusals - the refusals to report.
 * @returns 1, the status a refusal exits with.
 */
function refuse(refusals: readonly Refusal[]): number {
  for (const refusal of refusals) console.error(`upstream-update: ${refusal.code}: ${refusal.message}`)
  return 1
}

/**
 * Run the command line.
 * @param argv - the arguments, without the script.
 * @returns the exit status: 0 when the carry-forward finished, 1 for a refusal, 2 for a bad command line or an unusable input.
 */
export function main(argv: readonly string[]): number {
  let request: UpdateRequest
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: { tag: { type: 'string' }, write: { type: 'boolean', default: false } },
      strict: true,
      allowPositionals: false,
    })
    if (values.tag === undefined) {
      console.error(USAGE)
      return 2
    }
    request = { tag: values.tag, write: values.write }
  } catch (error) {
    console.error(`upstream-update: ${error instanceof Error ? error.message : String(error)}`)
    console.error(USAGE)
    return 2
  }
  try {
    const root = repositoryRoot(process.cwd())
    const outcome = carryForward(root, request.tag, request.write)
    if (outcome.plan !== undefined && outcome.refusals.length === 0) for (const line of formatPlan(outcome.plan)) console.log(line)
    if (outcome.refusals.length > 0) return refuse(outcome.refusals)
    console.log(request.write
      ? `upstream-update: ${MANIFEST_PATH} now pins ${request.tag}`
      : 'upstream-update: dry run; pass --write once the release merge is in HEAD to record it')
    return 0
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    console.error(`upstream-update: ${error instanceof UpstreamUpdateError ? `${error.code}: ` : ''}${text}`)
    return 2
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
