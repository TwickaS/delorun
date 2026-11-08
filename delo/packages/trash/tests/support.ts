/**
 * Shared fixtures of the trash specs: a private home-shaped scratch tree, a
 * session-log planter that writes the JSONL layout the persistence backend
 * derives, a SQLite FTS5 index fixture that holds the persisted side of
 * session-query-sqlite's schema, a Map-backed browser draft storage, and a
 * surface-log planter that writes a C20 surface's active and rotated files.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSurface } from '@delo/logs'
import { sessionDirectoryPath } from '../src/index.ts'
import type { DraftStorage } from '../src/index.ts'

/** The canary every spec plants: a secret that must vanish with the purge. */
export const CANARY = 'TRASH-CANARY-9f2c1e7a4b'

/** Milliseconds in one day. */
export const DAY = 86_400_000

/** One private scratch tree shaped like a Delo deployment's stores. */
export interface TrashTree {
  /** The trash root. */
  trashRoot: string
  /** The JSONL session-persistence root. */
  sessionsRoot: string
  /** The spill root. */
  spillRoot: string
  /** The versioned attachment root. */
  attachmentsRoot: string
  /** The Delo home whose logs the clear offer clears. */
  logsHome: string
  /** The full-text index file. */
  indexPath: string
  /** Remove the whole tree. */
  remove(): void
}

/** Create one private scratch tree. */
export function makeTree(): TrashTree {
  const base = mkdtempSync(join(tmpdir(), 'delo-trash-spec-'))
  const tree: TrashTree = {
    trashRoot: join(base, 'home', 'trash'),
    sessionsRoot: join(base, 'sessions'),
    spillRoot: join(base, 'spill'),
    attachmentsRoot: join(base, 'home', 'attachments', 'v1'),
    logsHome: join(base, 'home'),
    indexPath: join(base, 'index', 'query.sqlite'),
    remove: () => rmSync(base, { recursive: true, force: true }),
  }
  for (const dir of [tree.trashRoot, tree.sessionsRoot, tree.spillRoot, tree.attachmentsRoot, join(tree.logsHome, 'logs'), join(tree.logsHome, 'trash')]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  return tree
}

/**
 * Plant one chat's session directory with generation files, in the layout the
 * JSONL persistence backend derives, each generation holding the canary.
 * @param tree - the scratch tree.
 * @param sessionId - the chat's session id.
 * @param cwd - the chat's project directory.
 * @param versions - the format versions to plant; `0` writes the suffix-only name.
 * @returns the session directory.
 */
export function plantSession(tree: TrashTree, sessionId: string, cwd: string, versions: readonly number[]): string {
  const dir = sessionDirectoryPath(tree.sessionsRoot, cwd, sessionId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const version of versions) {
    const name = version === 0 ? 'session.jsonl' : `session.v${version}.jsonl`
    const header = JSON.stringify({
      type: 'session', version, id: sessionId, createdAt: 1, cwd, isSeeded: false, delegationDepth: 0,
    })
    const body = JSON.stringify({ type: 'message', text: `${CANARY} of session ${sessionId} generation v${version}` })
    writeFileSync(join(dir, name), `${header}\n${body}\n`, { mode: 0o600 })
  }
  return dir
}

/**
 * The persisted side of session-query-sqlite's schema, as a purge seam would
 * reach it in production through the engine's `forgetSessions`.
 */
export class IndexFixture {
  /** The index file's path. */
  readonly path: string
  private db: DatabaseSync

  /**
   * @param path - the index file to create.
   */
  constructor(path: string) {
    this.path = path
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), global_generation INTEGER NOT NULL);
      INSERT OR IGNORE INTO search_state (singleton, global_generation) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS persisted_sessions (
        id TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS persisted_docs USING fts5(
        text,
        session_id UNINDEXED,
        seq UNINDEXED,
        type UNINDEXED,
        time UNINDEXED,
        surface UNINDEXED,
        codepoint_length UNINDEXED
      );
    `)
  }

  /**
   * Index one canary document for a chat, as the engine's reconciliation writes it.
   * @param sessionId - the chat the document belongs to.
   * @param text - the document text.
   */
  plant(sessionId: string, text: string): void {
    this.db.prepare('INSERT OR IGNORE INTO persisted_sessions (id) VALUES (?)').run(sessionId)
    this.db.prepare(
      'INSERT INTO persisted_docs (text, session_id, seq, type, time, surface, codepoint_length) VALUES (?, ?, 1, ?, 1, ?, ?)',
    ).run(text, sessionId, 'message', 'user', Array.from(text).length)
  }

  /**
   * The purge seam the service binds: delete the rows and rebuild the file, so
   * no byte of the removed document text remains.
   * @param ids - the sessions to forget.
   */
  readonly forgetSessions = async (ids: readonly string[]): Promise<void> => {
    const removeDoc = this.db.prepare('DELETE FROM persisted_docs WHERE session_id = ?')
    const removeSession = this.db.prepare('DELETE FROM persisted_sessions WHERE id = ?')
    for (const id of ids) {
      removeDoc.run(id)
      removeSession.run(id)
    }
    this.db.exec('VACUUM')
  }

  /**
   * Whether the index file's bytes still hold a needle.
   * @param needle - the text to search.
   * @returns whether the file holds it.
   */
  fileContains(needle: string): boolean {
    this.db.close()
    this.db = new DatabaseSync(this.path)
    return readFileSync(this.path, 'latin1').includes(needle)
  }
}

/** A Map-backed browser draft storage, the studio's localStorage stand-in. */
export class DraftStorageFixture implements DraftStorage {
  private readonly entries = new Map<string, string>()

  /**
   * Plant one draft entry.
   * @param key - the host-qualified key.
   * @param value - the stored JSON.
   */
  plant(key: string, value: string): void {
    this.entries.set(key, value)
  }

  keys(): string[] {
    return [...this.entries.keys()]
  }

  remove(key: string): void {
    this.entries.delete(key)
  }

  /**
   * Read one entry.
   * @param key - the host-qualified key.
   * @returns its stored value, or `undefined`.
   */
  get(key: string): string | undefined {
    return this.entries.get(key)
  }
}

/**
 * Plant the canary in one C20 surface's active log and its rotated file.
 * @param home - the Delo home.
 * @param surfaceKind - the surface kind to write.
 * @returns the surface's directory.
 */
export function plantSurfaceLog(home: string, surfaceKind: 'home' | 'desktop-host'): string {
  const location = resolveSurface({ kind: surfaceKind, home, ...(surfaceKind === 'home' ? { profile: 'default' } : {}) })
  mkdirSync(location.dir, { recursive: true, mode: 0o700 })
  const line = `${JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', level: 'info', msg: `${CANARY} reached the ${surfaceKind} log`, source: 'delo' })}\n`
  writeFileSync(location.file, line, { mode: 0o600 })
  writeFileSync(`${location.file}.1`, line, { mode: 0o600 })
  return location.dir
}

/**
 * Whether any file of a tree holds a needle, byte for byte.
 * @param root - the tree to search.
 * @param needle - the text to search.
 * @returns the paths that hold the needle.
 */
export function grepTree(root: string, needle: string): string[] {
  const hits: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry)
      const info = statSync(path, { throwIfNoEntry: false })
      if (info === undefined) continue
      if (info.isDirectory()) {
        walk(path)
      } else if (info.isFile() && readFileSync(path, 'latin1').includes(needle)) {
        hits.push(path)
      }
    }
  }
  try {
    walk(root)
  } catch {
    return hits
  }
  return hits
}
