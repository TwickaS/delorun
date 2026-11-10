/**
 * The pass cache. A check that declares its inputs passes once per key: a later run whose key matches a stored pass
 * reports `cached pass` and does not run the check. A key is the sha256 of the check's id, its input files as git sees
 * them (the blob id of a tracked, unmodified file, the content hash of a modified, deleted or untracked one), the source
 * of the code its command runs and the generated files it reads (`sharing.ts`), the lockfile and the installed lockfile
 * copy pnpm keeps in `node_modules/.pnpm/lock.yaml`, the Node and pnpm versions, the platform, the clone (its git common
 * directory), the command, the budget entry, the values of the environment variables the check lists, and the values of
 * the variables every key records ({@link KEYED_ENV}). A check that reads history (`Check.history`) also keys HEAD.
 *
 * A pass is stored in the worktree (`node_modules/.cache/delo-checks/pass`, one file per check) and, when the sharing
 * rules allow it, in the machine-wide store (`shared-cache.ts`), where a run in another worktree finds it. In a strict
 * run (the merge tier and the full gate) a security-class or merge-only check is served from no cache: it runs.
 *
 * @module @delo/tools/checks/cache
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { git } from '../git.ts'
import type { Check, GateTier } from './plan.ts'
import type { SharedStore } from './shared-cache.ts'
import type { SharingPolicy } from './sharing.ts'
import { commandFor, type Unit } from './units.ts'

/** The lockfile every key includes, since a dependency change can change any check's result. */
const LOCKFILE = 'pnpm-lock.yaml'
/** pnpm's copy of the lockfile it last installed from: a worktree whose install is stale has another key. */
const INSTALLED_LOCKFILE = 'node_modules/.pnpm/lock.yaml'

/**
 * The variables whose values every key records, by name pattern: the ones that change how Node, the test runners and
 * Delo's and upstream's code behave. The repository root in a value is recorded as `<root>`, so worktrees share keys.
 */
export const KEYED_ENV = /^(?:DELO_|DSH_|DOCKER_|VITEST|NODE_OPTIONS$|NODE_PATH$|TZ$|LANG$|LC_)/

/** The variables whose presence, not value, every key records: a spec skips or runs on a credential being set. */
export const KEYED_PRESENCE = /^DEEPSEEK_/

/**
 * The variables that steer the runner itself and that no check receives (`machine.ts` removes them from the checks'
 * environment), so no key records them.
 */
export const RUNNER_CONTROL_ENV: readonly string[] = ['DELO_CHECKS_GRANT', 'DELO_CHECKS_SCOPE', 'DELO_FULL_GATE', 'DELO_GATE_PRIORITY', 'DELO_PUSH_SKIP', 'DELO_TIER']

/** Where a stored pass came from. */
export type PassSource = 'local' | 'shared'

/** The pass cache a run consults; {@link createPassCache} builds the file-backed one. */
export interface PassCache {
  /**
   * The check's key, or undefined when it declares no inputs and so always runs.
   * @param check - the check.
   * @returns the key as a hex sha256.
   */
  keyOf(check: Check): string | undefined
  /**
   * Where a pass recorded under `key` is stored for the check: the worktree first, then the machine-wide store.
   * @param check - the check.
   * @param key - the key the check runs under.
   * @returns the source, or undefined when no stored pass serves the check.
   */
  lookup(check: Check, key: string): PassSource | undefined
  /**
   * Record a pass for the check under `key`, replacing the check's earlier pass in the worktree.
   * @param check - the check.
   * @param key - the key the check passed under.
   */
  store(check: Check, key: string): void
  /**
   * The key of one unit of a unitised suite (`units.ts`): the check's facts with the unit's inputs, and a command without
   * its scope and worker count, which do not change what a package's specs prove.
   * @param check - the suite.
   * @param unit - the unit.
   * @returns the key as a hex sha256.
   */
  unitKey(check: Check, unit: Unit): string
  /**
   * Where a pass of the unit under `key` is stored: the worktree first, then, for a unit that is not local, the store.
   * @param check - the suite.
   * @param unit - the unit.
   * @param key - the unit's key.
   * @returns the source, or undefined when no stored pass serves the unit.
   */
  lookupUnit(check: Check, unit: Unit, key: string): PassSource | undefined
  /**
   * Record a pass of the unit under `key`, in the worktree and, for a unit that is not local, in the store.
   * @param check - the suite.
   * @param unit - the unit.
   * @param key - the unit's key.
   */
  storeUnit(check: Check, unit: Unit, key: string): void
  /**
   * Why the machine-wide store does not serve the check in this run, or undefined when it does.
   * @param check - the check.
   * @returns the reason, such as the sharing rule's, `--no-shared-cache` or the merge tier.
   */
  unshared(check: Check): string | undefined
}

