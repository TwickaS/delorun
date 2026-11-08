/**
 * The upstream update path: carry Delo's patch set from the ledger's pin onto a later upstream tag, and verify the
 * result before the ledger records it. Run from anywhere inside the repository:
 *
 * ```sh
 * node_modules/.bin/tsx delo/apps/tools/src/upstream-update.ts --record
 * node_modules/.bin/tsx delo/apps/tools/src/upstream-update.ts --tag <tag> [--write]
 * ```
 *
 * `--record` writes the SHA-256 digest of every listed patch's content at `HEAD` into the ledger, which is the record
 * a carry-forward holds each entry to. `--tag` resolves the tag in the clone, applies every listed patch to that tag's
 * commit in a scratch worktree, retires the entries the tag already absorbed, renders the ledger that describes the
 * result, and checks that ledger against the applied tree; `--write` writes it once the release merge is in `HEAD`.
 * A refusal is reported with its code and the checkout is left unchanged. Nothing is fetched and no version is
 * bumped: the tag must already be in the clone, because the release merge is a separate, owner-approved action
 * (`rehearse-upstream.ts` measures that merge against the divergence budget).
 *
 * @module @delo/tools/upstream-update
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { changedSince, hunkCount } from './check-fork-boundary.ts'
import { forkBoundaryErrors, MANIFEST_PATH, manifestErrors, parseManifest, type PatchManifest } from './fork-boundary.ts'
import { git, repositoryRoot, runGit } from './git.ts'
import { digestErrors, headDigests, patchDigest, unrecorded, worktreeDigests } from './ledger-digests.ts'
import { SCRATCH_CONFIG, withScratchWorktree } from './scratch-worktree.ts'

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
  | 'checksum-unrecorded'
  | 'checksum-drift'
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

/** What the command line asks for: one of the two modes, and whether a carry-forward writes the ledger. */
export interface UpdateRequest {
  /** Record the digest of every listed patch at `HEAD`, and change nothing else. */
  readonly record?: boolean
  /** The upstream tag to carry the patch set onto. */
  readonly tag?: string
  /** Write the carried ledger into the checkout; without it the command reports what it would write. */
  readonly write?: boolean
}

/** The ledger's upstream pin. */
export interface Baseline {
  /** The upstream tag the ledger pins, `upstream.ref`. */
  readonly ref: string
  /** The commit the ledger records for it, `upstream.commit`. */
  readonly commit: string
}

/** A listed patch that still differs from the target. */
export interface CarriedEntry {
  /** Repository-relative path. */
  readonly path: string
  /** The entry's class. */
  readonly class: PatchManifest['patches'][number]['class']
  /** The digest of the patch's content in the applied tree, which the carried ledger records. */
  readonly sha256: string
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
  /**
   * @param code - the failure's code, such as `target-tag-missing`.
   * @param message - what failed and what would make it pass.
   */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'UpstreamUpdateError'
  }
}

const USAGE = 'usage: upstream-update.ts --record | --tag <tag> [--write]'

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
 * Check that the ledger describes the checkout the patch set is measured in: every difference from the pin is a listed
 * entry, every listed entry still differs, and no entry is both retired and still different. A bump starts from a
 * coherent ledger, so this refuses before anything is applied.
 * @param root - the repository root.
 * @param manifest - the ledger at `HEAD`.
 * @returns one refusal per violation of the ledger's rules; empty when the ledger describes the checkout.
 */
export function checkLedger(root: string, manifest: PatchManifest): Refusal[] {
  const changed = changedSince(root, manifest.upstream.commit)
  const files = new Set(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(path => path.length > 0))
  return [...manifestErrors(manifest), ...forkBoundaryErrors(manifest, changed, files)]
    .map(message => ({ code: 'ledger-inconsistent' as const, message: `${message}; the ledger must describe the checkout before the patch set is carried` }))
}

