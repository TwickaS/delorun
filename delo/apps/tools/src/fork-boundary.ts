/**
 * The divergence ledger's rules. Every difference between the repository and its pinned upstream
 * commit lies under a fork-owned entry, is listed under `patches` with a class and a reason, or is
 * recorded under `retired` because upstream absorbed the change.
 *
 * @module @delo/tools/fork-boundary
 */
import { z } from 'zod'

/** The ledger's path, relative to the repository root. */
export const MANIFEST_PATH = 'delo/upstream-patches.json'

const commitId = z.string().regex(/^[0-9a-f]{40}$/u, { error: 'must be a full 40-character lowercase commit id' })

const manifestSchema = z.strictObject({
  $schema: z.string().optional(),
  upstream: z.strictObject({
    repository: z.string().min(1),
    ref: z.string().min(1),
    commit: commitId,
  }),
  forkOwned: z.array(z.string().min(1)).min(1),
  patches: z.array(z.strictObject({
    path: z.string().min(1),
    class: z.enum(['delo-feature', 'generic-fix', 'security']),
    reason: z.string(),
  })),
  retired: z.array(z.strictObject({
    path: z.string().min(1),
    reason: z.literal('absorbed'),
    upstreamCommit: commitId,
    hunks: z.number().int().nonnegative(),
  })),
})

/** The ledger stored at {@link MANIFEST_PATH}. */
export type PatchManifest = z.infer<typeof manifestSchema>

/** One listed patch: an upstream path the fork edits, with its class and reason. */
export type Patch = PatchManifest['patches'][number]

/** One retired entry: an upstream path whose change upstream absorbed, with the absorbing commit and its hunk count. */
export type RetiredEntry = PatchManifest['retired'][number]

/**
 * Parse and validate the ledger's text. Malformed JSON and schema violations both throw and name the
 * ledger and the failing fields; {@link manifestErrors} checks what the entries say.
 * @param text - the JSON text of the ledger.
 * @returns the typed ledger.
 * @throws Error when the text is not JSON or does not match the ledger schema.
 */
