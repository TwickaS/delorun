/**
 * The stock-home import's edges: a Delo home that changes between the plan
 * and the publication, a directory the import cannot read or remove, the
 * reader's own refusals, and the classification of a placement that failed.
 * Each spec asserts the refusal a person reads and that the Delo home keeps
 * what it held.
 */
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync, type Stats } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { publicationFailure } from '../src/dsh-import/apply.ts'
import type { DshImportError } from '../src/dsh-import/index.ts'
import { applyDshHomeImport, readDshImportRecord, recoverDshImport, STOCK_IMPORT_DIRECTORY, STOCK_IMPORT_JOURNAL, type DshImportApplyOptions } from '../src/dsh-import/index.ts'
import { SourceReader, type SourceProbe } from '../src/dsh-import/source.ts'
import { FIXTURE_SECRET, makeHomes, manifest, mark, plan, PROJECT, read, registry, sha256, snapshot, type Homes } from './dsh-import-support.ts'

/** Every category taken. */
const ALL: DshImportApplyOptions = { include: { profiles: true, settings: true, instructions: true, skills: true, credentials: true } }

/** The data alone. */
const DATA: DshImportApplyOptions = { include: {} }

/**
 * A reader over the scratch tree's stock home.
 * @param maxEntries - the entry limit.
 * @param probe - the calls a spec stages a change between.
 * @returns the reader.
 */
function readerOf(maxEntries: number, probe?: SourceProbe): SourceReader {
  return new SourceReader(homes.source, maxEntries, lstatSync(homes.source).dev, probe)
}

let homes: Homes
const locked: string[] = []

beforeEach(() => {
  homes = makeHomes()
})

afterEach(() => {
  for (const path of locked.splice(0)) chmodSync(path, 0o755)
  homes.remove()
})

/**
 * Take every permission from a directory until the spec ends.
 * @param path - the absolute path.
 * @param mode - the permission bits to leave.
 */
function lock(path: string, mode = 0o000): void {
  chmodSync(path, mode)
  locked.push(path)
}

