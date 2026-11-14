/**
 * A D1 stand-in for specs: the real migration run on in-memory SQLite (Node's `node:sqlite`), behind the same
 * statement calls the Worker makes. Miniflare would need `workerd`, which this site's install does not build.
 */
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { D1Like, D1Statement } from '../src/worker/env.ts'

type Value = string | number | null

/** The migration the stack applies to D1. */
const MIGRATION = readFileSync(new URL('../migrations/0001_subscribers.sql', import.meta.url), 'utf8')

/** A database with the subscriber table, plus `rows` for direct reads in a spec. */
export interface TestDb extends D1Like {
  rows(sql: string, ...values: Value[]): Record<string, unknown>[]
}

/**
 * @returns a fresh in-memory database with the migration applied.
 */
export function createDb(): TestDb {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(MIGRATION)
  const statement = (sql: string, values: Value[]): D1Statement => ({
    bind: (...next) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...values) ?? null) as T | null,
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }),
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...values) as T[] }),
  })
  return {
    prepare: sql => statement(sql, []),
    rows: (sql, ...values) => sqlite.prepare(sql).all(...values) as Record<string, unknown>[],
  }
}