/**
 * Check the checksum record: every listed patch must record a digest, and every recorded digest must match the file at
 * `HEAD`. Without a complete record the patch set cannot be carried, because a changed file would travel unnoticed.
 * @param root - the repository root.
 * @param manifest - the ledger at `HEAD`.
 * @returns one refusal for the unrecorded entries and one per drifted digest; empty when the record holds.
 */
export function checkDigests(root: string, manifest: PatchManifest): Refusal[] {
  const refusals: Refusal[] = []
  const missing = unrecorded(manifest)
  if (missing.length > 0) {
    refusals.push({
      code: 'checksum-unrecorded',
      message: `${String(missing.length)} of ${String(manifest.patches.length)} listed patches record no sha256, starting with ${missing[0] ?? ''};`
        + ' run `upstream-update.ts --record` and commit the ledger before carrying the patch set',
      ...missing[0] === undefined ? {} : { path: missing[0] },
    })
  }
  for (const error of digestErrors(manifest, headDigests(root, manifest.patches.map(patch => patch.path)))) {
    refusals.push({ code: 'checksum-drift', message: `${error}; re-record it with \`upstream-update.ts --record\` once the change is reviewed` })
  }
  return refusals
}

/**
 * The patch text that turns a file at the pin into the fork's version at `HEAD`.
 * @param root - the repository root.
 * @param baseline - the commit the ledger pins.
 * @param head - the checkout's `HEAD`.
 * @param path - the upstream path.
 * @returns the diff, binary-safe and without renames, so that `git apply` reproduces the content exactly.
 */
function patchText(root: string, baseline: string, head: string, path: string): string {
  return git(root, ['diff', '--binary', '--no-renames', '--no-color', '--no-ext-diff', baseline, head, '--', path])
}

/**
 * The hunks a listed patch has at the pin, which a retired entry records as the credit against the divergence budget.
 * @param root - the repository root.
 * @param baseline - the commit the ledger pins.
 * @param head - the checkout's `HEAD`.
 * @param path - the upstream path.
 * @returns the number of `@@` headers in the patch.
 */