describe('a Delorun home that changes after the plan', () => {
  it('refuses a workspace list that changed or went away, and puts nothing in place', async () => {
    homes.write('storages/workspace.json', registry({ w1: { path: '/work/proj', sessionIds: ['s1'] } }))
    homes.writeTarget('storages/workspace.json', registry({ d1: { path: '/work/delo', sessionIds: [] } }))
    const planned = await plan(homes)
    homes.writeTarget('storages/workspace.json', registry({ w1: { path: '/work/proj', sessionIds: ['s1'] } }))
    await expect(applyDshHomeImport(planned, DATA)).rejects.toMatchObject({ code: 'DSH_IMPORT_TARGET_REFUSED', subject: 'storages/workspace.json' })
    rmSync(join(homes.target, 'storages/workspace.json'))
    await expect(applyDshHomeImport(planned, DATA)).rejects.toMatchObject({ code: 'DSH_IMPORT_STAGING_FAILED', message: 'the import could not write its files (ENOENT); nothing was imported' })
    expect(snapshot(homes.target).map(entry => entry.path)).toEqual(['storages'])
  })

  it('refuses credentials that changed after the plan, or a Delorun credentials document that became unreadable, and never quotes a value', async () => {
    mark(homes)
    homes.write('.credentials.yaml', `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${FIXTURE_SECRET}\n`, 0o600)
    const planned = await plan(homes)
    homes.writeTarget('.credentials.yaml', `refs:\n  X: ${FIXTURE_SECRET}\n`, 0o600)
    const unreadable = await applyDshHomeImport(planned, ALL).then(() => { throw new Error('the import was expected to refuse') }, (error: unknown) => error as DshImportError)
    expect(unreadable).toMatchObject({ code: 'DSH_IMPORT_CREDENTIALS_REFUSED', subject: '.credentials.yaml' })
    expect(unreadable.message).not.toContain(FIXTURE_SECRET)
    rmSync(join(homes.target, '.credentials.yaml'))
    homes.write('.credentials.yaml', `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${FIXTURE_SECRET}-changed\n`, 0o600)
    await expect(applyDshHomeImport(planned, ALL)).rejects.toMatchObject({ code: 'DSH_IMPORT_SOURCE_CHANGED' })
    expect(snapshot(homes.target)).toEqual([])
  })

  it('adds a version to a credentials document that holds only a comment', async () => {
    mark(homes)
    homes.write('.credentials.yaml', 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: new-value\n', 0o600)
    homes.writeTarget('.credentials.yaml', '# my credentials\n', 0o600)
    await applyDshHomeImport(await plan(homes), ALL)
    expect(read(homes.target, '.credentials.yaml')).toBe('# my credentials\n\nversion: 1\nrefs:\n  DEEPSEEK_API_KEY: new-value\n')
  })
})

describe('a directory the import cannot read or remove', () => {
  it('refuses a Delorun home directory it cannot read on the way to a file', async () => {
    mark(homes)
    homes.write('skills/review/SKILL.md', '# review\n')
    mkdirSync(join(homes.target, 'skills', 'other'), { recursive: true })
    const planned = await plan(homes)
    lock(join(homes.target, 'skills'))
    await expect(applyDshHomeImport(planned, ALL)).rejects.toMatchObject({ code: 'DSH_IMPORT_TARGET_REFUSED', subject: 'skills/review' })
  })

  it('refuses a Delorun sessions root it cannot list, because a collision could not be found', async () => {
    homes.write(`sessions/${PROJECT}/s1/session.v4.jsonl.zstd`, 'x')
    homes.writeTarget('sessions/--a--/d1/session.v4.jsonl.zstd', 'x')
    lock(join(homes.target, 'sessions/--a--'))
    await expect(plan(homes)).rejects.toMatchObject({ code: 'DSH_IMPORT_TARGET_REFUSED', subject: 'sessions' })
  })

  it('refuses an archive directory it cannot read', async () => {
    mkdirSync(join(homes.target, 'archive'))
    lock(join(homes.target, 'archive'))
    await expect(recoverDshImport(homes.target)).rejects.toMatchObject({ code: 'DSH_IMPORT_TARGET_REFUSED', subject: STOCK_IMPORT_DIRECTORY })
  })

  it('stops a recovery it cannot carry out, and keeps the journal for the next one', async () => {
    homes.writeTarget(`${STOCK_IMPORT_DIRECTORY}/staging-a/files/held/x`, 'x')
    homes.writeTarget('held/x', 'x')
    homes.writeTarget(`${STOCK_IMPORT_DIRECTORY}/${STOCK_IMPORT_JOURNAL}`, JSON.stringify({ v: 1, staging: 'staging-a', directories: [], entries: [{ path: 'held/x', replace: false, sha256: sha256('x') }] }))
    lock(join(homes.target, 'held'))
    await expect(recoverDshImport(homes.target)).rejects.toMatchObject({ code: 'EACCES' })
    chmodSync(join(homes.target, 'held'), 0o755)
    homes.writeTarget('ro/sub/x', 'x')
    rmSync(join(homes.target, 'ro/sub/x'))
    homes.writeTarget(`${STOCK_IMPORT_DIRECTORY}/${STOCK_IMPORT_JOURNAL}`, JSON.stringify({ v: 1, staging: 'staging-a', directories: ['ro', 'ro/sub'], entries: [{ path: 'ro/sub/x', replace: false, sha256: sha256('x') }] }))
    lock(join(homes.target, 'ro'), 0o500)
    await expect(recoverDshImport(homes.target)).rejects.toMatchObject({ code: 'EACCES' })
    expect(read(homes.target, `${STOCK_IMPORT_DIRECTORY}/${STOCK_IMPORT_JOURNAL}`)).toContain('ro/sub')
  })

  it('reads an import record it cannot open as a failure, not as no record', async () => {
    mkdirSync(join(homes.target, STOCK_IMPORT_DIRECTORY, 'imports.json'), { recursive: true })
    await expect(readDshImportRecord(homes.target)).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('finds nothing to withdraw after an import that completed', async () => {
    mark(homes)
    await applyDshHomeImport(await plan(homes), DATA)
    expect(await recoverDshImport(homes.target)).toEqual({ withdrawn: [], kept: [], removed: 0 })
  })
})

describe('the plan\'s smaller cases', () => {
  it('counts two Delorun chats, names storage units it does not know, and leaves a linked attachment store behind', async () => {
    homes.write(`sessions/${PROJECT}/s1/session.v4.jsonl.zstd`, 'x')
    homes.writeTarget('sessions/--a--/d1/session.v4.jsonl.zstd', 'x')
    homes.writeTarget('sessions/--a--/d2/session.v4.jsonl.zstd', 'x')
    homes.write('storages/other.json', '{}')
    homes.write('storages/other.json.lock', '')
    homes.link('attachments/v1', homes.outside)
    homes.write('profiles/fine/package.json', manifest([]))
    homes.write('profiles/fine/install.lock', '')
    const planned = await plan(homes)
    expect(planned.blockers[0]?.message).toContain('already holds 2 chats')
    expect(Object.fromEntries(planned.skipped.map(entry => [entry.path, entry.reason]))).toMatchObject({
      'storages/other.json': 'unknown',
      'storages/other.json.lock': 'runtime-state',
      'attachments/v1': 'symbolic-link',
      'profiles/fine/install.lock': 'runtime-state',
    })
    rmSync(join(homes.source, 'storages'), { recursive: true })
    writeFileSync(join(homes.source, 'storages'), 'a file')
    expect((await plan(homes)).skipped).toContainEqual({ path: 'storages', reason: 'unknown' })
  })
})

describe('the stock home\'s reader', () => {
  it('refuses an entry or a directory it cannot read, and a copy it cannot write', async () => {
    homes.write('AGENTS.md', '# notes\n')
    const reader = readerOf(10)
    await expect(reader.inspect('missing')).rejects.toMatchObject({ code: 'DSH_IMPORT_SOURCE_UNUSABLE', subject: 'missing' })
    await expect(new SourceReader(join(homes.root, 'gone'), 10, 0).list('')).rejects.toMatchObject({ code: 'DSH_IMPORT_SOURCE_UNUSABLE', subject: undefined, message: 'the stock home could not be read (ENOENT)' })
    const entry = await reader.inspect('AGENTS.md')
    if (entry.kind !== 'file') throw new Error('the fixture is a plain file')
    await expect(reader.copy(entry.file, join(homes.root, 'missing', 'copy'))).rejects.toMatchObject({ code: 'DSH_IMPORT_STAGING_FAILED', subject: 'AGENTS.md' })
    expect(reader.escapes({ ...entry.file, ino: entry.file.ino + 1, nlink: 1 })).toBe(true)
    expect(reader.escapes(entry.file)).toBe(false)
  })

  it('leaves an entry on another device behind, as a mount point inside the stock home', async () => {
    homes.write('skills/review/SKILL.md', 'x')
    const probe: SourceProbe = {
      lstat: async (path: string): Promise<Stats> => {
        const stats = await lstat(path)
        return path.endsWith('skills') ? Object.assign(Object.create(Object.getPrototypeOf(stats) as object) as Stats, stats, { dev: stats.dev + 1 }) : stats
      },
      beforeOpen: () => undefined,
    }
    expect(await readerOf(10, probe).inspect('skills')).toEqual({ kind: 'refused', reason: 'mount-point' })
  })

  it('refuses a directory that another directory or a link replaced between the walk and its listing', async () => {
    homes.write('skills/review/SKILL.md', 'x')
    homes.write('elsewhere/secret/SKILL.md', 'canary')
    const swaps: readonly ((path: string) => void)[] = [
      (path) => {
        renameSync(path, `${path}.moved`)
        symlinkSync(join(homes.source, 'elsewhere'), path)
      },
      (path) => {
        renameSync(path, `${path}.moved`)
        mkdirSync(path)
      },
    ]
    for (const swap of swaps) {
      rmSync(join(homes.source, 'skills'), { recursive: true, force: true })
      rmSync(join(homes.source, 'skills.moved'), { recursive: true, force: true })
      homes.write('skills/review/SKILL.md', 'x')
      const reader = readerOf(10, { lstat, beforeOpen: (path) => { if (path === 'skills') swap(join(homes.source, 'skills')) } })
      expect(await reader.inspect('skills')).toEqual({ kind: 'directory' })
      await expect(reader.list('skills')).rejects.toMatchObject({ code: expect.stringMatching(/^DSH_IMPORT_SOURCE_(?:CHANGED|UNUSABLE)$/u) as string, subject: 'skills' })
    }
  })

  it('refuses a directory on the way to a file that a link replaced after the walk', async () => {
    homes.write('skills/review/SKILL.md', 'x')
    homes.write('elsewhere/review/SKILL.md', 'x')
    const reader = readerOf(10)
    await reader.inspect('skills')
    const entry = await reader.inspect('skills/review/SKILL.md')
    if (entry.kind !== 'file') throw new Error('the fixture is a plain file')
    renameSync(join(homes.source, 'skills'), join(homes.source, 'skills.moved'))
    symlinkSync(join(homes.source, 'skills.moved'), join(homes.source, 'skills'))
    await expect(reader.read(entry.file)).rejects.toMatchObject({ code: 'DSH_IMPORT_SOURCE_CHANGED', message: expect.stringContaining('it is reached through a link') as string })
  })

  it('refuses a file whose own path became a link after the walk, without following it', async () => {
    homes.write('AGENTS.md', '# notes\n')
    const reader = readerOf(10)
    const entry = await reader.inspect('AGENTS.md')
    if (entry.kind !== 'file') throw new Error('the fixture is a plain file')
    renameSync(join(homes.source, 'AGENTS.md'), join(homes.source, 'AGENTS.md.moved'))
    symlinkSync(join(homes.source, 'AGENTS.md.moved'), join(homes.source, 'AGENTS.md'))
    await expect(reader.read(entry.file)).rejects.toMatchObject({ code: 'DSH_IMPORT_SOURCE_CHANGED', message: expect.stringContaining('could not be opened (ELOOP)') as string })
  })

  it('refuses a home root that is no longer on the device the plan recorded', async () => {
    mark(homes)
    const reader = new SourceReader(homes.source, 10, lstatSync(homes.source).dev + 1)
    await expect(reader.list('')).rejects.toMatchObject({ code: 'DSH_IMPORT_SOURCE_CHANGED', subject: undefined, message: expect.stringContaining('the stock home changed after the import read it') as string })
  })

  it('counts every listed name against the entry limit, names it leaves behind included', async () => {
    for (let index = 0; index < 6; index += 1) homes.write(`unknown-${String(index)}`, 'x')
    await expect(readerOf(5).list('')).rejects.toMatchObject({ code: 'DSH_IMPORT_TOO_MANY_ENTRIES' })
    expect(await readerOf(6).list('')).toHaveLength(6)
  })
})

describe('a placement that fails', () => {
  it('reads an existing path and a home without hard links as refusals, and passes any other failure on', () => {
    const failure = (code: string): Error => Object.assign(new Error(code), { code })
    expect(publicationFailure('a', failure('EEXIST'))).toMatchObject({ code: 'DSH_IMPORT_TARGET_REFUSED', message: 'the Delorun home gained "a" while the import ran, and an import never replaces a file' })
    for (const code of ['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP']) {
      expect((publicationFailure('a', failure(code)) as DshImportError).message).toContain(`(${code}); the import needs the Delorun home on one file system that supports hard links`)
    }
    const other = failure('EIO')
    expect(publicationFailure('a', other)).toBe(other)
  })
})