/** The machine-wide store a cache uses, and whether this run reads it. */
export interface SharedUse {
  readonly store: SharedStore
  /** Why the run reads no shared pass, such as the merge tier; undefined when it reads them. It still stores its passes. */
  readonly noReads?: string | undefined
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
  /** The platform a key records, such as `linux-x64`. */
  readonly platform: string
  /** The sharing rules and the code each command runs. */
  readonly policy: SharingPolicy
  /** The machine-wide store; absent, as with `--no-shared-cache` or `--no-cache`, nothing is shared. */
  readonly shared?: SharedUse | undefined
  /** True in the merge tier and the full gate: a security-class or merge-only check is served from no cache. */
  readonly strict: boolean
  /**
   * Print a warning, such as a pass the store could not write.
   * @param line - the warning.
   */
  readonly warn: (line: string) => void
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

/** How a run uses the pass cache, from {@link cacheUse}. */
export interface CacheUse {
  /** Whether stored passes serve the run at all. */
  readonly on: boolean
  /** Whether the run opens the machine-wide store; it then stores its shareable passes there. */
  readonly shared: boolean
  /** Why the run reads no pass from the machine-wide store; undefined when it reads them. */
  readonly noReads?: string
  /** True for the trunk's last line: a security-class or merge-only check is served from no cache. */
  readonly strict: boolean
}

/**
 * How a run uses the pass cache. The merge tier, a run with `DELO_GATE_PRIORITY=trunk` and a full gate without `--only`
 * are the trunk's last line: they read no
 * shared pass, and their security-class and merge-only checks run whatever any cache holds. They still store the passes
 * they prove. The pre-commit tier reads no shared pass. An `--only` run without a tier counts as a lane's own run.
 * @param run - the invocation: `preCommit`, the gate tier (undefined for the full gate and the pre-commit tier), the
 * `--only` names, `--no-cache`, `--no-shared-cache`, and `fullGate` for a pre-push that asks for the whole gate.
 * @param env - the environment the run starts with.
 * @returns the use.
 */
export function cacheUse(run: { readonly preCommit: boolean, readonly tier: GateTier | undefined, readonly only: readonly string[], readonly noCache: boolean, readonly noSharedCache: boolean, readonly fullGate: boolean }, env: NodeJS.ProcessEnv): CacheUse {
  const on = passCacheEnabled({ noCache: run.noCache, fullGate: run.fullGate }, env)
  const strict = run.tier === 'merge' || env['DELO_GATE_PRIORITY'] === 'trunk' || (run.tier === undefined && !run.preCommit && run.only.length === 0)
  const noReads = run.preCommit ? 'the pre-commit tier reads no shared pass' : strict ? 'the merge tier and the full gate read no shared pass' : undefined
  return { on, shared: on && !run.noSharedCache, strict, ...noReads === undefined ? {} : { noReads } }
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
  if (patterns.length === 0) return []
  const pathspec = patterns.map(pattern => `:(glob)${pattern}`)
  const tracked = records(git(root, ['ls-files', '-s', '-z', '--', ...pathspec]))
  const modified = new Set(records(git(root, ['ls-files', '-m', '-z', '--', ...pathspec])))
  const untracked = records(git(root, ['ls-files', '-o', '--exclude-standard', '-z', '--', ...pathspec]))
  const entries: string[] = []
  for (const record of tracked) {
    // `<mode> <blob> <stage>` TAB `<path>`
    const tab = record.indexOf('\t')
    const path = record.slice(tab + 1)
    // A six-digit mode and a one-digit stage surround the object id.
    const blob = record.slice(7, tab - 2)
    entries.push(`${path}\0${modified.has(path) ? contentId(root, path) : blob}`)
  }
  for (const path of untracked) entries.push(`${path}\0${contentId(root, path)}`)
  return entries.sort()
}

/**
 * The values of the variables every key records ({@link KEYED_ENV}), with the repository root written as `<root>`.
 * @param env - the environment.
 * @param root - the repository root.
 * @returns the names and values, sorted by name.
 */
export function keyedEnvironment(env: NodeJS.ProcessEnv, root: string): Array<[string, string]> {
  return Object.entries(env)
    .filter((entry): entry is [string, string] => (KEYED_ENV.test(entry[0]) || KEYED_PRESENCE.test(entry[0])) && !RUNNER_CONTROL_ENV.includes(entry[0]) && entry[1] !== undefined)
    .map(([name, value]): [string, string] => [name, KEYED_PRESENCE.test(name) ? 'set' : value.replaceAll(root, '<root>')])
    .sort(([a], [b]) => (a < b ? -1 : 1))
}

/**
 * The pass cache over a directory: one `<id>.json` per check, holding its id and the key of its last pass, and the
 * machine-wide store when the run shares.
 * @param options - the repository, the directory, the environment, the versions a key records and the sharing.
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
  const runEnv = keyedEnvironment(options.env, options.root)
  const installed = contentId(options.root, INSTALLED_LOCKFILE)
  let clone: string | undefined
  let head: string | undefined
  const file = (check: Check): string => join(options.dir, `${check.id.replaceAll(':', '-')}.json`)
  const unitId = (check: Check, unit: Unit): string => `${check.id}@${unit.dir}`
  const unitFile = (check: Check, unit: Unit): string => join(options.dir, 'units', `${unitId(check, unit).replaceAll(/[:/@]/g, '-')}.json`)
  const keyFrom = (check: Check, id: string, inputs: readonly string[], command: readonly string[], history: boolean): string => {
    pnpm ??= options.pnpmVersion()
    clone ??= git(options.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
    if (history) head ??= git(options.root, ['rev-parse', 'HEAD']).trim()
    const facts = {
      id,
      inputs: fingerprint(inputs),
      code: fingerprint(options.policy.codeInputs(check)),
      state: options.policy.stateFiles(check).map(path => [path, contentId(options.root, path)]),
      lockfile: fingerprint([LOCKFILE]),
      installed,
      node: options.nodeVersion,
      pnpm,
      platform: options.platform,
      clone,
      head: history ? head : null,
      cwd: check.cwd,
      command,
      environment: check.environment ?? {},
      budget: check.budget,
      env: Object.fromEntries((check.env ?? []).map(name => [name, options.env[name] ?? null])),
      runEnv,
    }
    return createHash('sha256').update(JSON.stringify(facts)).digest('hex')
  }
  const unshared = (check: Check): string | undefined => {
    if (options.shared === undefined) return 'the run shares no pass (--no-shared-cache, --no-cache or CI)'
    return options.policy.unshared(check)
  }
  return {
    keyOf(check) {
      if (check.inputs === undefined || check.inputs.length === 0) return undefined
      return keyFrom(check, check.id, check.inputs, check.command.filter(arg => !arg.startsWith('--maxWorkers=')), check.history === true)
    },
    unitKey(check, unit) {
      const command = commandFor(check, []).filter(arg => !arg.startsWith('--maxWorkers='))
      return keyFrom(check, unitId(check, unit), unit.inputs, command, unit.local === true)
    },
    lookupUnit(check, unit, key) {
      if (options.strict && options.policy.securityPackage(unit.dir)) return undefined
      if (readPass(unitFile(check, unit))?.key === key) return 'local'
      const shared = options.shared
      if (shared === undefined || shared.noReads !== undefined || unit.local === true) return undefined
      return shared.store.has(unitId(check, unit), key) ? 'shared' : undefined
    },
    storeUnit(check, unit, key) {
      writePass(unitFile(check, unit), { id: unitId(check, unit), key })
      if (options.shared === undefined || unit.local === true) return
      const failure = options.shared.store.store(unitId(check, unit), key)
      if (failure !== undefined) options.warn(`delo checks: the pass of ${unitId(check, unit)} is not shared: ${failure}`)
    },
    lookup(check, key) {
      if (options.strict && (check.mergeOnly === true || options.policy.security(check))) return undefined
      if (readPass(file(check))?.key === key) return 'local'
      const shared = options.shared
      if (shared === undefined || shared.noReads !== undefined || unshared(check) !== undefined) return undefined
      return shared.store.has(check.id, key) ? 'shared' : undefined
    },
    store(check, key) {
      writePass(file(check), { id: check.id, key })
      if (options.shared === undefined || unshared(check) !== undefined) return
      const failure = options.shared.store.store(check.id, key)
      if (failure !== undefined) options.warn(`delo checks: the pass of ${check.id} is not shared: ${failure}`)
    },
    unshared(check) {
      return unshared(check) ?? options.shared?.noReads
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
