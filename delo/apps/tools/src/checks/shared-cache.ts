/**
 * The machine-wide pass store. Every worktree of every clone a user runs the checks in reads and writes one directory
 * under the user's cache directory, so a pass proven in one worktree serves a run in another whose key is the same.
 * Entries are content-addressed: a pass lives at `passes/<first two hex digits of its key>/<key>.json` and holds its
 * check id and key. A write goes through a file of the same directory that is created exclusively and renamed into
 * place, so a reader sees a whole entry or none, and concurrent writers of one key leave one whole entry. The store
 * refuses a directory inside the repository, a symbolic link, and a directory another user owns or that other users
 * can read or write, because an entry there could have been planted.
 *
 * The keys and the choice of the checks whose passes are shared live in `cache.ts` and `sharing.ts`.
 *
 * @module @delo/tools/checks/shared-cache
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { ensurePrivateDir } from './private-dir.ts'

/** The variable that names the store's directory, overriding the user's cache directory. */
export const SHARED_CACHE_ENV = 'DELO_CHECKS_SHARED_CACHE'

/** The version of an entry's fields; an entry of another version is a miss. */
const ENTRY_VERSION = 1

/** How long an entry serves before the store removes it, in milliseconds. */
export const ENTRY_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000

/** How often a run looks for expired entries, in milliseconds. */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

const SharedEntry = z.strictObject({ v: z.literal(ENTRY_VERSION), id: z.string(), key: z.string().regex(/^[0-9a-f]{64}$/) })

/** The machine-wide pass store a run reads and writes. */
export interface SharedStore {
  /** The store's directory. */
  readonly dir: string
  /**
   * Whether a pass of the check is stored under the key.
   * @param id - the check's id, which the entry must name.
   * @param key - the check's key.
   * @returns true for a whole entry of this version that names the id and the key.
   */
  has(id: string, key: string): boolean
  /**
   * Store a pass. A failed write, such as one on a full disk, loses only the entry: the run's result stands.
   * @param id - the check's id.
   * @param key - the key it passed under.
   * @returns undefined, or why the entry was not written.
   */
  store(id: string, key: string): string | undefined
}

/**
 * The store's directory: `$DELO_CHECKS_SHARED_CACHE` when set, otherwise `delo/checks` under `$XDG_CACHE_HOME` when that
 * is an absolute path, otherwise under `~/.cache`, as the XDG base directory rules say.
 * @param env - the run's environment.
 * @param home - the user's home directory.
 * @returns the absolute directory.
 * @throws Error when `DELO_CHECKS_SHARED_CACHE` is set to a relative path.
 */
export function sharedCacheDir(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const named = env[SHARED_CACHE_ENV]
  if (named !== undefined && named !== '') {
    if (!isAbsolute(named)) throw new Error(`${SHARED_CACHE_ENV} must be an absolute path, got ${named}`)
    return resolve(named)
  }
  const xdg = env['XDG_CACHE_HOME']
  return join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, '.cache'), 'delo', 'checks')
}

/** What {@link openSharedStore} checks the directory against. */
export interface StoreOwner {
  /** The repository root, which the directory must lie outside. */
  readonly root: string
  /** The user id the directory must belong to, `process.getuid()`. */
  readonly uid: number
  /** Milliseconds from the system clock, for expiry. */
  readonly now: () => number
}

/**
 * Open the store, creating its directory with mode 0700 when it does not exist.
 * @param dir - the directory, from {@link sharedCacheDir}.
 * @param owner - the repository root, the user and the clock.
 * @returns the store.
 * @throws Error when the directory lies inside the repository, is a symbolic link or not a directory, belongs to another
 * user, or grants any access to the group or others.
 */
export function openSharedStore(dir: string, owner: StoreOwner): SharedStore {
  const inside = relative(realpathSync(owner.root), resolve(dir))
  if (inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))) {
    throw new Error(`the shared pass cache ${dir} lies inside the repository; set ${SHARED_CACHE_ENV} to a directory outside it, or run with --no-shared-cache`)
  }
  ensurePrivateDir(dir, owner.uid, 'the shared pass cache', `run \`chmod 700 ${dir}\` as its owner, set ${SHARED_CACHE_ENV} to another directory, or run with --no-shared-cache`)
  const passes = join(dir, 'passes')
  const entry = (key: string): string => join(passes, key.slice(0, 2), `${key}.json`)
  prune(dir, passes, owner.now())
  return {
    dir,
    has(id, key) {
      let text: string
      try {
        text = readFileSync(entry(key), 'utf8')
      } catch (error) {
        // ENOENT: no pass is stored under the key. Any other read error also leaves the check to run.
        void error
        return false
      }
      const parsed = SharedEntry.safeParse(safeJson(text))
      return parsed.success && parsed.data.id === id && parsed.data.key === key
    },
    store(id, key) {
      const path = entry(key)
      const temporary = `${path}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`
      let written = false
      try {
        mkdirSync(join(passes, key.slice(0, 2)), { recursive: true, mode: 0o700 })
        writeFileSync(temporary, `${JSON.stringify({ v: ENTRY_VERSION, id, key })}\n`, { mode: 0o600, flag: 'wx' })
        written = true
        renameSync(temporary, path)
        return undefined
      } catch (error) {
        // A full disk, a removed directory or a path taken by something else: the pass is not shared, and the run's
        // result does not change.
        if (written) rmSync(temporary, { force: true })
        return String(error)
      }
    },
  }
}

/**
 * Parse JSON, or give undefined for text that is not JSON, such as a truncated file.
 * @param text - the text.
 * @returns the value, or undefined.
 */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    // SyntaxError: not an entry, so the schema refuses undefined and the check runs.
    void error
    return undefined
  }
}

/**
 * Remove the entries older than {@link ENTRY_LIFETIME_MS}, at most once per {@link PRUNE_INTERVAL_MS} on the machine.
 * The time of the last pass is the modification time of the `pruned` marker file.
 * @param dir - the store's directory.
 * @param passes - its `passes` directory.
 * @param now - the current time in milliseconds.
 */
function prune(dir: string, passes: string, now: number): void {
  const marker = join(dir, 'pruned')
  let last = 0
  try {
    last = statSync(marker).mtimeMs
  } catch (error) {
    // ENOENT: the store has never been pruned.
    void error
  }
  if (now - last < PRUNE_INTERVAL_MS) return
  writeFileSync(marker, '', { mode: 0o600 })
  for (const shard of listing(passes)) {
    for (const name of listing(join(passes, shard))) {
      const path = join(passes, shard, name)
      try {
        if (now - statSync(path).mtimeMs > ENTRY_LIFETIME_MS) rmSync(path, { force: true })
      } catch (error) {
        // ENOENT: another run removed or replaced the entry first.
        void error
      }
    }
  }
}

/**
 * The names in a directory, or none when it does not exist.
 * @param dir - the directory.
 * @returns the names.
 */
function listing(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch (error) {
    // ENOENT: nothing has been stored yet.
    void error
    return []
  }
}
