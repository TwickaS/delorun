/**
 * A CLI profile's one-time changes (`delo/apps/cli/src/profile-migrations.ts`): each runs until it completes, is then
 * recorded in the profile's own directory and never runs again. A record that does not read runs none and warns,
 * naming the file; the record an earlier release kept under the run directory is taken over once.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CommandOutput } from '../src/command.ts'
import { completedMigrations, MIGRATIONS_FILE, migrationsPath, RUN_DIRECTORY_MIGRATIONS_FILE, runProfileMigrations, type ProfileMigration } from '../src/profile-migrations.ts'

let home: string
let warnings: string[]
let output: CommandOutput

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'delorun-migrations-'))
  mkdirSync(join(home, 'run', 'default'), { recursive: true, mode: 0o700 })
  mkdirSync(join(home, 'profiles', 'default'), { recursive: true, mode: 0o700 })
  warnings = []
  output = { stdout: () => undefined, stderr: (text) => { warnings.push(text) } }
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
  it('runs each until it completes, records it in the profile directory, and never runs it again', async () => {
    const runs: string[] = []
    let ready = false
    const migrations = [migration('a', runs, () => true), migration('b', runs, () => ready)]
    expect(await runProfileMigrations(home, 'default', migrations, output)).toEqual(['a'])
    expect(completedMigrations(home, 'default')).toEqual({ kind: 'read', done: ['a'] })
    ready = true
    expect(await runProfileMigrations(home, 'default', migrations, output)).toEqual(['b'])
    expect(await runProfileMigrations(home, 'default', migrations, output)).toEqual([])
    expect(runs).toEqual(['a', 'b', 'b'])
    expect(migrationsPath(home, 'default')).toBe(join(home, 'profiles', 'default', MIGRATIONS_FILE))
    expect(JSON.parse(readFileSync(join(home, 'profiles', 'default', MIGRATIONS_FILE), 'utf8'))).toEqual({ v: 1, done: ['a', 'b'] })
    expect(existsSync(join(home, 'run', 'default', RUN_DIRECTORY_MIGRATIONS_FILE))).toBe(false)
    expect(warnings).toEqual([])
  })

  it('runs none while the record does not read, leaves the record as it is, and warns naming it', async () => {
    const path = join(home, 'profiles', 'default', MIGRATIONS_FILE)
    for (const text of ['not json', 'null', '{"done":"a"}', '{"v":1,"done":["a",7]}', '{"done":["a"]}']) {
      writeFileSync(path, text)
      warnings.length = 0
      const runs: string[] = []
      expect(completedMigrations(home, 'default')).toMatchObject({ kind: 'unreadable', path })
      expect(await runProfileMigrations(home, 'default', [migration('a', runs, () => true)], output)).toEqual([])
      expect(runs).toEqual([])
      expect(readFileSync(path, 'utf8')).toBe(text)
      expect(warnings.join('')).toContain(`delorun: Delo applied none of its one-time changes to the profile default, because ${path} does not read`)
      expect(warnings.join('')).toContain('Removing that file lets the next start apply the changes')
    }
  })

  it('takes over the record an earlier release kept under the run directory, so its migrations do not run again', async () => {
    const earlier = join(home, 'run', 'default', RUN_DIRECTORY_MIGRATIONS_FILE)
    writeFileSync(earlier, '{"v":1,"done":["a"]}\n')
    expect(completedMigrations(home, 'default')).toEqual({ kind: 'read', done: ['a'], fromRunDirectory: earlier })
    const runs: string[] = []
    expect(await runProfileMigrations(home, 'default', [migration('a', runs, () => true), migration('b', runs, () => true)], output)).toEqual(['b'])
    expect(runs).toEqual(['b'])
    expect(existsSync(earlier)).toBe(false)
    expect(JSON.parse(readFileSync(join(home, 'profiles', 'default', MIGRATIONS_FILE), 'utf8'))).toEqual({ v: 1, done: ['a', 'b'] })
  })

  it('runs none while the profile has no record and the run directory\'s does not read', async () => {
    const earlier = join(home, 'run', 'default', RUN_DIRECTORY_MIGRATIONS_FILE)
    writeFileSync(earlier, 'not json')
    const runs: string[] = []
    expect(await runProfileMigrations(home, 'default', [migration('a', runs, () => true)], output)).toEqual([])
    expect(runs).toEqual([])
    expect(readFileSync(earlier, 'utf8')).toBe('not json')
    expect(existsSync(join(home, 'profiles', 'default', MIGRATIONS_FILE))).toBe(false)
    expect(warnings.join('')).toContain(`because ${earlier} does not read: it is not JSON`)
  })

  it('reads the profile\'s own record before the run directory\'s', async () => {
    writeFileSync(join(home, 'run', 'default', RUN_DIRECTORY_MIGRATIONS_FILE), '{"v":1,"done":["a"]}\n')
    writeFileSync(join(home, 'profiles', 'default', MIGRATIONS_FILE), '{"v":1,"done":[]}\n')
    const runs: string[] = []
    expect(await runProfileMigrations(home, 'default', [migration('a', runs, () => true)], output)).toEqual(['a'])
    expect(runs).toEqual(['a'])
  })
})
