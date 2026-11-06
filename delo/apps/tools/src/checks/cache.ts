/**
 * The pass cache. A check that declares its inputs passes once per key: a later
 * run whose key matches the stored pass reports `cached pass` and does not run
 * the check. A key is the sha256 of the check's input files as git sees them
 * (the blob id of a tracked, unmodified file, the content hash of a modified,
 * deleted or untracked one), the lockfile, the Node and pnpm versions, the
 * command, the budget entry, and the values of the environment variables the
 * check lists.
 *
 * @module @delo/tools/checks/cache
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { git } from '../git.ts'
import type { Check } from './plan.ts'

/** The lockfile every key includes, since a dependency change can change any check's result. */
const LOCKFILE = 'pnpm-lock.yaml'

/** The pass cache a run consults; {@link createPassCache} builds the file-backed one. */
export interface PassCache {
  /**
   * The check's key, or undefined when it declares no inputs and so always runs.
   * @param check - the check.
   * @returns the key as a hex sha256.
   */
  keyOf(check: Check): string | undefined
  /**
   * Whether a pass recorded under `key` is stored for the check.
   * @param check - the check.
   * @param key - the key the check runs under.
   * @returns true when the stored pass has that key.
   */
  has(check: Check, key: string): boolean
  /**
   * Record a pass for the check under `key`, replacing the check's earlier pass.
   * @param check - the check.
   * @param key - the key the check passed under.
   */
  store(check: Check, key: string): void
}

/** What a file-backed pass cache reads from its run. */
export interface PassCacheOptions {
  /** The repository root that the input globs and paths are relative to. */
  readonly root: string
  /** The directory holding one pass file per check. */
  readonly dir: string
  /** The environment the listed variables are read from. */
  readonly env: NodeJS.ProcessEnv
  /** The Node version a key records, `process.version` in a run. */
  readonly nodeVersion: string
  /**
   * The pnpm version a key records; called once, when a check first needs its key.
   * @returns the version.
   */
  readonly pnpmVersion: () => string
}

const PassFile = z.object({ id: z.string(), key: z.string() })

/**
 * Whether a run serves checks from the pass cache. It is off with `--no-cache`, on a pre-push run whose
 * `DELO_FULL_GATE=1` asks for the whole gate, and in CI, where `CI` is set to a non-empty value.
 * @param options - `noCache` for the flag, and `fullGate` for a pre-push run that asks for the full gate.
 * @param env - the environment the run starts with.
 * @returns true when the cache serves this run.
 */
export function passCacheEnabled(options: { readonly noCache: boolean, readonly fullGate: boolean }, env: NodeJS.ProcessEnv): boolean {
  return !options.noCache && !options.fullGate && (env['CI'] ?? '') === ''
}

/**
 * The content id of a file as the key records it: a sha256 of its bytes, or `deleted` when it is gone.
 * @param root - the repository root.
 * @param path - a repository-relative path.
 * @returns `sha256:<hex>` or `deleted`.
 */
export function contentId(root: string, path: string): string {
  const absolute = join(root, path)
  if (!existsSync(absolute)) return 'deleted'
  return `sha256:${createHash('sha256').update(readFileSync(absolute)).digest('hex')}`
}

// The NUL-separated records of a `git ls-files -z` listing.
function records(output: string): string[] {
  return output.split('\0').filter(entry => entry.length > 0)
}

/**
 * The input files a set of git pathspecs names, each with its id, sorted: `path` NUL `id`. A tracked file that is unmodified
 * is identified by its index blob id, as `git ls-files -s` gives it; a modified, deleted or untracked file by the hash of its
 * content. Git's own pathspec matching decides which files a glob names, so `**` and ignored paths behave as in git.
 * @param root - the repository root.
 * @param patterns - repository-relative globs, such as `delo/**\/*.ts`.
 * @returns one entry per file, sorted.
 */
export function inputFingerprint(root: string, patterns: readonly string[]): string[] {
  const pathspec = patterns.map(pattern => `:(glob)${pattern}`)
  const tracked = records(git(root, ['ls-files', '-s', '-z', '--', ...pathspec]))
  const modified = new Set(records(git(root, ['ls-files', '-m', '-z', '--', ...pathspec])))
  const untracked = records(git(root, ['ls-files', '-o', '--exclude-standard', '-z', '--', ...pathspec]))
  const entries: string[] = []
  for (const record of tracked) {
    // `<mode> <blob> <stage>` TAB `<path>`
    const tab = record.indexOf('\t')
    const path = record.slice(tab + 1)
    const blob = record.slice(0, tab).split(' ')[1] ?? ''
    entries.push(`${path}\0${modified.has(path) ? contentId(root, path) : blob}`)
  }
  for (const path of untracked) entries.push(`${path}\0${contentId(root, path)}`)
  return entries.sort()
}

/**
 * The pass cache over a directory: one `<id>.json` per check, holding its id and the key of its last pass.
 * @param options - the repository, the directory, the environment and the versions a key records.
 * @returns the cache.
 */
export function createPassCache(options: PassCacheOptions): PassCache {
  const fingerprints = new Map<string, string[]>()
  const fingerprint = (patterns: readonly string[]): string[] => {
    const memo = patterns.join('\n')
    const known = fingerprints.get(memo)
    if (known !== undefined) return known
    const entries = inputFingerprint(options.root, patterns)
    fingerprints.set(memo, entries)
    return entries
  }
  let pnpm: string | undefined
  const file = (check: Check): string => join(options.dir, `${check.id.replaceAll(':', '-')}.json`)
  return {
    keyOf(check) {
      if (check.inputs === undefined || check.inputs.length === 0) return undefined
      pnpm ??= options.pnpmVersion()
      const facts = {
        inputs: fingerprint(check.inputs),
        lockfile: fingerprint([LOCKFILE]),
        node: options.nodeVersion,
        pnpm,
        cwd: check.cwd,
        command: check.command,
        environment: check.environment ?? {},
        budget: check.budget,
        env: Object.fromEntries((check.env ?? []).map(name => [name, options.env[name] ?? null])),
      }
      return createHash('sha256').update(JSON.stringify(facts)).digest('hex')
    },
    has(check, key) {
      return readPass(file(check))?.key === key
    },
    store(check, key) {
      writePass(file(check), { id: check.id, key })
    },
  }
}

/**
 * The pass a file records, or undefined when there is none or the file is not a pass: an entry that cannot be
 * read or parsed is treated as absent, so its check runs again.
 * @param path - the pass file.
 * @returns the recorded key, or undefined.
 */
function readPass(path: string): { readonly key: string } | undefined {
  try {
    const parsed = PassFile.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data : undefined
  } catch (error) {
    // A missing file, or one that is not JSON: no pass is recorded, so the check runs.
    void error
    return undefined
  }
}

/**
 * Write a pass through a temporary file that is renamed into place, so an interrupted write leaves the earlier pass.
 * @param path - the pass file.
 * @param pass - the check's id and key.
 */
function writePass(path: string, pass: { readonly id: string, readonly key: string }): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temporary, `${JSON.stringify(pass, null, 2)}\n`)
  renameSync(temporary, path)
}