export function parseManifest(text: string): PatchManifest {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`${MANIFEST_PATH}: not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = manifestSchema.safeParse(value)
  if (parsed.success) return parsed.data
  throw new Error(`${MANIFEST_PATH}: ${parsed.error.issues.map(issue => `${issue.path.map(String).join('.')}: ${issue.message}`).join('; ')}`)
}

/** One path that differs from the upstream commit. */
export interface ChangedPath {
  /** Repository-relative path with `/` separators. */
  readonly path: string
  /** How the path differs from the upstream commit. */
  readonly status: 'added' | 'modified' | 'deleted'
  /** True when git does not track the path yet, so its whole content is the difference. */
  readonly untracked?: true
}

const COMPILED_SUFFIXES = ['.d.ts.map', '.js.map', '.d.ts', '.js'] as const
const SOURCE_SUFFIXES = ['.ts', '.tsx', '.mts'] as const

/**
 * Report whether a fork-owned entry covers a path. An entry is a path or a glob: `*` matches within one
 * path segment and `**` across segments. An entry covers the path it matches and every path below a
 * matching directory, so `delo/` covers everything under `delo/` and a trailing `/` is optional.
 * @param path - repository-relative path with `/` separators.
 * @param forkOwned - the ledger's fork-owned entries.
 * @returns true when one entry covers the path.
 */
export function isForkOwned(path: string, forkOwned: readonly string[]): boolean {
  return forkOwned.some(entry => forkOwnedPattern(entry).test(path))
}

/**
 * Compile one fork-owned entry into a pattern anchored at the start of a path and ending at a segment boundary.
 * @param entry - a fork-owned entry, with an optional trailing `/`.
 * @returns the compiled pattern.
 */
function forkOwnedPattern(entry: string): RegExp {
  const glob = entry.endsWith('/') ? entry.slice(0, -1) : entry
  const source = glob.replace(/\*\*\/|\*\*|\*|[.+?^${}()|[\]\\]/gu, token => {
    if (token === '**/') return '(?:.*/)?'
    if (token === '**') return '.*'
    if (token === '*') return '[^/]*'
    return `\\${token}`
  })
  return new RegExp(`^${source}(?:/|$)`, 'u')
}

/**
 * Find the TypeScript source a compiled file was emitted from, if one exists beside it.
 * @param path - a changed fork-owned path.
 * @param files - every path present in the working tree.
 * @returns the sibling source path, or undefined when the path is not a compiled twin.
 */
export function compiledTwinSource(path: string, files: ReadonlySet<string>): string | undefined {
  const suffix = COMPILED_SUFFIXES.find(candidate => path.endsWith(candidate))
  if (suffix === undefined) return undefined
  const stem = path.slice(0, -suffix.length)
  return SOURCE_SUFFIXES.map(source => stem + source).find(source => files.has(source))
}

/**
 * Validate what the ledger's entries say: reasons, duplicates, and entries that claim fork-owned paths.
 * @param manifest - the parsed ledger.
 * @returns one message per defect; empty when the entries are well formed.
 */
export function manifestErrors(manifest: PatchManifest): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const { path } of [...manifest.patches, ...manifest.retired]) {
    if (seen.has(path)) errors.push(`${path}: listed more than once`)
    seen.add(path)
  }
  for (const patch of manifest.patches) {
    if (patch.reason.trim().length === 0) errors.push(`${patch.path}: a patch needs a reason`)
  }
  for (const { path } of [...manifest.patches, ...manifest.retired]) {
    if (isForkOwned(path, manifest.forkOwned)) errors.push(`${path}: fork-owned paths are not ledger entries; remove the entry`)
  }
  return errors
}

/**
 * Check every difference from upstream against the ledger.
 * @param manifest - the parsed ledger.
 * @param changed - paths that differ from the upstream commit, including uncommitted and untracked ones.
 * @param files - every path present in the working tree, used to find compiled twins.
 * @returns one message per violation; empty when the fork boundary holds.
 */
export function forkBoundaryErrors(manifest: PatchManifest, changed: readonly ChangedPath[], files: ReadonlySet<string>): string[] {
  const errors = manifestErrors(manifest)
  const listed = new Set(manifest.patches.map(patch => patch.path))
  const retired = new Set(manifest.retired.map(entry => entry.path))
  const changedPaths = new Set(changed.map(entry => entry.path))
  for (const entry of changed) {
    if (isForkOwned(entry.path, manifest.forkOwned)) {
      const source = entry.status === 'deleted' ? undefined : compiledTwinSource(entry.path, files)
      if (source !== undefined) errors.push(`${entry.path}: compiled output beside ${source}; delete it and keep build output out of source trees`)
      continue
    }
    if (listed.has(entry.path)) continue
    errors.push(retired.has(entry.path)
      ? `${entry.path}: retired as absorbed upstream but still differs from it; list it under patches`
      : `${entry.path}: ${entry.status} upstream file is not listed in ${MANIFEST_PATH}`)
  }
  for (const patch of manifest.patches) {
    if (!changedPaths.has(patch.path)) errors.push(`${patch.path}: listed patch no longer differs from upstream; remove the entry`)
  }
  return errors
}

/** The divergence from the pinned upstream commit: the listed patches measured in hunks, and the retired entries credited. */
export interface Divergence {
  /** Listed patches that differ from the pinned commit. */
  readonly entries: number
  /** Hunks of the listed patches, measured against the pinned commit. */
  readonly hunks: number
  /** Retired entries. They are not counted in `entries` or `hunks`; they are credited and listed separately. */
  readonly retired: readonly RetiredEntry[]
}

/**
 * Total the divergence of a ledger. A listed patch counts when its path appears in `hunks`, so a stale entry
 * contributes nothing; retiring an entry removes its entry and hunks from the total.
 * @param manifest - the parsed ledger.
 * @param hunks - the hunk count of every changed path, measured against the pinned commit.
 * @returns the listed totals and the credited retired entries.
 */
export function divergence(manifest: PatchManifest, hunks: ReadonlyMap<string, number>): Divergence {
  const live = manifest.patches.filter(patch => hunks.has(patch.path))
  return {
    entries: live.length,
    hunks: live.reduce((total, patch) => total + (hunks.get(patch.path) ?? 0), 0),
    retired: manifest.retired,
  }
}
