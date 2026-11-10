/**
 * A CLI profile's one-time changes (`delo/apps/cli/src/profile-migrations.ts`): each runs until it completes, is then
 * recorded under the profile's run directory and never runs again; a record that does not read runs each again.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { completedMigrations, MIGRATIONS_FILE, runProfileMigrations, type ProfileMigration } from '../src/profile-migrations.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'delorun-migrations-'))
  mkdirSync(join(home, 'run', 'default'), { recursive: true, mode: 0o700 })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/**
 * A migration that records each run and completes as told.
 * @param id - its id.
 * @param runs - collects its runs.
 * @param completes - whether it completes.
 * @returns the migration.
 */
function migration(id: string, runs: string[], completes: () => boolean): ProfileMigration {
  return { id, run: () => { runs.push(id); return Promise.resolve(completes()) } }
}

describe('profile migrations', () => {
  it('runs each until it completes, records it, and never runs it again', async () => {
    const runs: string[] = []
    let ready = false
    const migrations = [migration('a', runs, () => true), migration('b', runs, () => ready)]
    expect(await runProfileMigrations(home, 'default', migrations)).toEqual(['a'])
    expect(completedMigrations(home, 'default')).toEqual(['a'])
    ready = true
    expect(await runProfileMigrations(home, 'default', migrations)).toEqual(['b'])
    expect(await runProfileMigrations(home, 'default', migrations)).toEqual([])
    expect(runs).toEqual(['a', 'b', 'b'])
    expect(JSON.parse(readFileSync(join(home, 'run', 'default', MIGRATIONS_FILE), 'utf8'))).toEqual({ v: 1, done: ['a', 'b'] })
  })

  it('reads a record that is not JSON, or holds no list, as none completed', () => {
    const path = join(home, 'run', 'default', MIGRATIONS_FILE)
    writeFileSync(path, 'not json')
    expect(completedMigrations(home, 'default')).toEqual([])
    writeFileSync(path, '{"done":"a"}')
    expect(completedMigrations(home, 'default')).toEqual([])
    writeFileSync(path, '{"done":["a",7]}')
    expect(completedMigrations(home, 'default')).toEqual(['a'])
  })
})