function hunksAtPin(root: string, baseline: string, head: string, path: string): number {
  return git(root, ['diff', '--no-color', '--no-ext-diff', '--no-renames', '--unified=0', baseline, head, '--', path])
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
 * rules accept.
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
  const reasons = new Map(manifest.patches.map(patch => [patch.path, patch.reason]))
  const carriedManifest: PatchManifest = {
    ...manifest,
    upstream: { ...manifest.upstream, ref: tag, commit: targetCommit },
    patches: carried.map(entry => ({ path: entry.path, class: entry.class, reason: reasons.get(entry.path) ?? '', sha256: entry.sha256 })),
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
 * Verify a carried patch set describes the applied tree: every difference from the target is a listed entry, every
 * listed entry still differs, every carried digest matches the applied file, and no listed patch vanished from both
 * lists.
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
  const digests = worktreeDigests(tree, manifest.patches.map(patch => patch.path))
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
  // The ledger and its checksum record describe the checkout before the release merge. Once the merge is in HEAD they
  // describe the release's own changes too, so only the pre-merge state is held to them.
  const landed = isAncestor(root, targetCommit, head)
  const refusals: Refusal[] = landed ? [] : [...checkLedger(root, manifest), ...checkDigests(root, manifest)]
  if (refusals.length > 0) return { refusals }
  const pinned = baseline

  const applied = withScratchWorktree(root, targetCommit, (tree): { refusals: Refusal[]; carried?: CarriedEntry[]; absorbed?: RetiredEntry[]; ledger?: string } => {
    const failures: Refusal[] = []
    const absorbed: RetiredEntry[] = []
    for (const patch of manifest.patches) {
      // A patch the target already holds needs no application; that entry is absorbed, as the rehearsal counts it.
      if (runGit(root, ['diff', '--quiet', targetCommit, head, '--', patch.path]).status === 0) {
        absorbed.push({ path: patch.path, hunks: hunksAtPin(root, pinned.commit, head, patch.path) })
        continue
      }
      const run = applyPatch(tree, patchText(root, pinned.commit, head, patch.path))
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
    for (const patch of manifest.patches) {
      const change = changes.get(patch.path)
      if (change === undefined) continue
      carried.push({ path: patch.path, class: patch.class, sha256: patchDigest(readFileSync(join(tree, patch.path))), hunks: hunkCount(tree, targetCommit, change) })
    }
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
    baseline: pinned,
    carried: applied.carried,
    absorbed: applied.absorbed,
    ledger: applied.ledger,
  }
  if (!write) return { refusals: [], plan }
  return { refusals: writeBack(root, plan), plan }
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
 * Record the digest of every listed patch at `HEAD` in the ledger.
 * @param root - the repository root.
 * @returns the refusals, and no ledger; one refusal per listed path that `HEAD` does not hold.
 * @throws UpstreamUpdateError when the ledger at `HEAD` is unusable.
 */
export function recordDigests(root: string): readonly Refusal[] {
  const manifest = headManifest(root)
  const digests = headDigests(root, manifest.patches.map(patch => patch.path))
  const refusals: Refusal[] = []
  const patches: PatchManifest['patches'] = []
  for (const patch of manifest.patches) {
    const digest = digests.get(patch.path)
    if (digest === undefined) {
      refusals.push({
        code: 'verification-failed',
        path: patch.path,
        message: `${patch.path} is listed in the ledger but HEAD holds no file there; commit the change or remove the entry`,
      })
      continue
    }
    patches.push({ ...patch, sha256: digest })
  }
  if (refusals.length > 0) return refusals
  writeFileSync(join(root, MANIFEST_PATH), `${JSON.stringify({ ...manifest, patches }, null, 2)}\n`)
  return []
}

/**
 * Format a carry-forward as the lines the command prints.
 * @param plan - the verified carry-forward.
 * @returns the merge it describes, the carried entries with their digests, the absorbed entries, and the verification.
 */
export function formatPlan(plan: UpdatePlan): string[] {
  const lines = [
    `carry-forward onto ${plan.tag} (${plan.targetCommit}) from pin ${plan.baseline.ref} (${plan.baseline.commit}) at HEAD ${plan.head}`,
    `carried: ${counted(plan.carried.length, 'entry', 'entries')}, ${counted(hunksOf(plan.carried), 'hunk')}`,
  ]
  for (const entry of plan.carried) lines.push(`  ${entry.path} (${entry.class}, ${counted(entry.hunks, 'hunk')}, sha256 ${entry.sha256.slice(0, 12)})`)
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
 * @returns the exit status: 0 when the mode finished, 1 for a refusal, 2 for a bad command line or an unusable input.
 */
export function main(argv: readonly string[]): number {
  let request: UpdateRequest
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: { record: { type: 'boolean', default: false }, tag: { type: 'string' }, write: { type: 'boolean', default: false } },
      strict: true,
      allowPositionals: false,
    })
    request = { record: values.record, write: values.write, ...values.tag === undefined ? {} : { tag: values.tag } }
  } catch (error) {
    console.error(`upstream-update: ${error instanceof Error ? error.message : String(error)}`)
    console.error(USAGE)
    return 2
  }
  // The two modes are exclusive, and recording is the only thing `--record` does.
  if ((request.record === true) === (request.tag !== undefined) || (request.record === true && request.write === true)) {
    console.error(USAGE)
    return 2
  }
  try {
    const root = repositoryRoot(process.cwd())
    if (request.record === true) {
      const refusals = recordDigests(root)
      if (refusals.length > 0) return refuse(refusals)
      console.log(`upstream-update: recorded the sha256 of every listed patch in ${MANIFEST_PATH}`)
      return 0
    }
    const outcome = carryForward(root, request.tag ?? '', request.write === true)
    if (outcome.plan !== undefined && outcome.refusals.length === 0) for (const line of formatPlan(outcome.plan)) console.log(line)
    if (outcome.refusals.length > 0) return refuse(outcome.refusals)
    console.log(request.write === true
      ? `upstream-update: ${MANIFEST_PATH} now pins ${request.tag ?? ''}`
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
